/** All ids are ULID-style sortable strings. */
export type ID = string;

/** A relationship visible only to its two participants, within one workspace. */
export interface Friendship {
  userId: ID;
  status: "incoming" | "outgoing" | "accepted";
  createdAt: number;
}

/**
 * A guest joined with only a display name, when the host allows that. A guest
 * reads and takes part in public channels and nothing more, and its session
 * lasts a day. Servers before guest access never report one.
 */
export type Role = "owner" | "admin" | "member" | "guest";

/**
 * Who may join a workspace, after its owner:
 * - `invite_only`: an account, created with an invite code;
 * - `account_required`: an account, which anyone may create;
 * - `guest_allowed`: anyone, as a guest with a display name; creating an
 *   account stays open and optional.
 */
export type AccessPolicy = "invite_only" | "account_required" | "guest_allowed";
export const ACCESS_POLICIES: readonly AccessPolicy[] = [
  "invite_only",
  "account_required",
  "guest_allowed",
];

export interface User {
  id: ID;
  handle: string;
  displayName: string;
  role: Role;
  statusText: string;
  statusEmoji: string;
  /**
   * Epoch ms when the status clears itself (UX-61). Absent or null when it
   * stays until changed, and absent from servers before schema v39.
   */
  statusExpiresAt?: number | null;
  isBot: boolean;
  deactivated: boolean;
  /** Epoch ms until which notifications are snoozed, or null when available. */
  dndUntil: number | null;
  createdAt: number;
  /**
   * Their time zone, an IANA name such as "Asia/Kolkata", for the local time
   * others see (E9). Absent until it is set, and from older servers.
   */
  timeZone?: string;
  /**
   * They set themselves away by hand, which stands until they set themselves
   * back (E9). Being away by being idle is presence alone. Absent otherwise.
   */
  away?: true;
  /**
   * Names their profile picture: `GET /api/users/:id/avatar?v=` serves it,
   * and it changes only when the picture does (E9). Absent when they have none.
   */
  avatarVersion?: string;
  /**
   * Whether this account may create invite codes: always for an owner or admin,
   * and for a member only when an administrator has allowed it. Absent from
   * servers before schema v25, where every member could.
   */
  canInvite?: boolean;
}

export type ChannelType = "public" | "private" | "dm" | "group_dm";

export interface Channel {
  id: ID;
  type: ChannelType;
  /** Empty for dm/group_dm — clients derive the title from member names. */
  name: string;
  topic: string;
  description: string;
  creatorId: ID;
  archived: boolean;
  createdAt: number;
  /** Present on dm/group_dm so clients can render the counterpart(s). */
  memberIds?: ID[];
  /** Delegated room managers; authority ends when their membership ends. */
  managerIds?: ID[];
}

/** How loudly one channel should notify this user. */
export type NotifyLevel = "all" | "mentions" | "nothing";

export interface ChannelPrefs {
  notifyLevel: NotifyLevel;
  /** Muted channels never notify and stay quiet in the sidebar. */
  muted: boolean;
  /**
   * Listed under Starred, above Channels, for this account alone (UX-20).
   * Absent from servers before schema v40, which keep no stars: read it as
   * false. See `ReadySnapshot.stars`.
   */
  starred?: boolean;
  /**
   * The sidebar section this account keeps it in, or null (E8). A
   * conversation sits in one place: a section, Starred, or where it would
   * be. Absent from servers before schema v46; see `ReadySnapshot.sidebarSections`.
   */
  sectionId?: ID | null;
}

/**
 * A section of one account's sidebar, named by them, between Starred and
 * Channels (E8). Its conversations say so in `ChannelPrefs.sectionId`.
 */
export interface SidebarSection {
  id: ID;
  name: string;
}

/** The most sections one account keeps, and the longest a name may be once trimmed. */
export const SIDEBAR_SECTIONS_MAX = 50;
export const SIDEBAR_SECTION_NAME_MAX = 80;

