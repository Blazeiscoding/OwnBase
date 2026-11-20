import type {
  ChannelRemoval,
  EphemeralEvent,
  ID,
  Message,
  ReadySnapshot,
  ThreadFollow,
} from "@ownbase/protocol";
import type { StoreApi } from "zustand/vanilla";
import { failureOf } from "./answers.js";
import { ApiError, type Api } from "./api.js";
import { threadRootMessage, timelineMessages } from "./messageCache.js";
import type { OptimisticWrites, WriteSpec } from "./optimisticWrites.js";
import type { WorkspaceState } from "./workspaceState.js";

/**
 * How far this account has read: each conversation's cursor, and each
 * thread's, which the server keeps in the thread's follow record with whether
 * it is followed or muted. Removal notes in Activity are read here too.
 */
export class ReadMarks {
  constructor(
    private readonly api: Api,
    private readonly store: StoreApi<WorkspaceState>,
    private readonly writes: OptimisticWrites,
    private readonly isStopped: () => boolean,
  ) {}

  private get state(): WorkspaceState {
    return this.store.getState();
  }

  private get stopped(): boolean {
    return this.isStopped();
  }

  private pendingReads = new Map<ID, number>();
  /** Notes of removals this device is telling the server it read. */
  private readingRemovals = new Set<ID>();
  /**
   * Conversations deliberately left unread. Automatic acknowledgement skips
   * them, or looking at what you just marked unread would immediately read it
   * again. Leaving the conversation lifts the hold, so coming back reads it.
   */
  private readHold = new Set<ID>();
  private threadReadHold = new Set<ID>();
  /**
   * The latest mark unread still unanswered for each conversation: the message
   * it was for, and where the cursor goes back to if the server refuses it.
   */
  private unreadMarks = new Map<ID, { seq: number; before: number }>();
  private readRequests = new Map<ID, AbortController>();
  private readRetryTimer: ReturnType<typeof setInterval> | null = null;

  readLoadedTail(channelId: ID): void {
    const timeline = this.state.timelines[channelId];
    if (!timeline?.loaded || timeline.hasMoreNewer) return;
    const newest = timelineMessages(this.state, channelId).at(-1)?.seq ?? 0;
    this.markRead(channelId, timeline.readThroughSeq ?? newest);
  }

  /**
   * Follow updates can arrive from this device and another at once. The
   * revision decides, so a stale echo cannot undo a newer choice.
   */
  applyThreadFollow(state: ThreadFollow): void {
    this.store.setState((s) => {
      const known = s.threadFollows[state.rootId];
      if (known && known.revision > state.revision) return {};
      return { threadFollows: { ...s.threadFollows, [state.rootId]: state } };
    });
  }

  /**
   * How a thread's follow state is shown while a write about it is out. The
   * server's answer is its whole state after the request, so its echoes are
   * not heard here: they go through `applyThreadFollow` like any other
   * device's. An answer older than what has been shown since, such as a
   * read's while a follow is out, does not replace it; a refusal puts back
   * exactly what was there, including "no row at all".
   */
  private threadSpec<P>(
    rootId: ID,
    steps: Pick<WriteSpec<ThreadFollow | undefined, P>, "send" | "merge" | "apply">,
  ): WriteSpec<ThreadFollow | undefined, P> {
    return {
      ...steps,
      read: () => this.state.threadFollows[rootId],
      show: (value, { saving, refused }) => {
        if (value && !saving && !refused) return this.applyThreadFollow(value);
        this.store.setState((s) => {
          const threadFollows = { ...s.threadFollows };
          if (value) threadFollows[rootId] = value;
          else delete threadFollows[rootId];
          return { threadFollows };
        });
      },
      same: (a, b) =>
        a?.following === b?.following &&
        !!a?.muted === !!b?.muted &&
        a?.lastReadSeq === b?.lastReadSeq,
    };
  }

