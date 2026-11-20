import type { Channel, EventEnvelope, ID, Message } from "@ownbase/protocol";
import type { StoreApi } from "zustand/vanilla";
import { failureOf } from "./answers.js";
import { ApiError, type Api } from "./api.js";
import {
  THREAD_WINDOW,
  forgetAllUnlisted,
  forgetUnlisted,
  isMessageEvent,
  keepMessages,
  messageEventChannel,
  reduceMessages,
  stampMessages,
  windowTimeline,
  type ChannelTimeline,
  type MessageCache,
  type MessageEvent,
} from "./messageCache.js";
import type { OptimisticWrites } from "./optimisticWrites.js";
import type { HistoryWindow, TimelineStatus, WorkspaceState } from "./workspaceState.js";

const HISTORY_EVENTS_LIMIT = 2000;
const HISTORY_CACHE_LIMIT = 20;
const PAGE_SIZE = 50;

/**
 * A timeline as it was when a page joining it was asked for, so the page can
 * still join it if live arrivals trimmed it meanwhile.
 */
interface CapturedTimeline {
  timeline: ChannelTimeline;
  messages: Message[];
  seqs: Record<ID, number>;
}

interface TimelineLoad {
  ticket: object;
  startSeq: number;
  /** Events in its conversation while it is out, replayed onto what it brings. */
  events: EventEnvelope[];
  seen: Set<number>;
  overflow: boolean;
  /**
   * Stops its transfer once nothing will use the answer (REV-05): a newer
   * window for the conversation, eviction, revocation, a reset or destroy.
   */
  controller: AbortController;
  /** Which window it reads, so an identical request can share it. */
  key: string;
  /** The load in flight for `key`, which an identical request joins. */
  shared?: Promise<void>;
}

/** A thread page in flight, with what it needs to be joined or stopped (REV-05). */
interface ThreadLoad {
  events: EventEnvelope[];
  overflow: boolean;
  controller: AbortController;
  key: string;
  shared?: Promise<void>;
}

const stoppedOnPurpose = (controller: AbortController) => controller.signal.aborted;

/**
 * Loads conversations' and threads' history into the store a page at a time,
 * replaying what happens meanwhile onto each page, and lets go of the least
 * recently seen past `HISTORY_CACHE_LIMIT`.
 */
export class HistoryLoader {
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

  private historyEpoch = 0;
  private reloadChannels = new Set<ID>();
  private reloadThreads = new Map<ID, ID>();
  private threadLoads = new Map<ID, ThreadLoad>();
  private messageJump = 0;
  private timelineRequests = new Map<ID, object>();
  /** Events held until their history page's snapshot sequence decides which to replay. */
  private timelineHolds = new Map<ID, TimelineLoad>();
  private timelineRecency = new Map<ID, true>();
  private threadRecency = new Map<ID, true>();
  private activeConversation: ID | null = null;
  private activeThread: ID | null = null;

  private abortHistoryLoads(): void {
    for (const hold of this.timelineHolds.values()) hold.controller.abort();
    for (const load of this.threadLoads.values()) load.controller.abort();
  }

  /** Keeps an event for each history page in flight that it may change. */
  holdForLoads(envelope: EventEnvelope & { event: MessageEvent }): void {
    const channelId = messageEventChannel(envelope.event);
    const hold = this.timelineHolds.get(channelId);
    if (hold && !hold.seen.has(envelope.seq)) {
      if (hold.events.length < HISTORY_EVENTS_LIMIT) {
        hold.events.push(envelope);
        hold.seen.add(envelope.seq);
      } else hold.overflow = true;
    }
    for (const [rootId, load] of this.threadLoads) {
      if (this.state.threadPages[rootId]?.channelId !== channelId) continue;
      if (load.events.length < HISTORY_EVENTS_LIMIT) load.events.push(envelope);
      else load.overflow = true;
    }
  }