export interface ChannelMembership extends ChannelPrefs {
  channelId: ID;
  userId: ID;
  lastReadSeq: number;
  joinedAt: number;
}

export interface ReactionGroup {
  emoji: string;
  userIds: ID[];
}

export interface FileMeta {
  id: ID;
  name: string;
  mime: string;
  size: number;
  /** Present for images the server could measure — lets clients reserve space before load. */
  width: number | null;
  height: number | null;
}

/**
 * A file as the file browser lists it (E7): the file, and the message that
 * shared it, so it can be opened there. `sharedAt` is when that message was sent.
 */
export interface SharedFile {
  file: FileMeta;
  messageId: ID;
  channelId: ID;
  threadRootId: ID | null;
  userId: ID;
  sharedAt: number;
}

export interface Message {
  id: ID;
  channelId: ID;
  userId: ID;
  /**
   * Slack-mrkdwn-compatible text: *bold*, _italic_, `code`, ```blocks```,
   * <@USER_ID> mentions, <#CHANNEL_ID> channel links, plain URLs.
   */
  text: string;
  threadRootId: ID | null;
  /**
   * A reply whose author chose to show it in the channel's own timeline too.
   * It stays a reply: it belongs to its thread and counts toward its replies.
   */
  broadcast: boolean;
  /**
   * Event-log seq of this message's message.created event; used for unread math.
   * Note: inside a live `message.created` event payload this can be 0 — clients
   * must set it from the envelope's seq when applying the event.
   */
  seq: number;
  createdAt: number;
  editedAt: number | null;
  /** Client-generated idempotency key; lets the sender reconcile optimistic messages. */
  nonce: string | null;
  replyCount: number;
  reactions: ReactionGroup[];
  files: FileMeta[];
  /** Pinned messages are shown to the whole channel. */
  pinned: boolean;
  /** Buttons an app attached to this message; empty for anything a person sent. */
  actions: MessageAction[];
  /**
   * The message this one answers in place, shown above it as Discord does,
   * rather than in a thread. Absent when it answers nothing, and from servers
   * older than inline replies.
   */
  replyTo?: ReplyReference | null;
  /**
   * The message this one passes on, shown under its own words as a card.
   * Absent when it forwards nothing, and from servers older than forwarding.
   */
  forwardedFrom?: ForwardReference | null;
  /**
   * What the server found at the first few web addresses in its words, in the
   * order they appear (E2). Added a moment after the message is sent, by a
   * `message.updated` that says `previewsOnly`. Absent from servers before
   * link previews, and empty while none has been found.
   */
  previews?: LinkPreview[];
  /**
   * The choices this message asks people to pick from, its words being the
   * question (E6). Votes change it by a `message.updated` that says
   * `pollOnly`. Absent from a message that is not a poll, and from servers
   * before polls.
   */
  poll?: Poll;
  /**
   * A note about a call, left by the server as from the person who rang
   * (E10): a huddle nobody answered. Its words say the same to older clients.
   * Absent from every other message.
   */
  call?: CallNotice;
}

/** What a call note says happened (E10). */
export interface CallNotice {
  kind: "missed";
}

/**
 * A question with two to ten choices. An option is known by its place in
 * `options`, which never changes. Who chose what is on each option unless the
 * poll is anonymous; then each voter learns only their own choices, from
 * `ReadySnapshot.pollChoices` and the `poll.choices` event.
 */
export interface Poll {
  options: PollOption[];
  /** Whether a voter may choose more than one. */
  multiple: boolean;
  /** Whether who chose what is kept from everyone, its author too. */
  anonymous: boolean;
  /** How many people have chosen something. */
  voters: number;
  /** When its author closed it, after which nobody can vote; null while open. */
  closedAt: number | null;
}

export interface PollOption {
  text: string;
  votes: number;
  /** Who chose it, first to last; absent from an anonymous poll. */
  voterIds?: ID[];
}