  /**
   * Follows, mutes or marks a thread unread, shown at once. These go one at a
   * time, in the order they were made: sent together, a Follow could reach the
   * server after the Unfollow that came after it, and leave the thread
   * followed (Q09).
   */
  private writeThreadFollow(
    next: ThreadFollow,
    request: () => Promise<{ state: ThreadFollow }>,
  ): Promise<ApiError | null> {
    const step = { next, request };
    return this.writes.write({ kind: "threadFollow", rootId: next.rootId }, [step], {
      ...this.threadSpec<(typeof step)[]>(next.rootId, {
        send: async (steps) => {
          let state: ThreadFollow | undefined;
          for (const { request } of steps) ({ state } = await request());
          return state;
        },
        merge: (earlier, later) => [...earlier, ...later],
        apply: (_value, steps) => steps.at(-1)!.next,
      }),
    });
  }

  setThreadFollow(rootId: ID, following: boolean): Promise<ApiError | null> {
    const before = this.state.threadFollows[rootId];
    if (before?.following === following) return Promise.resolve(null);
    const channelId = before?.channelId ?? this.threadRoot(rootId)?.channelId;
    if (!channelId) return Promise.resolve(null);
    const tail = this.threadTailSeq(rootId);
    return this.writeThreadFollow(
      {
        rootId,
        channelId,
        following,
        // Following from here means caught up to whatever is loaded.
        lastReadSeq: following ? Math.max(before?.lastReadSeq ?? 0, tail) : 0,
        lastSeq: Math.max(before?.lastSeq ?? 0, tail),
        revision: (before?.revision ?? 0) + 1,
      },
      () => this.api.setThreadFollow(rootId, following),
    );
  }

  setThreadMute(rootId: ID, muted: boolean): Promise<ApiError | null> {
    const before = this.state.threadFollows[rootId];
    if ((before?.muted === true) === muted) return Promise.resolve(null);
    const channelId = before?.channelId ?? this.threadRoot(rootId)?.channelId;
    if (!channelId) return Promise.resolve(null);
    return this.writeThreadFollow(
      {
        rootId,
        channelId,
        following: muted ? false : (before?.following ?? false),
        lastReadSeq: before?.lastReadSeq ?? this.state.repliesRead[channelId] ?? 0,
        lastSeq: Math.max(before?.lastSeq ?? 0, this.threadTailSeq(rootId)),
        revision: (before?.revision ?? 0) + 1,
        ...(muted ? { muted: true as const } : {}),
      },
      () => this.api.setThreadMute(rootId, muted),
    );
  }

  async readChannelRemovals(ids: ID[]): Promise<ApiError | null> {
    const taken = ids
      .map((id) => this.state.channelRemovals[id])
      .filter((removal): removal is ChannelRemoval => !!removal);
    if (taken.length === 0) return null;
    for (const removal of taken) this.readingRemovals.add(removal.id);
    this.forgetRemovals(taken.map((removal) => removal.id));
    try {
      await this.api.readChannelRemovals(taken.map((removal) => removal.id));
      return null;
    } catch (error) {
      this.store.setState((s) => ({
        channelRemovals: {
          ...s.channelRemovals,
          ...Object.fromEntries(taken.map((removal) => [removal.id, removal])),
        },
      }));
      return failureOf(error);
    } finally {
      for (const removal of taken) this.readingRemovals.delete(removal.id);
    }
  }

  forgetRemovals(ids: ID[]): void {
    this.store.setState((s) => {
      if (!ids.some((id) => id in s.channelRemovals)) return {};
      const channelRemovals = { ...s.channelRemovals };
      for (const id of ids) delete channelRemovals[id];
      return { channelRemovals };
    });
  }

  markThreadRead(
    rootId: ID,
    opts: { explicit?: boolean; through?: Pick<Message, "channelId" | "seq"> } = {},
  ): void {
    if (opts.explicit) this.threadReadHold.delete(rootId);
    else if (this.threadReadHold.has(rootId)) return;
    const before = this.state.threadFollows[rootId];
    const channelId =
      before?.channelId ?? opts.through?.channelId ?? this.threadRoot(rootId)?.channelId;
    if (!channelId) return;
    const seq = opts.through?.seq ?? this.threadTailSeq(rootId);
    if (seq <= (before?.lastReadSeq ?? 0)) return;
    const next: ThreadFollow = {
      rootId,
      channelId,
      following: before?.following ?? false,
      lastReadSeq: seq,
      lastSeq: Math.max(before?.lastSeq ?? 0, seq),
      revision: (before?.revision ?? 0) + 1,
      ...(before?.muted ? { muted: true as const } : {}),
    };
    void this.writes.write(
      { kind: "threadRead", rootId },
      next,
      this.threadSpec<ThreadFollow>(rootId, {
        send: async (read) => (await this.api.markThreadRead(rootId, read.lastReadSeq)).state,
      }),
    );
  }

