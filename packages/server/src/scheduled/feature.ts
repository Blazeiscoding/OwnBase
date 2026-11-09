import { endpoints, type ErrorCode, type ScheduledMessage } from "@ownbase/protocol";
import { requireChannelAccess, type ServerContext } from "../core/context.js";
import { HttpError } from "../httpError.js";
import { type Posting } from "../messages/posting.js";

/** How many times an unexplained delivery error is retried before giving up. */
const SCHEDULED_ATTEMPTS = 3;

/**
 * Bounds on the scheduled queue. An account may have this many waiting, and
 * the workspace this many in all; the flush takes due rows a batch at a time,
 * yielding between batches; and a held row is looked at again after a pause,
 * or as soon as what held it clears, rather than on every tick. A batch of ten
 * held the loop for about 13 ms (median) when 2,000 came due at once, where
 * fifty held it for about 64 ms; draining took the same three seconds either
 * way.
 */
export const SCHEDULED_LIMITS = {
  perAccount: 200,
  perWorkspace: 10_000,
  batch: 10,
  heldRetryMs: 60_000,
};

/** Delivered queue rows are kept this long as proof of completion. */
const SCHEDULED_RETENTION_MS = 7 * 24 * 3600_000;

/** Messages scheduled to post later: the queue's routes, and the loop that posts what is due. */
export function registerScheduled(ctx: ServerContext, { posting }: { posting: Posting }) {
  const { opts, app, store, route, background, lifecycle } = ctx;
  const scheduledLimits = { ...SCHEDULED_LIMITS, ...opts.scheduledLimits };

  route(endpoints.scheduleMessage, async ({ reply, user: me, body, params }) => {
    const result = posting.schedule({
      userId: me.id,
      channelId: params.id,
      text: body.text,
      threadRootId: body.threadRootId ?? null,
      fileIds: body.fileIds ?? [],
      sendAt: body.sendAt,
      // Only a reply can also be shown in the channel, as with an ordinary send.
      broadcast: !!body.threadRootId && body.alsoSendToChannel === true,
      nonce: body.nonce ?? null,
    });
    if (result.replayed) reply.status(200);
    return { scheduled: result.scheduled };
  });

  route(endpoints.listScheduled, async ({ user: me }) => {
    return { scheduled: store.scheduled.list(me.id) };
  });

  route(endpoints.cancelScheduled, async ({ user: me, params }) => {
    const scheduled = store.scheduled.get(params.id);
    // Only the author may cancel, and a missing one is simply gone.
    if (!scheduled || scheduled.userId !== me.id) throw new HttpError(404, "not_found");
    store.scheduled.delete(scheduled.id);
    return { ok: true };
  });

  route(endpoints.rescheduleMessage, async ({ user: me, body, params }) => {
    const scheduled = store.scheduled.get(params.id);
    if (!scheduled || scheduled.userId !== me.id || scheduled.status === "sent") {
      throw new HttpError(404, "not_found");
    }
    requireChannelAccess(store, scheduled.channelId, me);
    store.scheduled.reschedule(scheduled.id, body.sendAt);
    return { scheduled: store.scheduled.get(scheduled.id)! };
  });

  route(endpoints.editScheduledMessage, async ({ user: me, body, params }) => {
    const scheduled = store.scheduled.get(params.id);
    if (!scheduled || scheduled.userId !== me.id || scheduled.status === "sent") {
      throw new HttpError(404, "not_found");
    }
    requireChannelAccess(store, scheduled.channelId, me);
    if (!body.text.trim() && scheduled.fileIds.length === 0) {
      throw new HttpError(400, "empty_message", "A message needs text or attachments.");
    }
    if (!store.scheduled.editText(scheduled.id, body.text, body.expectedText)) {
      throw new HttpError(
        409,
        "scheduled_changed",
        "This scheduled message has changed. Refresh before editing again.",
      );
    }
    return { scheduled: store.scheduled.get(scheduled.id)! };
  });

  /**
   * Posts anything that has come due. Runs on a timer and once at startup, so
   * messages scheduled while the server was down still go out.
   *
   * Nothing is dropped silently. Delivery marks the queue row sent inside the
   * message transaction, so a crash between the two replays rather than losing
   * or duplicating the message. An obstacle that the author can clear holds the
   * row; one they cannot fails it. Either way the reason is theirs to read.
   */
  let scheduledDrain: ReturnType<typeof setImmediate> | null = null;
  const flushScheduled = () => {
    if (opts.isolated) return;
    const due = store.scheduled.due(Date.now(), scheduledLimits.batch);
    const retryAt = Date.now() + scheduledLimits.heldRetryMs;
    for (const item of due) {
      try {
        sendScheduled(item, retryAt);
      } catch (err) {
        // Recording what happened failed too. The row is as it was, so it is
        // due again next round; the rest of the batch still goes.
        app.log.error({ err, scheduledId: item.id }, "scheduled message not handled; it stays due");
      }
    }
    // A full batch may mean more are due. They are taken on a later turn, so
    // the window and every other request get the loop between batches.
    if (due.length === scheduledLimits.batch && !scheduledDrain && !lifecycle.closing) {
      scheduledDrain = setImmediate(() => {
        scheduledDrain = null;
        background.run("scheduled messages", flushScheduled);
      });
    }
  };
  /**
   * What the author can clear holds a row until they do; what they cannot
   * fails it. Either way it is said in words for their list.
   */
  const heldBecause = (item: ScheduledMessage, code: ErrorCode | null): string | null => {
    switch (code) {
      case "channel_not_found":
        return store.channels.get(item.channelId)
          ? "You are no longer a member of that channel."
          : "That channel no longer exists.";
      case "channel_archived":
        return "That channel is archived.";
      case "account_deactivated":
        return "Your account is deactivated.";
      default:
        return null;
    }
  };
  const failedBecause = (code: ErrorCode | null): string | null =>
    code === "bad_thread_root"
      ? "The message this replied to was deleted."
      : code === "invalid_attachments"
        ? "Its attachments are no longer available."
        : null;

  /** Posts one due scheduled message, or records why it waits or failed. */
  const sendScheduled = (item: ScheduledMessage, retryAt: number): void => {
    const hold = (reason: string) => store.scheduled.hold(item.id, reason, retryAt);
    const fail = (reason: string) => store.scheduled.fail(item.id, reason);
    try {
      posting.post({
        poster: { kind: "person", userId: item.userId },
        channelId: item.channelId,
        text: item.text,
        threadRootId: item.threadRootId,
        broadcast: item.broadcast,
        nonce: null,
        fileIds: item.fileIds,
        scheduledId: item.id,
      });
    } catch (err) {
      const code = err instanceof HttpError ? err.code : null;
      const held = heldBecause(item, code);
      const failed = failedBecause(code);
      if (held) hold(held);
      else if (failed) fail(failed);
      else if (store.scheduled.countAttempt(item.id) >= SCHEDULED_ATTEMPTS)
        fail("Sending failed repeatedly, so it was not posted.");
      else hold("Sending failed. It will be tried again shortly.");
    }
  };

  lifecycle.onClose(() => {
    if (scheduledDrain) clearImmediate(scheduledDrain);
  });

  return {
    /** Posts anything now due. Runs on a timer; exposed so tests need not wait. */
    flush: flushScheduled,
    /** Posts what came due while the server was stopped, then every 15 seconds. */
    start() {
      background.run("scheduled messages", flushScheduled);
      lifecycle.every(15_000, () => background.run("scheduled messages", flushScheduled));
    },
    hourly: () =>
      background.maintain("scheduled", () =>
        store.scheduled.prune(Date.now() - SCHEDULED_RETENTION_MS),
      ),
  };
}