/** The most choices a poll offers, and the fewest. */
export const POLL_OPTIONS_MAX = 10;
export const POLL_OPTIONS_MIN = 2;
/** The longest a poll's question and each of its choices may be, once trimmed. */
export const POLL_QUESTION_MAX = 300;
export const POLL_OPTION_MAX = 80;

/**
 * A web page a message links to, as the server read it: the page's own title,
 * description and site name, and a picture it names, fetched by the server so
 * no reader's device asks the site for anything.
 */
export interface LinkPreview {
  id: ID;
  /** The address as the message has it. */
  url: string;
  title: string;
  description: string;
  siteName: string;
  /**
   * The picture, served to readers of the message at
   * `GET /api/link-previews/:id/image`; null when the page names none the
   * server would keep.
   */
  image: { width: number; height: number } | null;
}

/**
 * What a forward carries of the message it passes on, read afresh with it,
 * so it follows edits and deletion as a reply's quote does. Its words, files
 * and author show only where everyone who can read the forward can read the
 * original too: from a public channel, or from the same conversation. One
 * from a private conversation forwarded elsewhere says only that (`hidden`),
 * and its link opens it for those who can see it there.
 */
export interface ForwardReference {
  id: ID;
  /** Where it was said, for its link. */
  channelId: ID;
  /** Its author; empty when hidden or deleted. */
  userId: ID;
  /** All of its words; empty when hidden or deleted. */
  text: string;
  /** Its files, opened as the original's; none when hidden or deleted. */
  files: FileMeta[];
  /** When it was written; 0 when hidden or deleted. */
  createdAt: number;
  /** Deleted, or gone with older history. */
  deleted: boolean;
  /** From a private conversation, so not shown here. */
  hidden: boolean;
}

/**
 * What a reply shows of the message it answers: who wrote it and how it
 * began. Read afresh with the reply, so it follows edits and deletion, and
 * the reply can show it without the original having been loaded.
 */
export interface ReplyReference {
  id: ID;
  /** Its author; empty once it is deleted, when the reply says only that. */
  userId: ID;
  /** The start of its words, `replyExcerpt` long at most; empty once deleted. */
  text: string;
  /** How many files it carried, so a picture sent alone still reads as something. */
  fileCount: number;
  /** Deleted, or gone with older history: the reply says so instead. */
  deleted: boolean;
  /** Its author was notified of the reply, as a mention would. */
  ping: boolean;
}

/**
 * A Block Kit button, reduced to what can actually be drawn and clicked here.
 * Slack's element zoo is much larger; anything else in an `actions` block is
 * dropped rather than rejected, the same way unknown blocks are.
 */
export interface MessageAction {
  /** The app's own id for this button, echoed back when it is clicked. */
  actionId: string;
  blockId: string;
  text: string;
  value: string;
  style: "default" | "primary" | "danger";
  /** A link button opens this instead of calling the app back. */
  url: string | null;
}

/**
 * Whether an invite would let someone in right now. Decided by the server, so a
 * client with a wrong clock cannot show a dead link as usable.
 */
export type InviteStatus =
  | "active"
  | "expired"
  | "used_up"
  | "revoked"
  | "creator_deactivated"
  /** Its creator is no longer allowed to invite people. */
  | "creator_not_permitted";

export interface Invite {
  code: string;
  createdBy: ID;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number | null;
  uses: number;
  /** Absent from servers before schema v23. */
  revokedAt?: number | null;
  status?: InviteStatus;
}

/** Why someone reported a message (E12). */
export type ReportReason = "spam" | "harassment" | "inappropriate" | "other";
export const REPORT_REASONS: readonly ReportReason[] = [
  "spam",
  "harassment",
  "inappropriate",
  "other",
];
/** The most a report's note may say. */
export const REPORT_NOTE_MAX = 500;

/** What an admin did about a reported message (E12). */
export type ReportResolution = "dismiss" | "remove" | "deactivate";

/** One person's report of a message, as admins see it (E12). */
export interface MessageReport {
  id: ID;
  reporterId: ID;
  reason: ReportReason;
  /** What they added, or "". */
  note: string;
  createdAt: number;
}