  private touchHistory(kind: "timeline" | "thread", id: ID): void {
    const recency = kind === "timeline" ? this.timelineRecency : this.threadRecency;
    recency.delete(id);
    recency.set(id, true);
    const state = this.state;
    const victims = (ids: ID[], order: Map<ID, true>, protectedIds: (ID | null)[]) => {
      const present = new Set(ids);
      for (const key of order.keys())
        if (!present.has(key) && !protectedIds.includes(key)) order.delete(key);
      const candidates = [...ids.filter((key) => !order.has(key)), ...order.keys()].filter(
        (key) => ids.includes(key) && !protectedIds.includes(key),
      );
      return candidates.slice(0, Math.max(0, ids.length - HISTORY_CACHE_LIMIT));
    };
    const timelineVictims = victims(Object.keys(state.timelines), this.timelineRecency, [
      this.activeConversation,
      kind === "timeline" ? id : null,
    ]);
    const threadVictims = victims(
      [...new Set([...Object.keys(state.threads), ...Object.keys(state.threadPages)])],
      this.threadRecency,
      [this.activeThread, kind === "thread" ? id : null],
    );
    if (!timelineVictims.length && !threadVictims.length) return;
    const timelines = { ...state.timelines };
    const threads = { ...state.threads };
    const threadPages = { ...state.threadPages };
    for (const victim of timelineVictims) {
      delete timelines[victim];
      this.timelineRecency.delete(victim);
      this.timelineRequests.delete(victim);
      this.timelineHolds.get(victim)?.controller.abort();
      this.timelineHolds.delete(victim);
      this.reloadChannels.delete(victim);
    }
    for (const victim of threadVictims) {
      delete threads[victim];
      delete threadPages[victim];
      this.threadRecency.delete(victim);
      this.threadLoads.get(victim)?.controller.abort();
      this.threadLoads.delete(victim);
      this.reloadThreads.delete(victim);
    }
    const timelineStatus = { ...state.timelineStatus };
    for (const victim of timelineVictims) delete timelineStatus[victim];
    // Drafts, pending sends and retained attachment previews are independent of history.
    this.store.setState({
      ...forgetAllUnlisted({ ...state, timelines, threads, threadPages }),
      timelineStatus,
    });
  }

  /**
   * Each conversation accepts only its most recently requested history window,
   * so the window it replaces stops its transfer too (REV-05).
   */
  private beginTimelineRequest(channelId: ID, key: string): TimelineLoad {
    this.timelineHolds.get(channelId)?.controller.abort();
    const ticket: TimelineLoad = {
      ticket: {},
      startSeq: this.state.lastSeq,
      events: [],
      seen: new Set(),
      overflow: false,
      controller: new AbortController(),
      key,
    };
    this.timelineRequests.set(channelId, ticket.ticket);
    this.timelineHolds.set(channelId, ticket);
    return ticket;
  }

  private releaseTimelineRequest(channelId: ID, ticket: TimelineLoad): void {
    if (this.timelineHolds.get(channelId) === ticket) this.timelineHolds.delete(channelId);
  }

  private timelineEvents(ticket: TimelineLoad, snapshotSeq: number | undefined): EventEnvelope[] {
    if (ticket.overflow || (snapshotSeq === undefined && ticket.events.length))
      throw new ApiError(409, "history_changed", "Conversation changed while loading. Try again.");
    return ticket.events
      .filter((event) => event.seq > (snapshotSeq ?? 0))
      .sort((a, b) => a.seq - b.seq);
  }

  private stillWanted(channelId: ID, epoch: number, ticket: TimelineLoad): boolean {
    return (
      !this.stopped &&
      epoch === this.historyEpoch &&
      this.timelineRequests.get(channelId) === ticket.ticket &&
      !!this.state.channels[channelId]
    );
  }

