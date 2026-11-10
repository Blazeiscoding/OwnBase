import {
  endpoints,
  isAdministrator,
  SEND_RETRY_WINDOW_MS,
  type ID,
  type Message,
} from "@ownbase/protocol";
import {
  requireChannelAccess,
  requireVisibleMessage,
  type ServerContext,
} from "../core/context.js";
import { type Files } from "../files/feature.js";
import { HttpError } from "../httpError.js";
import { fetchLinkPreview, previewLinks, type FetchedPreview } from "../linkPreview.js";
import { createPosting } from "../messages/posting.js";
import { SCHEDULED_LIMITS } from "../scheduled/feature.js";

/**
 * One hourly retention round runs passes of at most a few thousand messages
 * each, yielding between them, until nothing is left or it has spent this
 * long; a larger backlog is finished on later rounds.
 */
const RETENTION_PASSES = 200;
const RETENTION_SWEEP_MS = 30_000;

export interface RetentionStatus {
  /** When a sweep last finished without an error; null before the first. */
  lastSuccessAt: number | null;
  /** Why the last sweep failed, or null when it did not. */
  lastError: string | null;
  /** Sweeps that have failed in a row. */
  failures: number;
}

/**
 * How long a removed message's send key is kept after it was posted: an app's
 * whole retry window, and a week more for a clock that disagrees with this one.
 */
const PURGED_SEND_KEYS_MS = SEND_RETRY_WINDOW_MS + 7 * 24 * 3600_000;