/** A reported message waiting for an admin, with every open report of it (E12). */
export interface ReportedMessage {
  messageId: ID;
  /** Who wrote it, known after they deleted it too. */
  authorId: ID;
  /** The message, or null once its author deleted it. */
  message: Message | null;
  /** Where it was posted, even a conversation the admin is not in. */
  channel: Channel;
  reports: MessageReport[];
}

/** An administrative action that was recorded. */
export type AuditAction =
  | "user.role_changed"
  | "user.deactivated"
  | "user.reactivated"
  | "user.password_reset"
  | "user.two_step_reset"
  | "report.resolved"
  | "user.invite_permission_granted"
  | "user.invite_permission_removed"
  | "account.recovered"
  | "workspace.ownership_transferred"
  | "workspace.renamed"
  | "workspace.access_policy_changed"
  | "workspace.icon_changed"
  | "workspace.link_previews_changed"
  | "workspace.copy_made"
  | "workspace.copy_downloaded"
  | "app.created"
  | "app.deleted"
  | "app.token_replaced"
  | "app.signing_secret_replaced"
  | "app.interactivity_url_changed"
  | "app.scopes_changed"
  | "webhook.created"
  | "webhook.url_replaced"
  | "webhook.deleted"
  | "command.created"
  | "command.deleted"
  | "subscription.created"
  | "subscription.deleted"
  | "subscription.retried"
  | "invite.created"
  | "invite.revoked";

export type AuditTargetType =
  "user" | "app" | "webhook" | "command" | "subscription" | "invite" | "workspace";

/**
 * One entry in the administrative record. Never holds a credential, a URL an
 * app was given, or anything anyone wrote: only who acted, on what, and the
 * small facts needed to make sense of it later.
 */
export interface AuditEntry {
  id: ID;
  at: number;
  /** Who did it, or null when the host did it from the command line. */
  actorId: ID | null;
  action: AuditAction;
  targetType: AuditTargetType;
  /** For an invite, a short fingerprint of its code rather than the code. */
  targetId: string | null;
  details: Record<string, string | number | boolean | null>;
}

/**
 * How the workspace server is running, for its owner and admins (OPS-10):
 * counts, sizes and times only. No message, file name, address, token or
 * delivery error is in it, so it can be read aloud or pasted into a request
 * for help without exposing anyone's conversations.
 */
export interface WorkspaceStatus {
  serverVersion: string;
  schemaVersion: number;
  uptimeSeconds: number;
  /** The database file and its write-ahead log, in bytes. */
  database: { bytes: number; walBytes: number };
  /**
   * Stored attachments, against the configured limit (null: none), and the
   * removal of deleted ones (REV-02): due or soon, failed and waiting to be
   * tried again, and set aside because they can never succeed. Absent from
   * servers that predate it.
   */
  attachments: {
    bytes: number;
    limitBytes: number | null;
    removal?: {
      waiting: number;
      retrying: number;
      rejected: number;
      oldestQueuedAt: number | null;
    };
  };
  /** Free space where the workspace is kept; null where it cannot be read. */
  diskFreeBytes: number | null;
  /** App event deliveries: waiting, the oldest waiting since, and given up on. */
  deliveries: { waiting: number; oldestWaitingAt: number | null; failed: number };
  /** Scheduled messages: due to send, held for a retry, and given up on. */
  scheduled: { queued: number; held: number; failed: number };
  /** Removing old history: off (retentionDays 0) or how its last sweeps went. */
  retention: {
    enabled: boolean;
    lastSuccessAt: number | null;
    failures: number;
  };
  /**
   * Backups the server takes on a timer: off, or how often, how many it
   * keeps, when the last one finished, failures since, and when the next is
   * due. Absent from servers that predate them.
   */
  backups?:
    | { enabled: false }
    | {
        enabled: true;
        everyMs: number;
        keep: number;
        lastSuccessAt: number | null;
        failures: number;
        nextAt: number | null;
        running: boolean;
      };
  /** Open sockets, and the people they belong to. */
  connections: { sockets: number; people: number };
  /**
   * How late the server's event loop ran over the last full minute, in
   * milliseconds; null until a minute has passed.
   */
  eventLoopDelayMs: { p50: number; p99: number; max: number } | null;
  /**
   * Background queues failing now: since when and how many times in a row.
   * Empty when all are running; absent from servers that predate it.
   */
  backgroundFailures?: { queue: string; since: number; failures: number }[];
  /**
   * Parts of the server outside its core, such as the Enterprise edition,
   * and how each is (P6). Absent where there are none.
   */
  extensions?: ExtensionStatus[];
}

