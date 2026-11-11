import { createStore, type StoreApi } from "zustand/vanilla";
import {
  DEFAULT_CHANNEL_PREFS,
  PROTOCOL_VERSION,
  SEND_RETRY_WINDOW_MS,
  SOCKET_CLOSE,
  SOCKET_REFUSALS,
  type AccessPolicy,
  type Channel,
  type ChannelPrefs,
  type NotifyLevel,
  type EphemeralEvent,
  type EventEnvelope,
  type Friendship,
  type HuddleRing,
  type ID,
  type MemberNotice,
  type Message,
  type ModalView,
  type Presence,
  type ReadySnapshot,
  type ServerNotice,
  type ForwardReference,
  type ReplyReference,
  type CreateChannelBody,
  type ReportReason,
  type SendMessageBody,
  type ServerToClient,
  type UpdateChannelBody,
  type UpdateMeBody,
  type ThreadFollow,
  type Reminder,
  type ChannelRemoval,
  type SidebarSection,
  type User,
  type ViewSubmitted,
  isInAppCommand,
  parseCommand,
  type InAppCommandName,
  type ParsedCommand,
} from "@ownbase/protocol";
import { Api, ApiError, type CommandHint } from "./api.js";
import { AccountActions } from "./account.js";
import { AdminActions } from "./admin.js";
import { AppActions } from "./apps.js";
import { Lists } from "./lists.js";
import { LocalLedger, type LocalOutcome } from "./localWork.js";
import { FileCache, previewImageKey } from "./fileCache.js";
import { AvatarCache } from "./avatars.js";
import { captureFailure } from "./capture.js";
import { ClientEmitter, type ClientEvents, type ClientListener } from "./events.js";
import { isThreadUnread } from "./selectors.js";
import {
  THREAD_WINDOW,
  forgetAllUnlisted,
  forgetUnlisted,
  isMessageEvent,
  keepMessages,
  messageEventChannel,
  patchMessage,
  reduceMessages,
  stampMessages,
  threadRootMessage,
  timelineMessages,
  unhandled,
  windowTimeline,
  withReaction,
  type ChannelTimeline,
  type MessageCache,
  type MessageEvent,
} from "./messageCache.js";
import {
  answerOf,
  doneOf,
  failureOf,
  fileRefusal,
  notConnected,
  refusalReason,
} from "./answers.js";
import { newNonce } from "./outbox.js";
import { OptimisticWrites, type WriteSpec } from "./optimisticWrites.js";
import { pollChoicesKey, pollChoicesOfKey, serverPollChoices, type PollDraft } from "./polls.js";
import type {
  CallLogLine,
  CallView,
  HuddleSession,
  HuddleState,
  ScreenShareQuality,
} from "./huddle.js";
import type { MicrophoneSettings, NoiseFilter, OpenSystemMicrophone } from "./devices.js";

class HuddleJoinRefusedError extends Error {}
/** A rejoin given up because the socket dropped again; the next one asks afresh. */
class HuddleRejoinCancelled extends Error {}

export type ConnectionStatus =
  | "connecting"
  | "online"
  | "reconnecting"
  | "auth_failed"
  | "protocol_mismatch"
  /** The server will refuse this account until its password is replaced. */
  | "password_change_required"
  | "closed";

/** A file shown in the composer or in an optimistic message, before the server has it. */
export interface LocalAttachment {
  name: string;
  size: number;
  mime: string;
  /** Object URL for instant local preview of images. */
  previewUrl: string | null;
}

export interface PendingMessage {
  nonce: string;
  channelId: ID;
  threadRootId: ID | null;
  /** A reply the author also chose to show in the channel. */
  broadcast?: boolean;
  /** The message this one answers in place, as it was when the reply was sent. */
  replyTo?: ReplyReference;
  /** The message this one passes on, as it was when it was forwarded. */
  forward?: ForwardReference;
  /** The choices it asks people to pick from, its words the question (E6). */
  poll?: PollDraft;
  text: string;
  userId: ID;
  createdAt: number;
  failed: boolean;
  /** Why it did not send, in words the author can act on. Null while in flight. */
  failureReason: string | null;
  /**
   * The server answered and turned this send down. Unlike a send whose outcome
   * is unknown, only the author's Retry sends it again, even after a restart.
   */
  refused?: boolean;
  attachments: LocalAttachment[];
  /** 0–1 while uploading attachments; null once the message itself is in flight. */
  uploadProgress: number | null;
}

/**
 * An outbox entry as it survives a restart. File objects cannot be serialized,
 * so only their descriptions travel; see `restoreOutbox` for what that means.
 */
export interface StoredPending {
  nonce: string;
  channelId: ID;
  threadRootId: ID | null;
  broadcast?: boolean;
  replyTo?: ReplyReference;
  forward?: ForwardReference;
  poll?: PollDraft;
  text: string;
  userId: ID;
  createdAt: number;
  attachments: { name: string; size: number; mime: string }[];
  /**
   * What the author was told when the server refused this send. Present only
   * for a known refusal, which comes back failed and waits for Retry; a send
   * whose outcome is unknown has none and is sent again, under the same nonce.
   */
  refusal?: string;
}

/**
 * How many unsent messages one account can have waiting at once. A send past
 * this is refused before the composer lets go of it, rather than being kept
 * only in memory where a restart would lose it.
 */
export const OUTBOX_LIMIT = 50;

/** What `send` did with what it was given. */
export type SendAnswer =
  /** Waiting in the outbox; `kept` settles once this device holds its words, null when nothing keeps them. */
  | { kind: "queued"; nonce: string; kept: Promise<LocalOutcome> | null }
  /** A command the server runs: anything it says comes back as a private answer. */
  | { kind: "command" }
  /** A command the app runs itself, which `send` does not: nothing was sent. */
  | ({ kind: "in_app"; name: InAppCommandName } & Omit<ParsedCommand, "name">)
  /** Nothing was taken. */
  | { kind: "refused"; reason: "empty" | "outbox_full" | "not_connected" };

/** The wait after "too much at once" from a server that did not say how long. */
const RATE_LIMIT_WAIT_MS = 2000;
/** However long a server asks for, a send is tried again within this. */
const RATE_LIMIT_WAIT_MAX_MS = 60_000;

const MISSING_ATTACHMENTS =
  "The attached files were not kept when the app closed. Attach them again to send this.";

const STALE_SEND =
  `Not sent. You wrote this more than ${SEND_RETRY_WINDOW_MS / 86_400_000} days ago, ` +
  "so it may already be posted. Press Retry to send it anyway.";

/**
 * Whether a failed send was answered and refused by the server, as opposed to
 * lost on the way or refused for reasons that pass (signing in, rate limits,
 * a server fault), after which sending the same request again is safe.
 */
function isRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![401, 408, 429].includes(error.status)
  );
}

function sendFailureReason(error: unknown): string {
  // Status 0: an upload that never had an answer (no connection, timed out).
  // The workspace was reached, so waiting to be back online would wait forever.
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "The workspace did not answer in time. Press Retry to send it again.";
  }
  if (error instanceof SyntaxError) {
    return "The workspace's answer could not be read. Press Retry to send it again.";
  }
  if (!(error instanceof ApiError) || error.status === 0) {
    return "Could not reach the workspace. It is sent again once you're back online.";
  }
  if (error.status === 429) return "Too much sent at once. It is sent again in a moment.";
  switch (error.code) {
    case "channel_archived":
      return "This conversation is archived.";
    case "channel_not_found":
      return "You no longer have access to this conversation.";
    case "bad_thread_root":
      return "The message this replies to is gone.";
    case "bad_reply_target":
      return "The message this answers is not in this conversation.";
    case "invalid_attachments":
      return "The attached files are no longer available.";
    case "attachments_scheduled":
      return "One of the attached files is part of a scheduled message.";
    case "message_not_found":
      return "The message this forwards is no longer there.";
    case "forward_unavailable":
      return "What this forwards is private or deleted, so it cannot be passed on.";
    case "file_too_large":
      return `${fileRefusal(error)} Discard this and attach a smaller one.`;
    case "storage_quota_exceeded":
      return `${fileRefusal(error)} Ask whoever hosts it to free space or raise the limit, then press Retry.`;
    case "nonce_conflict":
    case "message_deleted":
      return "This was already sent once. Discard it to clear it.";
    case "account_deactivated":
      return "This account is deactivated.";
    default:
      return error.status >= 500
        ? "The workspace could not save this. Press Retry to try again."
        : "This message was refused.";
  }
}

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

/** Which window of a channel's history a request reads. */
export type HistoryWindow = "initial" | "older" | "newer" | "latest";

/** A channel's history request on its way, and the window that last failed to load. */
export interface TimelineStatus {
  loading: HistoryWindow | null;
  error: HistoryWindow | null;
}

/**
 * A reply only this client can see — a slash command's private answer, or a
 * local note about one that failed. Never persisted; a reload clears them.
 */
export interface EphemeralMessage {
  id: ID;
  channelId: ID;
  /** The bot it is shown as coming from, or "" for a note from the app itself. */
  userId: ID;
  text: string;
  createdAt: number;
}

/**
 * How many private answers are kept (REV-04). They are never stored, but a
 * long session of commands would otherwise keep every one, in memory and on
 * screen. The newest are kept, per conversation and across the workspace;
 * what is let go is counted, so the conversation can say so, and none of its
 * text is kept. No answer expires by age: one stays until it is dismissed,
 * newer ones push it out, its conversation is left, or the app reloads.
 */
export const EPHEMERAL_LIMITS = {
  /** Answers kept in one conversation, which is also how many it shows. */
  perConversation: 20,
  /** Answers kept across the workspace. */
  total: 100,
  /** Characters of answer text kept across the workspace, about 0.8 MB. */
  totalChars: 400_000,
  /** Characters kept of one answer; a longer one is cut, and says so. */
  answerChars: 40_000,
} as const;

/** What replaces the end of an answer too long to keep whole. */
export const EPHEMERAL_CUT_NOTE = "\n\n_(The rest of this answer was too long to keep.)_";

/**
 * Adds a private answer within EPHEMERAL_LIMITS. An answer with an id already
 * shown replaces that one, in place in the same conversation, rather than
 * adding a second row.
 * Returns the answers kept and, per conversation, how many were let go.
 */
export function keepEphemeral(
  ephemerals: Record<ID, EphemeralMessage[]>,
  dropped: Record<ID, number>,
  incoming: EphemeralMessage,
): { ephemerals: Record<ID, EphemeralMessage[]>; ephemeralsDropped: Record<ID, number> } {
  const { perConversation, total, totalChars, answerChars } = EPHEMERAL_LIMITS;
  const message =
    incoming.text.length > answerChars
      ? { ...incoming, text: incoming.text.slice(0, answerChars) + EPHEMERAL_CUT_NOTE }
      : incoming;
  const next = { ...ephemerals };
  const counts = { ...dropped };
  // Ids are the server's and unique: one arriving again elsewhere moves here.
  for (const [channelId, list] of Object.entries(next)) {
    if (channelId === message.channelId || !list.some((e) => e.id === message.id)) continue;
    const kept = list.filter((e) => e.id !== message.id);
    if (kept.length > 0) next[channelId] = kept;
    else delete next[channelId];
  }
  const letGo = (channelId: ID, n: number) => {
    if (n > 0) counts[channelId] = (counts[channelId] ?? 0) + n;
  };
  const here = next[message.channelId] ?? [];
  const at = here.findIndex((e) => e.id === message.id);
  if (at >= 0) next[message.channelId] = here.map((e, i) => (i === at ? message : e));
  else {
    const added = [...here, message];
    letGo(message.channelId, added.length - perConversation);
    next[message.channelId] = added.slice(-perConversation);
  }
  // Across the workspace, the oldest go first; never the one just added.
  const all = Object.values(next)
    .flat()
    .sort((a, b) => a.createdAt - b.createdAt);
  let count = all.length;
  let chars = all.reduce((sum, e) => sum + e.text.length, 0);
  const gone = new Set<EphemeralMessage>();
  for (const e of all) {
    if (count <= total && chars <= totalChars) break;
    if (e === message) continue;
    gone.add(e);
    count--;
    chars -= e.text.length;
  }
  if (gone.size > 0) {
    for (const [channelId, list] of Object.entries(next)) {
      const kept = list.filter((e) => !gone.has(e));
      letGo(channelId, list.length - kept.length);
      if (kept.length > 0) next[channelId] = kept;
      else delete next[channelId];
    }
  }
  return { ephemerals: next, ephemeralsDropped: counts };
}

