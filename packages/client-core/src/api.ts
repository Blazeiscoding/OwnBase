import {
  endpoint,
  endpoints,
  extensionRoutes,
  type AccessPolicy,
  type AppScope,
  type ChannelPrefsBody,
  type CreateChannelBody,
  type CreateCommandBody,
  type CreateInviteBody,
  type EditScheduledBody,
  type FileKind,
  type ID,
  type NotifyLevel,
  type RegisterBody,
  type ReportReason,
  type ReportResolution,
  type ScheduleMessageBody,
  type SendMessageBody,
  type UpdateChannelBody,
  type UpdateMeBody,
} from "@ownbase/protocol";
import { ApiError, Transport } from "./transport.js";

export { ApiError };
export type { AppDetail, CommandHint, LoginResult, SignedIn } from "@ownbase/protocol";

/** How long a message send waits for the workspace's answer. */
export const SEND_TIMEOUT_MS = endpoints.sendMessage.timeoutMs;

/**
 * A path the server gave for one of its own routes. Anything else is refused
 * before this client sends it a session.
 */
export function serverPath(path: string): string {
  if (!/^\/api\/[A-Za-z0-9/_-]*$/.test(path)) throw new ApiError(502, "invalid_response");
  return path;
}

/** A one-time download ticket, before it is put in an address. */
function ticket(result: { token: unknown }): string {
  if (typeof result.token !== "string" || !/^[a-f0-9]{64}$/.test(result.token))
    throw new ApiError(502, "invalid_response");
  return result.token;
}

/**
 * A workspace server's REST API, a method for each endpoint in `endpoints`.
 * Paths, bodies, answers and timeouts all come from there.
 */
export class Api {
  private readonly http: Transport;

  constructor(baseUrl: string, token: string | null = null) {
    this.http = new Transport(baseUrl, token);
  }

  get baseUrl(): string {
    return this.http.baseUrl;
  }

  setToken(token: string | null): void {
    this.http.setToken(token);
  }

  serverInfo() {
    return this.http.json(endpoints.serverInfo);
  }

  storageUsage(signal?: AbortSignal) {
    return this.http.json(endpoints.storageUsage, {}, { signal });
  }

  /** An address that downloads the file once, within a minute, by a browser's navigation. */
  async downloadUrl(fileId: ID): Promise<string> {
    const issued = await this.http.json(endpoints.fileDownloadToken, { params: { id: fileId } });
    return this.http.url(endpoints.file, {
      params: { id: fileId },
      query: { download: ticket(issued) },
    });
  }

  rtcConfig() {
    return this.http.json(endpoints.rtcConfig);
  }

  friends() {
    return this.http.json(endpoints.friends);
  }

  updateFriend(userId: ID, action: "request" | "accept" | "remove") {
    const route = {
      request: endpoints.requestFriend,
      accept: endpoints.acceptFriend,
      remove: endpoints.removeFriend,
    }[action];
    return this.http.json(route, { params: { id: userId } });
  }

  register(body: RegisterBody) {
    return this.http.json(endpoints.register, { body });
  }

  /**
   * Signs in with a password. This client always says it can answer a second
   * step (E11); an account with two-step sign-in then gets a challenge in
   * place of a session.
   */
  login(body: { handle: string; password: string }) {
    return this.http.json(endpoints.login, { body: { ...body, twoStep: true } });
  }

  /**
   * The second step of signing in (E11): the first step's challenge, and a
   * code from the authenticator app or one of the recovery codes.
   */
  signInSecondStep(body: { challenge: string } & ({ code: string } | { recoveryCode: string })) {
    return this.http.json(endpoints.signInSecondStep, { body });
  }

  /**
   * Signs in with the one-time code a way of signing in besides a password
   * came back with (P9), and the secret this client began it with.
   */
  redeemSignIn(path: string, body: { code: string; verifier: string }) {
    const route = endpoint({ ...extensionRoutes.redeemSignIn, path: serverPath(path) });
    return this.http.json(route, { body });
  }

  /** Whether the signed-in person has linked their account to a way of signing in (P9). */
  signInConnection(path: string) {
    return this.http.json(
      endpoint({ ...extensionRoutes.signInConnection, path: serverPath(path) }),
    );
  }