/** Unauthenticated probe of a server — what the Join screen shows. */
/**
 * Which source a build was made from (IMP-08): the git revision, and whether
 * the tree had changes not in it. Null `dirty` means there was no git to ask.
 */
export interface BuildRevision {
  revision: string;
  dirty: boolean | null;
}

export interface ServerInfo {
  app: "ownbase";
  protocolVersion: number;
  serverVersion: string;
  /** What this server was built from; absent when it runs from source. */
  build?: BuildRevision;
  workspaceName: string;
  userCount: number;
  /** True once an owner exists; joining then requires an invite code. */
  requiresInvite: boolean;
  /**
   * Who may join. Absent from servers before guest access, which offer only
   * accounts (and say whether those need an invite through `requiresInvite`).
   */
  accessPolicy?: AccessPolicy;
  /**
   * True when this workspace has no owner yet and the caller is not on the
   * machine running it — claiming it needs the code the server printed at
   * startup. Whoever is at the keyboard does not need one.
   */
  requiresClaim: boolean;
  /** Scheduling retries are deduplicated by an account-scoped request key. */
  schedulingIdempotency?: boolean;
  /** Single-use, session-bound tickets for native file downloads. */
  downloadTickets?: boolean;
  /** The owner can make and download a copy of the whole workspace. */
  workspaceCopies?: boolean;
  /**
   * How others reach this workspace, when its host configured it. Links people
   * share are built on it, rather than on whatever address the sharer is using.
   */
  publicUrl?: string;
  /**
   * The workspace icon's version, for `GET /api/workspace/icon?v=`, or null
   * when it has none. Absent from servers before workspace icons.
   */
  iconVersion?: string | null;
  /**
   * Ways to sign in besides a password, from the server's extensions (P9),
   * and who may still use a password: everyone, or only the owner, kept as
   * the way back in. Absent when there is nothing but passwords.
   */
  signIn?: { methods: SignInMethod[]; passwords: "everyone" | "owner_only" };
}

/** A way to sign in besides a password, such as a company's single sign-on (P9). */
export interface SignInMethod {
  id: string;
  /** Who signs people in, such as "Okta": its button says "Sign in with Okta". */
  name: string;
  /**
   * Where the browser goes to begin, a path on this server, with
   * `client=web` or `client=desktop` (the desktop app opens it in the
   * system's browser) and `challenge`, the base64url SHA-256 of a secret the
   * client keeps. The way back brings a one-time code, `<server>/#/sso/<code>`
   * or `ownbase://sso?host=<server>&code=<code>`, which `redeem` turns into a
   * session for that secret alone.
   */
  start: string;
  /** POST `{ code, verifier }` here for `{ token, user }`. */
  redeem: string;
  /**
   * For a signed-in person to link this way to their account: GET says
   * whether it is linked (`SignInConnection`), POST answers `{ url }`, a path
   * on this server to open in a browser, and DELETE unlinks.
   */
  connect?: string;
}

/** What GET on a sign-in method's `connect` says for the signed-in person. */
export interface SignInConnection {
  connected: boolean;
  /** Who they are there, such as an email address, when linked. */
  as?: string;
}

/**
 * A panel an extension adds to Workspace settings for the owner (P9): its
 * fields, and the path its values are saved to with PUT, as `{ [key]: value }`.
 */
