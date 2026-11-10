import type {
  EditScheduledBody,
  FileKind,
  ID,
  Message,
  ScheduledMessage,
  SharedFile,
} from "@ownbase/protocol";
import type { StoreApi } from "zustand/vanilla";
import { answerOf, doneOf } from "./answers.js";
import type { Api, ApiError } from "./api.js";
import { timelineMessages } from "./messageCache.js";
import { PagedList } from "./pagedList.js";
import type { WorkspaceState } from "./workspace.js";

/** How long a sign that Activity may be out of date waits for others like it (REV-05). */
const ACTIVITY_REFRESH_DELAY_MS = 250;

/** What Activity's tabs ask the server for. */
export type ActivityAsk = "unread" | "mentions" | "threads";

/** A shared file, known by its own id as a paged list needs. */
export type SharedFileRow = SharedFile & { id: string };

export interface FileFilter {
  kind?: FileKind;
  userId?: ID;
  channelId?: ID;
  q?: string;
}

/** A followed thread's newest reply and how many replies are unread. */
export interface ThreadDetail {
  unreadCount: number;
  latestReply: Message | null;
}

type Store = StoreApi<WorkspaceState>;

/** Refreshes `list` each time `changed` says a change of the store may have made it out of date. */
function refreshWhen<T extends { id: string }>(
  store: Store,
  changed: (now: WorkspaceState, before: WorkspaceState, list: PagedList<T>) => boolean,
) {
  return (list: PagedList<T>) =>
    store.subscribe((now, before) => {
      if (changed(now, before, list)) list.refresh();
    });
}

/** A key of the store whose value changed for a conversation one of the listed rows is in. */
function changedFor(key: "changedContent" | "removedHistory") {
  return (
    now: WorkspaceState,
    before: WorkspaceState,
    list: { current: { items: readonly { channelId: ID }[] | null } },
  ) =>
    now[key] !== before[key] &&
    (list.current.items?.some((row) => now[key][row.channelId] !== before[key][row.channelId]) ??
      false);
}

/** A list a selector reads from the store: a change of what it reads is a reason to read again. */
function changedSignature(select: (s: WorkspaceState) => string) {
  return (now: WorkspaceState, before: WorkspaceState) => select(now) !== select(before);
}

/** The pinned messages of a channel among those loaded here. */
const pinnedLoaded = (channelId: ID) => (s: WorkspaceState) =>
  timelineMessages(s, channelId)
    .filter((m) => m.pinned)
    .map((m) => m.id)
    .join(",");

const savedIds = (s: WorkspaceState) => Object.keys(s.saved).sort().join(",");

/** Following, unfollowing, reading and a new reply all change a followed thread's row. */
const followedThreads = (s: WorkspaceState) =>
  Object.values(s.threadFollows)
    .filter((f) => f.following)
    .map((f) => `${f.rootId}:${f.lastReadSeq}:${f.lastSeq}`)
    .sort()
    .join(",");

/**
 * What arrived where Activity looks: in Unread, a new message in any
 * conversation joined or a new reply in a followed thread; in Threads, only
 * the reply.
 */
const activityArrivals = (ask: ActivityAsk) => (s: WorkspaceState) =>
  ask === "mentions"
    ? ""
    : [
        ...(ask === "unread"
          ? Object.entries(s.channelLastSeq)
              .filter(([channelId]) => channelId in s.memberships)
              .map(([channelId, seq]) => `${channelId}:${seq}`)
          : []),
        ...Object.values(s.threadFollows).map((f) => `${f.rootId}:${f.lastSeq}`),
      ]
        .sort()
        .join(",");

/**
 * The lists beside the conversations: saved and pinned messages, followed
 * threads, shared files, Activity and the scheduled queue. Each reads itself
 * a page at a time while open and reads itself again when an event says what
 * it shows may have changed (UX-08), so whoever shows one only opens it.
 */
export class Lists {
  constructor(
    private readonly api: Api,
    private readonly store: Store,
  ) {}

  /** This account's saved messages, across every conversation it can read. */
  saved(): PagedList<Message> {
    return new PagedList<Message>(
      async (cursor, signal) => {
        const page = await this.api.listSaved(cursor, signal);
        return { items: page.messages, nextCursor: page.nextCursor ?? null };
      },
      {
        watch: refreshWhen(
          this.store,
          (now, before, list) =>
            changedSignature(savedIds)(now, before) ||
            changedFor("changedContent")(now, before, list),
        ),
      },
    );
  }

  /**
   * A channel's pinned messages. One older than the history loaded here is
   * not in that history, so its edit, deletion or unpinning by someone else
   * is heard through `changedContent` (Q08).
   */
  pins(channelId: ID): PagedList<Message> {
    const pinned = changedSignature(pinnedLoaded(channelId));
    return new PagedList<Message>(
      async (cursor, signal) => {
        const page = await this.api.listPins(channelId, signal, cursor);
        return { items: page.messages, nextCursor: page.nextCursor ?? null };
      },
      {
        watch: refreshWhen(
          this.store,
          (now, before, list) =>
            pinned(now, before) ||
            now.changedContent[channelId] !== before.changedContent[channelId] ||
            changedFor("changedContent")(now, before, list),
        ),
      },
    );
  }

  /** How many messages a channel has pinned and the newest of them, for its header. */
  pinSummary(channelId: ID, signal?: AbortSignal) {
    return answerOf(async () => {
      const page = await this.api.listPins(channelId, signal, undefined, 1);
      return { total: page.total, newest: page.messages[0] };
    });
  }