  private captureTimeline(channelId: ID): CapturedTimeline | null {
    const state = this.state;
    const timeline = state.timelines[channelId];
    if (!timeline) return null;
    const messages = timeline.ids.flatMap((id) => state.messages[id] ?? []);
    const seqs = Object.fromEntries(timeline.ids.map((id) => [id, state.messageSeqs[id] ?? 0]));
    return { timeline, messages, seqs };
  }

  /**
   * Puts a page of a channel's history read at `page.seq` in place as its
   * timeline, alone or joined to the window it continues, and replays onto
   * it what happened in the channel since.
   */
  private landTimeline(
    channelId: ID,
    ticket: TimelineLoad,
    page: { messages: Message[]; seq: number },
    shape: Pick<ChannelTimeline, "hasMore" | "hasMoreNewer" | "readThroughSeq" | "snapshotSeq">,
    join: { side: "before" | "after"; captured: CapturedTimeline } | null,
    drop: "oldest" | "newest",
  ): void {
    const replayed = this.timelineEvents(ticket, page.seq);
    if (join) {
      const since = Math.min(page.seq, ticket.startSeq);
      replayed.splice(0, replayed.length, ...this.timelineEvents(ticket, since));
    }
    this.store.setState((s) => {
      let cache: MessageCache = s;
      const before = s.timelines[channelId]?.ids ?? [];
      let ids = page.messages.map((m) => m.id);
      if (join) {
        const { captured, side } = join;
        // What live arrivals trimmed while this was out is still the bridge to it.
        const lost = captured.messages.filter((m) => !(m.id in cache.messages));
        for (const m of lost) cache = keepMessages(cache, [m], captured.seqs[m.id]);
        ids = [
          ...new Set(
            side === "before"
              ? [...ids, ...captured.timeline.ids]
              : [...captured.timeline.ids, ...ids],
          ),
        ];
      }
      cache = keepMessages(cache, page.messages, page.seq);
      cache = {
        ...cache,
        timelines: { ...cache.timelines, [channelId]: { ...shape, ids, loaded: true } },
      };
      for (const envelope of replayed) {
        const { event } = envelope;
        if (isMessageEvent(event))
          cache = reduceMessages(cache, { ...envelope, event }, envelope.seq <= s.lastSeq);
      }
      const landed = cache.timelines[channelId]!;
      cache = stampMessages(cache, landed.ids, s.lastSeq);
      cache = {
        ...cache,
        timelines: {
          ...cache.timelines,
          [channelId]: { ...landed, snapshotSeq: Math.max(landed.snapshotSeq ?? 0, s.lastSeq) },
        },
      };
      cache = windowTimeline(cache, channelId, drop);
      return forgetUnlisted(cache, before);
    });
    // A pin chosen here and not yet answered stays as chosen over what the page says.
    this.writes.reshow();
    this.touchHistory("timeline", channelId);
  }

  loadTimeline(
    channelId: ID,
    opts: { older?: boolean; latest?: boolean; unreadAfter?: number } = {},
  ): Promise<void> {
    const epoch = this.historyEpoch;
    const tl = this.state.timelines[channelId];
    if (tl?.loaded) this.touchHistory("timeline", channelId);
    if (tl?.loaded && !opts.older && !opts.latest) {
      // Opening it again forgets a page that failed earlier.
      const status = this.state.timelineStatus[channelId];
      if (status?.error && !status.loading) this.setTimelineStatus(channelId, null);
      return Promise.resolve();
    }
    if (opts.older && (!tl?.hasMore || tl.ids.length === 0)) return Promise.resolve();
    const before = opts.older ? tl!.ids[0]! : undefined;
    // The same window already on its way: wait for it rather than ask twice.
    const key = before ? `older:${before}` : "tail";
    const running = this.timelineHolds.get(channelId);
    if (running?.key === key && running.shared) return running.shared;
    const captured = opts.older ? this.captureTimeline(channelId) : null;
    const ticket = this.beginTimelineRequest(channelId, key);
    ticket.shared = this.trackTimeline(
      channelId,
      opts.older ? "older" : opts.latest ? "latest" : "initial",
      ticket,
      this.fetchTimeline(channelId, opts, captured, epoch, ticket, before),
    );
    return ticket.shared;
  }