export interface SettingsPanel {
  id: string;
  title: string;
  description: string;
  fields: SettingsField[];
  save: string;
  /** Why it cannot be used now, such as a license without the feature. */
  problem?: string;
  /** Whether what it sets up is working, in a line. */
  status?: string;
}

export interface SettingsField {
  key: string;
  label: string;
  kind: "text" | "url" | "secret" | "toggle";
  help?: string;
  /** Text or a toggle's state. A secret's is never sent: "" with `isSet`. */
  value: string | boolean;
  isSet?: boolean;
  placeholder?: string;
}

/**
 * A part of the server outside its core, such as the Enterprise edition, as
 * the workspace status reports it (P6).
 */
export interface ExtensionStatus {
  name: string;
  /** One line for the owner and admins. */
  summary: string;
  /** Fine, needs attention soon, or needs it now. */
  health: "ok" | "warning" | "problem";
}

/**
 * Something the server tells the owner and admins under the conversation's
 * header, such as a license running out (P6). `id` stays the same while the
 * notice says the same thing, so putting it away is remembered.
 */
export interface ServerNotice {
  id: string;
  tone: "status" | "alert";
  text: string;
  link?: { label: string; url: string };
}

/**
 * The copy of the workspace its owner can download: being made, ready until
 * `expiresAt` (its zip `bytes` long), or failed and why.
 */
export type WorkspaceCopy =
  | { id: string; state: "making"; startedAt: number }
  | { id: string; state: "ready"; startedAt: number; bytes: number; expiresAt: number }
  | { id: string; state: "failed"; startedAt: number; error: string };

export interface StorageUsage {
  usedBytes: number;
  limitBytes: number | null;
  availableBytes: number | null;
  maxFileBytes: number;
}

/** One signed-in device or browser, as its owner sees it. */
export interface SessionInfo {
  id: ID;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  /** What the client called itself when it signed in. Never trusted, only shown. */
  userAgent: string;
  /** The session making this request. */
  current: boolean;
}

export interface ThreadFollow {
  rootId: ID;
  channelId: ID;
  following: boolean;
  /**
   * Replies up to here are read. For a thread this account has no cursor of
   * its own in, the membership's `repliesReadSeq`.
   */
  lastReadSeq: number;
  /**
   * Newest seq in the thread, root included. Carried here so a client can tell
   * a thread has unread replies without having loaded any of them.
   */
  lastSeq: number;
  /** Increases on every change, so a late echo cannot undo a newer one. */
  revision: number;
  /**
   * Set when the thread was marked unread: where the channel's read cursor
   * stood then. Until the channel is read past it, a reply also sent to the
   * channel is read only through the thread. Absent when there is no hold,
   * and from servers older than it.
   */
  unreadHold?: number;
  /**
   * Muted: not followed, and kept that way when this account replies, and its
   * replies notify only when they are addressed to it. Absent when not muted,
   * and from servers older than it.
   */
  muted?: true;
}

/**
 * One account's reminder about one message (E4). Setting another on the same
 * message changes this one.
 */
export interface Reminder {
  id: ID;
  messageId: ID;
  channelId: ID;
  /** The thread the message is in, so a client can drop it with that thread. */
  threadRootId: ID | null;
  /** When it is to come due, in epoch ms. */
  remindAt: number;
  /** When it came due, or null while it waits. */
  dueAt: number | null;
}

/** A reminder with the message it is about, as the Reminders list shows it. */
export interface ReminderItem {
  reminder: Reminder;
  message: Message;
}

export interface FollowedThread {
  root: Message;
  lastSeq: number;
  unreadCount: number;
}

export const PROTOCOL_VERSION = 1;

/**
 * Here rather than beside the request schemas: the client and the desktop
 * main process read it, and importing it from there would bring zod with it.
 *
 * How long an app goes on sending a message from its outbox on its own. An
 * older one waits for its author to choose Retry or Discard. For at least this
 * long after a message is posted, the server remembers its send key, without
 * its words, even after retention has removed it. So an app's own retry can
 * never post a removed message again.
 */