  /** Where to link it: a path on this server, opened in a browser (P9). */
  connectSignIn(path: string) {
    return this.http.json(endpoint({ ...extensionRoutes.connectSignIn, path: serverPath(path) }));
  }

  disconnectSignIn(path: string) {
    return this.http.json(
      endpoint({ ...extensionRoutes.disconnectSignIn, path: serverPath(path) }),
    );
  }

  /** The panels the server's extensions add to Workspace settings, for the owner (P9). */
  extensionSettings() {
    return this.http.json(endpoints.extensionSettings);
  }

  /** Saves a panel's values where it says, as `{ [key]: value }`. */
  saveExtensionSettings(path: string, values: Record<string, string | boolean>) {
    const route = endpoint({ ...extensionRoutes.saveSettings, path: serverPath(path) });
    return this.http.json(route, { body: values });
  }

  /** Joins with a display name alone, where the workspace allows guests. */
  joinAsGuest(displayName: string) {
    return this.http.json(endpoints.joinAsGuest, { body: { displayName } });
  }

  /**
   * Keeps a guest's identity as an account. Every guest session ends,
   * this one included; the token returned replaces it.
   */
  createAccountFromGuest(body: { handle: string; password: string }) {
    return this.http.json(endpoints.createAccountFromGuest, { body });
  }

  logout() {
    return this.http.json(endpoints.logout);
  }

  changePassword(currentPassword: string, newPassword: string) {
    return this.http.json(endpoints.changePassword, { body: { currentPassword, newPassword } });
  }

  listSessions() {
    return this.http.json(endpoints.listSessions);
  }

  revokeSession(id: ID) {
    return this.http.json(endpoints.revokeSession, { params: { id } });
  }

  revokeOtherSessions() {
    return this.http.json(endpoints.revokeOtherSessions);
  }

  /** Whether this account asks for a code at sign-in, and how many recovery codes it has left (E11). */
  twoStep() {
    return this.http.json(endpoints.twoStep);
  }

  /**
   * Starts setting two-step sign-in up (E11): a new key, and the address an
   * authenticator app scans for it. Nothing changes until a code from it is
   * given to `enableTwoStep`.
   */
  startTwoStep(password: string) {
    return this.http.json(endpoints.startTwoStep, { body: { password } });
  }

  /** Turns two-step sign-in on with a code from the new key; the recovery codes, shown once. */
  enableTwoStep(code: string) {
    return this.http.json(endpoints.enableTwoStep, { body: { code } });
  }

  /** A new set of recovery codes in place of the old (E11), shown once. */
  newRecoveryCodes(password: string) {
    return this.http.json(endpoints.newRecoveryCodes, { body: { password } });
  }

  disableTwoStep(password: string) {
    return this.http.json(endpoints.disableTwoStep, { body: { password } });
  }

  /** Turns someone's two-step sign-in off, for one who lost their app and codes. Admins only. */
  resetTwoStep(userId: ID) {
    return this.http.json(endpoints.resetTwoStep, { params: { id: userId } });
  }

  /** Blocks someone for this account (E12); everyone it has blocked now. */
  blockUser(userId: ID) {
    return this.http.json(endpoints.blockUser, { params: { id: userId } });
  }

  unblockUser(userId: ID) {
    return this.http.json(endpoints.unblockUser, { params: { id: userId } });
  }

  /** Reports a message to the workspace's admins (E12), with why and anything to add. */
  reportMessage(messageId: ID, reason: ReportReason, note = "") {
    return this.http.json(endpoints.reportMessage, {
      params: { id: messageId },
      body: { reason, ...(note.trim() ? { note: note.trim() } : {}) },
    });
  }

  /** The reported messages waiting for an admin (E12). Admins only. */
  listReports() {
    return this.http.json(endpoints.listReports);
  }

  /** Settles a reported message: dismissed, removed, or removed with its author deactivated (E12). Admins only. */
  resolveReport(messageId: ID, action: ReportResolution) {
    return this.http.json(endpoints.resolveReport, { params: { id: messageId }, body: { action } });
  }

  resetPassword(userId: ID) {
    return this.http.json(endpoints.resetPassword, { params: { id: userId } });
  }