  /**
   * Notes `load` in `timelineStatus` while it is the conversation's newest
   * request; one stopped for another, or by a reset, says nothing.
   */
  private async trackTimeline(
    channelId: ID,
    window: HistoryWindow,
    ticket: TimelineLoad,
    load: Promise<void>,
  ): Promise<void> {
    this.setTimelineStatus(channelId, { loading: window, error: null });
    const failed = await load.then(
      () => false,
      () => true,
    );
    if (this.stopped || this.timelineRequests.get(channelId) !== ticket.ticket) return;
    this.setTimelineStatus(channelId, failed ? { loading: null, error: window } : null);
  }

  private setTimelineStatus(channelId: ID, status: TimelineStatus | null): void {
    this.store.setState((s) => {
      const timelineStatus = { ...s.timelineStatus };
      if (status) timelineStatus[channelId] = status;
      else delete timelineStatus[channelId];
      return { timelineStatus };
    });
  }

  private async fetchTimeline(
    channelId: ID,
    opts: { older?: boolean; latest?: boolean; unreadAfter?: number },
    captured: CapturedTimeline | null,
    epoch: number,
    ticket: TimelineLoad,
    before: ID | undefined,
  ): Promise<void> {
    let answer: Awaited<ReturnType<Api["listMessages"]>>;
    let since: Awaited<ReturnType<Api["listMessagesSince"]>> | null = null;
    try {
      answer = await this.api.listMessages(channelId, {
        before,
        limit: PAGE_SIZE,
        signal: ticket.controller.signal,
      });
      const oldest = answer.messages.at(-1);
      const missed = opts.unreadAfter;
      if (
        !opts.older &&
        !opts.latest &&
        missed !== undefined &&
        missed > 0 &&
        answer.messages.length === PAGE_SIZE &&
        oldest &&
        oldest.seq > missed
      ) {
        // Still held, so what happens meanwhile is replayed into whichever
        // window is kept. A failure keeps the newest.
        since = await this.api
          .listMessagesSince(channelId, missed, PAGE_SIZE, ticket.controller.signal)
          .catch((error: unknown) => {
            if (stoppedOnPurpose(ticket.controller)) throw error;
            return null;
          });
      }
    } catch (error) {
      if (stoppedOnPurpose(ticket.controller)) return;
      throw error;
    } finally {
      this.releaseTimelineRequest(channelId, ticket);
    }
    if (!this.stillWanted(channelId, epoch, ticket)) return;
    if (since) {
      this.landTimeline(
        channelId,
        ticket,
        { messages: [...since.messages].reverse(), seq: since.seq },
        { hasMore: since.hasMoreOlder, hasMoreNewer: since.hasMoreNewer, snapshotSeq: since.seq },
        null,
        "oldest",
      );
      return;
    }
    // Newest first.
    const { messages, readThroughSeq, seq } = answer;
    const hasMore = messages.length === PAGE_SIZE;
    const page = { messages: [...messages].reverse(), seq };
    if (opts.older && captured) {
      const { timeline } = captured;
      this.landTimeline(
        channelId,
        ticket,
        page,
        {
          hasMore,
          hasMoreNewer: timeline.hasMoreNewer,
          readThroughSeq: timeline.readThroughSeq,
          snapshotSeq: timeline.snapshotSeq,
        },
        { side: "before", captured },
        // Paging up drops the far end, which is now hundreds of messages
        // below the viewport, not the history being read.
        "newest",
      );
      return;
    }
    this.landTimeline(
      channelId,
      ticket,
      page,
      {
        hasMore,
        hasMoreNewer: false,
        readThroughSeq,
        snapshotSeq: seq,
      },
      null,
      "oldest",
    );
  }