export const SEND_RETRY_WINDOW_MS = 30 * 24 * 3600_000;

/**
 * Where a queued message is in its delivery lifecycle. `held` is reversible —
 * every flush re-checks it, so unarchiving a channel or regaining access sends
 * the message. `failed` is terminal and only an explicit reschedule revives it.
 */
export type ScheduledStatus = "queued" | "held" | "failed" | "sent";

/** A message queued to be posted at a future time. */
export interface ScheduledMessage {
  id: ID;
  channelId: ID;
  userId: ID;
  text: string;
  threadRootId: ID | null;
  /** A reply that is also to be shown in the channel when it is sent. */
  broadcast: boolean;
  fileIds: ID[];
  sendAt: number;
  createdAt: number;
  status: ScheduledStatus;
  /** Why delivery is held or failed, phrased for the author. */
  failureReason: string | null;
  attempts: number;
  /** Set when delivered, in the same transaction as the message itself. */
  messageId: ID | null;
}

/** An integration: a bot user plus the tokens and hooks that drive it. */
export interface App {
  id: ID;
  name: string;
  botUserId: ID;
  createdBy: ID;
  createdAt: number;
  /**
   * Where a button click is delivered, Slack's "interactivity request URL".
   * Empty means this app's buttons are inert, which is what an app that only
   * posts should be.
   */
  interactivityUrl: string;
  /**
   * What its bot token may do and what it is sent (E18c). Absent from servers
   * before then, where every app could do everything.
   */
  scopes?: AppScope[];
}

/**
 * What an app may do (E18c), by Slack's names so the scopes an app documents
 * carry over. Posting is checked on the method. There are no read methods, so
 * the read scopes decide which events reach its subscriptions. The methods
 * for forms need none, as on Slack: a trigger already says someone asked.
 */
export const APP_SCOPES = [
  "chat:write",
  "chat:write.public",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "channels:read",
  "groups:read",
  "reactions:read",
  "pins:read",
  "users:read",
] as const;

export type AppScope = (typeof APP_SCOPES)[number];

/** What a new app may do unless it is given more: post, and be sent nothing. */
export const DEFAULT_APP_SCOPES: readonly AppScope[] = ["chat:write", "chat:write.public"];

/** The native events an app can be sent, each in its Slack shape. */
export const APP_EVENT_TYPES = [
  "message.created",
  "message.updated",
  "message.deleted",
  "reaction.added",
  "reaction.removed",
  "pin.added",
  "pin.removed",
  "channel.created",
  "channel.updated",
  "member.joined",
  "member.left",
  "user.joined",
  "user.updated",
] as const;

const HISTORY: Record<ChannelType, AppScope> = {
  public: "channels:history",
  private: "groups:history",
  dm: "im:history",
  group_dm: "mpim:history",
};

/**
 * The scope an app needs to be sent an event of this type from a conversation
 * of this kind, or from none for a workspace-wide one, as Slack names them.
 * Null for an event no app is sent.
 */
export function eventScope(type: string, channelType: ChannelType | null): AppScope | null {
  const kind = channelType ?? "public";
  switch (type) {
    case "message.created":
    case "message.updated":
    case "message.deleted":
      return HISTORY[kind];
    case "reaction.added":
    case "reaction.removed":
      return "reactions:read";
    case "pin.added":
    case "pin.removed":
      return "pins:read";
    case "channel.created":
    case "channel.updated":
    case "member.joined":
    case "member.left":
      return kind === "public" ? "channels:read" : "groups:read";
    case "user.joined":
    case "user.updated":
      return "users:read";
    default:
      return null;
  }
}

/** Every scope an event of this type can need, wherever it happens. */
export function eventScopes(type: string): AppScope[] {
  const kinds: (ChannelType | null)[] = ["public", "private", "dm", "group_dm", null];
  return [...new Set(kinds.map((kind) => eventScope(type, kind)).filter((s) => s !== null))];
}

