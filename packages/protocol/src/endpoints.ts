import { bytes, endpoint, json, text, type EndpointSpec } from "./endpoint.js";
import type {
  AccessPolicy,
  App,
  AuditEntry,
  Channel,
  ChannelPrefs,
  EventSubscription,
  FileMeta,
  FollowedThread,
  Friendship,
  ID,
  Invite,
  Message,
  NotifyLevel,
  ReminderItem,
  Reminder,
  ReportedMessage,
  ScheduledMessage,
  ServerInfo,
  SessionInfo,
  SettingsPanel,
  SignInConnection,
  SharedFile,
  SidebarSection,
  SlashCommand,
  StorageUsage,
  ThreadFollow,
  User,
  Webhook,
  WorkspaceCopy,
  WorkspaceStatus,
} from "./entities.js";
import type { CallLogEntry } from "./huddle.js";
import {
  accessPolicyBody,
  activityQuery,
  adminUserBody,
  appScopesBody,
  auditQuery,
  avatarQuery,
  changePasswordBody,
  channelManagerBody,
  channelPrefsBody,
  createAppBody,
  createChannelBody,
  createCommandBody,
  createInviteBody,
  createSubscriptionBody,
  createWebhookBody,
  downloadQuery,
  editMessageBody,
  editScheduledBody,
  followedThreadsQuery,
  guestAccountBody,
  guestJoinBody,
  interactivityBody,
  inviteMemberBody,
  linkPreviewsBody,
  loginBody,
  markReadBody,
  markUnreadBody,
  messageActionBody,
  messageHistoryQuery,
  notifyDefaultBody,
  pinnedMessagesQuery,
  pollVotesBody,
  readRemovalsBody,
  redeemSignInBody,
  registerBody,
  reminderBody,
  reportMessageBody,
  rescheduleBody,
  resolveReportBody,
  runCommandBody,
  savedMessagesQuery,
  scheduleMessageBody,
  searchQuery,
  sendMessageBody,
  settingsValuesBody,
  sharedFilesQuery,
  sidebarSectionBody,
  sidebarSectionOrderBody,
  threadFollowBody,
  threadHistoryQuery,
  threadMuteBody,
  threadReadBody,
  twoStepCodeBody,
  twoStepPasswordBody,
  twoStepSignInBody,
  updateChannelBody,
  updateMeBody,
  viewSubmitBody,
  workspaceIconQuery,
  workspaceNameBody,
  type UnreadSummary,
} from "./rest.js";

/** A session, as signing in or joining gives one. */
export interface SignedIn {
  token: string;
  user: User;
  /** The password used was issued by someone else, and must be replaced first. */
  mustChangePassword?: boolean;
}

/**
 * What a password gets: a session, or, for an account with two-step sign-in
 * (E11), the challenge its second step answers before `expiresAt`.
 */
export type LoginResult = SignedIn | { twoStep: { challenge: string; expiresAt: number } };

/** One entry in the composer's `/` hint list. */
export interface CommandHint {
  command: string;
  description: string;
  usageHint: string;
  /** Answered by the server itself rather than an installed app. */
  builtin: boolean;
}

/** An app with everything hanging off it, as the admin screen needs it. */
export interface AppDetail extends App {
  webhooks: Webhook[];
  commands: SlashCommand[];
  subscriptions: EventSubscription[];
  /** Readable by admins: apps need it to verify our signatures. */
  signingSecret: string;
}

/** A way for calls to connect, as `RTCIceServer` takes it. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** A one-time ticket for `?download=`, spent on first use, until `expiresAt`. */
export interface DownloadTicket {
  token: string;
  expiresAt: number;
}

/** A window of a conversation's history, centred on one message. */
export interface MessageWindow {
  messages: Message[];
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
  seq: number;
}

/** A page of a thread: its root, and replies before, after or around one. */
export interface ThreadPage extends MessageWindow {
  root: Message;
}

/**
 * A filled-in form, as the app took it: field errors keyed by block id, or,
 * once accepted, the forms that closed (E18b).
 */
export interface ViewSubmitted {
  ok: boolean;
  errors?: Record<string, string>;
  message?: string;
  closedViewIds?: ID[];
}

/**
 * Slack's answer shape, for the Web API methods apps call. A refusal still
 * has HTTP status 200, with `ok: false` and an `error` code.
 */