  async jumpToMessage(channelId: ID, messageId: ID): Promise<ID | null | undefined | ApiError> {
    const ticket = ++this.messageJump;
    const epoch = this.historyEpoch;
    const existing = this.state.timelines[channelId];
    if (existing) this.touchHistory("timeline", channelId);
    // A message already on screen needs no request and must not cancel paging.
    if (existing?.loaded && !existing.hasMoreNewer && existing.ids.includes(messageId)) return null;
    const timelineTicket = this.beginTimelineRequest(channelId, `around:${messageId}`);
    try {
      const answer = await this.api.listMessagesAround(
        channelId,
        messageId,
        PAGE_SIZE,
        timelineTicket.controller.signal,
      );
      this.releaseTimelineRequest(channelId, timelineTicket);
      const { messages, hasMoreOlder, hasMoreNewer, threadRootId, seq } = answer;
      if (ticket !== this.messageJump || !this.stillWanted(channelId, epoch, timelineTicket))
        return undefined;
      this.landTimeline(
        channelId,
        timelineTicket,
        { messages: [...messages].reverse(), seq },
        { hasMore: hasMoreOlder, hasMoreNewer, snapshotSeq: seq },
        null,
        "oldest",
      );
      return threadRootId ?? null;
    } catch (error) {
      this.releaseTimelineRequest(channelId, timelineTicket);
      if (stoppedOnPurpose(timelineTicket.controller)) return undefined;
      return failureOf(error);
    }
  }

  cancelMessageJump(): void {
    this.messageJump++;
  }

  loadNewer(channelId: ID): Promise<void> {
    const epoch = this.historyEpoch;
    const tl = this.state.timelines[channelId];
    if (!tl?.loaded || !tl.hasMoreNewer || tl.ids.length === 0) return Promise.resolve();
    const newest = tl.ids.at(-1)!;
    // The same page already on its way: wait for it rather than ask twice
    // (F14). A different window replaces it, as before.
    const key = `newer:${newest}`;
    const running = this.timelineHolds.get(channelId);
    if (running?.key === key && running.shared) return running.shared;
    const captured = this.captureTimeline(channelId)!;
    const ticket = this.beginTimelineRequest(channelId, key);
    ticket.shared = this.trackTimeline(
      channelId,
      "newer",
      ticket,
      this.fetchNewer(channelId, captured, newest, epoch, ticket),
    );
    return ticket.shared;
  }

  private async fetchNewer(
    channelId: ID,
    captured: CapturedTimeline,
    newest: ID,
    epoch: number,
    ticket: TimelineLoad,
  ): Promise<void> {
    let answer: Awaited<ReturnType<Api["listMessagesAfter"]>>;
    try {
      answer = await this.api.listMessagesAfter(
        channelId,
        newest,
        PAGE_SIZE,
        ticket.controller.signal,
      );
    } catch (error) {
      if (stoppedOnPurpose(ticket.controller)) return;
      throw error;
    } finally {
      this.releaseTimelineRequest(channelId, ticket);
    }
    if (!this.stillWanted(channelId, epoch, ticket)) return;
    const { messages, seq } = answer;
    const page = [...messages].reverse();
    const reachedTail = messages.length < PAGE_SIZE;
    const { timeline } = captured;
    this.landTimeline(
      channelId,
      ticket,
      { messages: page, seq },
      {
        hasMore: timeline.hasMore,
        hasMoreNewer: !reachedTail,
        snapshotSeq: reachedTail ? seq : timeline.snapshotSeq,
        readThroughSeq: Math.max(timeline.readThroughSeq ?? 0, page.at(-1)?.seq ?? 0),
      },
      { side: "after", captured },
      "oldest",
    );
  }

  jumpToLatest(channelId: ID): Promise<void> {
    this.cancelMessageJump();
    return this.loadTimeline(channelId, { latest: true });
  }