/**
 * A Block Kit modal, reduced to the parts that can be drawn and filled in.
 * The app sends Slack's view object; this is what survives the trip.
 */
export interface ModalView {
  /** Ours, not the app's — how a submission is tied back to what was opened. */
  id: ID;
  /** The app's own name for this view, echoed back on submission. */
  callbackId: string;
  title: string;
  /** Empty when the view only shows something, such as "Loading": no submit button. */
  submitLabel: string;
  closeLabel: string;
  /** Opaque app state, carried through untouched. */
  privateMetadata: string;
  /**
   * Changes whenever the app changes the view (E18b), so a client can tell an
   * update from the same view sent again. Absent from servers before then.
   */
  hash?: string;
  /** Anything above the fields — sections, headers — flattened to mrkdwn. */
  text: string;
  fields: ModalField[];
}

/**
 * What a modal input is drawn as. The pickers choose from the workspace: people
 * (`user`, `users`), conversations the person can see (`conversation`,
 * `conversations`) or public channels (`channel`, `channels`). A client that
 * does not know a kind draws a text box; the server checks every answer
 * against the kind, so an older client costs comfort, not correctness.
 */
export type ModalFieldType =
  | "text"
  | "textarea"
  | "select"
  | "multiselect"
  | "checkboxes"
  | "radio"
  | "user"
  | "users"
  | "conversation"
  | "conversations"
  | "channel"
  | "channels"
  | "date"
  | "time";

/** The kinds answered with a list rather than one value. */
export const MANY_ANSWER_FIELDS: ReadonlySet<ModalFieldType> = new Set([
  "multiselect",
  "checkboxes",
  "users",
  "conversations",
  "channels",
]);

export interface ModalOption {
  text: string;
  value: string;
  /** A line under the choice, for checkboxes and radio buttons. */
  description?: string;
}

/** One input in a modal. Anything Slack offers that is not here is dropped. */
export interface ModalField {
  blockId: string;
  actionId: string;
  label: string;
  hint: string;
  optional: boolean;
  type: ModalFieldType;
  placeholder: string;
  /**
   * What a one-answer kind starts with: text, an option's value, an id, a
   * date as `YYYY-MM-DD` or a time as `HH:mm`. Empty for the list kinds.
   */
  initialValue: string;
  /** What a list kind starts with chosen. Absent for the one-answer kinds. */
  initialValues?: string[];
  /** Choices for select, multiselect, checkboxes and radio; empty for the rest. */
  options: ModalOption[];
  /** For the list pickers: at most this many may be chosen. Absent: no limit. */
  maxSelected?: number;
  /** For `conversation` and `conversations`: which kinds are offered. Absent: all. */
  conversationTypes?: ChannelType[];
}

export interface Webhook {
  id: ID;
  appId: ID;
  channelId: ID;
  createdAt: number;
}

/**
 * A `/command` an app answers. Running it POSTs a Slack-shaped form body to
 * `url`; whatever comes back is shown to the person who typed it.
 */
export interface SlashCommand {
  id: ID;
  appId: ID;
  /** Stored without the leading slash, lowercase. */
  command: string;
  url: string;
  description: string;
  /** Shown after the command name in the hint list, e.g. "[staging|prod]". */
  usageHint: string;
  createdAt: number;
}

/** An outgoing subscription: the server POSTs matching events to `url`. */
export interface EventSubscription {
  id: ID;
  appId: ID;
  url: string;
  /** Native event types delivered; empty means every type the app can see. */
  eventTypes: string[];
  createdAt: number;
  /** Delivery health, included in the administrator's app detail response. */
  delivery?: {
    pending: number;
    failed: number;
    /** Given-up events asked to go again, waiting for room in the queue (REV-15). */
    retrying?: number;
    /** Events never queued because the endpoint's backlog was full, or given up on past the kept history. */
    dropped: number;
    lastError: string | null;
    lastFailedAt: number | null;
  };
}
