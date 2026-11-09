import { endpoints, type ID, type ModalView } from "@ownbase/protocol";
import { CapabilityMap } from "../core/capabilities.js";
import type { ServerContext } from "../core/context.js";
import { HttpError } from "../httpError.js";
import { ulid } from "../ids.js";
import { CAPABILITIES_ALIVE } from "../limits.js";
import { parseView, readAnswer, type AnswerContext } from "./blockKit.js";
import type { AppCalls } from "./calls.js";
import { slackError, structured } from "./slackApi.js";

/**
 * A `trigger_id` is permission to open one modal, on behalf of one person,
 * for a short while. Slack gives an app three seconds to use it; three
 * minutes is friendlier to a self-hosted app on a cold start and still short
 * enough that a leaked id is worthless. In memory, like a response_url.
 */
interface Trigger {
  userId: ID;
  channelId: ID;
  appId: ID;
  botUserId: ID;
  expiresAt: number;
}

/** Hands out a trigger_id, for a command or a button press to pass to its app. */
export type NewTrigger = (trigger: Omit<Trigger, "expiresAt">) => string;

/** An open modal, waiting for the person it was shown to. */
interface OpenView {
  view: ModalView;
  userId: ID;
  channelId: ID;
  appId: ID;
  botUserId: ID;
  /** The app's own name for it, unique among its open views; empty when it gave none. */
  externalId: string;
  expiresAt: number;
}

const TRIGGER_LIFE = 3 * 60_000;
const VIEW_LIFE = 30 * 60_000;
const MAX_STACK = 3;

