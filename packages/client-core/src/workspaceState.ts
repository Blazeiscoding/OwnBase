import type {
  AccessPolicy,
  Channel,
  ChannelPrefs,
  ChannelRemoval,
  CustomEmoji,
  Friendship,
  HuddleRing,
  ID,
  MemberNotice,
  ModalView,
  NotifyLevel,
  Presence,
  Reminder,
  ServerNotice,
  SidebarSection,
  ThreadFollow,
  User,
  UserGroup,
} from "@ownbase/protocol";
import type { CommandHint } from "./api.js";
import type { HuddleState } from "./huddle.js";
import type { MessageCache } from "./messageCache.js";
import type { FileDescription, StoredPending } from "./outbox.js";
import type { EphemeralMessage } from "./commands.js";

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
export interface LocalAttachment extends FileDescription {
  /** Object URL for instant local preview of images. */
  previewUrl: string | null;
}

/** A send in the outbox, as this window shows it. */
export interface PendingMessage extends Omit<StoredPending, "attachments" | "refusal"> {
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

/** Which window of a channel's history a request reads. */
export type HistoryWindow = "initial" | "older" | "newer" | "latest";

/** A channel's history request on its way, and the window that last failed to load. */
export interface TimelineStatus {
  loading: HistoryWindow | null;
  error: HistoryWindow | null;
}

export interface WorkspaceState extends MessageCache {
  /** channelId -> its history request on its way or failed; absent when neither. */
  timelineStatus: Record<ID, TimelineStatus>;
  friends: Friendship[];
  /** The people this account blocked (E12), whose messages fold away and who never notify it. */
  blocked: ID[];
  /** This account's keywords (K11): a message holding one notifies as a mention does. */
  keywords: string[];
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
  /**
   * Who made the last rename heard since connecting: null for the host, or
   * for none heard. Workspace settings names them to an admin who was editing.
   */
  workspaceRenamedBy: ID | null;
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
  /** What this account's conversations notify about unless one was set on its own (v53). */
  notifyDefault: NotifyLevel;
  /** This account's reminders by message id, waiting and due (E4). */
  reminders: Record<ID, Reminder>;
  /**
   * Notes that someone removed this account from channels, by id, for
   * Activity until read.
   */
  channelRemovals: Record<ID, ChannelRemoval>;
  /**
   * Reactions to this account's messages (K13): how far it has seen them,
   * how many of the Reactions tab's entries are newer, and a count that
   * moves each time the server says the list changed, for the open list to
   * read it again.
   */
  reactionActivity: { seenAt: number; unseen: number; revision: number };
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
  /** The workspace's own emoji, by name (J12). */
  customEmoji: Record<string, CustomEmoji>;
  /** Whether only the owner and admins may add custom emoji, as the server last said. */
  emojiAddingAdminsOnly: boolean;
  /** The workspace's user groups by id, with who is in each (J13); none for a guest. */
  userGroups: Record<ID, UserGroup>;
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
  /** Unsent words by `draftKey`, restored when you come back. */
  drafts: Record<string, string>;
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

export const initialState: WorkspaceState = {
  friends: [],
  blocked: [],
  keywords: [],
  openReports: null,
  memberNotice: null,
  serverNotices: [],
  status: "connecting",
  workspaceName: "",
  workspaceRenamedBy: null,
  workspaceId: null,
  serverProtocolVersion: null,
  clockSkewMs: null,
  sidebarSections: [],
  notifyDefault: "mentions",
  reminders: {},
  channelRemovals: {},
  reactionActivity: { seenAt: 0, unseen: 0, revision: 0 },
  pollChoices: {},
  pollPicks: {},
  accessPolicy: null,
  linkPreviews: null,
  iconVersion: undefined,
  customEmoji: {},
  emojiAddingAdminsOnly: false,
  userGroups: {},
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