  private threadRoot(rootId: ID): Message | undefined {
    return threadRootMessage(this.state, rootId) ?? undefined;
  }

  /** The newest seq this client has loaded for a thread, root included. */
  private threadTailSeq(rootId: ID): number {
    const { messages, threads } = this.state;
    let seq = this.threadRoot(rootId)?.seq ?? 0;
    for (const id of threads[rootId] ?? []) seq = Math.max(seq, messages[id]?.seq ?? 0);
    return seq;
  }

  markRead(
    channelId: ID,
    seq = this.state.channelLastSeq[channelId] ?? 0,
    opts: { explicit?: boolean } = {},
  ): void {
    if (opts.explicit) this.readHold.delete(channelId);
    else if (this.readHold.has(channelId)) return;
    if (!(channelId in this.state.memberships) || !Number.isSafeInteger(seq) || seq < 0) return;
    const current = this.state.memberships[channelId] ?? 0;
    if (seq <= current) return;
    this.pendingReads.set(channelId, Math.max(this.pendingReads.get(channelId) ?? 0, seq));
    this.store.setState((s) => ({ memberships: { ...s.memberships, [channelId]: seq } }));
    this.flushReads();
  }

  markUnread(channelId: ID, seq: number): void {
    if (!(channelId in this.state.memberships) || !Number.isSafeInteger(seq) || seq < 1) return;
    this.readRequests.get(channelId)?.abort();
    this.readRequests.delete(channelId);
    this.pendingReads.delete(channelId);
    this.readHold.add(channelId);
    const cursor = this.state.memberships[channelId] ?? 0;
    // Marked again while the last mark is unanswered and still showing: the
    // server has neither yet, so both go back to where the first began.
    const earlier = this.unreadMarks.get(channelId);
    const mark = { seq, before: earlier && cursor === earlier.seq - 1 ? earlier.before : cursor };
    this.unreadMarks.set(channelId, mark);
    this.store.setState((s) => ({ memberships: { ...s.memberships, [channelId]: seq - 1 } }));
    void this.api.markUnread(channelId, seq).then(
      () => {
        const latest = this.unreadMarks.get(channelId);
        if (latest === mark) this.unreadMarks.delete(channelId);
        // The server has this one now, so a later one refused goes back to it.
        else if (latest) latest.before = seq - 1;
      },
      () => {
        // A later mark unread speaks for the cursor now, even one for this
        // same message, which leaves the cursor looking as this one left it
        // (Q10). So does a read since, which has moved it.
        if (this.unreadMarks.get(channelId) !== mark) return;
        this.unreadMarks.delete(channelId);
        if (this.state.memberships[channelId] !== seq - 1) return;
        this.readHold.delete(channelId);
        this.store.setState((s) => ({
          memberships: { ...s.memberships, [channelId]: mark.before },
        }));
      },
    );
  }