  /**
   * Renames the workspace, for its owner and admins. Everyone signed in hears
   * `workspace.renamed`.
   */
  renameWorkspace(name: string) {
    return this.http.json(endpoints.renameWorkspace, { body: { name } });
  }

  /**
   * Changes who may join, for the owner and admins. Leaving guests allowed signs
   * every guest out. Everyone signed in hears `workspace.accessPolicy`.
   */
  setAccessPolicy(accessPolicy: AccessPolicy) {
    return this.http.json(endpoints.setAccessPolicy, { body: { accessPolicy } });
  }

  /**
   * Turns link previews on or off for new messages, for the owner and admins
   * (E2). Everyone signed in hears `workspace.linkPreviews`.
   */
  setLinkPreviews(enabled: boolean) {
    return this.http.json(endpoints.setLinkPreviews, { body: { enabled } });
  }

  /** Takes a preview off the sender's own message, for good. */
  removeLinkPreview(id: ID) {
    return this.http.json(endpoints.removeLinkPreview, { params: { id } });
  }

  /**
   * Sets the workspace's icon, for the owner and admins: a PNG, JPEG or WebP
   * image of at most `WORKSPACE_ICON_MAX_BYTES`, sent as itself. Everyone
   * signed in hears `workspace.icon`.
   */
  setWorkspaceIcon(image: Blob) {
    return this.http.json(endpoints.setWorkspaceIcon, { body: image });
  }

  removeWorkspaceIcon() {
    return this.http.json(endpoints.removeWorkspaceIcon);
  }

  /**
   * The workspace's icon, which anyone may read, signed in or not. Asked for
   * by its version, so the browser keeps it until the version changes.
   * Rejects with `no_icon` when the workspace has none.
   */
  workspaceIcon(version: string, signal?: AbortSignal) {
    return this.http.bytes(endpoints.workspaceIcon, { query: { v: version } }, { signal });
  }

  transferOwnership(userId: ID) {
    return this.http.json(endpoints.transferOwnership, { params: { id: userId } });
  }

  me() {
    return this.http.json(endpoints.me);
  }

  updateMe(body: UpdateMeBody) {
    return this.http.json(endpoints.updateMe, { body });
  }

  /** Keeps this picture as this account's own (E9): the image itself, made small first. */
  setAvatar(image: Blob) {
    return this.http.json(endpoints.setAvatar, { body: image });
  }

  /** Removes this account's picture; its initials show again. */
  removeAvatar() {
    return this.http.json(endpoints.removeAvatar);
  }

  /**
   * Someone's picture, named by its version, which the browser may keep:
   * another picture has another version.
   */
  fetchAvatar(userId: ID, version: string) {
    return this.http.bytes(endpoints.avatar, { params: { id: userId }, query: { v: version } });
  }

  listUsers() {
    return this.http.json(endpoints.listUsers);
  }

  /** Every channel this account can see, with how many active people each room holds. */
  listChannels(signal?: AbortSignal) {
    return this.http.json(endpoints.listChannels, {}, { signal });
  }

  createChannel(body: CreateChannelBody) {
    return this.http.json(endpoints.createChannel, { body });
  }

  updateChannel(id: ID, body: UpdateChannelBody) {
    return this.http.json(endpoints.updateChannel, { params: { id }, body });
  }

  joinChannel(id: ID) {
    return this.http.json(endpoints.joinChannel, { params: { id } });
  }

  leaveChannel(id: ID) {
    return this.http.json(endpoints.leaveChannel, { params: { id } });
  }

  inviteMember(channelId: ID, userId: ID) {
    return this.http.json(endpoints.inviteMember, { params: { id: channelId }, body: { userId } });
  }

  channelMembers(id: ID) {
    return this.http.json(endpoints.channelMembers, { params: { id } });
  }

  setChannelManager(channelId: ID, userId: ID, manager: boolean) {
    return this.http.json(endpoints.setChannelManager, {
      params: { id: channelId, userId },
      body: { manager },
    });
  }

  removeChannelMember(channelId: ID, userId: ID) {
    return this.http.json(endpoints.removeChannelMember, { params: { id: channelId, userId } });
  }

  markRead(channelId: ID, seq: number, signal?: AbortSignal) {
    return this.http.json(
      endpoints.markRead,
      { params: { id: channelId }, body: { seq } },
      { signal },
    );
  }