  async loadThread(
    threadRootId: ID,
    channelId: ID,
    direction: "latest" | "older" | "newer" = "latest",
    around?: ID,
  ): Promise<void> {
    const previous = this.state.threadPages[threadRootId];
    const ids = this.state.threads[threadRootId] ?? [];
    if (
      direction !== "latest" &&
      (previous?.loading ||
        !ids.length ||
        (direction === "older" ? !previous?.hasMoreOlder : !previous?.hasMoreNewer))
    )
      return;
    const from = direction === "older" ? ids[0]! : direction === "newer" ? ids.at(-1)! : undefined;
    // The same page already on its way: wait for it rather than ask twice.
    // A different one replaces it, so its transfer stops (REV-05).
    const key = `${direction}:${from ?? around ?? ""}`;
    const running = this.threadLoads.get(threadRootId);
    if (running?.key === key && running.shared) return running.shared;
    running?.controller.abort();
    const request: ThreadLoad = {
      events: [],
      overflow: false,
      controller: new AbortController(),
      key,
    };
    this.threadLoads.set(threadRootId, request);
    request.shared = this.fetchThread(threadRootId, channelId, direction, from, around, request);
    return request.shared;
  }

  private async fetchThread(
    threadRootId: ID,
    channelId: ID,
    direction: "latest" | "older" | "newer",
    from: ID | undefined,
    around: ID | undefined,
    request: ThreadLoad,
  ): Promise<void> {
    const epoch = this.historyEpoch;
    this.store.setState((s) => {
      const previous = s.threadPages[threadRootId];
      return {
        threads: { ...s.threads, [threadRootId]: s.threads[threadRootId] ?? [] },
        threadPages: {
          ...s.threadPages,
          [threadRootId]: {
            channelId,
            rootGone: previous?.rootGone ?? false,
            hasMoreOlder: previous?.hasMoreOlder ?? false,
            hasMoreNewer: previous?.hasMoreNewer ?? false,
            loaded: previous?.loaded ?? false,
            loading: true,
            error: null,
          },
        },
      };
    });
    const current = () =>
      !this.stopped &&
      epoch === this.historyEpoch &&
      !!this.state.channels[channelId] &&
      this.threadLoads.get(threadRootId) === request;
    this.touchHistory("thread", threadRootId);
    try {
      const response = await this.api.threadHistory(channelId, threadRootId, {
        ...(direction === "older"
          ? { before: from }
          : direction === "newer"
            ? { after: from }
            : around
              ? { around }
              : {}),
        limit: PAGE_SIZE,
        signal: request.controller.signal,
      });
      if (!current()) return;
      if (request.overflow) throw new Error("Thread changed too quickly to reconcile this page");
      this.store.setState((s) => {
        const previous = s.threadPages[threadRootId]!;
        const before = s.threads[threadRootId] ?? [];
        let cache: MessageCache = keepMessages(
          s,
          [response.root, ...response.messages],
          response.seq,
        );
        let ids = response.messages.map((m) => m.id);
        if (direction !== "latest") ids = [...new Set([...ids, ...before])].sort();
        let hasMoreOlder = direction === "newer" ? previous.hasMoreOlder : response.hasMoreOlder;
        let hasMoreNewer = direction === "older" ? previous.hasMoreNewer : response.hasMoreNewer;
        if (ids.length > THREAD_WINDOW) {
          if (direction === "older") {
            ids = ids.slice(0, THREAD_WINDOW);
            hasMoreNewer = true;
          } else {
            ids = ids.slice(-THREAD_WINDOW);
            hasMoreOlder = true;
          }
        }
        cache = {
          ...cache,
          threads: { ...cache.threads, [threadRootId]: ids },
          threadPages: {
            ...cache.threadPages,
            [threadRootId]: {
              channelId,
              rootGone: false,
              hasMoreOlder,
              hasMoreNewer,
              loading: false,
              loaded: true,
              error: null,
            },
          },
        };
        for (const envelope of request.events) {
          const { event } = envelope;
          if (envelope.seq > response.seq && isMessageEvent(event))
            cache = reduceMessages(cache, { ...envelope, event }, envelope.seq <= s.lastSeq);
        }
        return forgetUnlisted(cache, before);
      });
      this.writes.reshow();
    } catch (error) {
      if (!current()) return;
      // The reply to open at is gone, not the thread: its newest replies instead.
      if (around && error instanceof ApiError && error.code === "message_not_found")
        return this.loadThread(threadRootId, channelId, "latest");
      const gone = error instanceof ApiError && error.status === 404;
      this.store.setState((s) => ({
        threadPages: {
          ...s.threadPages,
          [threadRootId]: {
            ...s.threadPages[threadRootId]!,
            loading: false,
            ...(gone ? { rootGone: true, loaded: true } : {}),
            error: gone
              ? "This thread is no longer available."
              : "Could not load replies. Try again.",
          },
        },
      }));
    } finally {
      if (this.threadLoads.get(threadRootId) === request) this.threadLoads.delete(threadRootId);
    }
  }