  markThreadUnread(rootId: ID, seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 1) return;
    const before = this.state.threadFollows[rootId];
    const channelId = before?.channelId ?? this.threadRoot(rootId)?.channelId;
    if (!channelId) return;
    this.threadReadHold.add(rootId);
    const channelRead = this.state.memberships[channelId];
    void this.writeThreadFollow(
      {
        rootId,
        channelId,
        following: true,
        lastReadSeq: seq - 1,
        lastSeq: Math.max(before?.lastSeq ?? 0, this.threadTailSeq(rootId)),
        revision: (before?.revision ?? 0) + 1,
        // As the server holds it: against the channel's cursor as it is now.
        ...(channelRead === undefined ? {} : { unreadHold: channelRead }),
      },
      () => this.api.markThreadUnread(rootId, seq),
    ).then((error) => {
      if (error) this.threadReadHold.delete(rootId);
    });
  }

  clearReadRequests(): void {
    for (const controller of this.readRequests.values()) controller.abort();
    this.readRequests.clear();
    this.pendingReads.clear();
    // Holds deliberately survive a resync: a reconnect long enough to discard
    // history must not quietly read what someone marked unread.
  }

  flushReads(): void {
    if (this.stopped || this.state.status !== "online") return;
    for (const [channelId, seq] of this.pendingReads) {
      if (!(channelId in this.state.memberships)) {
        this.pendingReads.delete(channelId);
        continue;
      }
      if (this.readRequests.has(channelId)) continue;
      const controller = new AbortController();
      this.readRequests.set(channelId, controller);
      void this.api
        .markRead(channelId, seq, controller.signal)
        .then((result) => {
          if (
            controller.signal.aborted ||
            this.stopped ||
            this.readRequests.get(channelId) !== controller
          )
            return;
          const acknowledged = result.seq;
          if ((this.pendingReads.get(channelId) ?? 0) <= acknowledged)
            this.pendingReads.delete(channelId);
          this.channelRead({ type: "channel.read", channelId, seq: acknowledged });
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          if (error instanceof ApiError && (error.status === 403 || error.status === 404))
            this.pendingReads.delete(channelId);
          // Network failures retain the largest pending cursor for reconnect or the retry timer.
        })
        .finally(() => {
          if (this.readRequests.get(channelId) === controller) this.readRequests.delete(channelId);
        });
    }
  }

  /** The server's word on how far this account has read a conversation. */
  channelRead(event: Extract<EphemeralEvent, { type: "channel.read" }>): void {
    const s = this.state;
    if (!(event.channelId in s.memberships)) return;
    // While a conversation is deliberately unread, an acknowledgement still
    // in flight when it was marked must not raise the cursor back.
    if (this.readHold.has(event.channelId)) return;
    const pending = this.pendingReads.get(event.channelId) ?? 0;
    if (pending <= event.seq) this.pendingReads.delete(event.channelId);
    this.store.setState({
      memberships: {
        ...s.memberships,
        [event.channelId]: Math.max(s.memberships[event.channelId] ?? 0, event.seq),
      },
    });
  }

  /** A conversation marked unread, here or on another of this account's devices. */
  channelUnread(event: Extract<EphemeralEvent, { type: "channel.unread" }>): void {
    const s = this.state;
    this.pendingReads.delete(event.channelId);
    this.store.setState({
      memberships: { ...s.memberships, [event.channelId]: event.seq },
    });
  }

  /**
   * A conversation's cursor as a new snapshot has it, or further where a read
   * of this device's is still on its way.
   */
  readyCursor(m: ReadySnapshot["memberships"][number], snap: ReadySnapshot): number {
    const pending = this.pendingReads.get(m.channelId) ?? 0;
    if (pending <= m.lastReadSeq || pending > snap.seq) this.pendingReads.delete(m.channelId);
    return Math.max(m.lastReadSeq, this.pendingReads.get(m.channelId) ?? 0);
  }

  /** Whether this device is telling the server it read a removal note. */
  isReading(removalId: ID): boolean {
    return this.readingRemovals.has(removalId);
  }

  /** Sends reads that did not reach the server again, every five seconds, until `stop`. */
  start(): void {
    this.readRetryTimer ??= setInterval(() => this.flushReads(), 5000);
  }

  stop(): void {
    if (this.readRetryTimer) clearInterval(this.readRetryTimer);
    this.readRetryTimer = null;
  }

  /** Lets go of reads for a conversation this account can no longer see. */
  forgetChannel(channelId: ID): void {
    this.pendingReads.delete(channelId);
    this.readRequests.get(channelId)?.abort();
    this.readRequests.delete(channelId);
  }

  /** Leaving a conversation lifts its hold, so coming back reads it. */
  focusConversation(channelId: ID | null): void {
    for (const held of this.readHold) if (held !== channelId) this.readHold.delete(held);
  }

  focusThread(rootId: ID | null): void {
    for (const held of this.threadReadHold) if (held !== rootId) this.threadReadHold.delete(held);
  }
}