  listMessages(
    channelId: ID,
    opts: { before?: ID; limit?: number; threadRootId?: ID; signal?: AbortSignal } = {},
  ) {
    const { signal, ...query } = opts;
    return this.http.json(endpoints.listMessages, { params: { id: channelId }, query }, { signal });
  }

  /** A window of messages centred on one, for jumping to it. */
  listMessagesAround(channelId: ID, messageId: ID, limit = 50, signal?: AbortSignal) {
    return this.http.json(
      endpoints.listMessagesAround,
      { params: { id: channelId, messageId }, query: { limit } },
      { signal },
    );
  }

  /**
   * A window centred on the first message after `seq`, where someone who had
   * read up to it takes up reading again. 404 when nothing was said since.
   */
  listMessagesSince(channelId: ID, seq: number, limit = 50, signal?: AbortSignal) {
    return this.http.json(
      endpoints.listMessagesSince,
      { params: { id: channelId, seq }, query: { limit } },
      { signal },
    );
  }

  listMessagesAfter(channelId: ID, afterId: ID, limit = 50, signal?: AbortSignal) {
    return this.http.json(
      endpoints.listMessagesAfter,
      { params: { id: channelId, messageId: afterId }, query: { limit } },
      { signal },
    );
  }

  threadHistory(
    channelId: ID,
    rootId: ID,
    opts: { before?: ID; after?: ID; around?: ID; limit?: number; signal?: AbortSignal } = {},
  ) {
    const { signal, ...query } = opts;
    return this.http.json(
      endpoints.threadHistory,
      { params: { id: channelId, rootId }, query },
      { signal },
    );
  }

  /** One message, for the card under a link to it; a 404 when it is gone or not readable. */
  getMessage(channelId: ID, messageId: ID, signal?: AbortSignal) {
    return this.http.json(
      endpoints.getMessage,
      { params: { id: channelId, messageId } },
      { signal },
    );
  }

  /**
   * A send carries a nonce, so one that waited too long for an answer can go
   * again without posting twice.
   */
  sendMessage(channelId: ID, body: SendMessageBody) {
    return this.http.json(endpoints.sendMessage, { params: { id: channelId }, body });
  }

  /** With `expectedText`, refused as `message_changed` if the words are no longer those. */
  editMessage(id: ID, text: string, expectedText?: string) {
    return this.http.json(endpoints.editMessage, { params: { id }, body: { text, expectedText } });
  }

  deleteMessage(id: ID) {
    return this.http.json(endpoints.deleteMessage, { params: { id } });
  }

  addReaction(messageId: ID, emoji: string) {
    return this.http.json(endpoints.addReaction, { params: { id: messageId, emoji } });
  }

  removeReaction(messageId: ID, emoji: string) {
    return this.http.json(endpoints.removeReaction, { params: { id: messageId, emoji } });
  }

  /** Uploads one file to a channel; attach the returned id to a message. */
  uploadFile(
    channelId: ID,
    file: Blob,
    name: string,
    opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
  ) {
    const form = new FormData();
    form.append("file", file, name);
    return this.http.upload(endpoints.uploadFile, { params: { id: channelId } }, form, opts);
  }

  /** A link preview's picture, which the server fetched from the page (E2). */
  fetchPreviewImage(previewId: ID, signal?: AbortSignal) {
    return this.http.bytes(endpoints.previewImage, { params: { id: previewId } }, { signal });
  }

  fetchFile(fileId: ID, signal?: AbortSignal) {
    return this.http.bytes(endpoints.file, { params: { id: fileId } }, { signal });
  }

  scheduleMessage(channelId: ID, body: ScheduleMessageBody) {
    return this.http.json(endpoints.scheduleMessage, { params: { id: channelId }, body });
  }

  listScheduled(signal?: AbortSignal) {
    return this.http.json(endpoints.listScheduled, {}, { signal });
  }

  cancelScheduled(id: ID) {
    return this.http.json(endpoints.cancelScheduled, { params: { id } });
  }

  /** Requeues a held or failed message. A past time sends it on the next flush. */
  rescheduleMessage(id: ID, sendAt: number) {
    return this.http.json(endpoints.rescheduleMessage, { params: { id }, body: { sendAt } });
  }