export interface WorkspaceState extends MessageCache {
  /** channelId -> its history request on its way or failed; absent when neither. */
  timelineStatus: Record<ID, TimelineStatus>;
  friends: Friendship[];
  /** The people this account blocked (E12), whose messages fold away and who never notify it. */
  blocked: ID[];
  /** How many reported messages wait for an admin (E12); null unless this account is one. */
  openReports: number | null;
  /**
   * How many members the plan includes (P5); null unless this account is the
   * owner or an admin, on a server whose host set it.
   */
  memberNotice: MemberNotice | null;
  /**
   * What the server's extensions tell the owner and admins now (P6), such as
   * a license running out. Empty for everyone else.
   */
  serverNotices: ServerNotice[];
  status: ConnectionStatus;
  workspaceName: string;
  /** Authenticated storage identity; null until the first snapshot. */
  workspaceId: ID | null;
  /**
   * The protocol the server said it speaks when it refused this one, with
   * `protocol_mismatch`; 0 for a version-1 server, which did not say.
   */
  serverProtocolVersion: number | null;
  /**
   * How far the server's clock is ahead of this device's (behind when
   * negative), as of connecting; null until the first snapshot.
   * Reminders and scheduled messages go at the time this device chose.
   */
  clockSkewMs: number | null;
  /**
   * This account's sidebar sections, in their order (E8). A conversation's own
   * is `ChannelPrefs.sectionId`; one naming a section not here has none.
   */
  sidebarSections: SidebarSection[];
  /**
   * What this account's conversations notify about unless one was set on its
   * own (v53); null until the first snapshot.
   */
  notifyDefault: NotifyLevel | null;
  /** This account's reminders by message id, waiting and due (E4). */
  reminders: Record<ID, Reminder>;
  /**
   * Notes that someone removed this account from channels, by id, for
   * Activity until read.
   */
  channelRemovals: Record<ID, ChannelRemoval>;
  /**
   * What this account chose in each anonymous poll it voted in, by message id,
   * which no message says (E6).
   */
  pollChoices: Record<ID, number[]>;
  /**
   * Choices made here in a poll that the server has not yet been heard to
   * have, by message id: shown in place of its own; see `shownPoll`.
   */
  pollPicks: Record<ID, number[]>;
  /** Who may join now, as the server last said; null until the first snapshot. */
  accessPolicy: AccessPolicy | null;
  /** Whether new messages get link previews now (E2); null until the first snapshot. */
  linkPreviews: boolean | null;
  /**
   * The workspace icon's version, as the server last said, or null when there
   * is none; undefined until the first snapshot says which.
   */
  iconVersion: string | null | undefined;
  /**
   * Counts up whenever this account's scheduled queue may have changed: the
   * server said so, or this client connected and could have missed it saying so.
   * A list of scheduled messages reads the queue again when it moves.
   */
  scheduledChanges: number;
  self: User | null;
  users: Record<ID, User>;
  channels: Record<ID, Channel>;
  /** channelId -> my lastReadSeq (only channels I'm a member of). */
  memberships: Record<ID, number>;
  /** channelId -> how far replies count as read in a thread I have no cursor for (`repliesReadSeq`). */
  repliesRead: Record<ID, number>;
  /** channelId -> my notification settings for it, including choices still being saved. */
  prefs: Record<ID, ChannelPrefs>;
  /**
   * channelId -> a notification choice not yet saved, or one the server
   * refused. `failed` is what was chosen and not saved, kept so it can be
   * tried again; `prefs` meanwhile shows what the server has.
   */
  prefsWrites: Record<ID, { saving: boolean; failed: Partial<ChannelPrefs> | null }>;
  /** channelId -> seq of the newest message in it. */
  channelLastSeq: Record<ID, number>;
  presence: Record<ID, Presence>;
  /** channelId -> userId -> typing-expires-at (ms). */
  typing: Record<ID, Record<ID, number>>;
  lastSeq: number;
  pending: PendingMessage[];
  /** Message ids this user saved for later. */
  saved: Record<ID, true>;
  /**
   * Per conversation, the seq of the latest `history.removed`: retention took
   * threads away. Held views of that conversation drop them from here; one
   * the client does not hold, such as a page of Activity, can load again.
   */
  removedHistory: Record<ID, number>;
  /**
   * Per conversation, the seq of the latest event that changed what was
   * already there: a message edited or deleted, a pin, history removed, or
   * this account leaving. A view holding its own copy of messages, such as
   * search results or the Pinned panel, asks again when a conversation it
   * shows changes here, whether or not that history is loaded (Q07, Q08).
   */
  changedContent: Record<ID, number>;
  /**
   * Per conversation, the seq of the latest person to join or leave it. A
   * channel's member list is asked for, not held, so a view showing one asks
   * again when this moves, and when the connection comes back.
   */
  memberChanges: Record<ID, number>;
  /** channelId -> unread messages there that name this user. */
  mentionCounts: Record<ID, number>;
  /** threadRootId -> this account's follow state and read cursor for it. */
  threadFollows: Record<ID, ThreadFollow>;
  /** channelId -> unsent composer text, restored when you come back. */
  drafts: Record<ID, string>;
  /**
   * Draft key -> when its text last changed, in epoch ms, as far as this
   * device knows. A draft kept by an earlier version has none.
   */
  draftTimes: Record<string, number>;
  /** channelId -> who is in that channel's huddle right now. */
  huddles: Record<ID, ID[]>;
  /**
   * channelId -> the ring of a direct message's huddle this account is part
   * of, calling or called, while it rings (E10).
   */
  rings: Record<ID, HuddleRing>;
  /** Private replies per channel, newest last, within EPHEMERAL_LIMITS. */
  ephemerals: Record<ID, EphemeralMessage[]>;
  /** channelId -> private replies let go there to stay within the limits. */
  ephemeralsDropped: Record<ID, number>;
  /** The form an app has asked this person to fill in, on top of any stack, or null. */
  modal: ModalView | null;
  /**
   * Forms under the one shown, bottom first, which it goes back to when it
   * closes (E18b). Empty when only one is open.
   */
  modalsBelow: ModalView[];
  /** Commands that can be typed here; loaded once after connecting. */
  commands: CommandHint[];
  huddle: HuddleState | null;
  /**
   * Why the last huddle ended without this person leaving it, such as joining
   * it on another device, for the screen to say once. `at` tells one ending
   * from the next.
   */
  huddleEnded: { channelId: ID; message: string; error: boolean; at: number } | null;
  /**
   * How the ring of the huddle this device is in went, for its caller (E10):
   * who declined, or that nobody answered. Cleared as this device joins a
   * huddle, so it never speaks of another call. `at` tells one from the next.
   */
  ringNotice: { channelId: ID; message: string; at: number } | null;
}

const initialState: WorkspaceState = {
  friends: [],
  blocked: [],
  openReports: null,
  memberNotice: null,
  serverNotices: [],
  status: "connecting",
  workspaceName: "",
  workspaceId: null,
  serverProtocolVersion: null,
  clockSkewMs: null,
  sidebarSections: [],
  notifyDefault: null,
  reminders: {},
  channelRemovals: {},
  pollChoices: {},
  pollPicks: {},
  accessPolicy: null,
  linkPreviews: null,
  iconVersion: undefined,
  scheduledChanges: 0,
  self: null,
  users: {},
  channels: {},
  memberships: {},
  repliesRead: {},
  prefs: {},
  prefsWrites: {},
  channelLastSeq: {},
  presence: {},
  typing: {},
  lastSeq: 0,
  messages: {},
  messageSeqs: {},
  timelines: {},
  threads: {},
  threadPages: {},
  timelineStatus: {},
  pending: [],
  saved: {},
  removedHistory: {},
  changedContent: {},
  memberChanges: {},
  threadFollows: {},
  mentionCounts: {},
  drafts: {},
  draftTimes: {},
  huddles: {},
  rings: {},
  huddle: null,
  huddleEnded: null,
  ringNotice: null,
  ephemerals: {},
  ephemeralsDropped: {},
  modal: null,
  modalsBelow: [],
  commands: [],
};

/** Followed threads with replies this account has not read. */
export function unreadThreadCount(threadFollows: Record<ID, ThreadFollow>): number {
  return Object.values(threadFollows).filter(isThreadUnread).length;
}

/**
 * Whether this account has read a message; the server's count of unread
 * messages is the same rule. The channel's cursor reads what the channel
 * shows. A reply is read through its thread: by the thread's cursor, or, in a
 * thread this account has no cursor for, as far as the membership's
 * `repliesRead`. A reply also sent to the channel is read by either cursor.
 */
export function isMessageRead(
  message: Pick<Message, "channelId" | "seq" | "threadRootId" | "broadcast">,
  state: Pick<WorkspaceState, "memberships" | "threadFollows" | "repliesRead">,
): boolean {
  const channelRead = state.memberships[message.channelId] ?? 0;
  if (!message.threadRootId) return message.seq <= channelRead;
  const follow = state.threadFollows[message.threadRootId];
  const threadRead = follow?.lastReadSeq;
  // Also sent to the channel, and read there; unless the thread was marked
  // unread since the channel was last read past where it then stood.
  const held = follow?.unreadHold !== undefined && channelRead <= follow.unreadHold;
  if (message.broadcast && message.seq <= channelRead && !held) return true;
  return message.seq <= (threadRead ?? state.repliesRead[message.channelId] ?? 0);
}

/**
 * A live connection to one workspace server: typed REST + resilient WebSocket
 * + a Zustand store holding the local replica the UI renders from.
 */
export class WorkspaceClient {
  readonly store: StoreApi<WorkspaceState>;
  /**
   * The server's REST API, for this client's own use and for tests that stand
   * in for the server. Everything else asks the client, so the store hears.
   */
  readonly api: Api;
  readonly files: FileCache;
  /** Profile pictures, fetched with this session and kept as object URLs (E9). */
  readonly avatars: AvatarCache;
  readonly account: AccountActions;
  readonly admin: AdminActions;
  readonly apps: AppActions;
  readonly lists: Lists;
  /** The sends waiting to hear whether this device keeps their words (GL-02). */
  readonly kept = new LocalLedger();
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private typingSweep: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private nonceCounter = 0;
  /**
   * The next connection asks for a whole snapshot rather than what it missed,
   * because applying what was missed failed once and would fail again.
   */
  private wantsSnapshot = false;
  private readonly events = new ClientEmitter();

  /** Listens for one kind of news from this workspace; the function returned stops listening. */
  on<K extends keyof ClientEvents>(event: K, listener: ClientListener<K>): () => void {
    return this.events.on(event, listener);
  }

  /**
   * The server's seq when this connection opened. Everything at or below it
   * already happened; everything above it is arriving as it is sent.
   */
  private connectedAtSeq = 0;
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
  private acknowledgedMessages = new Set<ID>();
  /** Pins, saves, votes, reactions, snoozes, notification choices and thread follows not yet answered. */
  private writes = new OptimisticWrites();

  constructor(
    public readonly baseUrl: string,
    private token: string,
  ) {
    this.api = new Api(baseUrl, token);
    this.files = new FileCache(this.api, undefined, (fileId) => this.fileOwner(fileId));
    this.avatars = new AvatarCache((userId, version) => this.api.fetchAvatar(userId, version));
    this.store = createStore<WorkspaceState>(() => ({ ...initialState }));
    this.account = new AccountActions(this.api);
    this.admin = new AdminActions(this.api, (users) =>
      users.forEach((user) => this.keepUser(user)),
    );
    this.apps = new AppActions(this.api, () => void this.loadCommands());
    this.lists = new Lists(this.api, this.store);
    // A session that has ended keeps nothing it downloaded (F07).
    this.store.subscribe((now, before) => {
      if (
        now.status !== before.status &&
        (now.status === "auth_failed" || now.status === "password_change_required")
      )
        this.files.invalidateAll();
    });
  }

  get state(): WorkspaceState {
    return this.store.getState();
  }

  /**
   * The loaded message a file is attached to, asked when the file is first
   * fetched, so the cache can let it go with that message or conversation
   * after the history listing it is gone (F07).
   */
  private fileOwner(fileId: ID): { channelId: ID; messageId: ID; threadRootId: ID | null } | null {
    for (const m of Object.values(this.state.messages)) {
      if (
        m.files.some((f) => f.id === fileId) ||
        m.previews.some((p) => previewImageKey(p.id) === fileId)
      )
        return { channelId: m.channelId, messageId: m.id, threadRootId: m.threadRootId };
    }
    return null;
  }

  /** Where the next connection picks up: after what was heard, or afresh. */
  private resumeSeq(): number | null {
    return this.wantsSnapshot || this.state.lastSeq === 0 ? null : this.state.lastSeq;
  }

  connect(): void {
    if (this.ws) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopped = false;
    this.openSocket(this.resumeSeq());
    this.typingSweep ??= setInterval(() => this.sweepTyping(), 2000);
    this.readRetryTimer ??= setInterval(() => this.flushReads(), 5000);
    if (typeof window !== "undefined" && !this.listeningOnline) {
      window.addEventListener("online", this.onNetworkBack);
      this.listeningOnline = true;
    }
  }