/** Messages: reading, sending, editing, removing and reacting; link previews; and retention. */
export function registerMessages(ctx: ServerContext, { files }: { files: Files }) {
  const { opts, app, store, settings, route, ration, recordEvent, mutate, background, lifecycle } =
    ctx;
  const { flushFileDeletions } = files;
  const scheduledLimits = { ...SCHEDULED_LIMITS, ...opts.scheduledLimits };

  const updateMessage = (existing: Message, text: string, clearActions = false): Message => {
    const updated = mutate((emit) => {
      if (clearActions) store.messages.clearActions(existing.id);
      const message = store.messages.edit(existing.id, text);
      emit({ type: "message.updated", message });
      return message;
    });
    // New links in the new words get theirs; the edit already dropped the old ones'.
    queuePreviews(updated);
    return updated;
  };

  // ---------- link previews (E2) ----------

  /** Fetches at once, and the most messages waiting for theirs; past it a message goes without. */
  const PREVIEW_WORKERS = 2;
  const PREVIEW_QUEUE = 200;
  /**
   * A link posted again soon after is not fetched again. Pictures are held
   * here too, so this stays small: 25 links, each for half an hour.
   */
  const PREVIEW_CACHE = 25;
  const PREVIEW_CACHE_MS = 30 * 60_000;
  const previewQueue: ID[] = [];
  const previewQueued = new Set<ID>();
  let previewsRunning = 0;
  const previewCache = new Map<string, { at: number; found: Promise<FetchedPreview | null> }>();
  const fetchPreview =
    opts.fetchLinkPreview ??
    ((url: string, signal: AbortSignal) => fetchLinkPreview(url, { signal }));

  const cachedPreview = (url: string): Promise<FetchedPreview | null> => {
    const now = Date.now();
    const held = previewCache.get(url);
    if (held && now - held.at < PREVIEW_CACHE_MS) return held.found;
    const found = fetchPreview(url, lifecycle.signal).catch(() => null);
    previewCache.delete(url);
    previewCache.set(url, { at: now, found });
    while (previewCache.size > PREVIEW_CACHE)
      previewCache.delete(previewCache.keys().next().value!);
    return found;
  };

  /**
   * Looks for previews of a message's links after it is committed, a sent or
   * an edited one. Nothing is fetched while the workspace is an isolated copy,
   * which calls nothing outside, or with previews turned off.
   */
  const queuePreviews = (message: Message): void => {
    if (lifecycle.closing || opts.isolated || !settings.get("linkPreviews")) return;
    if (previewLinks(message.text).length === 0 || previewQueued.has(message.id)) return;
    if (previewQueue.length >= PREVIEW_QUEUE) return;
    previewQueued.add(message.id);
    previewQueue.push(message.id);
    pumpPreviews();
  };

  const pumpPreviews = (): void => {
    while (!lifecycle.closing && previewsRunning < PREVIEW_WORKERS && previewQueue.length > 0) {
      const id = previewQueue.shift()!;
      previewQueued.delete(id);
      previewsRunning++;
      void findPreviews(id)
        .catch((err) => app.log.warn({ err, messageId: id }, "could not add link previews"))
        .finally(() => {
          previewsRunning--;
          pumpPreviews();
        });
    }
  };

  /**
   * Fetches what a message's links lack, then adds it in one change told to
   * its readers as a `message.updated` with `previewsOnly`. A message edited
   * or deleted while its links were fetched gets nothing from this round: its
   * edit queued another for its new words.
   */
  const findPreviews = async (messageId: ID): Promise<void> => {
    const message = store.messages.get(messageId);
    if (!message) return;
    const known = new Set(store.messages.previewRows(messageId).map((row) => row.url));
    const found: { position: number; preview: FetchedPreview }[] = [];
    for (const [position, url] of previewLinks(message.text).entries()) {
      if (known.has(url)) continue;
      const preview = await cachedPreview(url);
      if (preview) found.push({ position, preview: { ...preview, url } });
    }
    if (found.length === 0 || lifecycle.closing) return;
    mutate((emit) => {
      const now = store.messages.get(messageId);
      if (!now || now.text !== message.text || !settings.get("linkPreviews")) return;
      let added = false;
      for (const { position, preview } of found)
        added = store.messages.addPreview(messageId, position, preview) || added;
      if (added)
        emit({
          type: "message.updated",
          message: store.messages.get(messageId)!,
          previewsOnly: true,
        });
    });
  };

  const posting = createPosting({ store, mutate, ration, queuePreviews, scheduledLimits });

  const retentionMs = (opts.retentionDays ?? 0) * 24 * 3600_000;

  /**
   * Discards conversation older than the configured retention window.
   *
   * Each pass logs one `history.removed` per conversation it touched, naming
   * the threads that went, rather than a deletion per message: a month of
   * those would put thousands of events into the very log this is meant to
   * keep small. Like any event, it reaches only those who can read the
   * conversation, and a client that was away hears it when it catches up.
   */
  const applyRetention = (): number => {
    if (!retentionMs) return 0;
    const { messages, fileIds } = mutate((emit) => {
      const purged = store.messages.purgeBefore(Date.now() - retentionMs);
      const byChannel = new Map<ID, ID[]>();
      for (const root of purged.roots) {
        const ids = byChannel.get(root.channelId) ?? [];
        ids.push(root.id);
        byChannel.set(root.channelId, ids);
      }
      for (const [channelId, rootIds] of byChannel)
        emit({ type: "history.removed", channelId, rootIds });
      return purged;
    });
    if (messages === 0) return 0;
    app.log.info(
      { messages, files: fileIds.length, retentionDays: opts.retentionDays },
      "discarded conversation past the retention window",
    );
    if (fileIds.length > 0) void flushFileDeletions();
    return messages;
  };

  /**
   * What the last retention sweep came to. A sweep that throws is caught, so
   * it cannot take the server down from a timer, and is tried again on the
   * next round; until one succeeds, this is how its failure stays visible.
   */
  const retention: RetentionStatus = { lastSuccessAt: null, lastError: null, failures: 0 };

  /**
   * Runs retention passes until one finds nothing left or the round's budget
   * is spent, giving the event loop back between passes so posts and reads
   * are served while a large backlog drains. Each pass is its own transaction:
   * stopping between two of them leaves nothing half removed.
   */
  const sweepRetention = async (): Promise<number> => {
    if (!retentionMs) return 0;
    const started = Date.now();
    let removed = 0;
    try {
      for (let pass = 0; pass < RETENTION_PASSES && !lifecycle.closing; pass++) {
        const went = applyRetention();
        removed += went;
        if (went === 0 || Date.now() - started > RETENTION_SWEEP_MS) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      retention.lastSuccessAt = Date.now();
      retention.lastError = null;
      retention.failures = 0;
    } catch (err) {
      retention.failures++;
      retention.lastError = err instanceof Error ? err.message : String(err);
      app.log.error(
        { err, failures: retention.failures, retentionDays: opts.retentionDays },
        "retention sweep failed; it will be tried again",
      );
    }
    return removed;
  };

  /**
   * Deletes a message, and when it started a thread, every reply in it.
   *
   * A reply has nothing to hang from once its thread's first message is gone:
   * the thread cannot be opened, and keeping the replies stored where nobody can
   * reach them served no one. So they go the same way, in the same transaction —
   * words blanked, attachments released, and the copies in the event log
   * redacted — and each is announced, replies before the message they answered,
   * so an open thread empties before it closes.
   */
  /** Deletes a message, its thread's replies with it, and their files, within `mutate`. */
  const removeMessageWithin = (existing: Message, emit: typeof recordEvent): void => {
    const replies = existing.threadRootId === null ? store.threads.replyIds(existing.id) : [];
    const doomed = [
      ...replies.map((id) => ({ id, threadRootId: existing.id as ID | null })),
      { id: existing.id, threadRootId: existing.threadRootId },
    ];
    for (const message of doomed) {
      const fileIds = store.files.idsForMessage(message.id);
      store.files.delete(fileIds);
      store.files.queueDeletions(fileIds);
      store.messages.delete(message.id);
      emit({
        type: "message.deleted",
        channelId: existing.channelId,
        messageId: message.id,
        threadRootId: message.threadRootId,
      });
    }
  };
  const removeMessage = (existing: Message) =>
    mutate((emit) => removeMessageWithin(existing, emit));

  route(endpoints.listMessages, async ({ user: me, query: q, params }) => {
    requireChannelAccess(store, params.id, me);
    const messages = store.messages.list({
      channelId: params.id,
      before: q.before,
      limit: q.limit,
      threadRootId: q.threadRootId,
    });
    return {
      messages,
      readThroughSeq: store.channels.lastMessageSeq(params.id),
      seq: store.currentSeq(),
    };
  });

  route(endpoints.listMessagesAround, async ({ user: me, query, params }) => {
    requireChannelAccess(store, params.id, me);
    const { limit } = query;
    const target = store.messages.get(params.messageId);
    if (!target || target.channelId !== params.id) throw new HttpError(404, "message_not_found");
    const rootId = target.threadRootId ?? target.id;
    if (target.threadRootId && !store.messages.get(rootId))
      throw new HttpError(404, "thread_not_found");
    return {
      ...store.messages.around(params.id, rootId, limit),
      threadRootId: target.threadRootId,
      seq: store.currentSeq(),
    };
  });

  route(endpoints.listMessagesSince, async ({ user: me, query, params }) => {
    requireChannelAccess(store, params.id, me);
    const { limit } = query;
    const seq = Number(params.seq);
    if (!/^\d{1,15}$/.test(params.seq) || !Number.isSafeInteger(seq))
      throw new HttpError(400, "invalid_seq");
    const target = store.messages.firstAfterSeq(params.id, seq, me.id);
    if (!target) throw new HttpError(404, "message_not_found");
    return {
      ...store.messages.around(params.id, target, limit),
      targetId: target,
      seq: store.currentSeq(),
    };
  });

  route(endpoints.getMessage, async ({ user: me, params }) => {
    requireChannelAccess(store, params.id, me);
    const message = store.messages.get(params.messageId);
    if (!message || message.channelId !== params.id) throw new HttpError(404, "message_not_found");
    return { message };
  });

  route(endpoints.listMessagesAfter, async ({ user: me, query, params }) => {
    requireChannelAccess(store, params.id, me);
    const { limit } = query;
    return {
      messages: store.messages.after(params.id, params.messageId, limit),
      seq: store.currentSeq(),
    };
  });

  route(endpoints.sendMessage, async ({ user: me, body, params }) => {
    const message = posting.post({
      poster: { kind: "person", userId: me.id },
      channelId: params.id,
      text: body.text,
      threadRootId: body.threadRootId ?? null,
      nonce: body.nonce ?? null,
      fileIds: body.fileIds ?? [],
      broadcast: body.alsoSendToChannel ?? false,
      replyToId: body.replyToId ?? null,
      // Discord notifies the author unless the reply says not to.
      replyPing: body.replyPing ?? true,
      forwardFromId: body.forwardFrom ?? null,
      poll: body.poll ?? null,
    });
    return { message };
  });

  route(endpoints.editMessage, async ({ user: me, body, params }) => {
    const existing = requireVisibleMessage(store, params.id, me);
    if (existing.userId !== me.id) throw new HttpError(403, "not_your_message");
    // People voted on the question as it was.
    if (existing.poll)
      throw new HttpError(409, "poll_not_editable", "A poll's question cannot be changed.");
    // It says what happened to a call, not what its caller wrote.
    if (existing.call)
      throw new HttpError(409, "call_not_editable", "A note about a call cannot be changed.");
    // Words already the new ones are a retry whose answer was lost, not a conflict.
    if (
      body.expectedText !== undefined &&
      existing.text !== body.expectedText &&
      existing.text !== body.text
    ) {
      throw new HttpError(
        409,
        "message_changed",
        "This message has changed. Choose which version to keep before saving.",
      );
    }
    return { message: updateMessage(existing, body.text) };
  });

  route(endpoints.deleteMessage, async ({ user: me, params }) => {
    const existing = requireVisibleMessage(store, params.id, me);
    const isPrivileged = isAdministrator(me.role);
    if (existing.userId !== me.id && !isPrivileged) throw new HttpError(403, "not_your_message");

    removeMessage(existing);
    await flushFileDeletions();
    return { ok: true };
  });

  route(endpoints.previewImage, async ({ reply, user: me, params }) => {
    const owner = store.messages.previewOwner(params.id);
    if (!owner || !store.canAccess(owner.channelId, me.id))
      throw new HttpError(404, "preview_not_found");
    const image = store.messages.previewImage(params.id);
    if (!image) throw new HttpError(404, "preview_not_found");
    return reply
      .header("content-type", image.type)
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .send(Buffer.from(image.bytes));
  });

  route(endpoints.removeLinkPreview, async ({ user: me, params }) => {
    const owner = store.messages.previewOwner(params.id);
    if (!owner || !store.canAccess(owner.channelId, me.id))
      throw new HttpError(404, "preview_not_found");
    if (owner.authorId !== me.id) throw new HttpError(403, "not_your_message");
    mutate((emit) => {
      store.messages.removePreview(params.id);
      emit({
        type: "message.updated",
        message: store.messages.get(owner.messageId)!,
        previewsOnly: true,
      });
    });
    return { ok: true };
  });

  route(endpoints.addReaction, async ({ user: me, params }) => {
    const msg = requireVisibleMessage(store, params.id, me);
    const emoji = decodeURIComponent(params.emoji).slice(0, 64);
    mutate((emit) => {
      if (store.messages.addReaction(msg.id, me.id, emoji)) {
        emit({
          type: "reaction.added",
          channelId: msg.channelId,
          messageId: msg.id,
          emoji,
          userId: me.id,
        });
      }
    });
    return { ok: true };
  });

  route(endpoints.removeReaction, async ({ user: me, params }) => {
    const msg = requireVisibleMessage(store, params.id, me);
    const emoji = decodeURIComponent(params.emoji).slice(0, 64);
    mutate((emit) => {
      if (store.messages.removeReaction(msg.id, me.id, emoji)) {
        emit({
          type: "reaction.removed",
          channelId: msg.channelId,
          messageId: msg.id,
          emoji,
          userId: me.id,
        });
      }
    });
    return { ok: true };
  });

  route(endpoints.latestDirectMessages, async ({ user: me }) => {
    return { messages: store.messages.latestDirect(me.id) };
  });

  return {
    posting,
    updateMessage,
    queuePreviews,
    removeMessage,
    removeMessageWithin,
    applyRetention,
    sweepRetention,
    retention,
    retentionOn: retentionMs > 0,
    hourly: () =>
      background.maintain("removed messages' send keys", () =>
        store.messages.pruneRequestsPurged(Date.now() - PURGED_SEND_KEYS_MS),
      ),
  };
}
