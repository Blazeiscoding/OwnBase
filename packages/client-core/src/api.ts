import type {
  AccessPolicy,
  CallLogEntry,
  App,
  AppScope,
  Channel,
  ChannelPrefs,
  ChannelPrefsBody,
  CreateChannelBody,
  CreateInviteBody,
  FileKind,
  FileMeta,
  Friendship,
  ID,
  AuditEntry,
  Invite,
  Message,
  SendMessageBody,
  ScheduledMessage,
  ScheduleMessageBody,
  ServerInfo,
  SettingsPanel,
  SignInConnection,
  StorageUsage,
  SessionInfo,
  SlashCommand,
  ThreadFollow,
  Reminder,
  ReportReason,
  ReportResolution,
  ReportedMessage,
  SharedFile,
  SidebarSection,
  ReminderItem,
  FollowedThread,
  EventSubscription,
  EditScheduledBody,
  UpdateChannelBody,
  UpdateMeBody,
  User,
  WorkspaceCopy,
  WorkspaceStatus,
  Webhook,
} from "@ownbase/protocol";

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

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

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

/**
 * A path the server gave for one of its own routes. Anything else is refused
 * before this client sends it a session.
 */
export function serverPath(path: string): string {
  if (!/^\/api\/[A-Za-z0-9/_-]*$/.test(path)) throw new ApiError(502, "invalid_response");
  return path;
}

/** Typed REST client for one workspace server. */
export class Api {
  constructor(
    public baseUrl: string,
    private token: string | null = null,
  ) {}