  private listeningOnline = false;
  /**
   * The device's network is back. A socket that never noticed it was gone
   * sends what was lost on the way now; one waiting out its backoff, up to
   * half a minute, tries at once.
   */
  private onNetworkBack = (): void => {
    if (this.stopped) return;
    if (this.state.status === "online") {
      this.retryLostSends();
      return;
    }
    if (this.reconnectTimer && !this.ws) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.reconnectDelay = 1000;
      this.openSocket(this.resumeSeq());
    }
  };

  destroy(): void {
    this.stopped = true;
    this.avatars.clear();
    // Writes still out answer to nobody now; none may correct the server,
    // and none waiting behind them may go (REV-11).
    this.writes.close();
    this.historyEpoch++;
    this.abortHistoryLoads();
    this.timelineRequests.clear();
    this.timelineHolds.clear();
    this.threadLoads.clear();
    this.clearReadRequests();
    if (this.readRetryTimer) clearInterval(this.readRetryTimer);
    this.readRetryTimer = null;
    // Release the microphone before the socket goes, so no call is left open.
    this.leaveHuddle();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.rateLimitTimer) clearTimeout(this.rateLimitTimer);
    this.rateLimitTimer = null;
    this.rateLimited.clear();
    if (this.listeningOnline) window.removeEventListener("online", this.onNetworkBack);
    this.listeningOnline = false;
    if (this.typingSweep) clearInterval(this.typingSweep);
    this.typingSweep = null;
    this.ws?.close();
    this.ws = null;
    for (const p of this.state.pending) {
      for (const a of p.attachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    this.files.dispose();
    this.retryFiles.clear();
    this.uploadedFiles.clear();
    this.store.setState((s) => ({
      status: "closed",
      threadPages: Object.fromEntries(
        Object.entries(s.threadPages).map(([id, page]) => [id, { ...page, loading: false }]),
      ),
      timelineStatus: Object.fromEntries(
        Object.entries(s.timelineStatus).map(([id, status]) => [id, { ...status, loading: null }]),
      ),
    }));
  }

  private openSocket(lastSeq: number | null): void {
    const wsUrl = this.baseUrl.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          token: this.token,
          lastSeq,
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
    };

    ws.onmessage = (e) => {
      if (this.ws !== ws || this.stopped) return;
      let msg: ServerToClient;
      try {
        msg = JSON.parse(String(e.data)) as ServerToClient;
      } catch {
        ws.close(SOCKET_CLOSE.invalidMessage, "invalid server message");
        return;
      }
      try {
        this.handleServerMessage(msg);
      } catch (error) {
        this.recoverFrom(ws, msg, error);
      }
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const refusal = SOCKET_REFUSALS.find((r) => SOCKET_CLOSE[r] === event.code);
      if (refusal) this.store.setState({ status: refusal });
      // A refusal lasts until somebody does something, so reconnecting would be
      // a loop that never ends and never says why.
      if (this.stopped || SOCKET_REFUSALS.some((r) => r === this.state.status)) {
        this.leaveHuddle();
        return;
      }
      // A call goes on through a dropped connection: its sound and video do
      // not pass through this socket, and the server keeps this device's
      // place a while. `resumeHuddle` takes it back once the socket returns.
      this.holdHuddle();
      this.store.setState({ status: "reconnecting" });
      this.reconnectTimer = setTimeout(() => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
        this.openSocket(this.resumeSeq());
      }, this.reconnectDelay);
    };

    ws.onerror = () => ws.close();
  }

  /**
   * Applying a server message failed here: a fault in this client, not in the
   * message. Asking for what was missed would replay the same event and fail
   * again, so an event that failed is dropped with whatever it half changed:
   * the connection starts over from a whole snapshot. Anything else is only
   * reported; the connection goes on.
   */
  private recoverFrom(ws: WebSocket, msg: ServerToClient, error: unknown): void {
    console.error(`Could not apply the server's "${msg.type}" message.`, error);
    if (msg.type !== "event") return;
    this.wantsSnapshot = true;
    ws.close(1000, "resync");
  }

  private handleServerMessage(msg: ServerToClient): void {
    switch (msg.type) {
      case "ready":
        this.wantsSnapshot = false;
        this.applyReady(msg);
        this.afterReady(msg);
        if (this.state.status === "online") this.retryLostSends();
        break;
      case "synced":
        this.store.setState((s) => ({ lastSeq: Math.max(s.lastSeq, msg.seq), status: "online" }));
        this.flushReads();
        this.retryLostSends();
        break;
      case "event":
        this.applyEvent(msg.envelope);
        break;
      case "ephemeral":
        this.applyEphemeral(msg.event);
        break;
      case "error":
        if (msg.code === "protocol_mismatch")
          this.store.setState({
            status: "protocol_mismatch",
            serverProtocolVersion: msg.protocolVersion ?? 0,
          });
        else this.store.setState({ status: msg.code });
        break;
      case "pong":
        break;
      default:
        unhandled(msg);
    }
  }

  private applyReady(snap: ReadySnapshot): void {
    // A replaced server must not inherit this connection's private drafts or
    // outbox, even if a copied session token happens to work there. Keep the
    // old identity intact so unmount can flush its work before signing in again.
    if (
      this.state.self &&
      (this.state.self.id !== snap.self.id ||
        (this.state.workspaceId && snap.workspaceId && this.state.workspaceId !== snap.workspaceId))
    ) {
      this.destroy();
      this.store.setState({ status: "auth_failed" });
      return;
    }
    this.reconnectDelay = 1000;
    // Anything the server had already recorded when we connected is history,
    // however soon after it reaches us.
    this.connectedAtSeq = snap.seq;
    const visible = new Set(snap.channels.map((c) => c.id));
    for (const id of Object.keys(this.state.channels)) {
      if (!visible.has(id)) this.removeChannel(id);
    }
    const reset = snap.replayFrom === null || this.state.lastSeq > snap.seq;
    if (reset) this.resetHistory();
    const users: Record<ID, User> = {};
    for (const u of snap.users) users[u.id] = u;
    const channels: Record<ID, Channel> = {};
    for (const c of snap.channels) channels[c.id] = c;
    const memberships: Record<ID, number> = {};
    const prefs: Record<ID, ChannelPrefs> = {};
    const repliesRead: Record<ID, number> = {};
    for (const m of snap.memberships) {
      const pending = this.pendingReads.get(m.channelId) ?? 0;
      if (pending <= m.lastReadSeq || pending > snap.seq) this.pendingReads.delete(m.channelId);
      memberships[m.channelId] = Math.max(m.lastReadSeq, this.pendingReads.get(m.channelId) ?? 0);
      repliesRead[m.channelId] = m.repliesReadSeq;
      prefs[m.channelId] = m.prefs;
    }
    const saved: Record<ID, true> = {};
    for (const id of snap.savedMessageIds) saved[id] = true;
    const threadFollows: Record<ID, ThreadFollow> = {};
    for (const follow of snap.threadFollows) threadFollows[follow.rootId] = follow;
    const leftWhileAway = Object.keys(this.state.prefs).filter((id) => !(id in prefs));

    this.store.setState((prev) => ({
      status: "connecting",
      workspaceName: snap.workspaceName,
      workspaceId: snap.workspaceId,
      clockSkewMs: snap.serverTime - Date.now(),
      sidebarSections: snap.sidebarSections,
      notifyDefault: snap.notifyDefault,
      reminders: Object.fromEntries(
        snap.reminders.map((reminder) => [reminder.messageId, reminder]),
      ),
      // But for those this device is reading, which the server may not have yet.
      channelRemovals: Object.fromEntries(
        snap.channelRemovals
          .filter((removal) => !this.readingRemovals.has(removal.id))
          .map((removal) => [removal.id, removal]),
      ),
      pollChoices: snap.pollChoices,
      // What the server now says stands, but for votes still on their way.
      pollPicks: Object.fromEntries(
        Object.entries(prev.pollPicks).filter(([messageId]) =>
          this.writes.isPending({ kind: "poll", messageId }),
        ),
      ),
      accessPolicy: snap.accessPolicy,
      linkPreviews: snap.linkPreviews,
      iconVersion: snap.iconVersion,
      // Whatever was said while this client was away was not heard.
      scheduledChanges: prev.scheduledChanges + 1,
      self: snap.self,
      users,
      channels,
      memberships,
      repliesRead,
      prefs,
      channelLastSeq: snap.channelLastSeq,
      presence: snap.presence,
      threadFollows,
      mentionCounts: snap.mentionCounts,
      saved,
      huddles: snap.huddles,
      rings: Object.fromEntries(snap.huddleRings.map((ring) => [ring.channelId, ring])),
      friends: snap.friends,
      blocked: snap.blocked,
      openReports: snap.openReports ?? null,
      memberNotice: snap.memberNotice ?? null,
      serverNotices: snap.notices ?? [],
      lastSeq: reset || prev.lastSeq === 0 ? snap.seq : (snap.replayFrom ?? prev.lastSeq),
      typing: {},
    }));
    // The snapshot is the server's word; writes still out go on top of it.
    for (const channelId of leftWhileAway) this.writes.forget({ kind: "prefs", channelId });
    for (const [channelId, channelPrefs] of Object.entries(prefs))
      this.writes.heard({ kind: "prefs", channelId }, channelPrefs);
    this.writes.heard({ kind: "sectionOrder" }, snap.sidebarSections);
    this.writes.reshow();
    for (const id of [...this.reloadChannels]) {
      this.reloadChannels.delete(id);
      if (channels[id]) void this.loadTimeline(id);
    }
    for (const [rootId, channelId] of [...this.reloadThreads]) {
      this.reloadThreads.delete(rootId);
      if (channels[channelId]) void this.loadThread(rootId, channelId);
    }
    this.resumeHuddle(snap);
  }

  private abortHistoryLoads(): void {
    for (const hold of this.timelineHolds.values()) hold.controller.abort();
    for (const load of this.threadLoads.values()) load.controller.abort();
  }

  private resetHistory(): void {
    this.historyEpoch++;
    this.abortHistoryLoads();
    for (const id of this.timelineHolds.keys()) this.reloadChannels.add(id);
    this.timelineRequests.clear();
    this.timelineHolds.clear();
    this.timelineRecency.clear();
    this.threadRecency.clear();
    this.clearReadRequests();
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
    this.acknowledgedMessages.clear();
    this.threadLoads.clear();
    this.store.setState({
      messages: {},
      messageSeqs: {},
      timelines: {},
      threads: {},
      threadPages: {},
      timelineStatus: {},
      typing: {},
      ephemerals: {},
      ephemeralsDropped: {},
      modal: null,
      modalsBelow: [],
    });
  }

  private removeChannel(channelId: ID): void {
    this.timelineRequests.delete(channelId);
    this.timelineHolds.get(channelId)?.controller.abort();
    this.timelineHolds.delete(channelId);
    this.timelineRecency.delete(channelId);
    this.pendingReads.delete(channelId);
    this.readRequests.get(channelId)?.abort();
    this.readRequests.delete(channelId);
    if (this.session?.channelId === channelId) this.leaveHuddle();
    const state = this.state;
    const inChannel = Object.values(state.messages).filter((m) => m.channelId === channelId);
    const roots = new Set(state.timelines[channelId]?.ids ?? []);
    for (const [id, page] of Object.entries(state.threadPages))
      if (page.channelId === channelId) roots.add(id);
    for (const m of inChannel) if (m.threadRootId) roots.add(m.threadRootId);
    // A choice for a channel this account can no longer see has nowhere to go.
    this.writes.forget({ kind: "prefs", channelId });
    for (const id of roots) {
      this.threadLoads.get(id)?.controller.abort();
      this.threadLoads.delete(id);
      this.threadRecency.delete(id);
    }
    for (const m of inChannel) for (const f of m.files) this.files.invalidate(f.id);
    // And those it fetched earlier, from history that has since been let go (F07).
    this.files.invalidateChannel(channelId);
    const without = <T>(values: Record<ID, T>) =>
      Object.fromEntries(Object.entries(values).filter(([id]) => id !== channelId));
    const notRoot = <T>(values: Record<ID, T>) =>
      Object.fromEntries(Object.entries(values).filter(([id]) => !roots.has(id)));
    this.store.setState(
      forgetAllUnlisted({
        messages: state.messages,
        messageSeqs: state.messageSeqs,
        timelines: without(state.timelines),
        threads: notRoot(state.threads),
        threadPages: notRoot(state.threadPages),
      }),
    );
    this.store.setState((s) => ({
      timelineStatus: without(s.timelineStatus),
      channels: without(s.channels),
      memberships: without(s.memberships),
      repliesRead: without(s.repliesRead),
      prefs: without(s.prefs),
      prefsWrites: without(s.prefsWrites),
      channelLastSeq: without(s.channelLastSeq),
      typing: without(s.typing),
      huddles: without(s.huddles),
      rings: without(s.rings),
      ephemerals: without(s.ephemerals),
      ephemeralsDropped: without(s.ephemeralsDropped),
      saved: notRoot(s.saved),
      modal: null,
      modalsBelow: [],
    }));
  }

  /** What a message arriving changes besides the messages held: badges, typing, the outbox. */
  private arrived(s: WorkspaceState, patch: Partial<WorkspaceState>, message: Message): void {
    // A reply belongs to its thread; only what the channel shows moves its badge.
    if (!message.threadRootId || message.broadcast)
      patch.channelLastSeq = {
        ...s.channelLastSeq,
        [message.channelId]: Math.max(s.channelLastSeq[message.channelId] ?? 0, message.seq),
      };
    const settled = s.pending.find((p) => p.userId === message.userId && p.nonce === message.nonce);
    if (settled) {
      for (const a of settled.attachments) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
      this.retryFiles.delete(settled.nonce);
      this.uploadedFiles.delete(settled.nonce);
      patch.pending = s.pending.filter((p) => p.nonce !== message.nonce);
    }
    const typing = s.typing[message.channelId];
    if (typing?.[message.userId]) {
      const { [message.userId]: _gone, ...rest } = typing;
      patch.typing = { ...s.typing, [message.channelId]: rest };
    }
  }

  /** Keeps an event for each history page in flight that it may change. */
  private holdForLoads(envelope: EventEnvelope & { event: MessageEvent }): void {
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

  /**
   * The server's answer to a send, which can arrive before its event. The
   * message takes its pending copy's place at once; its event, when it
   * comes, changes nothing more.
   */
  private settleSent(message: Message): void {
    const s = this.state;
    if (!s.channels[message.channelId]) return;
    if (!s.pending.some((p) => p.userId === message.userId && p.nonce === message.nonce)) return;
    if (message.seq > s.lastSeq) this.acknowledgedMessages.add(message.id);
    const envelope = { seq: message.seq, event: { type: "message.created" as const, message } };
    const patch: Partial<WorkspaceState> = liveMessages(s, envelope, false);
    this.arrived(s, patch, message);
    this.holdForLoads(envelope);
    this.store.setState(patch);
    this.writes.reshow();
  }

  private applyEvent(envelope: EventEnvelope): void {
    const { event, seq } = envelope;
    const s = this.state;
    if (seq <= s.lastSeq && s.lastSeq !== 0) return;
    const patch: Partial<WorkspaceState> = { lastSeq: seq };
    if (event.type === "message.created" && this.acknowledgedMessages.delete(event.message.id)) {
      this.store.setState(patch);
      return;
    }
    // The snapshot already says how channels, members and people are now.
    const inSnapshot = seq <= this.connectedAtSeq;
    const changed = (channelId: ID) => {
      patch.changedContent = { ...s.changedContent, [channelId]: seq };
    };
    /** The server's word on writes of this device's, told once the event is applied. */
    const heard: (() => void)[] = [];
    switch (event.type) {
      case "message.created": {
        const message = { ...event.message, seq };
        if (!s.channels[message.channelId]) break;
        this.arrived(s, patch, message);
        if (message.userId !== s.self?.id)
          this.events.emit("message", message, { live: seq > this.connectedAtSeq });
        break;
      }
      case "message.updated": {
        // Previews found or removed are not an edit: nothing quoting the
        // message changes, and Activity has nothing new to show (E2). Nor are
        // a poll's votes (E6).
        if (!event.previewsOnly && !event.pollOnly) changed(event.message.channelId);
        if (event.pollOnly && !event.message.poll?.anonymous) {
          const messageId = event.message.id;
          const mine = serverPollChoices(event.message, s.self?.id, null);
          this.settlePollPick(s, patch, messageId, mine);
          heard.push(() => this.writes.heard({ kind: "poll", messageId }, pollChoicesKey(mine)));
        }
        break;
      }
      case "history.removed": {
        this.files.invalidateRoots(event.channelId, event.rootIds);
        const gone = new Set(event.rootIds);
        const threadFollows = { ...s.threadFollows };
        const saved = { ...s.saved };
        for (const rootId of gone) {
          delete threadFollows[rootId];
          delete saved[rootId];
          this.threadLoads.delete(rootId);
          this.reloadThreads.delete(rootId);
        }
        patch.threadFollows = threadFollows;
        patch.saved = saved;
        // Their reminders went with them on the server.
        patch.reminders = Object.fromEntries(
          Object.entries(s.reminders).filter(
            ([messageId, reminder]) =>
              !gone.has(messageId) && !(reminder.threadRootId && gone.has(reminder.threadRootId)),
          ),
        );
        patch.removedHistory = { ...s.removedHistory, [event.channelId]: seq };
        changed(event.channelId);
        break;
      }
      case "message.deleted": {
        changed(event.channelId);
        this.events.emit("messageDeleted", event.messageId);
        if (s.pollChoices[event.messageId]) {
          const { [event.messageId]: _gone, ...pollChoices } = s.pollChoices;
          patch.pollChoices = pollChoices;
        }
        if (s.pollPicks[event.messageId]) {
          const { [event.messageId]: _gone, ...pollPicks } = s.pollPicks;
          patch.pollPicks = pollPicks;
        }
        // Its files go with it, whether or not its history is still loaded (F07).
        this.files.invalidateMessage(event.messageId);
        break;
      }
      case "reaction.added":
      case "reaction.removed": {
        if (event.userId !== s.self?.id) break;
        const key = { kind: "reaction", messageId: event.messageId, emoji: event.emoji } as const;
        heard.push(() => this.writes.heard(key, event.type === "reaction.added"));
        break;
      }
      case "pin.added":
      case "pin.removed": {
        changed(event.channelId);
        const pinned = event.type === "pin.added";
        heard.push(() => this.writes.heard({ kind: "pin", messageId: event.messageId }, pinned));
        break;
      }
      case "channel.created":
      case "channel.updated": {
        if (inSnapshot) break;
        patch.channels = { ...s.channels, [event.channel.id]: event.channel };
        if (
          event.type === "channel.created" &&
          event.channel.memberIds?.includes(s.self?.id ?? "")
        ) {
          patch.memberships = { ...s.memberships, [event.channel.id]: 0 };
          patch.repliesRead = joined(s.repliesRead, event.channel.id, seq);
        }
        break;
      }
      case "member.joined": {
        if (inSnapshot) break;
        patch.memberChanges = { ...s.memberChanges, [event.channelId]: seq };
        if (event.userId === s.self?.id) {
          // Joined with what was there read, as the server keeps it.
          patch.memberships = {
            ...s.memberships,
            [event.channelId]: s.memberships[event.channelId] ?? seq,
          };
          if (!(event.channelId in s.memberships))
            patch.repliesRead = joined(s.repliesRead, event.channelId, seq);
        }
        const ch = s.channels[event.channelId];
        if (ch?.memberIds && !ch.memberIds.includes(event.userId)) {
          patch.channels = {
            ...s.channels,
            [ch.id]: { ...ch, memberIds: [...ch.memberIds, event.userId] },
          };
        }
        break;
      }
      case "member.left": {
        if (inSnapshot) break;
        patch.memberChanges = { ...s.memberChanges, [event.channelId]: seq };
        if (event.userId === s.self?.id) {
          changed(event.channelId);
          const { [event.channelId]: _gone, ...rest } = s.memberships;
          patch.memberships = rest;
          const { [event.channelId]: _floor, ...repliesRead } = s.repliesRead;
          patch.repliesRead = repliesRead;
          // Notification settings belong to the membership, which a rejoin
          // starts afresh, and a choice still being saved has nowhere to go.
          const { [event.channelId]: _prefs, ...prefs } = s.prefs;
          const { [event.channelId]: _write, ...prefsWrites } = s.prefsWrites;
          patch.prefs = prefs;
          patch.prefsWrites = prefsWrites;
          this.writes.forget({ kind: "prefs", channelId: event.channelId });
        }
        const ch = s.channels[event.channelId];
        if (ch?.memberIds) {
          patch.channels = {
            ...s.channels,
            [ch.id]: { ...ch, memberIds: ch.memberIds.filter((id) => id !== event.userId) },
          };
        }
        break;
      }
      case "user.joined":
      case "user.updated": {
        if (inSnapshot) break;
        const user = event.user;
        patch.users = { ...s.users, [user.id]: user };
        if (user.id === s.self?.id) {
          patch.self = user;
          heard.push(() => this.writes.heard({ kind: "dnd" }, user.dndUntil));
        }
        break;
      }
      default:
        unhandled(event);
    }
    if (isMessageEvent(event)) {
      const message = { ...envelope, event };
      Object.assign(patch, liveMessages({ ...s, ...patch }, message, true));
      this.holdForLoads(message);
    }
    this.store.setState(patch);
    for (const tell of heard) tell();
  }

  private applyEphemeral(event: EphemeralEvent): void {
    const s = this.store.getState();
    switch (event.type) {
      case "friends":
        this.store.setState({ friends: event.friends });
        break;
      case "blocks":
        this.store.setState({ blocked: event.blocked });
        break;
      case "reports":
        this.store.setState({ openReports: event.open });
        break;
      case "workspace.renamed":
        this.store.setState({ workspaceName: event.workspaceName });
        break;
      case "workspace.accessPolicy":
        this.store.setState({ accessPolicy: event.accessPolicy });
        break;
      case "workspace.linkPreviews":
        this.store.setState({ linkPreviews: event.enabled });
        break;
      case "workspace.icon":
        this.store.setState({ iconVersion: event.iconVersion });
        break;
      case "channel.access": {
        if (!event.channel) {
          this.removeChannel(event.channelId);
          break;
        }
        const memberships = { ...s.memberships };
        const repliesRead = { ...s.repliesRead };
        const prefs = { ...s.prefs };
        const prefsWrites = { ...s.prefsWrites };
        if (event.membership) {
          memberships[event.channelId] = event.membership.lastReadSeq;
          repliesRead[event.channelId] = event.membership.repliesReadSeq;
          prefs[event.channelId] = event.membership.prefs;
        } else {
          delete memberships[event.channelId];
          delete repliesRead[event.channelId];
          delete prefs[event.channelId];
          delete prefsWrites[event.channelId];
          this.writes.forget({ kind: "prefs", channelId: event.channelId });
        }
        this.store.setState({
          channels: { ...s.channels, [event.channelId]: event.channel },
          memberships,
          repliesRead,
          prefs,
          prefsWrites,
        });
        if (event.membership)
          this.writes.heard({ kind: "prefs", channelId: event.channelId }, event.membership.prefs);
        break;
      }
      case "presence":
        this.store.setState({ presence: { ...s.presence, [event.userId]: event.presence } });
        break;
      case "huddle.participants": {
        const huddles = { ...s.huddles };
        if (event.userIds.length > 0) huddles[event.channelId] = event.userIds;
        else delete huddles[event.channelId];
        this.store.setState({ huddles });
        // Reconcile our own mesh against the new roster.
        if (this.session?.channelId === event.channelId && this.huddleAdmitted) {
          this.session.syncParticipants(event.userIds);
          this.publishHuddleState();
        }
        break;
      }
      case "huddle.ring": {
        // Over once it rings nobody; the server forgets it then too.
        const rings = { ...s.rings };
        const before = rings[event.ring.channelId];
        if (event.ring.ringing.length > 0) rings[event.ring.channelId] = event.ring;
        else delete rings[event.ring.channelId];
        const message = this.ringNoticeFor(before, event.ring);
        this.store.setState({
          rings,
          ...(message
            ? { ringNotice: { channelId: event.ring.channelId, message, at: Date.now() } }
            : {}),
        });
        break;
      }
      case "huddle.moved":
        // The server already gave the place to the other device; saying so
        // again here would only be refused.
        if (this.session?.channelId === event.channelId)
          this.endHuddle(
            {
              message: "You joined this huddle on another device, so it ended here.",
              error: false,
            },
            false,
          );
        break;
      case "huddle.join.result": {
        const pending = this.pendingHuddleJoin;
        if (pending?.channelId === event.channelId && pending.requestId === event.requestId) {
          if (event.accepted) this.huddleAdmitted = true;
          pending.finish(event.accepted ? undefined : new HuddleJoinRefusedError(event.message));
        }
        break;
      }
      case "huddle.signal":
        if (this.session?.channelId === event.channelId && this.huddleAdmitted) {
          void this.session.handleSignal(event.from, event.signal);
        }
        break;
      case "channel.read": {
        if (!(event.channelId in s.memberships)) break;
        // While a conversation is deliberately unread, an acknowledgement still
        // in flight when it was marked must not raise the cursor back.
        if (this.readHold.has(event.channelId)) break;
        const pending = this.pendingReads.get(event.channelId) ?? 0;
        if (pending <= event.seq) this.pendingReads.delete(event.channelId);
        this.store.setState({
          memberships: {
            ...s.memberships,
            [event.channelId]: Math.max(s.memberships[event.channelId] ?? 0, event.seq),
          },
        });
        break;
      }
      case "prefs":
        // What this or another device saved; a choice still being saved from
        // here stays on top until its own answer comes back.
        if (!this.writes.heard({ kind: "prefs", channelId: event.channelId }, event.prefs))
          this.store.setState({ prefs: { ...s.prefs, [event.channelId]: event.prefs } });
        break;
      case "saved":
        if (!this.writes.heard({ kind: "save", messageId: event.messageId }, event.saved))
          this.store.setState({ saved: withSaved(s.saved, event.messageId, event.saved) });
        break;
      case "mentions":
        this.store.setState({ mentionCounts: event.counts });
        break;
      case "channel.unread":
        this.pendingReads.delete(event.channelId);
        this.store.setState({
          memberships: { ...s.memberships, [event.channelId]: event.seq },
        });
        break;
      case "thread.follow":
        this.applyThreadFollow(event.state);
        break;
      case "reminder": {
        const known = s.reminders[event.reminder.messageId];
        this.store.setState({
          reminders: { ...s.reminders, [event.reminder.messageId]: event.reminder },
        });
        // Told once as it comes due; the same reminder told again is not news.
        if (event.message && event.reminder.dueAt !== null && known?.dueAt !== event.reminder.dueAt)
          this.events.emit("reminderDue", event.reminder, event.message);
        break;
      }
      case "reminder.removed": {
        if (!s.reminders[event.messageId]) break;
        const { [event.messageId]: _gone, ...reminders } = s.reminders;
        this.store.setState({ reminders });
        break;
      }
      case "channel.removal":
        this.store.setState({
          channelRemovals: { ...s.channelRemovals, [event.removal.id]: event.removal },
        });
        break;
      case "channel.removals.read":
        this.forgetRemovals(event.ids);
        break;
      case "notify.default":
        if (!this.writes.heard({ kind: "notifyDefault" }, event.level))
          this.store.setState({ notifyDefault: event.level });
        break;
      case "sidebar.sections":
        // A reorder of this device's still on its way is not undone by an older word.
        if (!this.writes.heard({ kind: "sectionOrder" }, event.sections))
          this.store.setState({ sidebarSections: event.sections });
        break;
      case "poll.choices": {
        const pollChoices = { ...s.pollChoices };
        if (event.choices.length > 0) pollChoices[event.messageId] = event.choices;
        else delete pollChoices[event.messageId];
        const patch: Partial<WorkspaceState> = { pollChoices };
        this.settlePollPick(s, patch, event.messageId, event.choices);
        this.store.setState(patch);
        this.writes.heard(
          { kind: "poll", messageId: event.messageId },
          pollChoicesKey(event.choices),
        );
        break;
      }
      case "scheduled":
        this.store.setState({ scheduledChanges: s.scheduledChanges + 1 });
        break;
      case "ephemeral.message":
        this.addEphemeral({
          id: event.id,
          channelId: event.channelId,
          userId: event.userId,
          text: event.text,
          createdAt: event.createdAt,
        });
        break;
      case "view.open": {
        // The server says what is open now, bottom first.
        const stack = event.stack?.length ? event.stack : [event.view];
        this.store.setState({ modal: stack.at(-1)!, modalsBelow: stack.slice(0, -1) });
        break;
      }
      case "view.close":
        this.forgetModals(event.viewIds);
        break;
      case "typing":
        if (event.userId === s.self?.id) break;
        this.store.setState({
          typing: {
            ...s.typing,
            [event.channelId]: { ...s.typing[event.channelId], [event.userId]: Date.now() + 5000 },
          },
        });
        break;
      default:
        unhandled(event);
    }
  }

  private sweepTyping(): void {
    const s = this.store.getState();
    const now = Date.now();
    let changed = false;
    const typing: WorkspaceState["typing"] = {};
    for (const [chId, byUser] of Object.entries(s.typing)) {
      const kept = Object.fromEntries(Object.entries(byUser).filter(([, exp]) => exp > now));
      if (Object.keys(kept).length !== Object.keys(byUser).length) changed = true;
      if (Object.keys(kept).length > 0) typing[chId] = kept;
    }
    if (changed) this.store.setState({ typing });
  }

  // ---------- actions ----------

  /** Takes forms off the stack; the one left on top, if any, is shown. */
  private forgetModals(viewIds: readonly ID[]): void {
    const { modal, modalsBelow } = this.state;
    const open = [...modalsBelow, ...(modal ? [modal] : [])];
    const kept = open.filter((view) => !viewIds.includes(view.id));
    if (kept.length === open.length) return;
    this.store.setState({ modal: kept.at(-1) ?? null, modalsBelow: kept.slice(0, -1) });
  }

  /**
   * Closes the form without answering it, going back to the one under it if
   * there is one. The server is told so the person's other devices follow;
   * the app is told nothing, as in Slack.
   */
  dismissModal(viewId = this.state.modal?.id): void {
    if (!viewId || this.state.modal?.id !== viewId) return;
    this.forgetModals([viewId]);
    void this.api.closeView(viewId).catch(() => {});
  }

  dismissAllModals(): void {
    const { modal, modalsBelow } = this.state;
    const root = modalsBelow[0] ?? modal;
    if (!root) return;
    this.forgetModals([...modalsBelow, ...(modal ? [modal] : [])].map((view) => view.id));
    void this.api.closeView(root.id).catch(() => {});
  }

  /**
   * Sends the filled-in form. Field errors come back keyed by block so the UI
   * can put each one under the field it belongs to; the form stays open then.
   */
  async submitModal(
    values: Record<string, Record<string, string | string[]>>,
    viewId = this.state.modal?.id,
  ): Promise<ViewSubmitted | ApiError> {
    const modal = this.state.modal;
    if (!modal || modal.id !== viewId)
      return { ok: false, errors: {}, message: "This form is no longer available." };
    const result = await answerOf(() => this.api.submitView(modal.id, values));
    // The server names what closed: none when the app changed the form or
    // stacked another on it. Only ever closing keeps a late answer from
    // reopening one.
    if (!(result instanceof ApiError) && result.ok) this.forgetModals(result.closedViewIds);
    return result;
  }

  /** Visible history is protected while inactive caches are evicted by recency. */
  focusConversation(channelId: ID | null): void {
    for (const held of this.readHold) if (held !== channelId) this.readHold.delete(held);
    this.activeConversation = channelId;
    if (channelId) this.touchHistory("timeline", channelId);
  }

  focusThread(rootId: ID | null): void {
    for (const held of this.threadReadHold) if (held !== rootId) this.threadReadHold.delete(held);
    this.activeThread = rootId;
    if (rootId) this.touchHistory("thread", rootId);
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
    page: { messages: Message[]; seq: number | undefined },
    shape: Pick<ChannelTimeline, "hasMore" | "hasMoreNewer" | "readThroughSeq" | "snapshotSeq">,
    join: { side: "before" | "after"; captured: CapturedTimeline } | null,
    drop: "oldest" | "newest",
  ): void {
    const replayed = this.timelineEvents(ticket, page.seq);
    if (join) {
      const since = Math.min(page.seq ?? 0, ticket.startSeq);
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

  /**
   * Loads the newest page, or the page before what is loaded with `older`.
   * `unreadAfter` is the seq the reader had read up to: when every message in
   * the newest page is after it and there are older ones, the conversation
   * opens instead on a window around the first unread, so it starts at its
   * New line rather than with the rest of what was missed out of sight above.
   * Settles once done; how it went is in `timelineStatus`.
   */
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

  /**
   * Marks a channel read through the newest of its history loaded here; not
   * while its timeline is anchored away from the newest, which is not on screen.
   */
  readLoadedTail(channelId: ID): void {
    const timeline = this.state.timelines[channelId];
    if (!timeline?.loaded || timeline.hasMoreNewer) return;
    const newest = timelineMessages(this.state, channelId).at(-1)?.seq ?? 0;
    this.markRead(channelId, timeline.readThroughSeq ?? newest);
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
        readThroughSeq: readThroughSeq ?? messages[0]?.seq ?? 0,
        snapshotSeq: seq,
      },
      null,
      "oldest",
    );
  }

  /**
   * Replaces the timeline with a window centred on `messageId`, for jumping to
   * a search hit or a pinned message. Answers the thread the message is in
   * (null when none), or undefined when another jump or window overtook it.
   */
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

  /**
   * Pages forward from an anchored view back toward the newest messages.
   * Settles once done; how it went is in `timelineStatus`.
   */
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

  /**
   * Keeps the current window visible until the live tail has loaded
   * successfully; how it went is in `timelineStatus`.
   */
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
          response.root ? [response.root, ...response.messages] : response.messages,
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
          threads: { ...cache.threads, [threadRootId]: response.root ? ids : [] },
          threadPages: {
            ...cache.threadPages,
            [threadRootId]: {
              channelId,
              rootGone: !response.root,
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

  /** Files held for a retry, keyed by nonce — never exposed to the store. */
  private retryFiles = new Map<string, File[]>();
  private uploadedFiles = new Map<string, ID[]>();

  /**
   * Optimistic send: the message (and local image previews) appear instantly,
   * then attachments upload and the server event reconciles it by nonce.
   * A refused send took nothing; the caller keeps the draft.
   */
  send(
    channelId: ID,
    text: string,
    opts: {
      threadRootId?: ID;
      files?: File[];
      alsoSendToChannel?: boolean;
      /** The message this one answers in place; see `quoteOf`. */
      replyTo?: ReplyReference;
      /** The message this one passes on, words of its own or none; see `forwardOf`. */
      forward?: ForwardReference;
      /** Makes it a poll, `text` its question (E6); alone, without files or a forward. */
      poll?: PollDraft;
    } = {},
  ): SendAnswer {
    const self = this.state.self;
    if (!self) return { kind: "refused", reason: "not_connected" };
    const files = opts.files ?? [];
    const forward = opts.forward;
    if (!text.trim() && files.length === 0 && !forward) return { kind: "refused", reason: "empty" };
    // A poll carries nothing else.
    const poll = opts.poll;
    if (poll && (files.length > 0 || forward)) return { kind: "refused", reason: "empty" };

    const command = !poll && !forward && files.length === 0 ? parseCommand(text) : null;
    if (command) {
      if (isInAppCommand(command.name))
        return { kind: "in_app", name: command.name, args: command.args };
      void this.runCommand(channelId, text.trim(), command.name, opts.threadRootId);
      return { kind: "command" };
    }
    if (this.ownPending() >= OUTBOX_LIMIT) return { kind: "refused", reason: "outbox_full" };

    const nonce = newNonce();
    const attachments: LocalAttachment[] = files.map((f) => ({
      name: f.name,
      size: f.size,
      mime: f.type,
      previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : null,
    }));
    const pendingMsg: PendingMessage = {
      nonce,
      channelId,
      threadRootId: opts.threadRootId ?? null,
      broadcast: !!opts.threadRootId && !!opts.alsoSendToChannel,
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      ...(forward ? { forward } : {}),
      ...(poll ? { poll } : {}),
      text,
      userId: self.id,
      createdAt: Date.now(),
      failed: false,
      failureReason: null,
      attachments,
      uploadProgress: files.length > 0 ? 0 : null,
    };
    this.store.setState((s) => ({ pending: [...s.pending, pendingMsg] }));
    if (files.length > 0) this.retryFiles.set(nonce, files);
    const kept = text.trim() ? this.kept.whenKept(nonce) : null;

    void this.deliver(pendingMsg, files);
    return { kind: "queued", nonce, kept };
  }

  private ownPending(): number {
    const self = this.state.self?.id;
    return this.state.pending.filter((p) => p.userId === self).length;
  }

  private async deliver(
    send: Pick<
      PendingMessage,
      "nonce" | "channelId" | "threadRootId" | "broadcast" | "replyTo" | "forward" | "poll" | "text"
    >,
    files: File[],
  ): Promise<void> {
    const { nonce, channelId, text, threadRootId, replyTo, forward, poll } = send;
    const setProgress = (fraction: number) =>
      this.store.setState((s) => ({
        pending: s.pending.map((p) => (p.nonce === nonce ? { ...p, uploadProgress: fraction } : p)),
      }));

    try {
      const fileIds = this.uploadedFiles.get(nonce) ?? [];
      this.uploadedFiles.set(nonce, fileIds);
      for (const [i, file] of files.entries()) {
        if (i < fileIds.length) continue;
        if (!this.stillSending(nonce)) return;
        const { file: uploaded } = await this.api.uploadFile(channelId, file, file.name, {
          onProgress: (fraction) => setProgress((i + fraction) / files.length),
        });
        fileIds.push(uploaded.id);
      }
      if (!this.stillSending(nonce)) return;
      if (files.length > 0) setProgress(1);

      const body: SendMessageBody = {
        text,
        nonce,
        ...(threadRootId ? { threadRootId } : {}),
        ...(threadRootId && send.broadcast ? { alsoSendToChannel: true } : {}),
        ...(fileIds.length > 0 ? { fileIds } : {}),
        ...(replyTo ? { replyToId: replyTo.id, replyPing: replyTo.ping } : {}),
        ...(forward ? { forwardFrom: forward.id } : {}),
        ...(poll ? { poll } : {}),
      };
      const { message } = await this.api.sendMessage(channelId, body);
      if (!this.stopped && this.state.status !== "auth_failed") {
        this.settleSent(message);
      }
    } catch (error) {
      const refused = isRefusal(error);
      // A refusal taken on from another window stays until its author's Retry;
      // not reaching the server from here says nothing new about it.
      if (!refused && this.state.pending.some((p) => p.nonce === nonce && p.refused)) return;
      this.failPending(nonce, sendFailureReason(error), refused);
      if (error instanceof ApiError && error.status === 429)
        this.waitOutRateLimit(nonce, error.retryAfterMs);
    }
  }

  /** Sends turned away for coming too fast, sent again once the wait is over. */
  private rateLimited = new Set<string>();
  private rateLimitTimer: ReturnType<typeof setTimeout> | null = null;
  private rateLimitUntil = 0;

  /**
   * Holds a send the workspace turned away for coming too fast until it said
   * to try again.
   */
  private waitOutRateLimit(nonce: string, waitMs = RATE_LIMIT_WAIT_MS): void {
    if (this.stopped) return;
    this.rateLimited.add(nonce);
    const wait = Math.min(Math.max(waitMs, 250), RATE_LIMIT_WAIT_MAX_MS);
    const until = Date.now() + wait;
    if (this.rateLimitTimer && until <= this.rateLimitUntil) return;
    if (this.rateLimitTimer) clearTimeout(this.rateLimitTimer);
    this.rateLimitUntil = until;
    this.rateLimitTimer = setTimeout(() => {
      this.rateLimitTimer = null;
      void this.resendRateLimited();
    }, wait);
  }

  /**
   * One at a time and in the order they were written, so they neither run
   * into the limit again all together nor arrive out of order. One turned
   * away again starts a new wait, and those after it wait with it.
   */
  private async resendRateLimited(): Promise<void> {
    const waiting = this.state.pending.filter((p) => this.rateLimited.has(p.nonce));
    this.rateLimited.clear();
    for (const p of waiting) {
      if (this.stopped) return;
      if (this.rateLimitTimer) {
        this.rateLimited.add(p.nonce);
        continue;
      }
      await this.resend(p.nonce);
    }
  }

  /** Whether a send is still wanted: not discarded, delivered or refused meanwhile. */
  private stillSending(nonce: string): boolean {
    return !this.stopped && this.state.pending.some((p) => p.nonce === nonce && !p.refused);
  }

  private failPending(nonce: string, failureReason: string, refused = false): void {
    this.store.setState((s) => ({
      pending: s.pending.map((p) =>
        p.nonce === nonce
          ? { ...p, failed: true, failureReason, refused, uploadProgress: null }
          : p,
      ),
    }));
  }

  /**
   * Sends that were lost on the way go again once the workspace answers, as
   * their notice promised. One the server refused waits for its author, and
   * one whose files this window no longer holds would go without them.
   */
  private retryLostSends(): void {
    for (const p of this.state.pending) {
      if (!p.failed || p.refused) continue;
      const files = this.retryFiles.get(p.nonce) ?? [];
      if (p.attachments.length > 0 && files.length !== p.attachments.length) continue;
      this.retrySend(p.nonce);
    }
  }

  retrySend(nonce: string): void {
    void this.resend(nonce);
  }

  /** Sends a failed message again; settles once this try has its answer. */
  private async resend(nonce: string): Promise<void> {
    const p = this.state.pending.find((p) => p.nonce === nonce);
    if (!p?.failed) return;
    const files = this.retryFiles.get(nonce) ?? [];
    // Sending now would post the words without the files the author chose.
    if (p.attachments.length > 0 && files.length !== p.attachments.length) {
      this.failPending(nonce, MISSING_ATTACHMENTS);
      return;
    }
    this.store.setState((s) => ({
      pending: s.pending.map((item) =>
        item.nonce === nonce
          ? { ...item, failed: false, failureReason: null, refused: false }
          : item,
      ),
    }));
    await this.deliver(p, files);
  }

  /**
   * The whole outbox in a form that survives a restart: every send accepted
   * stays, and a known refusal keeps its reason. Preview URLs are not kept.
   */
  outboxSnapshot(): StoredPending[] {
    return this.state.pending.map((p) => ({
      nonce: p.nonce,
      channelId: p.channelId,
      threadRootId: p.threadRootId,
      broadcast: p.broadcast,
      ...(p.replyTo ? { replyTo: p.replyTo } : {}),
      ...(p.forward ? { forward: p.forward } : {}),
      ...(p.poll ? { poll: p.poll } : {}),
      text: p.text,
      userId: p.userId,
      createdAt: p.createdAt,
      attachments: p.attachments.map((a) => ({ name: a.name, size: a.size, mime: a.mime })),
      ...(p.failed && p.refused ? { refusal: p.failureReason ?? "This message was refused." } : {}),
    }));
  }

  /**
   * Puts back work the author had already committed to sending. Re-delivery is
   * safe because the server settles a repeated request key onto the same
   * message, so a send that did reach the server before the restart cannot
   * become a second one. Once retention has removed that message, the server
   * remembers its key only for a while, so a send older than
   * `SEND_RETRY_WINDOW_MS` is not sent again on its own: it waits, saying so,
   * for its author's Retry.
   * Attachments do not survive a restart, so those entries stop and say so
   * instead of posting the words without the files. A send the server refused
   * stays refused until the author chooses Retry: whatever made it refuse may
   * have changed since, and that is theirs to decide. Nothing is dropped for
   * being one too many; every entry here was accepted once.
   */
  restoreOutbox(entries: StoredPending[]): void {
    const self = this.state.self;
    if (!self) return;
    const now = Date.now();
    const restored = entries
      .filter((e) => e.userId === self.id && !this.state.pending.some((p) => p.nonce === e.nonce))
      .map(({ refusal, ...e }): PendingMessage => {
        const reason =
          refusal ??
          (e.attachments.length > 0
            ? MISSING_ATTACHMENTS
            : now - e.createdAt > SEND_RETRY_WINDOW_MS
              ? STALE_SEND
              : null);
        return {
          ...e,
          failed: reason !== null,
          failureReason: reason,
          refused: refusal !== undefined,
          attachments: e.attachments.map((a) => ({ ...a, previewUrl: null })),
          uploadProgress: null,
        };
      });
    if (restored.length === 0) return;
    this.store.setState((s) => ({ pending: [...s.pending, ...restored] }));
    for (const entry of restored) {
      if (entry.failed) continue;
      void this.deliver(entry, []);
    }
  }

  discardSend(nonce: string): void {
    this.dropPending(nonce);
  }

  /**
   * Takes on the refusal another window on this account was given for the
   * same send, so this one stops sending it too and waits for its author's
   * Retry instead of trying again on its own.
   */
  adoptRefusal(nonce: string, reason: string): void {
    const p = this.state.pending.find((x) => x.nonce === nonce);
    if (!p || p.refused) return;
    this.failPending(nonce, reason, true);
  }

  private dropPending(nonce: string): void {
    const p = this.state.pending.find((x) => x.nonce === nonce);
    if (p) {
      for (const a of p.attachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    this.retryFiles.delete(nonce);
    this.uploadedFiles.delete(nonce);
    this.store.setState((s) => ({ pending: s.pending.filter((x) => x.nonce !== nonce) }));
  }

  /** Shows a change to one held message at once, before the server has it. */
  private showOnMessage(messageId: ID, change: (message: Message) => Message): void {
    this.store.setState((s) => {
      const messages = patchMessage(s, messageId, change).messages;
      return messages === s.messages ? {} : { messages };
    });
  }

  private heldOr(message: Message): Message {
    return this.state.messages[message.id] ?? message;
  }

  /**
   * Adds this account's reaction, or takes it back, shown at once (see
   * `OptimisticWrites`). Resolves with the server's refusal, or null.
   */
  toggleReaction(message: Message, emoji: string): Promise<ApiError | null> {
    const selfId = this.state.self?.id;
    if (!selfId) return Promise.resolve(notConnected());
    const mine = (m: Message) =>
      m.reactions.some((g) => g.emoji === emoji && g.userIds.includes(selfId));
    return this.writes.write(
      { kind: "reaction", messageId: message.id, emoji },
      !mine(this.heldOr(message)),
      {
        read: () => mine(this.heldOr(message)),
        show: (on) => this.showOnMessage(message.id, (m) => withReaction(m, emoji, selfId, on)),
        send: async (on) => {
          await (on
            ? this.api.addReaction(message.id, emoji)
            : this.api.removeReaction(message.id, emoji));
        },
      },
    );
  }

  /**
   * Votes in a poll, replacing this account's choices; none takes the vote
   * back. Shown at once; the latest choice is the one that stands. Resolves
   * with the server's refusal, such as for a poll closed meanwhile, or null.
   */
  vote(message: Message, choices: number[]): Promise<ApiError | null> {
    const messageId = message.id;
    const key = { kind: "poll", messageId } as const;
    const anonymous = message.poll?.anonymous ?? false;
    const shown = (s: WorkspaceState) =>
      pollChoicesKey(s.pollPicks[messageId] ?? this.serverChoicesIn(messageId, anonymous, s));
    return this.writes.write(key, pollChoicesKey(choices), {
      read: () => shown(this.state),
      show: (chosen) =>
        this.store.setState((s) => {
          const server = this.serverChoicesIn(messageId, anonymous, s);
          // Settled, and what the server is known to have: nothing to hold.
          if (!this.writes.isPending(key) && pollChoicesKey(server) === chosen) {
            if (!s.pollPicks[messageId]) return {};
            const { [messageId]: _settled, ...pollPicks } = s.pollPicks;
            return { pollPicks };
          }
          return { pollPicks: { ...s.pollPicks, [messageId]: pollChoicesOfKey(chosen) } };
        }),
      send: async (chosen) => {
        const answer = await this.api.votePoll(messageId, pollChoicesOfKey(chosen));
        if (anonymous)
          this.store.setState((s) => {
            const pollChoices = { ...s.pollChoices };
            if (answer.choices.length > 0) pollChoices[messageId] = answer.choices;
            else delete pollChoices[messageId];
            return { pollChoices };
          });
        return pollChoicesKey(answer.choices);
      },
    });
  }

  /** Its author closes a poll for good. Resolves with the server's refusal, or null. */
  closePoll(message: Message): Promise<ApiError | null> {
    return doneOf(async () => {
      const { message: closed } = await this.api.closePoll(message.id);
      const closedAt = closed.poll?.closedAt ?? null;
      // Only that it closed: the counts are whatever was last heard.
      this.showOnMessage(message.id, (m) =>
        m.poll && m.poll.closedAt === null ? { ...m, poll: { ...m.poll, closedAt } } : m,
      );
    });
  }

  /** What the server has as this account's choices in a poll, from what is held of it. */
  private serverChoicesIn(messageId: ID, anonymous: boolean, s = this.state): number[] {
    if (anonymous) return s.pollChoices[messageId] ?? [];
    const message = s.messages[messageId];
    return message ? serverPollChoices(message, s.self?.id, null) : [];
  }

  /**
   * The server is heard to have `server` as this account's choices in a poll.
   * A pick made here and settled is dropped once it matches; one still being
   * sent stays shown until its answer.
   */
  private settlePollPick(
    s: WorkspaceState,
    patch: Partial<WorkspaceState>,
    messageId: ID,
    server: number[],
  ): void {
    const picks = patch.pollPicks ?? s.pollPicks;
    const picked = picks[messageId];
    if (!picked || this.writes.isPending({ kind: "poll", messageId })) return;
    if (pollChoicesKey(picked) !== pollChoicesKey(server)) return;
    const { [messageId]: _settled, ...rest } = picks;
    patch.pollPicks = rest;
  }

  /** Pins a message or takes its pin off, shown at once; the channel-wide event confirms it. */
  togglePin(message: Message): Promise<ApiError | null> {
    return this.writes.write({ kind: "pin", messageId: message.id }, !message.pinned, {
      read: () => this.heldOr(message).pinned,
      show: (pinned) =>
        this.showOnMessage(message.id, (m) => (m.pinned === pinned ? m : { ...m, pinned })),
      send: async (pinned) => {
        await (pinned ? this.api.pinMessage(message.id) : this.api.unpinMessage(message.id));
      },
    });
  }

  /**
   * Saves a message for later or lets it go, shown at once; this account's
   * devices get the echo. Pass `save` to repeat an earlier intent, so trying a
   * refused save again saves even if the state has changed elsewhere since,
   * rather than flipping.
   */
  toggleSaved(messageId: ID, save = !this.state.saved[messageId]): Promise<ApiError | null> {
    return this.writes.write({ kind: "save", messageId }, save, {
      read: () => !!this.state.saved[messageId],
      show: (on) =>
        this.store.setState((s) =>
          !!s.saved[messageId] === on ? {} : { saved: withSaved(s.saved, messageId, on) },
        ),
      send: async (on) => {
        await (on ? this.api.saveMessage(messageId) : this.api.unsaveMessage(messageId));
      },
    });
  }

  /**
   * Follow updates can arrive from this device and another at once. The
   * revision decides, so a stale echo cannot undo a newer choice.
   */
  private applyThreadFollow(state: ThreadFollow): void {
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

  /** Follows a thread or stops, shown at once; other devices get the echo. */
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

  /**
   * Mutes a thread or lifts its mute, shown at once. Muting unfollows it, and
   * lifting a mute leaves it unfollowed; neither reads it.
   */
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

  /**
   * Sets a reminder about a message, or moves the one there, once the server
   * has it. Resolves with its refusal, such as for a time already past, or null.
   */
  setReminder(messageId: ID, at: number): Promise<ApiError | null> {
    return doneOf(async () => {
      const { reminder } = await this.api.setReminder(messageId, at);
      this.store.setState((s) => ({ reminders: { ...s.reminders, [messageId]: reminder } }));
    });
  }

  /** Removes a reminder, done or cancelled. One already gone counts as removed. */
  async cancelReminder(messageId: ID): Promise<ApiError | null> {
    try {
      await this.api.cancelReminder(messageId);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) return failureOf(error);
    }
    this.store.setState((s) => {
      if (!s.reminders[messageId]) return {};
      const { [messageId]: _gone, ...reminders } = s.reminders;
      return { reminders };
    });
    return null;
  }

  /**
   * Reads notes that someone removed this account from channels, which clears
   * them from Activity at once and from this account's other devices once the
   * server has it. If it could not be told, the notes are back, and this
   * resolves with why.
   */
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

  private forgetRemovals(ids: ID[]): void {
    this.store.setState((s) => {
      if (!ids.some((id) => id in s.channelRemovals)) return {};
      const channelRemovals = { ...s.channelRemovals };
      for (const id of ids) delete channelRemovals[id];
      return { channelRemovals };
    });
  }

  /**
   * Marks a thread read up to its loaded tail. This is the only cursor that
   * reading a thread moves: the channel's stays put, so unseen channel
   * messages and mentions stay unread. A thread you do not follow keeps its
   * cursor too, without following it. `through`, a reply named from outside
   * the thread such as in Activity, reads it up to that reply instead, loaded
   * or not. A read waits for no follow or mute: it moves only the cursor.
   */
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

  /**
   * Renames the workspace, for its owner and admins, and shows the name the
   * server kept as soon as it answers, rather than when its event arrives.
   */
  renameWorkspace(name: string): Promise<string | ApiError> {
    return answerOf(async () => {
      const { workspaceName } = await this.api.renameWorkspace(name);
      if (!this.stopped) this.store.setState({ workspaceName });
      return workspaceName;
    });
  }

  /**
   * Changes who may join, for its owner and admins, and shows what the server
   * kept as soon as it answers. Leaving guests allowed signs every guest out.
   */
  setAccessPolicy(policy: AccessPolicy): Promise<ApiError | null> {
    return doneOf(async () => {
      const { accessPolicy } = await this.api.setAccessPolicy(policy);
      if (!this.stopped) this.store.setState({ accessPolicy });
    });
  }

  /** Turns link previews on or off, for its owner and admins, and shows the answer at once. */
  setLinkPreviews(enabled: boolean): Promise<ApiError | null> {
    return doneOf(async () => {
      const answer = await this.api.setLinkPreviews(enabled);
      if (!this.stopped) this.store.setState({ linkPreviews: answer.enabled });
    });
  }

  /**
   * Takes a preview off one of this account's messages. It goes from view at
   * once; the server's `message.updated` says the same, and a refusal puts it
   * back and resolves with why.
   */
  removeLinkPreview(message: Message, previewId: ID): Promise<ApiError | null> {
    const has = (m: Message) => m.previews.some((p) => p.id === previewId);
    return this.writes.write({ kind: "linkPreview", previewId }, false, {
      read: () => has(this.heldOr(message)),
      show: (shown) =>
        this.showOnMessage(message.id, (m) => {
          if (has(m) === shown) return m;
          return shown
            ? { ...m, previews: message.previews }
            : { ...m, previews: m.previews.filter((p) => p.id !== previewId) };
        }),
      send: async () => {
        await this.api.removeLinkPreview(previewId);
      },
    });
  }

  /**
   * Sets the workspace's icon, for its owner and admins, and shows the new
   * one as soon as the server keeps it, rather than when its event arrives.
   */
  setWorkspaceIcon(image: Blob): Promise<ApiError | null> {
    return doneOf(async () => {
      const { iconVersion } = await this.api.setWorkspaceIcon(image);
      if (!this.stopped) this.store.setState({ iconVersion });
    });
  }

  /**
   * Adds a section to this account's sidebar, last, and gives it once the
   * server has it; the refusal instead, such as at the limit (E8).
   */
  createSidebarSection(name: string): Promise<SidebarSection | ApiError> {
    return answerOf(async () => {
      const { section, sections } = await this.api.createSidebarSection(name);
      this.keepSections(sections);
      return section;
    });
  }

  renameSidebarSection(id: ID, name: string): Promise<ApiError | null> {
    return doneOf(async () =>
      this.keepSections((await this.api.renameSidebarSection(id, name)).sections),
    );
  }

  /** Deletes one of this account's sections; its conversations go back where they would be. */
  deleteSidebarSection(id: ID): Promise<ApiError | null> {
    return doneOf(async () =>
      this.keepSections((await this.api.deleteSidebarSection(id)).sections),
    );
  }

  /**
   * Puts this account's sections in a new order, shown at once. A refusal,
   * such as a section added on another device meanwhile, shows the list the
   * server last told this one.
   */
  orderSidebarSections(ids: ID[]): Promise<ApiError | null> {
    return this.writes.write<SidebarSection[], ID[]>({ kind: "sectionOrder" }, ids, {
      read: () => this.state.sidebarSections,
      show: (sidebarSections) => this.store.setState({ sidebarSections }),
      send: async (order) => (await this.api.orderSidebarSections(order)).sections,
      apply: (sections, order) => {
        const byId = new Map(sections.map((section) => [section.id, section]));
        return order.flatMap((id) => byId.get(id) ?? []);
      },
    });
  }

  private keepSections(sections: SidebarSection[]): void {
    if (this.stopped) return;
    if (!this.writes.heard({ kind: "sectionOrder" }, sections))
      this.store.setState({ sidebarSections: sections });
  }

  /** Removes the workspace's icon, for its owner and admins, at once here too. */
  removeWorkspaceIcon(): Promise<ApiError | null> {
    return doneOf(async () => {
      await this.api.removeWorkspaceIcon();
      if (!this.stopped) this.store.setState({ iconVersion: null });
    });
  }

  /**
   * Shows a notification choice for one channel at once, then saves it. If
   * the server refuses, the channel shows what the server has, and the
   * choice is kept in `prefsWrites` to try again, unless a later choice has
   * already replaced it: an earlier request failing never undoes a later one.
   */
  setChannelPrefs(channelId: ID, patch: Partial<ChannelPrefs>): Promise<ApiError | null> {
    // A level chosen here is this conversation's own from now on, as the
    // server will say; shown so at once.
    if (patch.notifyLevel !== undefined && patch.notifyChosen === undefined)
      patch = { ...patch, notifyChosen: true };
    return this.writes.write({ kind: "prefs", channelId }, patch, this.prefsSpec(channelId));
  }

  /** Tries again to save the notification choice for a channel that failed. */
  retryChannelPrefs(channelId: ID): void {
    void this.writes.retry({ kind: "prefs", channelId });
  }

  private prefsSpec(channelId: ID): WriteSpec<ChannelPrefs, Partial<ChannelPrefs>> {
    return {
      read: () => this.state.prefs[channelId] ?? DEFAULT_CHANNEL_PREFS,
      show: (prefs, { saving, failed }) =>
        this.store.setState((s) => {
          const prefsWrites = { ...s.prefsWrites };
          const unsaved = failed && Object.keys(failed).length > 0 ? failed : null;
          if (saving || unsaved) prefsWrites[channelId] = { saving, failed: unsaved };
          else delete prefsWrites[channelId];
          return { prefs: { ...s.prefs, [channelId]: prefs }, prefsWrites };
        }),
      send: async (change) => (await this.api.setChannelPrefs(channelId, change)).prefs,
      merge: (earlier, later) => ({ ...earlier, ...later }),
      apply: (prefs, change) => ({ ...prefs, ...change }),
      unreplaced: (change, replacement) => {
        const rest = omitKeys(change, Object.keys(replacement));
        return Object.keys(rest).length > 0 ? rest : null;
      },
      keepFailed: true,
      same: (a, b) =>
        Object.keys({ ...a, ...b }).every(
          (key) => a[key as keyof ChannelPrefs] === b[key as keyof ChannelPrefs],
        ),
    };
  }

  /** Snooze notifications for `minutes`, or pass null to clear Do Not Disturb. */
  snoozeNotifications(minutes: number | null): Promise<ApiError | null> {
    return this.snoozeNotificationsUntil(minutes === null ? null : Date.now() + minutes * 60_000);
  }

  /**
   * Pause notifications until an epoch ms time; null resumes them now. The
   * server ends with the latest snooze chosen here, whatever order the
   * requests reach it in; if that one is refused, only the snooze goes back,
   * to what the server last said, and the rest of the profile is left as it
   * now is.
   */
  snoozeNotificationsUntil(dndUntil: number | null): Promise<ApiError | null> {
    if (!this.state.self) return Promise.resolve(notConnected());
    return this.writes.write({ kind: "dnd" }, dndUntil, {
      read: () => this.state.self?.dndUntil ?? null,
      show: (until) =>
        this.store.setState((s) => {
          if (!s.self || s.self.dndUntil === until) return {};
          const self = { ...s.self, dndUntil: until };
          return { self, users: { ...s.users, [self.id]: self } };
        }),
      send: async (until) => (await this.api.updateMe({ dndUntil: until })).user.dndUntil,
    });
  }

  // ---------- huddles ----------

  private session: HuddleSession | null = null;
  /** How tall the call draws everyone's pictures; see `setCallViews`. */
  private callViews: ReadonlyMap<ID, CallView> = new Map();
  private huddleAttempt = 0;
  private huddleAdmitted = false;
  /** Whether the session was let into its huddle, so a returning socket asks to go on with it. */
  private inHuddle = false;
  private rejoins = 0;
  /** The call log of the last huddle, kept after leaving it for Diagnostics. */
  private lastCallLog: CallLogLine[] = [];
  private pendingHuddleJoin: {
    channelId: ID;
    requestId: string;
    finish: (error?: Error) => void;
  } | null = null;

  /**
   * Every step of the current huddle, or of the last one after leaving it:
   * for Diagnostics, so someone who cannot connect can show why.
   */
  callLog(): CallLogLine[] {
    return [...(this.session?.log ?? this.lastCallLog)];
  }

  /** Mirrors the live session into the store so React can render it. */
  private publishHuddleState(): void {
    this.store.setState({ huddle: this.session?.state() ?? null });
  }

  /**
   * Joins the channel's huddle, starting one if nobody is in it, with the
   * microphone off when `muted`, and the devices chosen in Voice & video
   * settings. Throws if the microphone is unavailable or admission fails,
   * releasing local media and leaving no half-joined room.
   */
  async joinHuddle(
    channelId: ID,
    options: {
      muted?: boolean;
      microphone?: MicrophoneSettings;
      cameraId?: string;
      noiseFilter?: NoiseFilter;
      systemMicrophone?: OpenSystemMicrophone;
    } = {},
  ): Promise<void> {
    this.leaveHuddle();
    const attempt = this.huddleAttempt;
    const selfId = this.state.self?.id;
    if (!selfId) return;
    this.store.setState({ huddleEnded: null, ringNotice: null });

    let config: RTCConfiguration;
    try {
      config = await this.api.rtcConfig();
    } catch (err) {
      this.lastCallLog = [
        {
          at: Date.now(),
          text: `Could not read the call settings: ${err instanceof Error ? err.message : String(err)}.`,
        },
      ];
      throw err;
    }
    if (attempt !== this.huddleAttempt) return;

    // Calls are loaded when someone joins one, not with every visit.
    const { HuddleSession } = await import("./huddle.js");
    if (attempt !== this.huddleAttempt) return;
    const session = new HuddleSession(
      channelId,
      selfId,
      {
        send: (msg) => this.sendSocket(msg),
      },
      config,
      {
        refreshConfig: () => this.api.rtcConfig(),
        microphone: options.microphone,
        cameraId: options.cameraId,
        noiseFilter: options.noiseFilter,
        systemMicrophone: options.systemMicrophone,
        onReport: (peer, report) => {
          if (this.session === session)
            this.sendSocket({ type: "huddle.report", channelId, peer, report });
        },
      },
    );
    session.setViews(this.callViews);
    this.session = session;
    this.lastCallLog = session.log;
    try {
      await session.startLocalAudio(options.muted);
    } catch (err) {
      session.destroy();
      if (this.session === session) this.session = null;
      // Said as what to do about it, not as the browser's "Permission denied".
      throw new Error(captureFailure("microphone", err) ?? "Your microphone could not start.", {
        cause: err,
      });
    }
    if (attempt !== this.huddleAttempt) {
      session.destroy();
      return;
    }
    try {
      const requestId = `join-${attempt}`;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingHuddleJoin?.finish(
            new Error("The huddle did not answer. Check your connection, then try again."),
          );
        }, 10_000);
        this.pendingHuddleJoin = {
          channelId,
          requestId,
          finish: (error) => {
            clearTimeout(timer);
            this.pendingHuddleJoin = null;
            if (error) reject(error);
            else resolve();
          },
        };
        this.sendSocket({ type: "huddle.join", channelId, requestId });
        session.note("Asked the server to join the huddle.");
      });
      session.note("The server let this device into the huddle.");
    } catch (error) {
      session.note(`Not let in: ${error instanceof Error ? error.message : String(error)}`);
      session.destroy();
      if (this.session === session) {
        this.session = null;
        if (!(error instanceof HuddleJoinRefusedError))
          this.sendSocket({ type: "huddle.leave", channelId });
        this.publishHuddleState();
      }
      throw error;
    }
    if (attempt !== this.huddleAttempt) {
      session.destroy();
      return;
    }
    this.huddleAdmitted = true;
    this.inHuddle = true;
    session.onChange = () => this.publishHuddleState();
    // Dial whoever is already there; later arrivals come via participants events.
    session.syncParticipants(this.state.huddles[channelId] ?? []);
    this.publishHuddleState();
  }

  leaveHuddle(): void {
    this.endHuddle();
  }

  /**
   * What the caller's device in the call says as its ring changes (E10): who
   * has just declined, or, once it ends with nobody answering, that nobody
   * did. Their other devices say nothing, nor does anyone rung.
   */
  private ringNoticeFor(before: HuddleRing | undefined, after: HuddleRing): string | null {
    if (after.callerId !== this.state.self?.id || this.state.huddle?.channelId !== after.channelId)
      return null;
    const declined = after.declined.filter((id) => !before?.declined.includes(id));
    if (declined.length > 0)
      return `${declined.map((id) => this.state.users[id]?.displayName ?? "Someone").join(" and ")} declined`;
    if (after.ringing.length === 0 && after.answered.length === 0) return "No answer";
    return null;
  }

  /**
   * Says no to the ring of this direct message's huddle (E10). It stops here
   * at once and on this account's other devices when the server says so; the
   * caller is told.
   */
  declineRing(channelId: ID): void {
    const ring = this.state.rings[channelId];
    const selfId = this.state.self?.id;
    if (!ring || !selfId || !ring.ringing.includes(selfId)) return;
    this.sendSocket({ type: "huddle.decline", channelId });
    const ringing = ring.ringing.filter((id) => id !== selfId);
    const rings = { ...this.state.rings };
    if (ringing.length > 0)
      rings[channelId] = { ...ring, ringing, declined: [...ring.declined, selfId] };
    else delete rings[channelId];
    this.store.setState({ rings });
  }

  /**
   * Ends this device's part in the huddle: tells the server unless it already
   * knows, and says why on screen when the person did not choose it.
   */
  private endHuddle(
    why: { message: string; error: boolean } | null = null,
    tellServer = true,
  ): void {
    this.huddleAttempt++;
    this.huddleAdmitted = false;
    this.inHuddle = false;
    this.pendingHuddleJoin?.finish(new Error("Joining the huddle was cancelled."));
    const session = this.session;
    if (!session) return;
    this.session = null;
    if (tellServer) this.sendSocket({ type: "huddle.leave", channelId: session.channelId });
    if (why) session.note(why.message);
    session.destroy();
    this.publishHuddleState();
    if (why)
      this.store.setState({
        huddleEnded: { channelId: session.channelId, ...why, at: Date.now() },
      });
  }

  /**
   * The socket dropped mid-call. The call goes on: its sound and video pass
   * between the devices, and the server keeps this one's place a while. Only
   * a join still waiting for its answer is given up, since none will come.
   */
  private holdHuddle(): void {
    const session = this.session;
    if (!session) return;
    this.huddleAdmitted = false;
    if (!this.inHuddle) {
      this.pendingHuddleJoin?.finish(
        new Error("The connection dropped while joining the huddle. Try again."),
      );
      return;
    }
    // A rejoin still waiting is asked again when the socket returns.
    const pending = this.pendingHuddleJoin;
    this.pendingHuddleJoin = null;
    pending?.finish(new HuddleRejoinCancelled());
    session.note("The connection to the server dropped. Staying in the call meanwhile.");
  }

  /**
   * Back in the huddle once the socket returns. The snapshot says whether
   * the server kept this device's place: if it did, the others never saw it
   * go and every peer connection stays; if not (it waited too long, or the
   * server restarted), they closed theirs, so this side closes its own and
   * dials again once let back in. Refused, the call ends and says why.
   */
  private resumeHuddle(snap: ReadySnapshot): void {
    const session = this.session;
    const selfId = this.state.self?.id;
    if (!session || !this.inHuddle || !selfId) return;
    const channelId = session.channelId;
    const kept = (snap.huddles[channelId] ?? []).includes(selfId);
    if (!kept) session.closePeers();
    const attempt = this.huddleAttempt;
    const back = () => {
      if (attempt !== this.huddleAttempt || this.session !== session) return;
      this.huddleAdmitted = true;
      session.note(
        kept ? "Back in the huddle, in the place the server kept." : "Let into the huddle again.",
      );
      session.syncParticipants(this.state.huddles[channelId] ?? []);
      this.publishHuddleState();
    };
    session.note("The connection to the server came back. Asking to go on with the huddle.");
    const requestId = `rejoin-${attempt}-${++this.rejoins}`;
    const timer = setTimeout(() => {
      this.pendingHuddleJoin?.finish(new Error("The huddle did not answer."));
    }, 10_000);
    this.pendingHuddleJoin = {
      channelId,
      requestId,
      finish: (error) => {
        clearTimeout(timer);
        if (this.pendingHuddleJoin?.requestId === requestId) this.pendingHuddleJoin = null;
        if (!error) return back();
        if (error instanceof HuddleRejoinCancelled) return;
        if (attempt !== this.huddleAttempt || this.session !== session) return;
        this.endHuddle(
          {
            message: `The huddle ended here after the connection dropped. ${error.message}`,
            error: true,
          },
          !(error instanceof HuddleJoinRefusedError),
        );
      },
    };
    this.sendSocket({ type: "huddle.join", channelId, requestId });
  }

  toggleMic(): void {
    this.session?.toggleMic();
  }

  /** Asks for a microphone again after the huddle's stopped. */
  retryMicrophone(): void {
    void this.session?.recoverMicrophone();
  }

  /**
   * Starts sharing the screen, at `quality` where given, with its sound unless
   * `sound` is false, or stops sharing it.
   */
  async toggleScreenShare(quality?: ScreenShareQuality, sound?: boolean): Promise<void> {
    await this.session?.toggleScreenShare(quality, sound);
  }

  /**
   * Changes the share's resolution and frame rate while it goes; false where
   * nothing is shared or the browser would not change it.
   */
  async setScreenShareQuality(quality: ScreenShareQuality): Promise<boolean> {
    return (await this.session?.setScreenShareQuality(quality)) ?? false;
  }

  async toggleCamera(): Promise<void> {
    await this.session?.toggleCamera();
  }

  /**
   * How tall the call draws each other person's camera and share, in device
   * pixels; anyone left out is not drawn. Kept for a session started later,
   * since the call's view can be up before it (`HuddleSession.setViews`).
   */
  setCallViews(views: ReadonlyMap<ID, CallView>): void {
    this.callViews = views;
    this.session?.setViews(views);
  }

  /** Changes the huddle's microphone, or its processing, while in one. */
  async setMicrophone(settings: MicrophoneSettings): Promise<void> {
    await this.session?.setMicrophone(settings);
  }

  /** Changes the huddle's camera; while it is off, the next one it turns on. */
  async setCamera(deviceId: string | undefined): Promise<void> {
    await this.session?.setCamera(deviceId);
  }

  private sendSocket(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** `changedAt` is when the words were written: now, or earlier for a draft put back. */
  setDraft(channelId: ID, text: string, changedAt = Date.now()): void {
    this.store.setState((s) => {
      const drafts = { ...s.drafts };
      const draftTimes = { ...s.draftTimes };
      if (text.trim()) {
        // The same words again change nothing, and say nothing new about when.
        if (drafts[channelId] === text) return s;
        drafts[channelId] = text;
        draftTimes[channelId] = changedAt;
      } else {
        delete drafts[channelId];
        delete draftTimes[channelId];
      }
      return { drafts, draftTimes };
    });
  }

  /**
   * Replaces the drafts with what is stored: at startup, with the times
   * stored beside them (`stored`), or as another window changed them. A draft
   * whose text is unchanged keeps its time; one restored takes its stored
   * time, if any; one another window changed is as new as hearing of it.
   */
  hydrateDrafts(drafts: Record<ID, string>, stored?: Record<string, number>): void {
    this.store.setState((s) => {
      const draftTimes: Record<string, number> = {};
      const now = Date.now();
      for (const [key, text] of Object.entries(drafts)) {
        const time = s.drafts[key] === text ? s.draftTimes[key] : stored ? stored[key] : now;
        if (time !== undefined) draftTimes[key] = time;
      }
      return { drafts, draftTimes };
    });
  }

  /**
   * `explicit` marks someone actually asking for this, rather than the visible
   * timeline acknowledging itself. Only the former overrides a deliberate
   * unread, so looking at a conversation cannot undo one but choosing to read
   * it can.
   */
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

  /**
   * Leaves a message and everything after it unread. Any acknowledgement
   * already on its way is abandoned first, so it cannot land afterwards and
   * undo this.
   */
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

  /** The same for one thread, which also follows it. */
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

  private clearReadRequests(): void {
    for (const controller of this.readRequests.values()) controller.abort();
    this.readRequests.clear();
    this.pendingReads.clear();
    // Holds deliberately survive a resync: a reconnect long enough to discard
    // history must not quietly read what someone marked unread.
  }

  private flushReads(): void {
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
          const acknowledged = result.seq ?? seq;
          if ((this.pendingReads.get(channelId) ?? 0) <= acknowledged)
            this.pendingReads.delete(channelId);
          this.applyEphemeral({ type: "channel.read", channelId, seq: acknowledged });
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

  /**
   * Runs a slash command. Anything it has to say comes back over the socket as
   * an ephemeral, so the only thing handled here is the command not working at
   * all — which is still worth telling the person who typed it.
   */
  private async runCommand(
    channelId: ID,
    text: string,
    name: string,
    threadRootId?: ID,
  ): Promise<void> {
    try {
      await this.api.runCommand(channelId, {
        text,
        ...(threadRootId ? { threadRootId } : {}),
      });
    } catch (err) {
      const message =
        err instanceof ApiError && err.code === "unknown_command"
          ? `\`/${name}\` is not a command here.`
          : `\`/${name}\` could not run. ${refusalReason(failureOf(err)) ?? "The workspace turned it down."}`;
      this.addEphemeral({
        id: `local-${Date.now()}-${++this.nonceCounter}`,
        channelId,
        userId: "",
        text: message,
        createdAt: Date.now(),
      });
    }
  }

  private addEphemeral(message: EphemeralMessage): void {
    this.store.setState((s) => keepEphemeral(s.ephemerals, s.ephemeralsDropped, message));
  }

  /** Forgets that private replies were let go here, once the notice is dismissed. */
  dismissDroppedEphemerals(channelId: ID): void {
    this.store.setState((s) => {
      if (!(channelId in s.ephemeralsDropped)) return {};
      const ephemeralsDropped = { ...s.ephemeralsDropped };
      delete ephemeralsDropped[channelId];
      return { ephemeralsDropped };
    });
  }

  dismissEphemeral(channelId: ID, id: ID): void {
    this.store.setState((s) => {
      const kept = (s.ephemerals[channelId] ?? []).filter((e) => e.id !== id);
      const ephemerals = { ...s.ephemerals };
      if (kept.length > 0) ephemerals[channelId] = kept;
      else delete ephemerals[channelId];
      return { ephemerals };
    });
  }

  /** Loads the `/` hint list. A failure keeps the list there was: hints are a convenience. */
  private async loadCommands(): Promise<void> {
    const commands = await answerOf(async () => (await this.api.listCommands()).commands);
    if (!(commands instanceof ApiError) && !this.stopped) this.store.setState({ commands });
  }

  /** Whether this device has gone idle, as it last told the server (E9). */
  private idle = false;

  /**
   * Says this device has gone idle, nobody touching it for a while, or is in
   * use again (E9). Every device of an account idle makes it away. Said again
   * on each new connection, so a server that restarted still knows.
   */
  setIdle(idle: boolean): void {
    if (this.idle === idle) return;
    this.idle = idle;
    this.sendSocket({ type: "idle", idle });
  }

  /**
   * Blocks or unblocks someone for this account (E12); resolves with the
   * server's refusal, or null. The list is kept from the answer, before the
   * socket says it.
   */
  setBlocked(userId: ID, blocked: boolean): Promise<ApiError | null> {
    return doneOf(async () => {
      const result = blocked
        ? await this.api.blockUser(userId)
        : await this.api.unblockUser(userId);
      if (!this.stopped) this.store.setState({ blocked: result.blocked });
    });
  }

  /**
   * What conversations notify about unless one was set on its own (v53),
   * shown at once; put back when the server refused, resolving with why.
   */
  setNotifyDefault(level: NotifyLevel): Promise<ApiError | null> {
    if (this.state.notifyDefault === null) return Promise.resolve(notConnected());
    return this.writes.write<NotifyLevel | null>({ kind: "notifyDefault" }, level, {
      read: () => this.state.notifyDefault,
      show: (notifyDefault) => this.store.setState({ notifyDefault }),
      send: async (chosen) => (await this.api.setNotifyDefault(chosen!)).level,
    });
  }

  private changeSelf(request: () => Promise<{ user: User }>): Promise<ApiError | null> {
    return doneOf(async () => this.keepUser((await request()).user));
  }

  /** Away by hand, until set back (E9). */
  setAway(away: boolean): Promise<ApiError | null> {
    return this.changeSelf(() => this.api.updateMe({ away }));
  }

  /** A time zone for this account, such as one chosen in settings; null forgets it (E9). */
  setTimeZone(timeZone: string | null): Promise<ApiError | null> {
    return this.changeSelf(() => this.api.updateMe({ timeZone }));
  }

  /** Keeps a new profile picture for this account, made small first (E9). */
  setAvatar(image: Blob): Promise<ApiError | null> {
    return this.changeSelf(() => this.api.setAvatar(image));
  }

  removeAvatar(): Promise<ApiError | null> {
    return this.changeSelf(() => this.api.removeAvatar());
  }

  /** An account as the server now has it, shown at once rather than when its event comes. */
  private keepUser(user: User): void {
    if (this.stopped) return;
    this.store.setState((s) => ({
      self: s.self?.id === user.id ? user : s.self,
      users: { ...s.users, [user.id]: user },
    }));
  }

  /**
   * What this device tells the server once it is in (E9):
   * that it is idle, if it is, and its time zone, for an account with none.
   */
  private afterReady(snap: ReadySnapshot): void {
    if (this.idle) this.sendSocket({ type: "idle", idle: true });
    void this.loadCommands();
    if (snap.self.timeZone) return;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) void this.setTimeZone(zone);
  }

  /** Changes this account's name or status; resolves with the server's refusal, or null. */
  updateProfile(body: UpdateMeBody): Promise<ApiError | null> {
    return this.changeSelf(() => this.api.updateMe(body));
  }

  setFriendship(userId: ID, action: "request" | "accept" | "remove"): Promise<ApiError | null> {
    return doneOf(async () => {
      const { friends } = await this.api.updateFriend(userId, action);
      if (!this.stopped) this.store.setState({ friends });
    });
  }

  private signingOut = false;

  /**
   * Signs this session out. Doing so closes the connection, which reads as a
   * sign-in that ended, often before the answer arrives; `signedOutOnPurpose`
   * tells the two apart.
   */
  async signOut(): Promise<ApiError | null> {
    this.signingOut = true;
    const refused = await doneOf(() => this.api.logout());
    if (refused) this.signingOut = false;
    return refused;
  }

  get signedOutOnPurpose(): boolean {
    return this.signingOut;
  }

  serverInfo() {
    return answerOf(() => this.api.serverInfo());
  }

  private fileLimit: Promise<number | null> | null = null;

  /**
   * The largest file this workspace takes, asked once: null where the server
   * does not say, or could not be asked, which is asked again next time.
   */
  maxFileBytes(): Promise<number | null> {
    this.fileLimit ??= this.api.storageUsage().then(
      (usage) => (Number.isFinite(usage.maxFileBytes) ? usage.maxFileBytes : null),
      () => {
        this.fileLimit = null;
        return null;
      },
    );
    return this.fileLimit;
  }

  search(q: string, limit?: number, opts?: { cursor?: ID; channelId?: ID; signal?: AbortSignal }) {
    return answerOf(() => this.api.search(q, limit, opts));
  }

  /** One message, for the card under a link to it; a 404 when it is gone or not readable. */
  getMessage(channelId: ID, messageId: ID, signal?: AbortSignal) {
    return answerOf(async () => (await this.api.getMessage(channelId, messageId, signal)).message);
  }

  /** Refused as `message_changed` if the words are no longer `expectedText`. */
  editMessage(messageId: ID, text: string, expectedText: string) {
    return doneOf(() => this.api.editMessage(messageId, text, expectedText));
  }

  deleteMessage(messageId: ID) {
    return doneOf(() => this.api.deleteMessage(messageId));
  }

  /** Presses a button an app put on a message. */
  runMessageAction(messageId: ID, actionId: string) {
    return answerOf(() => this.api.runMessageAction(messageId, actionId));
  }

  /** Reports a message to the workspace's admins (E12), with why and anything to add. */
  reportMessage(messageId: ID, reason: ReportReason, note?: string) {
    return doneOf(() => this.api.reportMessage(messageId, reason, note));
  }

  /** An address that downloads the file once, within a minute, by a browser's navigation. */
  downloadUrl(fileId: ID) {
    return answerOf(() => this.api.downloadUrl(fileId));
  }

  reminders(signal?: AbortSignal) {
    return answerOf(async () => (await this.api.listReminders(signal)).reminders);
  }

  latestDirectMessages(signal?: AbortSignal) {
    return answerOf(() => this.api.latestDirectMessages(signal));
  }

  /** Every channel this account can see, with how many active people each room holds. */
  browseChannels(signal?: AbortSignal) {
    return answerOf(() => this.api.listChannels(signal));
  }

  updateChannel(channelId: ID, body: UpdateChannelBody) {
    return doneOf(() => this.api.updateChannel(channelId, body));
  }

  joinChannel(channelId: ID) {
    return doneOf(() => this.api.joinChannel(channelId));
  }

  leaveChannel(channelId: ID) {
    return doneOf(() => this.api.leaveChannel(channelId));
  }

  channelMembers(channelId: ID) {
    return answerOf(async () => (await this.api.channelMembers(channelId)).memberIds);
  }

  addToChannel(channelId: ID, userId: ID) {
    return doneOf(() => this.api.inviteMember(channelId, userId));
  }

  removeFromChannel(channelId: ID, userId: ID) {
    return doneOf(() => this.api.removeChannelMember(channelId, userId));
  }

  setChannelManager(channelId: ID, userId: ID, manager: boolean) {
    return doneOf(() => this.api.setChannelManager(channelId, userId, manager));
  }

  sendTyping(channelId: ID): void {
    this.sendSocket({ type: "typing", channelId });
  }

  openDm(userIds: ID[]): Promise<Channel | ApiError> {
    return this.createChannel({
      type: userIds.length === 1 ? "dm" : "group_dm",
      memberIds: userIds,
    });
  }

  /** Makes a conversation this account is in, shown at once rather than when its event comes. */
  createChannel(body: CreateChannelBody): Promise<Channel | ApiError> {
    return answerOf(async () => {
      const { channel } = await this.api.createChannel(body);
      if (this.stopped) return channel;
      this.store.setState((s) => ({
        channels: { ...s.channels, [channel.id]: channel },
        memberships: { ...s.memberships, [channel.id]: s.memberships[channel.id] ?? 0 },
        repliesRead:
          channel.id in s.memberships
            ? s.repliesRead
            : joined(s.repliesRead, channel.id, s.lastSeq),
      }));
      return channel;
    });
  }
}

/**
 * `repliesRead` after joining a channel at `seq`: its replies until then are
 * not this account's to catch up on, as the server counts them on joining.
 */
function joined(repliesRead: Record<ID, number>, channelId: ID, seq: number) {
  return { ...repliesRead, [channelId]: seq };
}

/**
 * A message event as it happens, rather than replayed onto a page: a channel
 * at its newest end lets go of its oldest messages past the cap.
 */
function liveMessages(
  cache: MessageCache,
  envelope: EventEnvelope & { event: MessageEvent },
  inOrder: boolean,
): MessageCache {
  const next = reduceMessages(cache, envelope, inOrder);
  return envelope.event.type === "message.created"
    ? windowTimeline(next, envelope.event.message.channelId, "oldest")
    : next;
}

function withSaved(saved: Record<ID, true>, messageId: ID, on: boolean): Record<ID, true> {
  const next = { ...saved };
  if (on) next[messageId] = true;
  else delete next[messageId];
  return next;
}

function omitKeys<T extends object>(values: T, keys: string[]): Partial<T> {
  const out: Partial<T> = { ...values };
  for (const key of keys) delete out[key as keyof T];
  return out;
}