/** The forms apps open in front of people: `views.*`, and closing and submitting them. */
export function registerViews(ctx: ServerContext, { calls }: { calls: AppCalls }) {
  const { store, settings, route, ration, gateway } = ctx;

  const triggers = new CapabilityMap<Trigger>(CAPABILITIES_ALIVE.triggers);

  const newTrigger: NewTrigger = (trigger) => {
    const now = Date.now();
    const id = ulid();
    triggers.set(id, { ...trigger, expiresAt: now + TRIGGER_LIFE }, now);
    return id;
  };

  const openViews = new CapabilityMap<OpenView>(CAPABILITIES_ALIVE.openViews);
  const submittingViews = new Set<ID>();

  /**
   * The forms each person has open, bottom first: the one an app opened and
   * any pushed on it, at most three as on Slack. One stack a person, since a
   * client shows one form at a time: opening a new one closes the old stack.
   */
  const viewStacks = new Map<ID, ID[]>();

  /** A person's stack, without any view that expired or was let go. */
  const stackOf = (userId: ID): ID[] => {
    const ids = (viewStacks.get(userId) ?? []).filter((id) => openViews.get(id));
    if (ids.length > 0) viewStacks.set(userId, ids);
    else viewStacks.delete(userId);
    return ids;
  };

  /**
   * Tells the person's devices what they have open now: the whole stack, with
   * the form to show on top, or which forms closed when none is left.
   */
  const showStack = (userId: ID, closed: ID[] = []): void => {
    const ids = stackOf(userId);
    if (ids.length > 0) {
      const stack = ids.map((id) => openViews.get(id)!.view);
      gateway.tellPerson(userId, { type: "view.open", view: stack.at(-1)!, stack });
    } else if (closed.length > 0) {
      gateway.tellPerson(userId, { type: "view.close", viewIds: closed });
    }
  };

  /** Closes a view and everything stacked on it; returns what closed. */
  const closeFrom = (userId: ID, viewId: ID): ID[] => {
    const ids = stackOf(userId);
    const at = ids.indexOf(viewId);
    if (at < 0) return [];
    const closed = ids.slice(at);
    for (const id of closed) openViews.delete(id);
    if (at === 0) viewStacks.delete(userId);
    else viewStacks.set(userId, ids.slice(0, at));
    return closed;
  };

  const closeStack = (userId: ID): ID[] => {
    const root = stackOf(userId)[0];
    return root ? closeFrom(userId, root) : [];
  };

  /**
   * Keeps or puts a view in the map with a fresh half hour, and with it the
   * rest of its stack: an app still changing a form is a form still in use,
   * and the one under it must not expire while the person is on top.
   */
  const keepOpen = (open: Omit<OpenView, "expiresAt">): void => {
    const now = Date.now();
    for (const id of stackOf(open.userId)) {
      const other = openViews.get(id, now);
      if (other && id !== open.view.id)
        openViews.set(id, { ...other, expiresAt: now + VIEW_LIFE }, now);
    }
    openViews.set(open.view.id, { ...open, expiresAt: now + VIEW_LIFE }, now);
  };

  /** One of this app's open views by the name it gave it. */
  const viewByExternalId = (appId: ID, externalId: string): OpenView | undefined => {
    for (const userId of [...viewStacks.keys()]) {
      for (const id of stackOf(userId)) {
        const open = openViews.get(id);
        if (open?.appId === appId && open.externalId === externalId) return open;
      }
    }
    return undefined;
  };

  /**
   * An app's view object read for showing, or Slack's name for why it cannot
   * be: every input it held was a kind this server cannot draw (a form that
   * silently lost its questions is worse than none), or there is nothing in
   * it at all. A view of text alone is fine: an app shows "Loading" that way
   * before it updates the view with the real form, or "Done" after one.
   */
  const readView = (
    raw: unknown,
    id: ID,
    channelId: ID,
  ): { view: ModalView; externalId: string } | { error: string } => {
    const { droppedFields, wordless, ...parsed } = parseView(raw, id, { channelId });
    if (parsed.fields.length === 0 && (droppedFields > 0 || wordless)) {
      return { error: droppedFields > 0 ? "unsupported_elements" : "no_inputs" };
    }
    const named = (raw as { external_id?: unknown } | null)?.external_id;
    return {
      view: { ...parsed, hash: ulid() },
      externalId: typeof named === "string" ? named.slice(0, 255) : "",
    };
  };

  /** The view as Slack's methods answer with it, so an app can keep its id and hash. */
  const describeView = (open: OpenView) => {
    const ids = stackOf(open.userId);
    const at = ids.indexOf(open.view.id);
    return {
      id: open.view.id,
      type: "modal",
      callback_id: open.view.callbackId,
      external_id: open.externalId,
      hash: open.view.hash,
      private_metadata: open.view.privateMetadata,
      root_view_id: ids[0] ?? open.view.id,
      previous_view_id: at > 0 ? ids[at - 1]! : null,
    };
  };

  /**
   * Spends a trigger_id for this app, or names why it cannot be. The trigger
   * decides who sees the view, so an app cannot open a modal in front of
   * someone who did not just ask for one.
   */
  const spendTrigger = (owner: { id: ID }, triggerId: unknown): Trigger | { error: string } => {
    const trigger = typeof triggerId === "string" ? triggers.get(triggerId) : undefined;
    if (!trigger || trigger.expiresAt < Date.now()) {
      if (typeof triggerId === "string") triggers.delete(triggerId);
      return { error: "expired_trigger_id" };
    }
    // The trigger belongs to whoever it was issued for, and to that app alone.
    if (trigger.appId !== owner.id) return { error: "trigger_not_yours" };
    triggers.delete(triggerId as string);
    if (!calls.capabilityHolds({ ...trigger, invokerId: trigger.userId })) {
      return { error: "expired_trigger_id" };
    }
    return trigger;
  };

  /**
   * Shows a new view to the person a trigger was issued for: pushed on the
   * stack they have open from this app, or as the first of a new stack,
   * which closes whatever they had open before.
   */
  const placeView = (
    owner: { id: ID; botUserId: ID },
    trigger: Trigger,
    raw: unknown,
    push: boolean,
  ) => {
    const ids = stackOf(trigger.userId);
    const top = ids.length > 0 ? openViews.get(ids.at(-1)!) : undefined;
    const stacking = push && top?.appId === owner.id;
    if (stacking && ids.length >= MAX_STACK) return slackError("push_limit_reached");
    const read = readView(raw, ulid(), trigger.channelId);
    if ("error" in read) return slackError(read.error);
    if (read.externalId && viewByExternalId(owner.id, read.externalId)) {
      return slackError("duplicate_external_id");
    }
    if (!stacking) closeStack(trigger.userId);
    keepOpen({
      view: read.view,
      userId: trigger.userId,
      channelId: trigger.channelId,
      appId: owner.id,
      botUserId: owner.botUserId,
      externalId: read.externalId,
    });
    viewStacks.set(trigger.userId, [...(stacking ? ids : []), read.view.id]);
    showStack(trigger.userId);
    return { ok: true, view: describeView(openViews.get(read.view.id)!) };
  };

  const showOnTrigger =
    (push: boolean) =>
    async ({ req, bot: owner }: { req: { body: unknown }; bot: { id: ID; botUserId: ID } }) => {
      const body = (req.body ?? {}) as { trigger_id?: unknown; view?: unknown };
      const trigger = spendTrigger(owner, body.trigger_id);
      if ("error" in trigger) return slackError(trigger.error);
      return placeView(owner, trigger, structured(body.view), push);
    };
  route(endpoints.viewsOpen, showOnTrigger(false));
  route(endpoints.viewsPush, showOnTrigger(true));

  route(endpoints.viewsUpdate, async ({ req, bot: owner }) => {
    // An app updating in a loop pushes a form at someone with every call.
    ration("post", owner.botUserId);
    const body = (req.body ?? {}) as {
      view_id?: unknown;
      external_id?: unknown;
      hash?: unknown;
      view?: unknown;
    };
    const found =
      typeof body.view_id === "string" && body.view_id
        ? openViews.get(body.view_id)
        : typeof body.external_id === "string" && body.external_id
          ? viewByExternalId(owner.id, body.external_id)
          : undefined;
    // Another app's view is answered as no view at all.
    if (!found || found.appId !== owner.id || !stackOf(found.userId).includes(found.view.id)) {
      return slackError("not_found");
    }
    if (!calls.capabilityHolds({ ...found, invokerId: found.userId })) {
      showStack(found.userId, closeStack(found.userId));
      return slackError("not_found");
    }
    if (typeof body.hash === "string" && body.hash && body.hash !== found.view.hash) {
      return slackError("hash_conflict");
    }
    const raw = structured(body.view);
    const read = readView(raw, found.view.id, found.channelId);
    if ("error" in read) return slackError(read.error);
    // An update that names the view keeps or changes its name; one that does not keeps it.
    const externalId = read.externalId || found.externalId;
    const named = externalId ? viewByExternalId(owner.id, externalId) : undefined;
    if (named && named.view.id !== found.view.id) return slackError("duplicate_external_id");
    keepOpen({ ...found, view: read.view, externalId });
    showStack(found.userId);
    return { ok: true, view: describeView(openViews.get(found.view.id)!) };
  });

  route(endpoints.closeView, async ({ user: me, params }) => {
    const closed = closeFrom(me.id, params.id);
    if (closed.length > 0) showStack(me.id, closed);
    return { ok: true };
  });

  route(endpoints.submitView, async ({ user: me, body, params }) => {
    const open = openViews.get(params.id);
    // A view belongs to the one person it was opened for.
    if (!open || open.userId !== me.id || open.expiresAt < Date.now()) {
      // A request from another account must not consume the owner's view.
      if (!open || open.expiresAt < Date.now()) openViews.delete(params.id);
      throw new HttpError(404, "view_not_found");
    }
    // Only the form on top is in front of the person; one under it waits
    // until they come back to it.
    if (stackOf(me.id).at(-1) !== open.view.id) throw new HttpError(404, "view_not_found");
    // A view of text alone, such as "Loading", has nothing to submit.
    if (!open.view.submitLabel) throw new HttpError(400, "view_has_no_submit");
    const owner = store.apps.get(open.appId);
    if (!owner?.interactivityUrl) {
      showStack(me.id, closeStack(me.id));
      throw new HttpError(400, "no_interactivity_url");
    }
    // A form can sit open for half an hour before anyone presses submit.
    if (!calls.capabilityHolds({ ...open, invokerId: open.userId })) {
      showStack(me.id, closeStack(me.id));
      throw new HttpError(404, "view_not_found");
    }

    // Only the fields the app actually asked for, in Slack's nested shape.
    const values: Record<string, Record<string, unknown>> = {};
    const missing: Record<string, string> = {};
    const answering: AnswerContext = {
      isPerson: (id) => {
        const person = store.people.get(id);
        return !!person && !person.deactivated;
      },
      conversationType: (id) => {
        const channel = store.channels.get(id);
        return channel && !channel.archived && store.canAccess(id, me.id) ? channel.type : null;
      },
    };
    for (const field of open.view.fields) {
      const answer = readAnswer(field, body.values[field.blockId]?.[field.actionId], answering);
      if ("error" in answer) {
        missing[field.blockId] = answer.error;
        continue;
      }
      values[field.blockId] = { ...values[field.blockId], [field.actionId]: answer.state };
    }
    // Required fields are checked here as well as in the browser: the app
    // should never have to defend against a submission the form itself forbids.
    if (Object.keys(missing).length > 0) return { ok: false, errors: missing };

    if (submittingViews.has(open.view.id))
      throw new HttpError(
        409,
        "view_submitting",
        "This form is already being submitted. Wait for its answer before trying again.",
      );
    const release = calls.admit(me.id, owner.id);
    submittingViews.add(open.view.id);
    try {
      const payload = JSON.stringify({
        type: "view_submission",
        team: { id: settings.get("workspaceId"), domain: settings.get("workspaceName") },
        user: { id: me.id, username: me.handle, name: me.displayName },
        api_app_id: owner.id,
        trigger_id: newTrigger({
          userId: me.id,
          channelId: open.channelId,
          appId: owner.id,
          botUserId: owner.botUserId,
        }),
        view: {
          ...describeView(open),
          title: { type: "plain_text", text: open.view.title },
          state: { values },
        },
      });
      const form = new URLSearchParams({ payload }).toString();

      try {
        const res = await calls.postForm(owner.id, owner.interactivityUrl, form);
        if (res.status < 200 || res.status >= 300) {
          return { ok: false, errors: {}, message: `The app answered ${res.status}.` };
        }
        const answered = res.body.trim();
        let parsed: { response_action?: unknown; errors?: Record<string, string>; view?: unknown } =
          {};
        if (answered.startsWith("{")) {
          try {
            parsed = JSON.parse(answered) as typeof parsed;
          } catch {
            // The app did answer, so saying it did not would send someone
            // looking for a network problem that is not there.
            return {
              ok: false,
              errors: {},
              message: "The app answered with something that could not be read.",
            };
          }
          // Slack's shape for "your answers are not acceptable, here is why".
          if (parsed.response_action === "errors" && parsed.errors) {
            return { ok: false, errors: parsed.errors };
          }
        }
        // Accepted. The app may change this form or stack another on it,
        // provided the person has not closed it while the app was deciding.
        const still = stackOf(me.id).includes(open.view.id) ? openViews.get(open.view.id) : null;
        const action = parsed.response_action;
        if (still && (action === "update" || action === "push")) {
          const pushing = action === "push";
          if (pushing && stackOf(me.id).length >= MAX_STACK) {
            return {
              ok: false,
              errors: {},
              message: "The app tried to open more forms on top of this one than can be open.",
            };
          }
          const read = readView(
            structured(parsed.view),
            pushing ? ulid() : open.view.id,
            open.channelId,
          );
          const named =
            "error" in read || !read.externalId
              ? undefined
              : viewByExternalId(owner.id, read.externalId);
          if ("error" in read || (named && named.view.id !== read.view.id)) {
            return {
              ok: false,
              errors: {},
              message: "The app answered with a form that cannot be shown.",
            };
          }
          if (pushing) {
            keepOpen({ ...still, view: read.view, externalId: read.externalId });
            viewStacks.set(me.id, [...stackOf(me.id), read.view.id]);
          } else {
            keepOpen({
              ...still,
              view: read.view,
              externalId: read.externalId || still.externalId,
            });
          }
          showStack(me.id);
          return { ok: true, closedViewIds: [] };
        }
        // Anything else closes this form, and "clear" every form under it too.
        const closed = action === "clear" ? closeStack(me.id) : closeFrom(me.id, open.view.id);
        showStack(me.id, closed);
        return { ok: true, closedViewIds: closed.length > 0 ? closed : [open.view.id] };
      } catch (err) {
        const why = calls.whyFailed(err);
        return { ok: false, errors: {}, message: `That did not go through: ${why}.` };
      }
    } finally {
      submittingViews.delete(open.view.id);
      release();
    }
  });

  return { newTrigger };
}