  setToken(token: string | null): void {
    this.token = token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    // A file is sent as itself, with its own type; anything else as JSON.
    const file = typeof Blob !== "undefined" && body instanceof Blob ? body : null;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined
          ? { "content-type": file ? file.type || "application/octet-stream" : "application/json" }
          : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: file ?? (body !== undefined ? JSON.stringify(body) : undefined),
      signal: opts?.timeoutMs
        ? opts.signal
          ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)])
          : AbortSignal.timeout(opts.timeoutMs)
        : opts?.signal,
    });
    if (!res.ok) {
      let code = "http_error";
      let message: string | undefined;
      try {
        const data = (await res.json()) as { error?: string; message?: string };
        code = data.error ?? code;
        message = data.message;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, code, message);
    }
    return (await res.json()) as T;
  }

  serverInfo(timeoutMs = 4000): Promise<ServerInfo> {
    return this.request<ServerInfo>("GET", "/api/server-info", undefined, { timeoutMs });
  }

  storageUsage(signal?: AbortSignal): Promise<StorageUsage> {
    return this.request("GET", "/api/storage", undefined, { timeoutMs: 10_000, signal });
  }

  async downloadUrl(fileId: ID): Promise<string> {
    if (!(await this.serverInfo()).downloadTickets)
      throw new ApiError(409, "download_upgrade_required");
    const result = await this.request<{ token: string; expiresAt: number }>(
      "POST",
      `/api/files/${fileId}/download-token`,
      undefined,
      { timeoutMs: 10_000 },
    );
    if (typeof result.token !== "string" || !/^[a-f0-9]{64}$/.test(result.token))
      throw new ApiError(502, "invalid_response");
    return `${this.baseUrl}/api/files/${encodeURIComponent(fileId)}?download=${result.token}`;
  }

  rtcConfig(): Promise<RTCConfiguration> {
    return this.request("GET", "/api/rtc-config", undefined, { timeoutMs: 5000 });
  }

  friends(): Promise<{ friends: Friendship[] }> {
    return this.request("GET", "/api/friends");
  }

  updateFriend(
    userId: ID,
    action: "request" | "accept" | "remove",
  ): Promise<{ friends: Friendship[] }> {
    return this.request(
      { request: "POST", accept: "PUT", remove: "DELETE" }[action],
      `/api/friends/${encodeURIComponent(userId)}`,
    );
  }

  register(body: {
    handle: string;
    displayName: string;
    password: string;
    inviteCode?: string;
    claimCode?: string;
  }): Promise<{ token: string; user: User }> {
    return this.request("POST", "/api/auth/register", body);
  }

  /**
   * Signs in with a password. This client always says it can answer a second
   * step (E11), which an older server does not read; an account with
   * two-step sign-in then gets a challenge in place of a session.
   */
  login(body: { handle: string; password: string }): Promise<LoginResult> {
    return this.request("POST", "/api/auth/login", { ...body, twoStep: true });
  }

  /**
   * The second step of signing in (E11): the first step's challenge, and a
   * code from the authenticator app or one of the recovery codes.
   */
  signInSecondStep(
    body: { challenge: string } & ({ code: string } | { recoveryCode: string }),
  ): Promise<SignedIn & { recoveryCodesLeft: number }> {
    return this.request("POST", "/api/auth/two-step", body);
  }

  /**
   * Signs in with the one-time code a way of signing in besides a password
   * came back with (P9), and the secret this client began it with.
   */
  redeemSignIn(path: string, body: { code: string; verifier: string }): Promise<SignedIn> {
    return this.request("POST", serverPath(path), body, { timeoutMs: 20_000 });
  }

  /** Whether the signed-in person has linked their account to a way of signing in (P9). */
  signInConnection(path: string): Promise<SignInConnection> {
    return this.request("GET", serverPath(path), undefined, { timeoutMs: 10_000 });
  }

  /** Where to link it: a path on this server, opened in a browser (P9). */
  connectSignIn(path: string): Promise<{ url: string }> {
    return this.request("POST", serverPath(path), undefined, { timeoutMs: 10_000 });
  }

  disconnectSignIn(path: string): Promise<SignInConnection> {
    return this.request("DELETE", serverPath(path), undefined, { timeoutMs: 10_000 });
  }

  /** The panels the server's extensions add to Workspace settings, for the owner (P9). */
  extensionSettings(): Promise<{ panels: SettingsPanel[] }> {
    return this.request("GET", "/api/admin/extension-settings", undefined, { timeoutMs: 10_000 });
  }

  /** Saves a panel's values where it says, as `{ [key]: value }`. */
  saveExtensionSettings(path: string, values: Record<string, string | boolean>): Promise<unknown> {
    return this.request("PUT", serverPath(path), values, { timeoutMs: 20_000 });
  }

  /** Joins with a display name alone, where the workspace allows guests. */
  joinAsGuest(displayName: string): Promise<{ token: string; user: User }> {
    return this.request("POST", "/api/auth/guest", { displayName });
  }

  /**
   * Keeps a guest's identity as an account. Every guest session ends,
   * this one included; the token returned replaces it.
   */
  createAccountFromGuest(body: {
    handle: string;
    password: string;
  }): Promise<{ token: string; user: User }> {
    return this.request("POST", "/api/auth/guest/account", body, { timeoutMs: 20_000 });
  }

  logout(): Promise<{ ok: true }> {
    return this.request("POST", "/api/auth/logout", undefined, { timeoutMs: 10_000 });
  }

  changePassword(currentPassword: string, newPassword: string): Promise<{ ok: true }> {
    return this.request(
      "POST",
      "/api/auth/password",
      { currentPassword, newPassword },
      { timeoutMs: 20_000 },
    );
  }

  listSessions(): Promise<{ sessions: SessionInfo[] }> {
    return this.request("GET", "/api/auth/sessions", undefined, { timeoutMs: 10_000 });
  }

  revokeSession(id: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/auth/sessions/${encodeURIComponent(id)}`, undefined, {
      timeoutMs: 10_000,
    });
  }

  revokeOtherSessions(): Promise<{ revoked: number }> {
    return this.request("DELETE", "/api/auth/sessions", undefined, { timeoutMs: 10_000 });
  }

  /** Whether this account asks for a code at sign-in, and how many recovery codes it has left (E11). */
  twoStep(): Promise<{ enabled: boolean; recoveryCodesLeft: number }> {
    return this.request("GET", "/api/me/two-step", undefined, { timeoutMs: 10_000 });
  }

  /**
   * Starts setting two-step sign-in up (E11): a new key, and the address an
   * authenticator app scans for it. Nothing changes until a code from it is
   * given to `enableTwoStep`.
   */
  startTwoStep(password: string): Promise<{ secret: string; uri: string }> {
    return this.request("POST", "/api/me/two-step", { password }, { timeoutMs: 20_000 });
  }

  /** Turns two-step sign-in on with a code from the new key; the recovery codes, shown once. */
  enableTwoStep(code: string): Promise<{ recoveryCodes: string[] }> {
    return this.request("POST", "/api/me/two-step/enable", { code }, { timeoutMs: 10_000 });
  }

  /** A new set of recovery codes in place of the old (E11), shown once. */
  newRecoveryCodes(password: string): Promise<{ recoveryCodes: string[] }> {
    return this.request(
      "POST",
      "/api/me/two-step/recovery-codes",
      { password },
      { timeoutMs: 20_000 },
    );
  }

  /** Turns two-step sign-in off (E11). */
  disableTwoStep(password: string): Promise<{ ok: true }> {
    return this.request("POST", "/api/me/two-step/disable", { password }, { timeoutMs: 20_000 });
  }

  /** Turns someone's two-step sign-in off, for one who lost their app and codes. Admins only. */
  resetTwoStep(userId: ID): Promise<{ ok: true }> {
    return this.request(
      "POST",
      `/api/admin/users/${encodeURIComponent(userId)}/two-step/reset`,
      undefined,
      { timeoutMs: 10_000 },
    );
  }

  /** Blocks someone for this account (E12); everyone it has blocked now. */
  blockUser(userId: ID): Promise<{ blocked: ID[] }> {
    return this.request("PUT", `/api/me/blocks/${encodeURIComponent(userId)}`, undefined, {
      timeoutMs: 10_000,
    });
  }

  /** Unblocks someone for this account (E12); everyone it has blocked now. */
  unblockUser(userId: ID): Promise<{ blocked: ID[] }> {
    return this.request("DELETE", `/api/me/blocks/${encodeURIComponent(userId)}`, undefined, {
      timeoutMs: 10_000,
    });
  }

  /** Reports a message to the workspace's admins (E12), with why and anything to add. */
  reportMessage(messageId: ID, reason: ReportReason, note = ""): Promise<{ ok: true }> {
    return this.request(
      "POST",
      `/api/messages/${encodeURIComponent(messageId)}/report`,
      { reason, ...(note.trim() ? { note: note.trim() } : {}) },
      { timeoutMs: 10_000 },
    );
  }

  /** The reported messages waiting for an admin (E12). Admins only. */
  listReports(): Promise<{ reports: ReportedMessage[] }> {
    return this.request("GET", "/api/admin/reports", undefined, { timeoutMs: 10_000 });
  }

  /** Settles a reported message: dismissed, removed, or removed with its author deactivated (E12). Admins only. */
  resolveReport(messageId: ID, action: ReportResolution): Promise<{ ok: true }> {
    return this.request(
      "POST",
      `/api/admin/reports/${encodeURIComponent(messageId)}/resolve`,
      { action },
      { timeoutMs: 20_000 },
    );
  }

  resetPassword(userId: ID): Promise<{ temporaryPassword: string }> {
    return this.request(
      "POST",
      `/api/admin/users/${encodeURIComponent(userId)}/password`,
      undefined,
      { timeoutMs: 20_000 },
    );
  }

  /**
   * Renames the workspace, for its owner and admins. Everyone signed in hears
   * `workspace.renamed`. A server without `ReadySnapshot.workspaceSettings`
   * has no such route.
   */
  renameWorkspace(name: string): Promise<{ workspaceName: string }> {
    return this.request("PUT", "/api/admin/workspace/name", { name }, { timeoutMs: 10_000 });
  }

  /**
   * Changes who may join, for the owner and admins. Leaving guests allowed signs
   * every guest out. Everyone signed in hears `workspace.accessPolicy`.
   */
  setAccessPolicy(accessPolicy: AccessPolicy): Promise<{ accessPolicy: AccessPolicy }> {
    return this.request(
      "PUT",
      "/api/admin/workspace/access-policy",
      { accessPolicy },
      { timeoutMs: 10_000 },
    );
  }

  /**
   * Turns link previews on or off for new messages, for the owner and admins
   * (E2). Everyone signed in hears `workspace.linkPreviews`.
   */
  setLinkPreviews(enabled: boolean): Promise<{ enabled: boolean }> {
    return this.request(
      "PUT",
      "/api/admin/workspace/link-previews",
      { enabled },
      { timeoutMs: 10_000 },
    );
  }

  /** Takes a preview off the sender's own message, for good. */
  removeLinkPreview(id: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/link-previews/${id}`);
  }

  /**
   * Sets the workspace's icon, for the owner and admins: a PNG, JPEG or WebP
   * image of at most `WORKSPACE_ICON_MAX_BYTES`, sent as itself. Everyone
   * signed in hears `workspace.icon`. A server without
   * `ReadySnapshot.workspaceIcon` has no such route.
   */
  setWorkspaceIcon(image: Blob): Promise<{ iconVersion: string }> {
    return this.request("PUT", "/api/admin/workspace/icon", image, { timeoutMs: 30_000 });
  }

  /** Removes the workspace's icon, for the owner and admins. */
  removeWorkspaceIcon(): Promise<{ iconVersion: null }> {
    return this.request("DELETE", "/api/admin/workspace/icon", undefined, { timeoutMs: 10_000 });
  }

  /**
   * The workspace's icon, which anyone may read, signed in or not. Asked for
   * by its version, so the browser keeps it until the version changes.
   * Rejects with `no_icon` when the workspace has none.
   */
  async workspaceIcon(version: string, signal?: AbortSignal): Promise<Blob> {
    const res = await fetch(`${this.baseUrl}/api/workspace/icon?v=${encodeURIComponent(version)}`, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new ApiError(res.status, res.status === 404 ? "no_icon" : "icon_failed");
    return res.blob();
  }

  transferOwnership(userId: ID): Promise<{ owner: User; previousOwner: User }> {
    return this.request("POST", `/api/admin/users/${encodeURIComponent(userId)}/owner`, undefined, {
      timeoutMs: 10_000,
    });
  }

  me(): Promise<{ user: User }> {
    return this.request("GET", "/api/me");
  }

  updateMe(body: UpdateMeBody): Promise<{ user: User }> {
    return this.request("PATCH", "/api/me", body);
  }

  /** Keeps this picture as this account's own (E9): the image itself, made small first. */
  setAvatar(image: Blob): Promise<{ user: User }> {
    return this.request("PUT", "/api/me/avatar", image, { timeoutMs: 30_000 });
  }

  /** Removes this account's picture; its initials show again. */
  removeAvatar(): Promise<{ user: User }> {
    return this.request("DELETE", "/api/me/avatar", undefined, { timeoutMs: 10_000 });
  }

  /**
   * Someone's picture, named by its version, which the browser may keep:
   * another picture has another version.
   */
  async fetchAvatar(userId: ID, version: string): Promise<Blob> {
    const res = await fetch(
      `${this.baseUrl}/api/users/${userId}/avatar?v=${encodeURIComponent(version)}`,
      {
        headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) throw new ApiError(res.status, "avatar_unavailable");
    return res.blob();
  }

  listUsers(): Promise<{ users: User[] }> {
    return this.request("GET", "/api/users");
  }

  listChannels(): Promise<{ channels: Channel[] }> {
    return this.request("GET", "/api/channels");
  }

  createChannel(body: CreateChannelBody): Promise<{ channel: Channel }> {
    return this.request("POST", "/api/channels", body, { timeoutMs: 10_000 });
  }

  updateChannel(id: ID, body: UpdateChannelBody): Promise<{ channel: Channel }> {
    return this.request("PATCH", `/api/channels/${id}`, body, { timeoutMs: 10_000 });
  }

  joinChannel(id: ID): Promise<{ ok: true }> {
    return this.request("POST", `/api/channels/${id}/join`);
  }

  leaveChannel(id: ID): Promise<{ ok: true }> {
    return this.request("POST", `/api/channels/${id}/leave`, undefined, { timeoutMs: 10_000 });
  }

  inviteMember(channelId: ID, userId: ID): Promise<{ ok: true }> {
    return this.request("POST", `/api/channels/${channelId}/invite-member`, { userId });
  }

  channelMembers(id: ID): Promise<{ memberIds: ID[] }> {
    return this.request("GET", `/api/channels/${id}/members`, undefined, { timeoutMs: 10_000 });
  }

  setChannelManager(channelId: ID, userId: ID, manager: boolean): Promise<{ channel: Channel }> {
    return this.request(
      "PATCH",
      `/api/channels/${channelId}/managers/${userId}`,
      { manager },
      { timeoutMs: 10_000 },
    );
  }

  removeChannelMember(channelId: ID, userId: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/channels/${channelId}/members/${userId}`, undefined, {
      timeoutMs: 10_000,
    });
  }

  markRead(channelId: ID, seq: number, signal?: AbortSignal): Promise<{ ok: true; seq?: number }> {
    return this.request(
      "POST",
      `/api/channels/${channelId}/read`,
      { seq },
      { timeoutMs: 10_000, signal },
    );
  }

  listMessages(
    channelId: ID,
    opts: { before?: ID; limit?: number; threadRootId?: ID; signal?: AbortSignal } = {},
  ): Promise<{ messages: Message[]; readThroughSeq?: number; seq?: number }> {
    const params = new URLSearchParams();
    if (opts.before) params.set("before", opts.before);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.threadRootId) params.set("threadRootId", opts.threadRootId);
    const qs = params.size > 0 ? `?${params}` : "";
    return this.request("GET", `/api/channels/${channelId}/messages${qs}`, undefined, {
      timeoutMs: 10_000,
      signal: opts.signal,
    });
  }

  /** A window of messages centred on one, for jumping to it. */
  listMessagesAround(
    channelId: ID,
    messageId: ID,
    limit = 50,
    signal?: AbortSignal,
  ): Promise<{
    messages: Message[];
    hasMoreOlder: boolean;
    hasMoreNewer: boolean;
    threadRootId?: ID | null;
    seq?: number;
  }> {
    return this.request(
      "GET",
      `/api/channels/${channelId}/messages/around/${messageId}?limit=${limit}`,
      undefined,
      { timeoutMs: 10_000, signal },
    );
  }

  listMessagesAfter(
    channelId: ID,
    afterId: ID,
    limit = 50,
    signal?: AbortSignal,
  ): Promise<{ messages: Message[]; seq?: number }> {
    return this.request(
      "GET",
      `/api/channels/${channelId}/messages/after/${afterId}?limit=${limit}`,
      undefined,
      { timeoutMs: 10_000, signal },
    );
  }

  threadHistory(
    channelId: ID,
    rootId: ID,
    opts: { before?: ID; after?: ID; around?: ID; limit?: number; signal?: AbortSignal } = {},
  ): Promise<{
    root: Message;
    messages: Message[];
    hasMoreOlder: boolean;
    hasMoreNewer: boolean;
    seq: number;
  }> {
    const { signal, ...params } = opts;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) query.set(key, String(value));
    return this.request(
      "GET",
      `/api/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(rootId)}?${query}`,
      undefined,
      { timeoutMs: 10_000, signal },
    );
  }

  /** One message, for the card under a link to it; a 404 when it is gone or not readable. */
  getMessage(channelId: ID, messageId: ID, signal?: AbortSignal): Promise<{ message: Message }> {
    return this.request("GET", `/api/channels/${channelId}/messages/${messageId}`, undefined, {
      timeoutMs: 10_000,
      signal,
    });
  }

  sendMessage(channelId: ID, body: SendMessageBody): Promise<{ message: Message }> {
    return this.request("POST", `/api/channels/${channelId}/messages`, body);
  }

  /** With `expectedText`, refused as `message_changed` if the words are no longer those. */
  editMessage(id: ID, text: string, expectedText?: string): Promise<{ message: Message }> {
    return this.request(
      "PATCH",
      `/api/messages/${id}`,
      { text, expectedText },
      { timeoutMs: 10_000 },
    );
  }

  deleteMessage(id: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/messages/${id}`);
  }

  addReaction(messageId: ID, emoji: string): Promise<{ ok: true }> {
    return this.request("PUT", `/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
  }

  removeReaction(messageId: ID, emoji: string): Promise<{ ok: true }> {
    return this.request(
      "DELETE",
      `/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
    );
  }

  /** Uploads one file to a channel; attach the returned id to a message. */
  async uploadFile(
    channelId: ID,
    file: Blob,
    name: string,
    opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
  ): Promise<{ file: FileMeta }> {
    const form = new FormData();
    form.append("file", file, name);

    // XHR rather than fetch: it reports upload progress, which large files need.
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(new ApiError(0, "aborted"));
        return;
      }
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${this.baseUrl}/api/channels/${channelId}/files`);
      xhr.timeout = 300_000;
      if (this.token) xhr.setRequestHeader("authorization", `Bearer ${this.token}`);
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText) as { file: FileMeta });
          } catch {
            reject(new ApiError(0, "invalid_response"));
          }
        } else {
          let code = "upload_failed";
          try {
            code = (JSON.parse(xhr.responseText) as { error?: string }).error ?? code;
          } catch {
            /* non-JSON error body */
          }
          reject(new ApiError(xhr.status, code));
        }
      });
      xhr.addEventListener("error", () => reject(new ApiError(0, "network_error")));
      xhr.addEventListener("abort", () => reject(new ApiError(0, "aborted")));
      xhr.addEventListener("timeout", () => reject(new ApiError(0, "upload_timeout")));
      const abort = () => xhr.abort();
      opts.signal?.addEventListener("abort", abort, { once: true });
      xhr.addEventListener("loadend", () => opts.signal?.removeEventListener("abort", abort));
      xhr.send(form);
    });
  }

  /** Raw bytes of an upload, fetched with the session token. */
  /** A link preview's picture, which the server fetched from the page (E2). */
  fetchPreviewImage(previewId: ID, signal?: AbortSignal): Promise<Blob> {
    return this.fetchBytes(`/api/link-previews/${previewId}/image`, signal);
  }

  fetchFile(fileId: ID, signal?: AbortSignal): Promise<Blob> {
    return this.fetchBytes(`/api/files/${fileId}`, signal);
  }

  private async fetchBytes(path: string, signal?: AbortSignal): Promise<Blob> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
      // Bypass bytes cached by older servers that marked this URL immutable.
      cache: "no-store",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(300_000)])
        : AbortSignal.timeout(300_000),
    });
    if (!res.ok)
      throw new ApiError(
        res.status,
        res.status === 404 ? "file_not_found" : "file_download_failed",
      );
    return res.blob();
  }

  async scheduleMessage(
    channelId: ID,
    body: ScheduleMessageBody,
  ): Promise<{ scheduled: ScheduledMessage }> {
    if (body.nonce && !(await this.serverInfo()).schedulingIdempotency) {
      throw new ApiError(
        409,
        "scheduling_upgrade_required",
        "Update this workspace server before using recoverable scheduling.",
      );
    }
    return this.request("POST", `/api/channels/${channelId}/scheduled`, body, {
      timeoutMs: 15_000,
    });
  }

  listScheduled(signal?: AbortSignal): Promise<{ scheduled: ScheduledMessage[] }> {
    return this.request("GET", "/api/scheduled", undefined, { signal, timeoutMs: 10_000 });
  }

  cancelScheduled(id: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/scheduled/${id}`, undefined, { timeoutMs: 10_000 });
  }

  /** Requeues a held or failed message. A past time sends it on the next flush. */
  rescheduleMessage(id: ID, sendAt: number): Promise<{ scheduled: ScheduledMessage }> {
    return this.request("PATCH", `/api/scheduled/${id}`, { sendAt }, { timeoutMs: 10_000 });
  }

  editScheduledMessage(id: ID, body: EditScheduledBody): Promise<{ scheduled: ScheduledMessage }> {
    return this.request("PATCH", `/api/scheduled/${id}/text`, body, { timeoutMs: 10_000 });
  }

  setChannelPrefs(channelId: ID, body: ChannelPrefsBody): Promise<{ prefs: ChannelPrefs }> {
    return this.request("PATCH", `/api/channels/${channelId}/prefs`, body);
  }

  pinMessage(id: ID): Promise<{ ok: true }> {
    return this.request("PUT", `/api/messages/${id}/pin`);
  }

  unpinMessage(id: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/messages/${id}/pin`);
  }

  /** `total` counts every pin, from servers that say; older ones leave it out. */
  listPins(
    channelId: ID,
    signal?: AbortSignal,
    cursor?: string,
    limit = 30,
  ): Promise<{ messages: Message[]; nextCursor: string | null; total?: number }> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return this.request("GET", `/api/channels/${channelId}/pins?${query}`, undefined, {
      signal,
      timeoutMs: 10_000,
    });
  }

  saveMessage(id: ID): Promise<{ ok: true }> {
    return this.request("PUT", `/api/messages/${id}/save`);
  }

  unsaveMessage(id: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/messages/${id}/save`);
  }

  listSaved(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{ messages: Message[]; nextCursor: string | null }> {
    const query = new URLSearchParams({ limit: "30" });
    if (cursor) query.set("cursor", cursor);
    return this.request("GET", `/api/saved?${query}`, undefined, { signal, timeoutMs: 10_000 });
  }

  /** Adds a section at the end of this account's sidebar (E8). */
  createSidebarSection(
    name: string,
  ): Promise<{ section: SidebarSection; sections: SidebarSection[] }> {
    return this.request("POST", "/api/sidebar-sections", { name });
  }

  renameSidebarSection(id: ID, name: string): Promise<{ sections: SidebarSection[] }> {
    return this.request("PATCH", `/api/sidebar-sections/${id}`, { name });
  }

  /** Deletes a section; its conversations go back where they would be. */
  deleteSidebarSection(id: ID): Promise<{ sections: SidebarSection[] }> {
    return this.request("DELETE", `/api/sidebar-sections/${id}`);
  }

  /** Puts every one of this account's sections in this order. */
  orderSidebarSections(ids: ID[]): Promise<{ sections: SidebarSection[] }> {
    return this.request("PUT", "/api/sidebar-sections/order", { ids });
  }

  /** A page of the files shared in conversations this account can read (E7). */
  listSharedFiles(
    filter: { kind?: FileKind; userId?: ID; channelId?: ID; q?: string },
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{ files: SharedFile[]; nextCursor: string | null }> {
    const query = new URLSearchParams({ limit: "30" });
    if (filter.kind) query.set("kind", filter.kind);
    if (filter.userId) query.set("userId", filter.userId);
    if (filter.channelId) query.set("channelId", filter.channelId);
    if (filter.q) query.set("q", filter.q);
    if (cursor) query.set("cursor", cursor);
    return this.request("GET", `/api/files?${query}`, undefined, { signal, timeoutMs: 10_000 });
  }

  markUnread(channelId: ID, seq: number): Promise<{ ok: true; seq: number }> {
    return this.request("POST", `/api/channels/${channelId}/unread`, { seq });
  }

  markThreadUnread(rootId: ID, seq: number): Promise<{ state: ThreadFollow }> {
    return this.request("POST", `/api/messages/${rootId}/thread/unread`, { seq });
  }

  setThreadFollow(rootId: ID, following: boolean): Promise<{ state: ThreadFollow }> {
    return this.request("PUT", `/api/messages/${rootId}/follow`, { following });
  }

  setThreadMute(rootId: ID, muted: boolean): Promise<{ state: ThreadFollow }> {
    return this.request("PUT", `/api/messages/${rootId}/mute`, { muted });
  }

  setReminder(messageId: ID, at: number): Promise<{ reminder: Reminder }> {
    return this.request("PUT", `/api/messages/${messageId}/reminder`, { at });
  }

  cancelReminder(messageId: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/messages/${messageId}/reminder`);
  }

  /** Replaces this account's choices in a poll; none takes the vote back (E6). */
  votePoll(messageId: ID, choices: number[]): Promise<{ message: Message; choices: number[] }> {
    return this.request("PUT", `/api/messages/${messageId}/poll/votes`, { choices });
  }

  closePoll(messageId: ID): Promise<{ message: Message }> {
    return this.request("POST", `/api/messages/${messageId}/poll/close`);
  }

  listReminders(signal?: AbortSignal): Promise<{ reminders: ReminderItem[] }> {
    return this.request("GET", "/api/reminders", undefined, { signal });
  }

  markThreadRead(rootId: ID, seq: number): Promise<{ state: ThreadFollow }> {
    return this.request("POST", `/api/messages/${rootId}/thread/read`, { seq });
  }

  listFollowedThreads(
    opts: { cursor?: string; unreadOnly?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<{ threads: FollowedThread[]; nextCursor: string | null }> {
    const query = new URLSearchParams({ limit: "30" });
    if (opts.cursor) query.set("cursor", opts.cursor);
    if (opts.unreadOnly) query.set("unreadOnly", "true");
    return this.request("GET", `/api/threads/followed?${query}`, undefined, {
      signal,
      timeoutMs: 10_000,
    });
  }

  // ---------- apps and integrations (admin only) ----------

  /** The bot token comes back once here and is never retrievable again. */
  /** Left without scopes, the app may do everything, as before scopes (E18c). */
  createApp(body: {
    name: string;
    scopes?: AppScope[];
  }): Promise<{ app: App; botUser: User; token: string; signingSecret: string }> {
    return this.request("POST", "/api/apps", body);
  }

  /** Replaces what an app may do (E18c). */
  setAppScopes(appId: ID, scopes: AppScope[]): Promise<{ app: App }> {
    return this.request("PUT", `/api/apps/${appId}/scopes`, { scopes });
  }

  listApps(): Promise<{ apps: AppDetail[] }> {
    return this.request("GET", "/api/apps");
  }

  deleteApp(id: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/apps/${id}`);
  }

  createWebhook(appId: ID, body: { channelId: ID }): Promise<{ webhook: Webhook; url: string }> {
    return this.request("POST", `/api/apps/${appId}/webhooks`, body);
  }

  /** Replaces every bot token the app has; the old ones stop working at once. */
  replaceAppToken(appId: ID): Promise<{ token: string }> {
    return this.request("POST", `/api/apps/${appId}/token`);
  }

  replaceSigningSecret(appId: ID): Promise<{ signingSecret: string }> {
    return this.request("POST", `/api/apps/${appId}/signing-secret`);
  }

  /** A new URL for the same webhook and channel; the old URL stops working. */
  replaceWebhookUrl(id: ID): Promise<{ webhook: Webhook; url: string }> {
    return this.request("POST", `/api/webhooks/${id}/url`);
  }

  deleteWebhook(id: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/webhooks/${id}`);
  }

  /**
   * Posts to an incoming webhook the way any other tool would, so a test
   * proves the URL itself works. The URL is the webhook's whole authority, so
   * no session token goes with it, and success is Slack's plain-text "ok"
   * rather than JSON, which `request` would fail to read.
   */
  async postToWebhook(url: string, payload: { text: string }): Promise<void> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return;
    let code = "http_error";
    try {
      code = ((await res.json()) as { error?: string }).error ?? code;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, code);
  }

  createCommand(
    appId: ID,
    body: { command: string; url: string; description?: string; usageHint?: string },
  ): Promise<{ command: SlashCommand }> {
    return this.request("POST", `/api/apps/${appId}/commands`, body);
  }

  deleteCommand(id: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/commands/${id}`);
  }

  /** The server calls the URL to verify it before this resolves. */
  createSubscription(
    appId: ID,
    body: { url: string; eventTypes?: string[] },
  ): Promise<{ subscription: EventSubscription }> {
    return this.request("POST", `/api/apps/${appId}/subscriptions`, body);
  }

  deleteSubscription(id: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/subscriptions/${id}`);
  }

  retrySubscription(id: ID): Promise<{ ok: true; retried: number; waiting?: number }> {
    return this.request("POST", `/api/subscriptions/${id}/retry`);
  }

  /** Every command that can be typed here, built-ins included. */
  listCommands(): Promise<{ commands: CommandHint[] }> {
    return this.request("GET", "/api/commands");
  }

  /**
   * A command whose app failed answers `ok: false` with why, in `message`;
   * older servers leave the reason out and only tell the channel.
   */
  runCommand(
    channelId: ID,
    body: { text: string; threadRootId?: ID },
  ): Promise<{ ok: boolean; error?: string; message?: string }> {
    return this.request("POST", `/api/channels/${channelId}/commands`, body);
  }

  /** Presses a button an app put on a message. */
  runMessageAction(messageId: ID, actionId: string): Promise<{ ok: boolean; error?: string }> {
    return this.request("POST", `/api/messages/${messageId}/actions`, { actionId });
  }

  /**
   * Sends a filled-in modal; field errors come back keyed by block id. Once
   * accepted, `closedViewIds` names the forms that closed (E18b).
   */
  submitView(
    viewId: ID,
    values: Record<string, Record<string, string | string[]>>,
  ): Promise<{
    ok: boolean;
    errors?: Record<string, string>;
    message?: string;
    closedViewIds?: ID[];
  }> {
    return this.request("POST", `/api/views/${viewId}/submit`, { values });
  }

  /** Closes a modal and any stacked on it, for the person's other devices. */
  closeView(viewId: ID): Promise<{ ok: boolean }> {
    return this.request("POST", `/api/views/${viewId}/close`);
  }

  /**
   * Everyone with an account, with when they were last seen, and whether they
   * have two-step sign-in (E11; an older server does not say). Admins only.
   */
  listAllUsers(): Promise<{
    users: (User & { lastSeenAt: number | null; twoStep?: boolean })[];
  }> {
    return this.request("GET", "/api/admin/users", undefined, { timeoutMs: 10_000 });
  }

  /** Change someone's role, or take their access away. Admins only. */
  updateUserAdmin(
    userId: ID,
    patch: { role?: "member" | "admin"; deactivated?: boolean; canInvite?: boolean },
  ): Promise<{ user: User }> {
    return this.request("PATCH", `/api/admin/users/${userId}`, patch);
  }

  setInteractivityUrl(appId: ID, url: string): Promise<{ app: App }> {
    return this.request("PUT", `/api/apps/${appId}/interactivity`, { url });
  }

  createInvite(body: CreateInviteBody = {}): Promise<{ invite: Invite }> {
    return this.request("POST", "/api/invites", body);
  }

  /**
   * Whether the server is keeping up: sizes, queues and timings, never what is
   * in them. The owner and admins only (OPS-10).
   */
  /** What happened in huddles lately, for the owner and admins. Memory only. */
  callLog(): Promise<{ entries: CallLogEntry[] }> {
    return this.request("GET", "/api/admin/calls", undefined, { timeoutMs: 10_000 });
  }

  workspaceStatus(): Promise<WorkspaceStatus> {
    return this.request("GET", "/api/admin/status", undefined, { timeoutMs: 10_000 });
  }

  /** The copy of the workspace its owner can download, if one is being made or kept. */
  workspaceCopy(): Promise<{ copy: WorkspaceCopy | null }> {
    return this.request("GET", "/api/admin/copy", undefined, { timeoutMs: 10_000 });
  }

  /** Starts a copy for the owner to download, or gives the one being made. */
  makeWorkspaceCopy(): Promise<{ copy: WorkspaceCopy }> {
    return this.request("POST", "/api/admin/copy", undefined, { timeoutMs: 10_000 });
  }

  /**
   * An address that downloads the ready copy once, within a minute: a
   * navigation, so the browser streams a copy of any size straight to disk.
   */
  async workspaceCopyUrl(id: string): Promise<string> {
    const result = await this.request<{ token: string; expiresAt: number }>(
      "POST",
      "/api/admin/copy/download-token",
      undefined,
      { timeoutMs: 10_000 },
    );
    if (typeof result.token !== "string" || !/^[a-f0-9]{64}$/.test(result.token))
      throw new ApiError(502, "invalid_response");
    return `${this.baseUrl}/api/admin/copy/${encodeURIComponent(id)}?download=${result.token}`;
  }

  /** A page of what administrators have changed, newest first. */
  listAudit(before?: string): Promise<{ entries: AuditEntry[]; nextCursor: string | null }> {
    return this.request(
      "GET",
      `/api/admin/audit${before ? `?before=${encodeURIComponent(before)}` : ""}`,
    );
  }

  /** Every invite for an administrator; one's own for everyone else. Newest first. */
  listInvites(): Promise<{ invites: Invite[] }> {
    return this.request("GET", "/api/invites");
  }

  /** Stops an invite letting anyone else in. Already-revoked is not an error. */
  revokeInvite(code: string): Promise<{ invite: Invite }> {
    return this.request("DELETE", `/api/invites/${encodeURIComponent(code)}`);
  }

  activity(
    mode: "unread" | "mentions" | "threads",
    opts: { cursor?: ID; signal?: AbortSignal } = {},
  ): Promise<{ messages: Message[]; nextCursor: ID | null }> {
    const params = new URLSearchParams({ mode });
    if (opts.cursor) params.set("cursor", opts.cursor);
    return this.request("GET", `/api/activity?${params}`, undefined, {
      signal: opts.signal,
      timeoutMs: 10_000,
    });
  }

  search(
    q: string,
    limit = 30,
    opts: { cursor?: ID; channelId?: ID; signal?: AbortSignal } = {},
  ): Promise<{ messages: Message[]; nextCursor: ID | null }> {
    const params = new URLSearchParams({ q, limit: String(limit) });
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.channelId) params.set("channelId", opts.channelId);
    // Dates in the query name days on the reader's calendar, not the server's.
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timeZone) params.set("tz", timeZone);
    return this.request("GET", `/api/search?${params}`, undefined, {
      timeoutMs: 10_000,
      signal: opts.signal,
    });
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