  /** Nothing still loading lands: the client is closing. */
  stop(): void {
    this.historyEpoch++;
    this.abortHistoryLoads();
    this.timelineRequests.clear();
    this.timelineHolds.clear();
    this.threadLoads.clear();
  }

  /** Loads again what was held before a reset, where its conversation is still there. */
  reloadAfterReady(channels: Record<ID, Channel>): void {
    for (const id of [...this.reloadChannels]) {
      this.reloadChannels.delete(id);
      if (channels[id]) void this.loadTimeline(id);
    }
    for (const [rootId, channelId] of [...this.reloadThreads]) {
      this.reloadThreads.delete(rootId);
      if (channels[channelId]) void this.loadThread(rootId, channelId);
    }
  }

  /**
   * Stops every load and notes what was held, to load again once the new
   * snapshot says which conversations are still there.
   */
  reset(): void {
    this.historyEpoch++;
    this.abortHistoryLoads();
    for (const id of this.timelineHolds.keys()) this.reloadChannels.add(id);
    this.timelineRequests.clear();
    this.timelineHolds.clear();
    this.timelineRecency.clear();
    this.threadRecency.clear();
    const state = this.state;
    for (const [id, timeline] of Object.entries(state.timelines)) {
      if (timeline.loaded) this.reloadChannels.add(id);
    }
    for (const [rootId, replies] of Object.entries(state.threads)) {
      const channelId =
        state.threadPages[rootId]?.channelId ??
        state.messages[rootId]?.channelId ??
        state.messages[replies[0] ?? ""]?.channelId;
      if (channelId) this.reloadThreads.set(rootId, channelId);
    }
    this.threadLoads.clear();
  }

  /** Stops loading a conversation this account can no longer see. */
  forgetTimeline(channelId: ID): void {
    this.timelineRequests.delete(channelId);
    this.timelineHolds.get(channelId)?.controller.abort();
    this.timelineHolds.delete(channelId);
    this.timelineRecency.delete(channelId);
  }

  forgetThreads(roots: Set<ID>): void {
    for (const id of roots) {
      this.threadLoads.get(id)?.controller.abort();
      this.threadLoads.delete(id);
      this.threadRecency.delete(id);
    }
  }

  /** A thread retention took: nothing loads it, now or after a reset. */
  forgetThread(rootId: ID): void {
    this.threadLoads.delete(rootId);
    this.reloadThreads.delete(rootId);
  }

  focusConversation(channelId: ID | null): void {
    this.activeConversation = channelId;
    if (channelId) this.touchHistory("timeline", channelId);
  }

  focusThread(rootId: ID | null): void {
    this.activeThread = rootId;
    if (rootId) this.touchHistory("thread", rootId);
  }
}