  editScheduledMessage(id: ID, body: EditScheduledBody) {
    return this.http.json(endpoints.editScheduledMessage, { params: { id }, body });
  }

  setChannelPrefs(channelId: ID, body: ChannelPrefsBody) {
    return this.http.json(endpoints.setChannelPrefs, { params: { id: channelId }, body });
  }

  /** What conversations notify about unless one is set on its own (v53). */
  setNotifyDefault(level: NotifyLevel) {
    return this.http.json(endpoints.setNotifyDefault, { body: { level } });
  }

  /** What waits in this workspace, for a device showing another one. */
  unreadSummary() {
    return this.http.json(endpoints.unreadSummary);
  }

  pinMessage(id: ID) {
    return this.http.json(endpoints.pinMessage, { params: { id } });
  }

  unpinMessage(id: ID) {
    return this.http.json(endpoints.unpinMessage, { params: { id } });
  }

  listPins(channelId: ID, signal?: AbortSignal, cursor?: string, limit = 30) {
    return this.http.json(
      endpoints.listPins,
      { params: { id: channelId }, query: { limit, cursor } },
      { signal },
    );
  }

  saveMessage(id: ID) {
    return this.http.json(endpoints.saveMessage, { params: { id } });
  }

  unsaveMessage(id: ID) {
    return this.http.json(endpoints.unsaveMessage, { params: { id } });
  }

  listSaved(cursor?: string, signal?: AbortSignal) {
    return this.http.json(endpoints.listSaved, { query: { limit: 30, cursor } }, { signal });
  }

  /** Adds a section at the end of this account's sidebar (E8). */
  createSidebarSection(name: string) {
    return this.http.json(endpoints.createSidebarSection, { body: { name } });
  }

  renameSidebarSection(id: ID, name: string) {
    return this.http.json(endpoints.renameSidebarSection, { params: { id }, body: { name } });
  }

  /** Deletes a section; its conversations go back where they would be. */
  deleteSidebarSection(id: ID) {
    return this.http.json(endpoints.deleteSidebarSection, { params: { id } });
  }

  /** Puts every one of this account's sections in this order. */
  orderSidebarSections(ids: ID[]) {
    return this.http.json(endpoints.orderSidebarSections, { body: { ids } });
  }

  /** A page of the files shared in conversations this account can read (E7). */
  listSharedFiles(
    filter: { kind?: FileKind; userId?: ID; channelId?: ID; q?: string },
    cursor?: string,
    signal?: AbortSignal,
  ) {
    return this.http.json(
      endpoints.listSharedFiles,
      { query: { limit: 30, ...filter, cursor } },
      { signal },
    );
  }

  markUnread(channelId: ID, seq: number) {
    return this.http.json(endpoints.markUnread, { params: { id: channelId }, body: { seq } });
  }

  markThreadUnread(rootId: ID, seq: number) {
    return this.http.json(endpoints.markThreadUnread, { params: { id: rootId }, body: { seq } });
  }

  setThreadFollow(rootId: ID, following: boolean) {
    return this.http.json(endpoints.setThreadFollow, {
      params: { id: rootId },
      body: { following },
    });
  }

  setThreadMute(rootId: ID, muted: boolean) {
    return this.http.json(endpoints.setThreadMute, { params: { id: rootId }, body: { muted } });
  }

  setReminder(messageId: ID, at: number) {
    return this.http.json(endpoints.setReminder, { params: { id: messageId }, body: { at } });
  }

  cancelReminder(messageId: ID) {
    return this.http.json(endpoints.cancelReminder, { params: { id: messageId } });
  }

  /** Reads notes that someone removed this account from channels; says which were there. */
  readChannelRemovals(ids: ID[]) {
    return this.http.json(endpoints.readChannelRemovals, { body: { ids } });
  }

  /** Replaces this account's choices in a poll; none takes the vote back (E6). */
  votePoll(messageId: ID, choices: number[]) {
    return this.http.json(endpoints.votePoll, { params: { id: messageId }, body: { choices } });
  }

  closePoll(messageId: ID) {
    return this.http.json(endpoints.closePoll, { params: { id: messageId } });
  }