export interface SlackAnswer {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * Every REST route the server answers, declared once: the server registers
 * each through `route()`, and the client's `Api` calls each by its name here.
 * Enterprise routes are declared the same way in ee/.
 */
export const endpoints = {
  // ---------- unauthenticated ----------

  health: endpoint({
    method: "GET",
    path: "/api/health",
    access: "public",
    answer: json<{ status: "ok"; instanceId: string }>(),
  }),

  rtcConfig: endpoint({
    method: "GET",
    path: "/api/rtc-config",
    access: "guest",
    answer: json<{ iceServers: IceServer[] }>(),
    timeoutMs: 5000,
  }),

  serverInfo: endpoint({
    method: "GET",
    path: "/api/server-info",
    access: "public",
    answer: json<ServerInfo>(),
    timeoutMs: 4000,
  }),

  /**
   * The workspace's icon, for anyone: the Join screen shows it beside the
   * workspace's name before anyone signs in. Its type is the one its bytes
   * were checked to be. Asked for by its current version, the answer never
   * changes, since another picture has another version, so it is kept for a
   * year; asked for otherwise, it is checked again each time.
   */
  workspaceIcon: endpoint({
    method: "GET",
    path: "/api/workspace/icon",
    access: "public",
    query: workspaceIconQuery,
    answer: bytes,
    timeoutMs: 20000,
  }),

  register: endpoint({
    method: "POST",
    path: "/api/auth/register",
    access: "public",
    body: registerBody,
    answer: json<SignedIn>(),
    status: 201,
    timeoutMs: 20000,
  }),

  /**
   * Joining with a display name alone, where the host allows guests. The
   * policy is read inside the same write that creates the guest, so a page
   * that still says guests are welcome cannot let one in after the host said
   * no. Rationed by address like any sign-in, and bounded in number.
   */
  joinAsGuest: endpoint({
    method: "POST",
    path: "/api/auth/guest",
    access: "public",
    body: guestJoinBody,
    answer: json<SignedIn>(),
    status: 201,
  }),

  /**
   * A guest keeping who they are as an account: same id, so their messages
   * and rooms stay theirs. Only while accounts can be created without an
   * invite, and a new session replaces every guest one.
   */
  createAccountFromGuest: endpoint({
    method: "POST",
    path: "/api/auth/guest/account",
    access: "guest",
    body: guestAccountBody,
    answer: json<SignedIn>(),
    timeoutMs: 20000,
  }),

  login: endpoint({
    method: "POST",
    path: "/api/auth/login",
    access: "public",
    body: loginBody,
    answer: json<LoginResult>(),
    timeoutMs: 20000,
  }),

  /**
   * The second step of signing in (E11): a code from the authenticator app,
   * each step's once, or a recovery code, each once. A few wrong ones send
   * the person back to their password.
   */
  signInSecondStep: endpoint({
    method: "POST",
    path: "/api/auth/two-step",
    access: "public",
    body: twoStepSignInBody,
    answer: json<SignedIn & { recoveryCodesLeft: number }>(),
  }),

  logout: endpoint({
    method: "POST",
    path: "/api/auth/logout",
    access: "public",
    answer: json<{ ok: true }>(),
  }),

  /**
   * Changing a password proves you know the current one, then signs out
   * everywhere else. A password is usually changed because someone else might
   * know it; leaving their sessions running would defeat the whole exercise.
   */
  changePassword: endpoint({
    method: "POST",
    path: "/api/auth/password",
    access: "member",
    whileLocked: true,
    body: changePasswordBody,
    answer: json<{ ok: true }>(),
    timeoutMs: 20000,
  }),

  /** Whether two-step sign-in is on, and how many recovery codes are left (E11). */
  twoStep: endpoint({
    method: "GET",
    path: "/api/me/two-step",
    access: "member",
    answer: json<{ enabled: boolean; recoveryCodesLeft: number }>(),
  }),

  /** Starts setting two-step sign-in up: a new key and what an app scans for it (E11). */
  startTwoStep: endpoint({
    method: "POST",
    path: "/api/me/two-step",
    access: "member",
    body: twoStepPasswordBody,
    answer: json<{ secret: string; uri: string }>(),
    timeoutMs: 20000,
  }),

  /**
   * Turns two-step sign-in on once a code from the new key is right (E11),
   * and gives the recovery codes, which are never shown again. Other devices
   * stay signed in; it is asked for at each sign-in from now on.
   */
  enableTwoStep: endpoint({
    method: "POST",
    path: "/api/me/two-step/enable",
    access: "member",
    body: twoStepCodeBody,
    answer: json<{ recoveryCodes: string[] }>(),
  }),

  /** A new set of recovery codes in place of the old (E11), shown once. */
  newRecoveryCodes: endpoint({
    method: "POST",
    path: "/api/me/two-step/recovery-codes",
    access: "member",
    body: twoStepPasswordBody,
    answer: json<{ recoveryCodes: string[] }>(),
    timeoutMs: 20000,
  }),

  /** Turns two-step sign-in off (E11). */
  disableTwoStep: endpoint({
    method: "POST",
    path: "/api/me/two-step/disable",
    access: "member",
    body: twoStepPasswordBody,
    answer: json<{ ok: true }>(),
    timeoutMs: 20000,
  }),

  /** Everywhere this account is signed in, so its owner can see and end them. */
  listSessions: endpoint({
    method: "GET",
    path: "/api/auth/sessions",
    access: "member",
    answer: json<{ sessions: SessionInfo[] }>(),
  }),

  revokeSession: endpoint({
    method: "DELETE",
    path: "/api/auth/sessions/:id",
    access: "member",
    answer: json<{ ok: true }>(),
  }),

  /** "Sign out my other devices" — the one asking stays signed in. */
  revokeOtherSessions: endpoint({
    method: "DELETE",
    path: "/api/auth/sessions",
    access: "member",
    answer: json<{ revoked: number }>(),
  }),

  // ---------- me / users ----------

  me: endpoint({ method: "GET", path: "/api/me", access: "guest", answer: json<{ user: User }>() }),

  updateMe: endpoint({
    method: "PATCH",
    path: "/api/me",
    access: "guest",
    body: updateMeBody,
    answer: json<{ user: User }>(),
  }),

  /**
   * Someone's profile picture, for whoever is signed in (E9). A request
   * naming its version may keep it for good: another picture has another.
   */
  avatar: endpoint({
    method: "GET",
    path: "/api/users/:id/avatar",
    access: "guest",
    query: avatarQuery,
    answer: bytes,
    timeoutMs: 30000,
  }),

  /** Removes this account's profile picture; its initials show again. */
  removeAvatar: endpoint({
    method: "DELETE",
    path: "/api/me/avatar",
    access: "member",
    answer: json<{ user: User }>(),
  }),

  listUsers: endpoint({
    method: "GET",
    path: "/api/users",
    access: "guest",
    answer: json<{ users: User[] }>(),
  }),

  friends: endpoint({
    method: "GET",
    path: "/api/friends",
    access: "guest",
    answer: json<{ friends: Friendship[] }>(),
  }),

  requestFriend: endpoint({
    method: "POST",
    path: "/api/friends/:id",
    access: "member",
    answer: json<{ friends: Friendship[] }>(),
  }),

  acceptFriend: endpoint({
    method: "PUT",
    path: "/api/friends/:id",
    access: "member",
    answer: json<{ friends: Friendship[] }>(),
  }),

  removeFriend: endpoint({
    method: "DELETE",
    path: "/api/friends/:id",
    access: "member",
    answer: json<{ friends: Friendship[] }>(),
  }),

  /**
   * Blocks someone for this account (E12): it hears nothing from them, and
   * they are told nothing. Blocking also ends a friendship or a request between
   * the two, as it does elsewhere; that alone reaches them, as an unfriending.
   */
  blockUser: endpoint({
    method: "PUT",
    path: "/api/me/blocks/:id",
    access: "guest",
    answer: json<{ blocked: ID[] }>(),
  }),

  /** Unblocks someone for this account (E12). */
  unblockUser: endpoint({
    method: "DELETE",
    path: "/api/me/blocks/:id",
    access: "guest",
    answer: json<{ blocked: ID[] }>(),
  }),

  listChannels: endpoint({
    method: "GET",
    path: "/api/channels",
    access: "guest",
    answer: json<{ channels: Channel[]; memberCounts: Record<ID, number> }>(),
  }),

  createChannel: endpoint({
    method: "POST",
    path: "/api/channels",
    access: "member",
    body: createChannelBody,
    answer: json<{ channel: Channel }>(),
    status: 201,
  }),

  updateChannel: endpoint({
    method: "PATCH",
    path: "/api/channels/:id",
    access: "member",
    body: updateChannelBody,
    answer: json<{ channel: Channel }>(),
  }),

  joinChannel: endpoint({
    method: "POST",
    path: "/api/channels/:id/join",
    access: "guest",
    answer: json<{ ok: true }>(),
  }),

  leaveChannel: endpoint({
    method: "POST",
    path: "/api/channels/:id/leave",
    access: "guest",
    answer: json<{ ok: true }>(),
  }),

  inviteMember: endpoint({
    method: "POST",
    path: "/api/channels/:id/invite-member",
    access: "member",
    body: inviteMemberBody,
    answer: json<{ ok: true }>(),
  }),

  removeChannelMember: endpoint({
    method: "DELETE",
    path: "/api/channels/:id/members/:userId",
    access: "member",
    answer: json<{ ok: true }>(),
  }),

  setChannelManager: endpoint({
    method: "PATCH",
    path: "/api/channels/:id/managers/:userId",
    access: "member",
    body: channelManagerBody,
    answer: json<{ channel: Channel }>(),
  }),

  channelMembers: endpoint({
    method: "GET",
    path: "/api/channels/:id/members",
    access: "guest",
    answer: json<{ memberIds: ID[] }>(),
  }),

  markRead: endpoint({
    method: "POST",
    path: "/api/channels/:id/read",
    access: "guest",
    body: markReadBody,
    answer: json<{ ok: true; seq: number }>(),
  }),

  markUnread: endpoint({
    method: "POST",
    path: "/api/channels/:id/unread",
    access: "guest",
    body: markUnreadBody,
    answer: json<{ ok: true; seq: number }>(),
  }),

  // ---------- messages ----------

  threadHistory: endpoint({
    method: "GET",
    path: "/api/channels/:id/threads/:rootId",
    access: "guest",
    query: threadHistoryQuery,
    answer: json<ThreadPage>(),
  }),

  listMessages: endpoint({
    method: "GET",
    path: "/api/channels/:id/messages",
    access: "guest",
    query: messageHistoryQuery,
    answer: json<{ messages: Message[]; readThroughSeq: number; seq: number }>(),
  }),

  listMessagesAround: endpoint({
    method: "GET",
    path: "/api/channels/:id/messages/around/:messageId",
    access: "guest",
    query: messageHistoryQuery,
    answer: json<MessageWindow & { threadRootId: ID | null }>(),
  }),

  // A window of history centred on the first message after `seq`, where
  // someone who had read up to it takes up reading again. A conversation with
  // more unread than one page opens there, at its New line, not at the newest.
  // Their own messages are skipped: 404 when nobody else has written since.
  listMessagesSince: endpoint({
    method: "GET",
    path: "/api/channels/:id/messages/since/:seq",
    access: "guest",
    query: messageHistoryQuery,
    answer: json<MessageWindow & { targetId: ID }>(),
  }),

  // One message, for the card under a link to it. Asked by each reader, so a
  // message in a private conversation shows only to the people in it.
  getMessage: endpoint({
    method: "GET",
    path: "/api/channels/:id/messages/:messageId",
    access: "guest",
    answer: json<{ message: Message }>(),
  }),

  listMessagesAfter: endpoint({
    method: "GET",
    path: "/api/channels/:id/messages/after/:messageId",
    access: "guest",
    query: messageHistoryQuery,
    answer: json<{ messages: Message[]; seq: number }>(),
  }),

  sendMessage: endpoint({
    method: "POST",
    path: "/api/channels/:id/messages",
    access: "guest",
    body: sendMessageBody,
    answer: json<{ message: Message }>(),
    status: 201,
    timeoutMs: 30000,
  }),

  editMessage: endpoint({
    method: "PATCH",
    path: "/api/messages/:id",
    access: "guest",
    body: editMessageBody,
    answer: json<{ message: Message }>(),
  }),

  deleteMessage: endpoint({
    method: "DELETE",
    path: "/api/messages/:id",
    access: "guest",
    answer: json<{ ok: true }>(),
  }),

  /**
   * Reports a message to the workspace's admins (E12), by anyone who can read
   * it but its author. Reporting it again while the first report is open
   * changes nothing, and its author is told nothing.
   */
  reportMessage: endpoint({
    method: "POST",
    path: "/api/messages/:id/report",
    access: "guest",
    body: reportMessageBody,
    answer: json<{ ok: true }>(),
  }),

  // ---------- link previews ----------

  /**
   * A preview's picture, for whoever can read its message. The server fetched
   * it and checked its first bytes; it is sent as the type those bytes say,
   * never sniffed again by the browser, and kept by nothing on the way.
   */
  previewImage: endpoint({
    method: "GET",
    path: "/api/link-previews/:id/image",
    access: "member",
    answer: bytes,
    timeoutMs: 300000,
  }),

  /** The sender takes a preview off their message; an edit keeping the link leaves it off. */
  removeLinkPreview: endpoint({
    method: "DELETE",
    path: "/api/link-previews/:id",
    access: "member",
    answer: json<{ ok: true }>(),
  }),

  // ---------- files ----------

  storageUsage: endpoint({
    method: "GET",
    path: "/api/storage",
    access: "member",
    answer: json<StorageUsage>(),
  }),

  uploadFile: endpoint({
    method: "POST",
    path: "/api/channels/:id/files",
    access: "member",
    body: "file",
    answer: json<{ file: FileMeta }>(),
    status: 201,
    timeoutMs: 300000,
  }),

  /**
   * The file browser's page (E7): files shared in conversations the asker can
   * read, newest first, by kind, sharer, conversation and words in the name.
   */
  listSharedFiles: endpoint({
    method: "GET",
    path: "/api/files",
    access: "guest",
    query: sharedFilesQuery,
    answer: json<{ files: SharedFile[]; nextCursor: string | null }>(),
  }),

  fileDownloadToken: endpoint({
    method: "POST",
    path: "/api/files/:id/download-token",
    access: "guest",
    answer: json<DownloadTicket>(),
  }),

  file: endpoint({
    method: "GET",
    path: "/api/files/:id",
    access: "guest",
    ticket: true,
    query: downloadQuery,
    answer: bytes,
    timeoutMs: 300000,
  }),

  // ---------- reactions ----------

  addReaction: endpoint({
    method: "PUT",
    path: "/api/messages/:id/reactions/:emoji",
    access: "guest",
    answer: json<{ ok: true }>(),
  }),

  removeReaction: endpoint({
    method: "DELETE",
    path: "/api/messages/:id/reactions/:emoji",
    access: "guest",
    answer: json<{ ok: true }>(),
  }),

  // ---------- polls (E6) ----------

  /**
   * A voter's choices, replacing any before; none takes the vote back. Readers
   * are told the new count by a `message.updated` that says `pollOnly`, and the
   * voter's own devices what they chose, which an anonymous poll says to nobody.
   */
  votePoll: endpoint({
    method: "PUT",
    path: "/api/messages/:id/poll/votes",
    access: "guest",
    body: pollVotesBody,
    answer: json<{ message: Message; choices: number[] }>(),
  }),

  /** Its author closes a poll for good: the votes stand and nobody can change them. */
  closePoll: endpoint({
    method: "POST",
    path: "/api/messages/:id/poll/close",
    access: "member",
    answer: json<{ message: Message }>(),
  }),

  /**
   * For the owner and admins: whether the server is keeping up, from counts,
   * sizes and times alone. Nothing from a conversation, an app's delivery
   * error or a credential is in it.
   */
  workspaceStatus: endpoint({
    method: "GET",
    path: "/api/admin/status",
    access: "admin",
    answer: json<WorkspaceStatus>(),
  }),

  workspaceCopy: endpoint({
    method: "GET",
    path: "/api/admin/copy",
    access: "owner",
    answer: json<{ copy: WorkspaceCopy | null }>(),
  }),

  makeWorkspaceCopy: endpoint({
    method: "POST",
    path: "/api/admin/copy",
    access: "owner",
    answer: json<{ copy: WorkspaceCopy }>(),
  }),

  copyDownloadToken: endpoint({
    method: "POST",
    path: "/api/admin/copy/download-token",
    access: "owner",
    answer: json<DownloadTicket>(),
  }),

  /**
   * The copy as one zip. A ticket stands in for the header a download in the
   * browser cannot carry, and whoever spends it must still be the owner,
   * signed in with the session that asked for it.
   */
  copyFile: endpoint({
    method: "GET",
    path: "/api/admin/copy/:id",
    access: "owner",
    ticket: true,
    query: downloadQuery,
    answer: bytes,
    timeoutMs: 300000,
  }),

  /**
   * For the owner and admins: what happened in huddles lately (see
   * `CallLog`), in the conversations they can see themselves. Memory only.
   */
  callLog: endpoint({
    method: "GET",
    path: "/api/admin/calls",
    access: "admin",
    answer: json<{ entries: CallLogEntry[] }>(),
  }),

  createApp: endpoint({
    method: "POST",
    path: "/api/apps",
    access: "admin",
    body: createAppBody,
    answer: json<{ app: App; botUser: User; token: string; signingSecret: string }>(),
    status: 201,
  }),

  listApps: endpoint({
    method: "GET",
    path: "/api/apps",
    access: "admin",
    answer: json<{ apps: AppDetail[] }>(),
  }),

  /**
   * What an app may do (E18c): Slack's scope names, replacing the whole list.
   * Its tokens hold the new list from the next call; events already queued
   * for it were let through under the old one and are still sent.
   *
   * Logged with what was added and taken away, which is what an operator
   * looks for when an app starts or stops seeing something.
   */
  setAppScopes: endpoint({
    method: "PUT",
    path: "/api/apps/:id/scopes",
    access: "admin",
    body: appScopesBody,
    answer: json<{ app: App }>(),
  }),

  /**
   * A new bot token, replacing every one the app had. For a token that has
   * leaked, and for an admin who closed the dialog before copying the one they
   * were shown at creation, which is otherwise a working app nobody can use.
   *
   * Logged without the token: who replaced which app's credentials is what an
   * operator wants to find afterwards.
   */
  replaceAppToken: endpoint({
    method: "POST",
    path: "/api/apps/:id/token",
    access: "admin",
    answer: json<{ token: string }>(),
  }),

  /**
   * A new signing secret. Every request signed from here on uses it, including
   * event deliveries already waiting in the queue, which are signed when they
   * are sent rather than when they were queued. The app refuses them until it
   * has the new secret, which is the point when the old one has leaked.
   */
  replaceSigningSecret: endpoint({
    method: "POST",
    path: "/api/apps/:id/signing-secret",
    access: "admin",
    answer: json<{ signingSecret: string }>(),
  }),

  deleteApp: endpoint({
    method: "DELETE",
    path: "/api/apps/:id",
    access: "admin",
    answer: json<{ ok: true }>(),
  }),

  createWebhook: endpoint({
    method: "POST",
    path: "/api/apps/:id/webhooks",
    access: "admin",
    body: createWebhookBody,
    answer: json<{ webhook: Webhook; url: string }>(),
    status: 201,
  }),

  /**
   * A new URL for an existing webhook. The secret is the whole of a webhook's
   * authority, so a URL pasted somewhere public has to be replaceable without
   * removing the webhook and choosing its channel again.
   */
  replaceWebhookUrl: endpoint({
    method: "POST",
    path: "/api/webhooks/:id/url",
    access: "admin",
    answer: json<{ webhook: Webhook; url: string }>(),
  }),

  deleteWebhook: endpoint({
    method: "DELETE",
    path: "/api/webhooks/:id",
    access: "admin",
    answer: json<{ ok: true }>(),
  }),

  /**
   * Incoming webhook, shaped like Slack's: POST a JSON body with `text` and/or
   * `blocks`. Form-encoded `payload=<json>` is accepted too, since many older
   * integrations send it that way.
   */
  postToWebhook: endpoint({
    method: "POST",
    path: "/hooks/:token",
    access: "public",
    body: "slack",
    answer: text,
  }),

  /**
   * Slack's auth.test. Bolt calls it before it will start, and gives up if it
   * fails, so without it no Bolt app could run against this server at all.
   * `bot_id` is the app's id: this server has no separate bot identity.
   */
  authTest: endpoint({
    method: "POST",
    path: "/api/auth.test",
    access: "bot",
    body: "slack",
    answer: json<SlackAnswer>(),
  }),

  /**
   * Slack Web API compatible send, so existing bot code works by pointing at
   * this server. Errors use Slack's `{ok:false, error}` shape.
   */
  chatPostMessage: endpoint({
    method: "POST",
    path: "/api/chat.postMessage",
    access: "bot",
    body: "slack",
    answer: json<SlackAnswer>(),
  }),

  createCommand: endpoint({
    method: "POST",
    path: "/api/apps/:id/commands",
    access: "admin",
    body: createCommandBody,
    answer: json<{ command: SlashCommand }>(),
    status: 201,
  }),

  deleteCommand: endpoint({
    method: "DELETE",
    path: "/api/commands/:id",
    access: "admin",
    answer: json<{ ok: true }>(),
  }),

  /** Every command anyone can run, for the composer's hint list. */
  listCommands: endpoint({
    method: "GET",
    path: "/api/commands",
    access: "guest",
    answer: json<{ commands: CommandHint[] }>(),
  }),

  /** Runs `/whatever …` typed in a channel. */
  runCommand: endpoint({
    method: "POST",
    path: "/api/channels/:id/commands",
    access: "member",
    body: runCommandBody,
    answer: json<{ ok: boolean; error?: string; message?: string }>(),
    timeoutMs: 30000,
  }),

  /** Slack's `response_url`: how an app replies after its first few seconds. */
  commandResponse: endpoint({
    method: "POST",
    path: "/api/commands/response/:token",
    access: "public",
    body: "slack",
    answer: json<SlackAnswer>(),
  }),

  // ---------- people ----------

  /**
   * Everyone with an account, for an admin who has to run this workspace: who
   * they are, what they can do, and when they were last seen. Bots are in the
   * list because a forgotten bot is exactly the account worth noticing.
   */
  /**
   * What administrators have changed, newest first, for a workspace that has
   * to be able to say who deactivated someone or replaced an app's token.
   */
  listAudit: endpoint({
    method: "GET",
    path: "/api/admin/audit",
    access: "admin",
    query: auditQuery,
    answer: json<{ entries: AuditEntry[]; nextCursor: string | null }>(),
  }),

  listAllUsers: endpoint({
    method: "GET",
    path: "/api/admin/users",
    access: "admin",
    answer: json<{ users: (User & { lastSeenAt: number | null; twoStep: boolean })[] }>(),
  }),

  /**
   * Change what someone can do, or take their access away.
   *
   * The rules are about who may act on whom, and they are deliberately narrow:
   * the owner is untouchable and cannot be locked out of their own server, an
   * admin cannot demote or deactivate another admin (a workspace should not be
   * losable to an argument between two of them), and nobody can act on
   * themselves — an admin cannot quietly promote themselves to owner or lock
   * themselves out by accident.
   */
  updateUserAdmin: endpoint({
    method: "PATCH",
    path: "/api/admin/users/:id",
    access: "admin",
    body: adminUserBody,
    answer: json<{ user: User }>(),
  }),

  /**
   * Password recovery for an installation with no email: an admin issues a
   * temporary password and reads it to the person over whatever channel they
   * trust. It is shown once, all their sessions end, and they are expected to
   * change it. Who may be reset is resettable's to say.
   */
  resetPassword: endpoint({
    method: "POST",
    path: "/api/admin/users/:id/password",
    access: "admin",
    answer: json<{ temporaryPassword: string }>(),
    timeoutMs: 20000,
  }),

  /**
   * Turns someone's two-step sign-in off, for one who lost their authenticator
   * app and recovery codes (E11). Their devices stay signed in; their next
   * sign-in asks for the password alone, and they can set it up again.
   */
  resetTwoStep: endpoint({
    method: "POST",
    path: "/api/admin/users/:id/two-step/reset",
    access: "admin",
    answer: json<{ ok: true }>(),
  }),

  /**
   * The reported messages waiting for an admin (E12), each with its reports:
   * the message itself even from a conversation the admin is not in, since
   * whoever reported it showed it to them, and null once its author deleted it.
   */
  listReports: endpoint({
    method: "GET",
    path: "/api/admin/reports",
    access: "admin",
    answer: json<{ reports: ReportedMessage[] }>(),
  }),

  /**
   * Settles a reported message (E12): dismissed, removed, or removed with its
   * author deactivated, by People's rules for deactivating. Every open report
   * of it closes, and the record says what was done and to whom, never what
   * the message said.
   */
  resolveReport: endpoint({
    method: "POST",
    path: "/api/admin/reports/:id/resolve",
    access: "admin",
    body: resolveReportBody,
    answer: json<{ ok: true }>(),
    timeoutMs: 20000,
  }),

  /**
   * Hands the workspace to someone else. Only the owner can do it, and they
   * become an admin rather than losing their access — a workspace with no owner
   * is the state this whole area exists to prevent.
   */
  transferOwnership: endpoint({
    method: "POST",
    path: "/api/admin/users/:id/owner",
    access: "owner",
    answer: json<{ owner: User; previousOwner: User }>(),
  }),

  // ---------- workspace settings (UX-60) ----------

  /**
   * The workspace's name, for its owner and admins. The host renames it by
   * the same rule, so the two cannot drift apart.
   */
  renameWorkspace: endpoint({
    method: "PUT",
    path: "/api/admin/workspace/name",
    access: "admin",
    body: workspaceNameBody,
    answer: json<{ workspaceName: string }>(),
  }),

  /**
   * Who may join, for its owner and admins: the stored choice every start
   * keeps, and the same one the desktop host changes. Leaving guests allowed
   * signs every guest out at once.
   */
  setAccessPolicy: endpoint({
    method: "PUT",
    path: "/api/admin/workspace/access-policy",
    access: "admin",
    body: accessPolicyBody,
    answer: json<{ accessPolicy: AccessPolicy }>(),
  }),

  /**
   * Link previews for new messages, on or off, for the owner and admins (E2).
   * Turning them off adds none from then on; the previews messages already
   * have stay, and their senders can remove them.
   */
  setLinkPreviews: endpoint({
    method: "PUT",
    path: "/api/admin/workspace/link-previews",
    access: "admin",
    body: linkPreviewsBody,
    answer: json<{ enabled: boolean }>(),
  }),

  /** This account's profile picture, sent whole as the image itself, as the icon is (E9). */
  setAvatar: endpoint({
    method: "PUT",
    path: "/api/me/avatar",
    access: "member",
    body: "image",
    answer: json<{ user: User }>(),
    timeoutMs: 30000,
  }),

  setWorkspaceIcon: endpoint({
    method: "PUT",
    path: "/api/admin/workspace/icon",
    access: "admin",
    body: "image",
    answer: json<{ iconVersion: string }>(),
    timeoutMs: 30000,
  }),

  /** Removes the icon, for the owner and admins; the workspace shows its coloured square again. */
  removeWorkspaceIcon: endpoint({
    method: "DELETE",
    path: "/api/admin/workspace/icon",
    access: "admin",
    answer: json<{ iconVersion: null }>(),
  }),

  /** Slack's views.open: a new form for the person who just asked for one. */
  viewsOpen: endpoint({
    method: "POST",
    path: "/api/views.open",
    access: "bot",
    body: "slack",
    answer: json<SlackAnswer>(),
  }),

  /**
   * Slack's views.push: a form on top of the one the person has open from
   * this app, which they come back to when this one closes. With none open,
   * it opens as views.open would.
   */
  viewsPush: endpoint({
    method: "POST",
    path: "/api/views.push",
    access: "bot",
    body: "slack",
    answer: json<SlackAnswer>(),
  }),

  /**
   * Slack's views.update: changes a form the person still has open, without
   * a trigger, which is how an app shows "Loading" at once and the real form
   * when it has it. What they typed into an input that keeps its block and
   * action ids stays, as on Slack. A `hash` from an earlier answer refuses
   * the change if the view has changed since, so two updates cannot cross.
   */
  viewsUpdate: endpoint({
    method: "POST",
    path: "/api/views.update",
    access: "bot",
    body: "slack",
    answer: json<SlackAnswer>(),
  }),

  /**
   * The person closed a form: it and anything stacked on it go, and their
   * other devices follow. Their own stack only, so nobody can close another
   * person's form. The app is not told, as on Slack without notify_on_close.
   */
  closeView: endpoint({
    method: "POST",
    path: "/api/views/:id/close",
    access: "member",
    answer: json<{ ok: boolean }>(),
  }),

  /**
   * Someone filled the form in and pressed submit. The values go to the app as
   * Slack's `view_submission`; field errors it answers with come back to the
   * client so they can be shown against the fields they belong to.
   */
  submitView: endpoint({
    method: "POST",
    path: "/api/views/:id/submit",
    access: "member",
    body: viewSubmitBody,
    answer: json<ViewSubmitted>(),
    timeoutMs: 30000,
  }),

  /**
   * Where this app's button clicks are delivered. Verified the same way a
   * subscription URL is: an endpoint that cannot echo the challenge has not
   * agreed to receive anything, which is also what stops this server being
   * aimed at an unrelated host.
   */
  setInteractivityUrl: endpoint({
    method: "PUT",
    path: "/api/apps/:id/interactivity",
    access: "admin",
    body: interactivityBody,
    answer: json<{ app: App }>(),
  }),

  /**
   * Someone pressed a button. This posts Slack's `block_actions` payload to
   * the owning app and renders whatever comes back, so an integration written
   * for Slack works unchanged.
   */
  runMessageAction: endpoint({
    method: "POST",
    path: "/api/messages/:id/actions",
    access: "member",
    body: messageActionBody,
    answer: json<{ ok: boolean; error?: string }>(),
    timeoutMs: 30000,
  }),

  // ---------- outgoing event subscriptions ----------

  createSubscription: endpoint({
    method: "POST",
    path: "/api/apps/:id/subscriptions",
    access: "admin",
    body: createSubscriptionBody,
    answer: json<{ subscription: EventSubscription }>(),
    status: 201,
    timeoutMs: 30000,
  }),

  deleteSubscription: endpoint({
    method: "DELETE",
    path: "/api/subscriptions/:id",
    access: "admin",
    answer: json<{ ok: true }>(),
  }),

  retrySubscription: endpoint({
    method: "POST",
    path: "/api/subscriptions/:id/retry",
    access: "admin",
    answer: json<{ ok: true; retried: number; waiting: number }>(),
  }),

  scheduleMessage: endpoint({
    method: "POST",
    path: "/api/channels/:id/scheduled",
    access: "member",
    body: scheduleMessageBody,
    answer: json<{ scheduled: ScheduledMessage }>(),
    status: 201,
    timeoutMs: 15000,
  }),

  listScheduled: endpoint({
    method: "GET",
    path: "/api/scheduled",
    access: "guest",
    answer: json<{ scheduled: ScheduledMessage[] }>(),
  }),

  cancelScheduled: endpoint({
    method: "DELETE",
    path: "/api/scheduled/:id",
    access: "member",
    answer: json<{ ok: true }>(),
  }),

  /** The recovery path for a held or failed message: a past time sends it now. */
  rescheduleMessage: endpoint({
    method: "PATCH",
    path: "/api/scheduled/:id",
    access: "member",
    body: rescheduleBody,
    answer: json<{ scheduled: ScheduledMessage }>(),
  }),

  editScheduledMessage: endpoint({
    method: "PATCH",
    path: "/api/scheduled/:id/text",
    access: "member",
    body: editScheduledBody,
    answer: json<{ scheduled: ScheduledMessage }>(),
  }),

  pinMessage: endpoint({
    method: "PUT",
    path: "/api/messages/:id/pin",
    access: "member",
    answer: json<{ ok: true }>(),
  }),

  unpinMessage: endpoint({
    method: "DELETE",
    path: "/api/messages/:id/pin",
    access: "member",
    answer: json<{ ok: true }>(),
  }),

  listPins: endpoint({
    method: "GET",
    path: "/api/channels/:id/pins",
    access: "guest",
    query: pinnedMessagesQuery,
    answer: json<{ messages: Message[]; nextCursor: string | null; total: number }>(),
  }),

  saveMessage: endpoint({
    method: "PUT",
    path: "/api/messages/:id/save",
    access: "guest",
    answer: json<{ ok: true }>(),
  }),

  unsaveMessage: endpoint({
    method: "DELETE",
    path: "/api/messages/:id/save",
    access: "guest",
    answer: json<{ ok: true }>(),
  }),

  setChannelPrefs: endpoint({
    method: "PATCH",
    path: "/api/channels/:id/prefs",
    access: "guest",
    body: channelPrefsBody,
    bodyOptional: true,
    answer: json<{ prefs: ChannelPrefs }>(),
  }),

  /** What this account's conversations notify about unless one is set on its own (v53). */
  setNotifyDefault: endpoint({
    method: "PUT",
    path: "/api/me/notify-default",
    access: "guest",
    body: notifyDefaultBody,
    bodyOptional: true,
    answer: json<{ level: NotifyLevel }>(),
  }),

  /** What waits here, for a device of this account that has another workspace open. */
  unreadSummary: endpoint({
    method: "GET",
    path: "/api/me/unread",
    access: "guest",
    answer: json<UnreadSummary>(),
  }),

  createSidebarSection: endpoint({
    method: "POST",
    path: "/api/sidebar-sections",
    access: "guest",
    body: sidebarSectionBody,
    bodyOptional: true,
    answer: json<{ section: SidebarSection; sections: SidebarSection[] }>(),
    status: 201,
  }),

  renameSidebarSection: endpoint({
    method: "PATCH",
    path: "/api/sidebar-sections/:id",
    access: "guest",
    body: sidebarSectionBody,
    bodyOptional: true,
    answer: json<{ sections: SidebarSection[] }>(),
  }),

  /** Deletes a section; its conversations go back where they would be. */
  deleteSidebarSection: endpoint({
    method: "DELETE",
    path: "/api/sidebar-sections/:id",
    access: "guest",
    answer: json<{ sections: SidebarSection[] }>(),
  }),

  orderSidebarSections: endpoint({
    method: "PUT",
    path: "/api/sidebar-sections/order",
    access: "guest",
    body: sidebarSectionOrderBody,
    bodyOptional: true,
    answer: json<{ sections: SidebarSection[] }>(),
  }),

  setThreadFollow: endpoint({
    method: "PUT",
    path: "/api/messages/:id/follow",
    access: "guest",
    body: threadFollowBody,
    bodyOptional: true,
    answer: json<{ state: ThreadFollow }>(),
  }),

  setThreadMute: endpoint({
    method: "PUT",
    path: "/api/messages/:id/mute",
    access: "guest",
    body: threadMuteBody,
    bodyOptional: true,
    answer: json<{ state: ThreadFollow }>(),
  }),

  setReminder: endpoint({
    method: "PUT",
    path: "/api/messages/:id/reminder",
    access: "guest",
    body: reminderBody,
    bodyOptional: true,
    answer: json<{ reminder: Reminder }>(),
  }),

  cancelReminder: endpoint({
    method: "DELETE",
    path: "/api/messages/:id/reminder",
    access: "guest",
    answer: json<{ ok: true }>(),
  }),

  listReminders: endpoint({
    method: "GET",
    path: "/api/reminders",
    access: "guest",
    answer: json<{ reminders: ReminderItem[] }>(),
  }),

  markThreadRead: endpoint({
    method: "POST",
    path: "/api/messages/:id/thread/read",
    access: "guest",
    body: threadReadBody,
    bodyOptional: true,
    answer: json<{ state: ThreadFollow }>(),
  }),

  markThreadUnread: endpoint({
    method: "POST",
    path: "/api/messages/:id/thread/unread",
    access: "guest",
    body: markUnreadBody,
    answer: json<{ state: ThreadFollow }>(),
  }),

  listFollowedThreads: endpoint({
    method: "GET",
    path: "/api/threads/followed",
    access: "guest",
    query: followedThreadsQuery,
    answer: json<{ threads: FollowedThread[]; nextCursor: string | null }>(),
  }),

  /**
   * The newest message in each direct conversation the caller is in, newest
   * first, so a list of direct messages can say who said what last. Replies
   * in a thread count only when also sent to the conversation.
   */
  latestDirectMessages: endpoint({
    method: "GET",
    path: "/api/conversations/latest",
    access: "member",
    answer: json<{ messages: Message[] }>(),
  }),

  listSaved: endpoint({
    method: "GET",
    path: "/api/saved",
    access: "guest",
    query: savedMessagesQuery,
    answer: json<{ messages: Message[]; nextCursor: string | null }>(),
  }),

  // ---------- invites & search ----------

  createInvite: endpoint({
    method: "POST",
    path: "/api/invites",
    access: "member",
    body: createInviteBody,
    bodyOptional: true,
    answer: json<{ invite: Invite }>(),
    status: 201,
  }),

  /**
   * The invites someone can do something about: every one for an administrator,
   * and a member's own for everyone else. Codes are credentials for an
   * invite-only workspace, so a member is never shown anyone else's.
   */
  listInvites: endpoint({
    method: "GET",
    path: "/api/invites",
    access: "member",
    answer: json<{ invites: Invite[] }>(),
  }),

  /**
   * Withdraws an invite, for a link that has been shared further than meant.
   * Its creator or an administrator may; anyone else is told there is no such
   * invite, so trying codes cannot confirm which ones exist.
   */
  revokeInvite: endpoint({
    method: "DELETE",
    path: "/api/invites/:code",
    access: "member",
    answer: json<{ invite: Invite }>(),
  }),

  activity: endpoint({
    method: "GET",
    path: "/api/activity",
    access: "guest",
    query: activityQuery,
    answer: json<{ messages: Message[]; nextCursor: ID | null }>(),
  }),

  // Reads notes that someone removed this account from channels, which clears
  // them on every device. One already read, or not this account's, is passed over.
  readChannelRemovals: endpoint({
    method: "POST",
    path: "/api/activity/removals/read",
    access: "guest",
    body: readRemovalsBody,
    answer: json<{ ids: ID[] }>(),
  }),

  search: endpoint({
    method: "GET",
    path: "/api/search",
    access: "guest",
    query: searchQuery,
    answer: json<{ messages: Message[]; nextCursor: ID | null }>(),
  }),

  // The panels the extensions add to Workspace settings, for the owner (P9).
  extensionSettings: endpoint({
    method: "GET",
    path: "/api/admin/extension-settings",
    access: "owner",
    answer: json<{ panels: SettingsPanel[] }>(),
  }),
};

export type EndpointName = keyof typeof endpoints;

/**
 * Routes an extension offers at paths of its own (P9), which the server names
 * in `ServerInfo.signIn` and in settings panels: a client calls each at the
 * path it was given, and the extension declares each at that path.
 */
export const extensionRoutes = {
  /** A one-time sign-in code, and the secret the client began with, for a session. */
  redeemSignIn: {
    method: "POST",
    access: "public",
    body: redeemSignInBody,
    answer: json<SignedIn>(),
    timeoutMs: 20_000,
  },
  /** Whether the signed-in person has linked their account to this way of signing in. */
  signInConnection: { method: "GET", access: "member", answer: json<SignInConnection>() },
  /** Where to link it: a path on this server, opened in a browser. */
  connectSignIn: { method: "POST", access: "guest", answer: json<{ url: string }>() },
  disconnectSignIn: { method: "DELETE", access: "member", answer: json<SignInConnection>() },
  /** A settings panel's values, as `{ [key]: value }`, for the owner. */
  saveSettings: {
    method: "PUT",
    access: "owner",
    body: settingsValuesBody,
    bodyOptional: true,
    answer: json<{ ok: true }>(),
    timeoutMs: 20_000,
  },
} as const satisfies Record<string, Omit<EndpointSpec, "path">>;