  /**
   * Threads this account follows, most recently active first, each as its
   * first message; `detail` has what the server said of each beside it.
   */
  followedThreads(unreadOnly: boolean): PagedList<Message> & {
    detail: (rootId: ID) => ThreadDetail | undefined;
  } {
    const details = new Map<ID, ThreadDetail>();
    const list = new PagedList<Message>(
      async (cursor, signal) => {
        const page = await this.api.listFollowedThreads({ cursor, unreadOnly }, signal);
        if (!signal.aborted)
          for (const t of page.threads)
            details.set(t.root.id, { unreadCount: t.unreadCount, latestReply: t.latestReply });
        return { items: page.threads.map((t) => t.root), nextCursor: page.nextCursor ?? null };
      },
      {
        watch: refreshWhen(
          this.store,
          (now, before, list) =>
            changedSignature(followedThreads)(now, before) ||
            changedFor("changedContent")(now, before, list),
        ),
      },
    );
    return Object.assign(list, { detail: (rootId: ID) => details.get(rootId) });
  }

  /** Files shared in the conversations this account can read (E7), newest first. */
  files(filter: FileFilter): PagedList<SharedFileRow> {
    return new PagedList<SharedFileRow>(
      async (cursor, signal) => {
        const page = await this.api.listSharedFiles(filter, cursor, signal);
        return {
          items: page.files.map((f) => ({ ...f, id: f.file.id })),
          nextCursor: page.nextCursor,
        };
      },
      { watch: refreshWhen<SharedFileRow>(this.store, changedFor("changedContent")) },
    );
  }

  /**
   * One of Activity's lists. The server refreshes the mention counts for
   * mention edits even when a count stays the same, so every change of them
   * is a reason to look again.
   */
  activity(ask: ActivityAsk): PagedList<Message> {
    const arrived = changedSignature(activityArrivals(ask));
    return new PagedList<Message>(
      async (cursor, signal) => {
        const page = await this.api.activity(ask, { cursor, signal });
        return { items: page.messages, nextCursor: page.nextCursor };
      },
      {
        delayMs: ACTIVITY_REFRESH_DELAY_MS,
        watch: refreshWhen(
          this.store,
          (now, before, list) =>
            now.mentionCounts !== before.mentionCounts ||
            arrived(now, before) ||
            changedFor("changedContent")(now, before, list) ||
            changedFor("removedHistory")(now, before, list),
        ),
      },
    );
  }

  /** Messages queued to go out later, soonest first. */
  scheduled(): ScheduledList {
    return new ScheduledList(this.api, this.store);
  }
}

export interface ScheduledListState {
  /** Null until first read. */
  items: ScheduledMessage[] | null;
  loading: boolean;
  /** The last read failed; what was shown stays. */
  failed: boolean;
}

/**
 * The scheduled queue, read again whenever the server says it changed. A
 * change made here takes the place of any read in flight, and no read starts
 * until it is answered, so the list never shows the queue from before it.
 */
export class ScheduledList {
  private state: ScheduledListState = { items: null, loading: false, failed: false };
  private readonly listeners = new Set<(state: ScheduledListState) => void>();
  private request: AbortController | null = null;
  private changing = false;

  constructor(
    private readonly api: Api,
    private readonly store: Store,
  ) {}

  get current(): ScheduledListState {
    return this.state;
  }

  subscribe = (listener: (state: ScheduledListState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Reads the queue and keeps it current until the function given back is called. */
  open(): () => void {
    void this.reload();
    const unwatch = this.store.subscribe((now, before) => {
      if (now.scheduledChanges !== before.scheduledChanges) void this.reload();
    });
    return () => {
      unwatch();
      this.request?.abort();
      this.request = null;
    };
  }

  async reload(): Promise<void> {
    if (this.changing) return;
    this.request?.abort();
    const controller = new AbortController();
    this.request = controller;
    this.set({ loading: true, failed: false });
    try {
      const { scheduled } = await this.api.listScheduled(controller.signal);
      if (!controller.signal.aborted) this.set({ items: scheduled });
    } catch {
      if (!controller.signal.aborted) this.set({ failed: true });
    } finally {
      if (this.request === controller) {
        this.request = null;
        this.set({ loading: false });
      }
    }
  }

  /** Calls one back. A refusal leaves the list unchanged. */
  cancel(id: ID): Promise<ApiError | null> {
    return this.change(async () => {
      await this.api.cancelScheduled(id);
      return this.state.items?.filter((item) => item.id !== id) ?? null;
    });
  }

  /** Requeues one for `sendAt`; a past time sends it on the next flush. */
  reschedule(id: ID, sendAt: number): Promise<ApiError | null> {
    return this.change(async () => {
      const { scheduled } = await this.api.rescheduleMessage(id, sendAt);
      return (
        this.state.items
          ?.map((item) => (item.id === id ? scheduled : item))
          .sort((a, b) => a.sendAt - b.sendAt) ?? null
      );
    });
  }

  /** With `expectedText`, refused as `scheduled_changed` if the words are no longer those. */
  edit(id: ID, body: EditScheduledBody): Promise<ApiError | null> {
    return this.change(async () => {
      const { scheduled } = await this.api.editScheduledMessage(id, body);
      return this.state.items?.map((item) => (item.id === id ? scheduled : item)) ?? null;
    });
  }

  private async change(make: () => Promise<ScheduledMessage[] | null>): Promise<ApiError | null> {
    if (this.changing) return null;
    this.changing = true;
    this.request?.abort();
    this.request = null;
    this.set({ loading: false });
    const refused = await doneOf(async () => this.set({ items: await make() }));
    this.changing = false;
    return refused;
  }

  private set(patch: Partial<ScheduledListState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener(this.state);
  }
}