  listReminders(signal?: AbortSignal) {
    return this.http.json(endpoints.listReminders, {}, { signal });
  }

  markThreadRead(rootId: ID, seq: number) {
    return this.http.json(endpoints.markThreadRead, { params: { id: rootId }, body: { seq } });
  }

  listFollowedThreads(opts: { cursor?: string; unreadOnly?: boolean } = {}, signal?: AbortSignal) {
    return this.http.json(
      endpoints.listFollowedThreads,
      {
        query: {
          limit: 30,
          cursor: opts.cursor,
          ...(opts.unreadOnly ? { unreadOnly: "true" as const } : {}),
        },
      },
      { signal },
    );
  }

  /** The newest message in each direct conversation this account is in, for the list of direct messages. */
  latestDirectMessages(signal?: AbortSignal) {
    return this.http.json(endpoints.latestDirectMessages, {}, { signal });
  }

  // ---------- apps and integrations (admin only) ----------

  /**
   * The bot token comes back once here and is never retrievable again. Left
   * without scopes, the app may do everything (E18c).
   */
  createApp(body: { name: string; scopes?: AppScope[] }) {
    return this.http.json(endpoints.createApp, { body });
  }

  /** Replaces what an app may do (E18c). */
  setAppScopes(appId: ID, scopes: AppScope[]) {
    return this.http.json(endpoints.setAppScopes, { params: { id: appId }, body: { scopes } });
  }

  listApps() {
    return this.http.json(endpoints.listApps);
  }

  deleteApp(id: ID) {
    return this.http.json(endpoints.deleteApp, { params: { id } });
  }

  createWebhook(appId: ID, body: { channelId: ID }) {
    return this.http.json(endpoints.createWebhook, { params: { id: appId }, body });
  }

  /** Replaces every bot token the app has; the old ones stop working at once. */
  replaceAppToken(appId: ID) {
    return this.http.json(endpoints.replaceAppToken, { params: { id: appId } });
  }

  replaceSigningSecret(appId: ID) {
    return this.http.json(endpoints.replaceSigningSecret, { params: { id: appId } });
  }

  /** A new URL for the same webhook and channel; the old URL stops working. */
  replaceWebhookUrl(id: ID) {
    return this.http.json(endpoints.replaceWebhookUrl, { params: { id } });
  }

  deleteWebhook(id: ID) {
    return this.http.json(endpoints.deleteWebhook, { params: { id } });
  }

  /** Posts to an incoming webhook's URL as any other tool would, so a test proves the URL works. */
  postToWebhook(url: string, payload: { text: string }): Promise<void> {
    return this.http.postToWebhook(endpoints.postToWebhook, url, payload);
  }

  createCommand(appId: ID, body: CreateCommandBody) {
    return this.http.json(endpoints.createCommand, { params: { id: appId }, body });
  }

  deleteCommand(id: ID) {
    return this.http.json(endpoints.deleteCommand, { params: { id } });
  }

  /** The server calls the URL to verify it before this resolves. */
  createSubscription(appId: ID, body: { url: string; eventTypes?: string[] }) {
    return this.http.json(endpoints.createSubscription, { params: { id: appId }, body });
  }

  deleteSubscription(id: ID) {
    return this.http.json(endpoints.deleteSubscription, { params: { id } });
  }

  retrySubscription(id: ID) {
    return this.http.json(endpoints.retrySubscription, { params: { id } });
  }

  /** Every command that can be typed here, built-ins included. */
  listCommands() {
    return this.http.json(endpoints.listCommands);
  }

  /** A command whose app failed answers `ok: false` with why, in `message`. */
  runCommand(channelId: ID, body: { text: string; threadRootId?: ID }) {
    return this.http.json(endpoints.runCommand, { params: { id: channelId }, body });
  }

  /** Presses a button an app put on a message. */
  runMessageAction(messageId: ID, actionId: string) {
    return this.http.json(endpoints.runMessageAction, {
      params: { id: messageId },
      body: { actionId },
    });
  }

  /**
   * Sends a filled-in modal; field errors come back keyed by block id. Once
   * accepted, `closedViewIds` names the forms that closed (E18b).
   */
  submitView(viewId: ID, values: Record<string, Record<string, string | string[]>>) {
    return this.http.json(endpoints.submitView, { params: { id: viewId }, body: { values } });
  }

