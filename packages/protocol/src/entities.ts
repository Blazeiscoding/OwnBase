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
}

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

/** An administrative action that was recorded. */
export type AuditAction =
  | "user.role_changed"
  | "user.deactivated"
  | "user.reactivated"
  | "user.password_reset"
  | "user.invite_permission_granted"
  | "user.invite_permission_removed"
  | "account.recovered"
  | "workspace.ownership_transferred"
  | "workspace.renamed"
  | "workspace.access_policy_changed"
  | "app.created"
  | "app.deleted"
  | "app.token_replaced"
  | "app.signing_secret_replaced"
  | "app.interactivity_url_changed"
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
  app: "slackoss";
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
  /**
   * How others reach this workspace, when its host configured it. Links people
   * share are built on it, rather than on whatever address the sharer is using.
   */
  publicUrl?: string;
}

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
  submitLabel: string;
  closeLabel: string;
  /** Opaque app state, carried through untouched. */
  privateMetadata: string;
  /** Anything above the fields — sections, headers — flattened to mrkdwn. */
  text: string;
  fields: ModalField[];
}

/** One input in a modal. Anything Slack offers that is not here is dropped. */
export interface ModalField {
  blockId: string;
  actionId: string;
  label: string;
  hint: string;
  optional: boolean;
  type: "text" | "textarea" | "select";
  placeholder: string;
  initialValue: string;
  /** Choices for a select; empty for the text kinds. */
  options: { text: string; value: string }[];
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