  /** Closes a modal and any stacked on it, for the person's other devices. */
  closeView(viewId: ID) {
    return this.http.json(endpoints.closeView, { params: { id: viewId } });
  }

  /**
   * Everyone with an account, with when they were last seen, and whether they
   * have two-step sign-in (E11). Admins only.
   */
  listAllUsers() {
    return this.http.json(endpoints.listAllUsers);
  }

  /** Change someone's role, or take their access away. Admins only. */
  updateUserAdmin(
    userId: ID,
    patch: { role?: "member" | "admin"; deactivated?: boolean; canInvite?: boolean },
  ) {
    return this.http.json(endpoints.updateUserAdmin, { params: { id: userId }, body: patch });
  }

  setInteractivityUrl(appId: ID, url: string) {
    return this.http.json(endpoints.setInteractivityUrl, { params: { id: appId }, body: { url } });
  }

  createInvite(body: CreateInviteBody = {}) {
    return this.http.json(endpoints.createInvite, { body });
  }

  /** What happened in huddles lately, for the owner and admins. Memory only. */
  callLog() {
    return this.http.json(endpoints.callLog);
  }

  /**
   * Whether the server is keeping up: sizes, queues and timings, never what is
   * in them. The owner and admins only (OPS-10).
   */
  workspaceStatus() {
    return this.http.json(endpoints.workspaceStatus);
  }

  /** The copy of the workspace its owner can download, if one is being made or kept. */
  workspaceCopy() {
    return this.http.json(endpoints.workspaceCopy);
  }

  /** Starts a copy for the owner to download, or gives the one being made. */
  makeWorkspaceCopy() {
    return this.http.json(endpoints.makeWorkspaceCopy);
  }

  /**
   * An address that downloads the ready copy once, within a minute: a
   * navigation, so the browser streams a copy of any size straight to disk.
   */
  async workspaceCopyUrl(id: string): Promise<string> {
    const issued = await this.http.json(endpoints.copyDownloadToken);
    return this.http.url(endpoints.copyFile, {
      params: { id },
      query: { download: ticket(issued) },
    });
  }

  /** A page of what administrators have changed, newest first. */
  listAudit(before?: string) {
    return this.http.json(endpoints.listAudit, { query: { before } });
  }

  /** Every invite for an administrator; one's own for everyone else. Newest first. */
  listInvites() {
    return this.http.json(endpoints.listInvites);
  }

  /** Stops an invite letting anyone else in. Already-revoked is not an error. */
  revokeInvite(code: string) {
    return this.http.json(endpoints.revokeInvite, { params: { code } });
  }

  activity(
    mode: "unread" | "mentions" | "threads",
    opts: { cursor?: ID; signal?: AbortSignal } = {},
  ) {
    return this.http.json(
      endpoints.activity,
      { query: { mode, cursor: opts.cursor } },
      { signal: opts.signal },
    );
  }

  search(q: string, limit = 30, opts: { cursor?: ID; channelId?: ID; signal?: AbortSignal } = {}) {
    // Dates in the query name days on the reader's calendar, not the server's.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    return this.http.json(
      endpoints.search,
      { query: { q, limit, cursor: opts.cursor, channelId: opts.channelId, tz } },
      { signal: opts.signal },
    );
  }
}

/** Normalize whatever the user typed ("192.168.1.4:8543", "chat.foo.com", full URL) into a base URL. */
export function normalizeServerUrl(input: string, defaultPort = 8543): string {
  let s = input.trim();
  // A bare host means a workspace server on its usual port. An address written
  // out in full is taken as written, so http://chat.local is port 80 there as
  // it is everywhere else, and a link built on it leads back to it.
  const bare = !/^https?:\/\//i.test(s);
  // More than one colon and no brackets can only be an IPv6 address on its
  // own: a port after one has to follow brackets, or it would be read as the
  // address's last group. So it goes in brackets, on the usual port.
  if (bare && !s.startsWith("[") && (s.match(/:/g)?.length ?? 0) > 1) s = `[${s}]`;
  const url = new URL(bare ? `http://${s}` : s);
  if (bare && !url.port) url.port = String(defaultPort);
  return url.origin;
}
