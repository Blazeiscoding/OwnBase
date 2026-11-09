import {
  ACCESS_POLICIES,
  DEFAULT_PORT,
  endpoints,
  isAdministrator,
  workspaceNameSchema,
  type AccessPolicy,
  type ID,
  type MemberNotice,
  type ReportedMessage,
  type ServerNotice,
  type User,
  type WorkspaceStatus,
} from "@ownbase/protocol";
import type { FastifyRequest } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { statfsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { registerAccounts } from "./accounts/feature.js";
import { registerApps } from "./apps/feature.js";
import { hashPassword, hashToken, newSessionToken } from "./auth.js";
import type { BackupManifest } from "./backup.js";
import { backupWorkspace, separateDirectories } from "./backup.js";
import {
  BackupSchedule,
  type BackupScheduleStatus,
  type ScheduledBackups,
} from "./backupSchedule.js";
import { registerChannels } from "./channels/feature.js";
import { ConfigError, parsePort } from "./config.js";
import { BackgroundWork } from "./core/background.js";
import { createCommits } from "./core/commit.js";
import { checkedPicture, rationWith, type ServerContext } from "./core/context.js";
import { createHttp } from "./core/http.js";
import { Lifecycle } from "./core/lifecycle.js";
import { bearerToken, Network } from "./core/network.js";
import { openDb, SCHEMA_VERSION } from "./db.js";
import type { ServerExtension } from "./extensions.js";
import { DOWNLOAD_TOKEN_TTL_MS, maxFileSizeOf, registerFiles } from "./files/feature.js";
import { Gateway } from "./gateway.js";
import { HttpError } from "./httpError.js";
import { registerHuddles } from "./huddles/feature.js";
import { secretToken } from "./ids.js";
import { DEFAULT_LIMITS, RateLimiter, type Limits } from "./limits.js";
import { type FetchedPreview } from "./linkPreview.js";
import { advertise, type MdnsHandle } from "./mdns.js";
import { registerMessages, type RetentionStatus } from "./messages/feature.js";
import { holdWorkspace, type WorkspaceHold } from "./ownership.js";
import { registerPeople } from "./people/feature.js";
import { registerPolls } from "./polls/feature.js";
import { serverRelaySchema, type ServerRelay } from "./relay.js";
import { registerReminders, REMINDER_LIMITS } from "./reminders/feature.js";
import { createRouter } from "./route.js";
import { registerSaved } from "./saved/feature.js";
import { registerScheduled, SCHEDULED_LIMITS } from "./scheduled/feature.js";
import { registerSearch } from "./search/feature.js";
import { registerExtensions } from "./sso/feature.js";
import { Store } from "./store.js";
import { registerThreads } from "./threads/feature.js";
import { SERVER_VERSION } from "./version.js";
import { WorkspaceCopies } from "./workspaceCopy.js";
import { CapabilityMap } from "./core/capabilities.js";
import { checkIcon, ICON_META_KEYS, storedIconRows, type WorkspaceIcon } from "./workspaceIcon.js";

export { GUEST_SESSION_TTL_MS } from "./accounts/feature.js";
export type { RetentionStatus } from "./messages/feature.js";
export { SERVER_VERSION };

const isAccessPolicy = (value: unknown): value is AccessPolicy =>
  ACCESS_POLICIES.includes(value as AccessPolicy);

export interface ServerOptions {
  /** Directory holding workspace.db and uploads. Use ":memory:" for tests. */
  dataDir: string;
  port?: number;
  host?: string;
  /**
   * The name of a workspace nobody owns yet. Once it has an owner the name is
   * the workspace's own, changed by its owner and admins, and this is ignored.
   */
  workspaceName?: string;
  /**
   * Whether an account after the first needs an invite code, for a workspace
   * nobody owns yet; ignored, like `accessPolicy`, once it has an owner.
   */
  inviteOnly?: boolean;
  /**
   * Who may join a workspace nobody owns yet; takes precedence over
   * `inviteOnly`. Once it has an owner, who may join is the workspace's own
   * choice, made by its owner and admins in Workspace settings, and a start
   * never puts back an older one over it.
   */
  accessPolicy?: AccessPolicy;
  /** Advertise on the LAN via mDNS. Default true. */
  mdns?: boolean;
  /** Directory with the built web client; served at / so browsers can join too. */
  webDistPath?: string;
  /** Max upload size in bytes. Default 100 MB. */
  maxFileSize?: number;
  /** Attachment storage cap in bytes, including pending uploads. Zero/omitted is unlimited. */
  maxStorageBytes?: number;
  /**
   * How long an upload may sit unattached before it counts as abandoned.
   * Default 24 hours. Must outlast the gap between choosing a file and sending
   * it, including a client that is offline in between.
   */
  abandonedUploadTtlMs?: number;
  /**
   * The address others reach this server on, e.g. "https://chat.team.dev".
   * Used to build the `response_url` handed to slash commands. Set it when a
   * reverse proxy sits in front; otherwise the request's own Host is used.
   */
  publicUrl?: string;
  /**
   * Whether a reverse proxy in front of this server sets the `X-Forwarded-*`
   * headers. Off by default: those headers are worth believing only when
   * something trustworthy writes them, and worthless when anyone can.
   */
  trustProxy?: boolean;
  /**
   * Believe Cloudflare's client-address header, falling back to the final
   * X-Forwarded-For hop, only when the socket peer is loopback. This is for the
   * desktop's local cloudflared connector; normal LAN and standalone servers
   * leave it unset and key limits on the socket peer.
   */
  trustedClientProxy?: "loopback";
  /**
   * Lets slash commands and event subscriptions call private addresses
   * (192.168.x, 10.x, localhost…). Off by default: the server can reach the
   * host's whole LAN, and an admin-typed URL should not become a probe of it.
   * Turn it on deliberately when the bot really does run on the same network.
   */
  allowPrivateHooks?: boolean;
  /**
   * Request logging. A stream can be given instead of `true` to send the log
   * somewhere other than stdout, which is also how a test reads back what was
   * actually written.
   */
  logger?: boolean | { stream: NodeJS.WritableStream };
  /**
   * How long a huddle place waits for a device whose connection dropped
   * (`HUDDLE_GRACE_MS` by default). For tests.
   */
  huddleGraceMs?: number;
  /** How long a direct message's huddle rings (`HUDDLE_RING_MS` by default). For tests. */
  huddleRingMs?: number;
  /** Private deployments default to LAN-only media with no external ICE service. */
  iceServers?: { urls: string | string[]; username?: string; credential?: string }[];
  /**
   * A TURN relay for calls between networks that will not connect directly,
   * given to calls after `iceServers`. A Cloudflare relay's password is asked
   * for when calls need one; its API token never leaves this server. A shared
   * secret signs each member a password of their own, and never leaves it either.
   */
  relay?: ServerRelay | null;
  /**
   * How much one caller may do. `false` turns rationing off, which is
   * reasonable on a LAN where everyone is already trusted and unreasonable
   * anywhere reachable from outside it.
   */
  rateLimits?: Partial<Limits> | false;
  /** Overrides for the scheduled queue's bounds; see `SCHEDULED_LIMITS`. */
  scheduledLimits?: Partial<typeof SCHEDULED_LIMITS>;
  /** Overrides for reminders' bounds; see `REMINDER_LIMITS`. */
  reminderLimits?: Partial<typeof REMINDER_LIMITS>;
  /**
   * Copy an existing workspace before upgrading its schema. On by default; see
   * `OpenDbOptions.backupBeforeUpgrade` for when turning it off is reasonable.
   */
  backupBeforeUpgrade?: boolean;
  /**
   * How many days of conversation to keep. Omitted or zero keeps everything,
   * which is the default: a workspace that silently started discarding history
   * would be worse than one that grows.
   *
   * Turning it on is not reversible. What it removes is removed from the
   * database entirely rather than hidden, so restoring it means restoring a
   * backup taken before the sweep ran.
   */
  retentionDays?: number;
  /**
   * Backups taken on a timer into dated folders, keeping the newest few. Off
   * when omitted. Never in an isolated copy, which would otherwise write into,
   * and prune, the original's backups.
   */
  scheduledBackups?: ScheduledBackups;
  /**
   * Takes one backup into `out`, for scheduled backups and the owner's copies.
   * In this process when omitted; the command line passes one that uses a
   * child process, so the copy never holds up chat.
   */
  takeBackup?: (out: string, signal: AbortSignal) => Promise<BackupManifest>;
  /**
   * Where the owner's downloadable copies are made (P4). By default a
   * `.copies` folder in the scheduled backups' directory when there is one,
   * otherwise one for this workspace in the system's temporary folder. It
   * needs room for a whole copy, and is emptied when the server starts.
   */
  copiesDir?: string;
  /**
   * How many members the workspace's plan includes, for a workspace someone
   * hosts for others (P5). Past it the owner and admins are offered a bigger
   * plan, named and linked when the host gives `planName` and `upgradeUrl`.
   * Nobody is locked out and joining carries on. Omitted, nothing is said.
   */
  memberNotice?: MemberNotice;
  /**
   * The code that claims a workspace nobody owns yet, when the host gives
   * it (OWNBASE_CLAIM_CODE, P7) rather than letting the server make one.
   * Ignored once someone owns the workspace.
   */
  claimCode?: string;
  /**
   * Parts of the server from outside this package, such as the Enterprise
   * features in ee/ (P6), registered after the server's own routes. See
   * `ServerExtension`. None by default, and the server is complete without.
   */
  extensions?: ServerExtension[];
  /**
   * Starts a copy for looking at, such as a backup restored to check it. The
   * copy holds the original's apps, their signing secrets and its queue of
   * scheduled messages, so an ordinary start would post those messages a
   * second time and call the same apps as the same workspace. An isolated one
   * posts nothing that is due, delivers no app events, refuses every call to
   * an app, and does not announce itself on the network. What was queued stays
   * queued, and goes out if the same data is later started normally.
   */
  isolated?: boolean;
  /**
   * Fetches one link's preview in place of the real fetch, for tests, which
   * cannot reach a page on the public internet. The real one goes through the
   * outbound guard (linkPreview.ts).
   */
  fetchLinkPreview?: (url: string, signal: AbortSignal) => Promise<FetchedPreview | null>;
}

export interface WorkspaceServer {
  /** Identifies this running instance for public-route verification; changes on every start. */
  instanceId: string;
  port: number;
  store: Store;
  gateway: Gateway;
  /**
   * The code needed to claim an unowned workspace from off this machine. Null
   * once someone owns it. The host prints it; it is not served over the API.
   */
  claimCode: string | null;
  /** The copy taken before this start upgraded the workspace, if it did. */
  upgradeBackup: string | null;
  /** Posts anything now due. Runs on a timer; exposed so tests need not wait. */
  flushScheduled: () => void;
  /**
   * Removes a page of committed attachment deletions due by `now` (default:
   * the present), going on with the next page on a later turn if it was full.
   */
  flushFileDeletions: (now?: number) => Promise<void>;
  /** Frees uploads nobody attached. Runs on a timer; exposed so tests need not wait. */
  expireAbandonedUploads: () => number;
  /**
   * Discards conversation past the retention window, returning how many
   * messages went. Runs on a timer; exposed so tests need not wait.
   */
  applyRetention: () => number;
  /**
   * What the hourly timer runs: retention passes until the backlog is gone or
   * the round's budget is spent, yielding between them. Never rejects; a
   * failure is logged and recorded in `retentionStatus`.
   */
  sweepRetention: () => Promise<number>;
  /** Whether the last retention sweep succeeded, and if not, why. */
  retentionStatus: () => RetentionStatus;
  /** How scheduled backups are going; null when they are off. */
  backupStatus: () => BackupScheduleStatus | null;
  /**
   * Takes a scheduled backup now, or waits for the one running. Runs on a
   * timer; exposed so tests need not wait. Never rejects; see `backupStatus`.
   */
  runBackup: () => Promise<void>;
  /** Delivers a bounded batch of committed integration events. */
  flushEventDeliveries: () => Promise<void>;
  /**
   * Changes the address others reach this server on while it runs, or clears
   * it with null. A desktop host that opens a tunnel learns the address only
   * after starting, and loses it when the tunnel closes. While one is set, as
   * with `publicUrl`, no request counts as coming from this machine.
   */
  setPublicUrl: (url: string | null) => void;
  /** Trusts a loopback connector's client-address headers only while it is in use. */
  setTrustLoopbackProxy: (enabled: boolean) => void;
  /** Replaces the STUN and TURN servers that calls started from now on are given. */
  setIceServers: (servers: NonNullable<ServerOptions["iceServers"]>) => void;
  /** Replaces the relay that calls started from now on are given, or removes it with null. */
  setRelay: (relay: ServerRelay | null) => void;
  /** Why the relay gave calls no password last time it was asked, until it does. */
  relayError: () => string | null;
  /** Whether an account after the first needs an invite code. */
  inviteOnly: () => boolean;
  /**
   * Turns invites on (`invite_only`) or off. Off keeps guests allowed if they
   * were, so a host that does not know about guests cannot let them in.
   */
  setInviteOnly: (inviteOnly: boolean) => void;
  /** Who may join: invited accounts, any account, or guests too. */
  accessPolicy: () => AccessPolicy;
  /**
   * Changes who may join, as the host, by the same rule as an owner or admin
   * in Workspace settings. Turning guests off signs every guest out at once,
   * their sockets included, and everyone signed in is told.
   */
  setAccessPolicy: (policy: AccessPolicy) => void;
  /** The workspace's id: made once, kept through renames, moves and restores. */
  workspaceId: () => ID;
  /** The workspace's name now. */
  workspaceName: () => string;
  /**
   * Renames the workspace while it runs, as the host, by the same rule as an
   * owner or admin: 1 to 80 characters without control characters, trimmed.
   * Everyone signed in is told at once, the network announcement changes,
   * and the name is stored for the next start.
   */
  setWorkspaceName: (name: string) => void;
  /** The workspace's icon now, or null when it has none. */
  workspaceIcon: () => WorkspaceIcon | null;
  /**
   * Sets the workspace's icon, as the host, by the same rule as an owner or
   * admin: a PNG, JPEG or WebP image of `type`, which its bytes must agree
   * with, of at most 256 KB and 1024 pixels a side. Everyone signed in is
   * told at once. Returns its version; throws, saying why, one it refuses.
   */
  setWorkspaceIcon: (bytes: Uint8Array, type: string) => string;
  /** Removes the workspace's icon, as the host. Everyone signed in is told at once. */
  removeWorkspaceIcon: () => void;
  /**
   * Calls `listener` whenever the workspace is renamed, who may join changes
   * or its icon does, by its host or by an owner or admin, so whatever shows
   * any of them outside the workspace can follow. Returns how to stop.
   */
  onWorkspaceChange: (listener: (change: WorkspaceChange) => void) => () => void;
  /**
   * Announces the workspace on the local network afresh. The announcement is
   * made on the interfaces there were when it started, so after the computer
   * wakes or changes network it has to be made again to be found. Does
   * nothing when announcing is off or the workspace is stopping.
   */
  reannounce: () => void;
  /** How many people are connected now, each counted once however many devices they use. */
  connectedPeople: () => number;
  /** Calls `listener` whenever that count may have changed. Returns how to stop. */
  onConnectedChange: (listener: () => void) => () => void;
  stop: () => Promise<void>;
}

/** A change to the workspace itself, as `WorkspaceServer.onWorkspaceChange` reports it. */
export interface WorkspaceChange {
  /** The new name, when it was renamed. */
  workspaceName?: string;
  /** Who may join now, when that changed. */
  accessPolicy?: AccessPolicy;
  /** The icon's new version when it changed, or null when it was removed. */
  iconVersion?: string | null;
  /** The owner or admin who made the change, or null for the host. */
  by: ID | null;
}

export async function createWorkspaceServer(opts: ServerOptions): Promise<WorkspaceServer> {
  // Whatever stops the start after the workspace is taken gives it back, so a
  // failed start, such as a port in use, does not keep it from the next one.
  const ownership: { hold: WorkspaceHold | null } = { hold: null };
  try {
    return await startWorkspaceServer(opts, ownership);
  } catch (err) {
    ownership.hold?.release();
    throw err;
  }
}

async function startWorkspaceServer(
  opts: ServerOptions,
  ownership: { hold: WorkspaceHold | null },
): Promise<WorkspaceServer> {
  const instanceId = randomUUID();
  const extensions = opts.extensions ?? [];
  if (
    opts.maxStorageBytes !== undefined &&
    (!Number.isSafeInteger(opts.maxStorageBytes) || opts.maxStorageBytes < 0)
  ) {
    throw new Error("maxStorageBytes must be a non-negative safe integer");
  }
  // Zero would sweep uploads the moment they land, taking working ones with it.
  if (
    opts.abandonedUploadTtlMs !== undefined &&
    (!Number.isSafeInteger(opts.abandonedUploadTtlMs) || opts.abandonedUploadTtlMs <= 0)
  ) {
    throw new Error("abandonedUploadTtlMs must be a positive safe integer");
  }
  if (
    opts.retentionDays !== undefined &&
    (!Number.isSafeInteger(opts.retentionDays) || opts.retentionDays < 0)
  ) {
    throw new Error("retentionDays must be a non-negative safe integer");
  }
  // Checked here as well as by the CLI, so the desktop app's embedded server
  // and anyone calling this directly get the same refusal.
  if (opts.port !== undefined) parsePort(opts.port, "port");
  // Before the database opens, so a refused start leaves nothing open in the folder.
  if (opts.accessPolicy !== undefined && !isAccessPolicy(opts.accessPolicy))
    throw new TypeError(`accessPolicy must be one of ${ACCESS_POLICIES}`);
  const network = new Network(opts);
  // Before the database opens, so a refused relay leaves nothing open in the folder.
  if (opts.relay) serverRelaySchema.parse(opts.relay);
  const scheduled = opts.isolated ? undefined : opts.scheduledBackups;
  if (scheduled) {
    if (opts.dataDir === ":memory:")
      throw new ConfigError("Scheduled backups need a workspace folder, not one in memory.");
    if (!Number.isSafeInteger(scheduled.everyMs) || scheduled.everyMs <= 0)
      throw new ConfigError("Scheduled backups need a time between them greater than zero.");
    if (!Number.isSafeInteger(scheduled.keep) || scheduled.keep < 1)
      throw new ConfigError("Scheduled backups need to keep at least one.");
    try {
      await separateDirectories(opts.dataDir, scheduled.dir);
    } catch {
      throw new ConfigError(
        `Backups must go outside the workspace folder, and the workspace must not be inside theirs: ${scheduled.dir}`,
      );
    }
  }
  const dbPath = opts.dataDir === ":memory:" ? ":memory:" : join(opts.dataDir, "workspace.db");
  // Before anything reads or changes the folder: a second server would keep
  // its own count of the attachments and run its own queue and clean-up.
  if (opts.dataDir !== ":memory:") ownership.hold = holdWorkspace(opts.dataDir, "a server");
  let upgradeBackup: string | null = null;
  const unprunedCopies: { file: string; error: Error }[] = [];
  const db = openDb(dbPath, undefined, {
    backupBeforeUpgrade: opts.backupBeforeUpgrade,
    onUpgradeBackup: (file) => (upgradeBackup = file),
    onUpgradeBackupPruneFailure: (file, error) => unprunedCopies.push({ file, error }),
  });
  const store = new Store(db);
  const { settings } = store;

  // Before anyone owns the workspace, nobody in it could change its name or
  // who may join, so what it is started with decides both. Once it has an
  // owner they are its own, changed by its owner and admins, and a start
  // never puts back an older choice over theirs.
  const unowned = store.people.count() === 0;
  if (opts.workspaceName && (unowned || settings.stored("workspaceName") === null))
    settings.set("workspaceName", opts.workspaceName);
  if (settings.stored("workspaceName") === null)
    settings.set("workspaceName", settings.get("workspaceName"));
  settings.get("workspaceId");
  // Before guest access, invite_only alone said who could join: on, invited
  // accounts; off, any account. A workspace keeps that until someone chooses.
  if (settings.stored("accessPolicy") === null)
    settings.set(
      "accessPolicy",
      settings.get("inviteOnlyBefore") ? "invite_only" : "account_required",
    );
  const accessPolicy = (): AccessPolicy => settings.get("accessPolicy");
  const workspaceName = () => settings.get("workspaceName");
  const linkPreviewsOn = () => settings.get("linkPreviews");
  const inviteOnly = () => accessPolicy() === "invite_only";
  /**
   * The workspace's icon, held here once read, since everyone who opens the
   * workspace or finds it to join asks for it.
   */
  let icon: WorkspaceIcon | null = settings.get("icon");
  /**
   * Writes who may join, in one write with whatever `record` adds, and ends
   * every guest session when guests are no longer allowed. Returns the ended
   * sessions, whose sockets are the caller's to close.
   */
  const writeAccessPolicy = (policy: AccessPolicy, record?: () => void): string[] =>
    store.transaction(() => {
      settings.set("accessPolicy", policy);
      record?.();
      return policy === "guest_allowed" ? [] : store.accounts.revokeGuestSessions();
    });
  /** Off unless guests are allowed; off again keeps the other choice. */
  const withInvites = (on: boolean): AccessPolicy =>
    on ? "invite_only" : accessPolicy() === "invite_only" ? "account_required" : accessPolicy();
  if (unowned) {
    if (opts.accessPolicy !== undefined) writeAccessPolicy(opts.accessPolicy);
    else if (opts.inviteOnly !== undefined) writeAccessPolicy(withInvites(opts.inviteOnly));
  }

  /**
   * A workspace with no owner is up for grabs. Until one exists, the account
   * that becomes owner must come either from the machine running the server or
   * from someone holding the code it printed at startup — otherwise the first
   * stranger to find it on the network owns it. A host that hands out the
   * link to claim it gives the code instead (P7), and the one it gives last
   * is the one in force.
   */
  if (store.people.count() === 0) {
    if (opts.claimCode) settings.set("claimCode", opts.claimCode);
    else if (!settings.get("claimCode")) settings.set("claimCode", secretToken());
  }
  const claimCode = () => settings.get("claimCode");
  const deviceName = (req: FastifyRequest) => network.deviceName(req);
  const isLocalRequest = (req: FastifyRequest) => network.isLocalRequest(req);
  const callerAddress = (req: FastifyRequest) => network.callerAddress(req);

  const { app, runningHandlers } = await createHttp({
    logger: opts.logger,
    maxFileSize: maxFileSizeOf(opts),
    webDistPath: opts.webDistPath,
  });
  if (upgradeBackup) {
    app.log.info({ file: upgradeBackup }, "backed up the workspace before upgrading it");
  }
  for (const { file, error } of unprunedCopies) {
    app.log.warn({ file, err: error }, "could not remove an older pre-upgrade copy");
  }

  /**
   * Rationing. The cap on concurrent password hashing keeps one burst from
   * exhausting this machine; this keeps a patient caller from grinding away at
   * it all day, which that cap alone does nothing about.
   */
  const limiter =
    opts.rateLimits === false
      ? null
      : new RateLimiter({ ...DEFAULT_LIMITS, ...(opts.rateLimits ?? {}) });
  const ration = rationWith(limiter);
  const scheduledLimits = { ...SCHEDULED_LIMITS, ...opts.scheduledLimits };

  const gateway = new Gateway(
    store,
    limiter,
    (req) => network.callerAddress(req),
    (err, where) =>
      app.log.error({ err, where }, "socket work failed; its socket closes to reconnect"),
    {
      huddleGraceMs: opts.huddleGraceMs,
      huddleRingMs: opts.huddleRingMs,
      // Rung only once the server is up, by which time the note can be posted.
      missedCall: (channelId, callerId) => huddles.postMissedCall(channelId, callerId),
    },
  );

  store.outbox.connect(gateway, (err, what) =>
    app.log.error({ err, what }, "could not tell someone of a committed change"),
  );

  const background = new BackgroundWork(app.log);
  const { recordEvent, mutate, onPublished } = createCommits({
    store,
    gateway,
    log: app.log,
    background,
  });
  onPublished(() => apps.deliverSoon());
  const lifecycle = new Lifecycle();

  const { route, signedIn: requireUser } = createRouter({
    app,
    log: app.log,
    sessionUser: (tokenHash) => store.accounts.getSessionUser(tokenHash),
    mustChangePassword: (userId) => store.accounts.mustChangePassword(userId),
    appForToken: (tokenHash) => store.apps.forToken(tokenHash),
  });

  const ctx: ServerContext = {
    opts,
    app,
    log: app.log,
    db,
    store,
    settings,
    gateway,
    route,
    requireUser,
    ration,
    limiter,
    recordEvent,
    mutate,
    background,
    network,
    lifecycle,
  };

  const files = registerFiles(ctx);
  const { flushFileDeletions, expireAbandonedUploads, storage } = files;

  const messages = registerMessages(ctx, { files });
  const polls = registerPolls(ctx);
  const { posting, removeMessageWithin, applyRetention, sweepRetention, retention } = messages;

  const huddles = registerHuddles(ctx, { posting });

  const channels = registerChannels(ctx);
  const { joinPublicChannels } = channels;

  // ---------- unauthenticated ----------

  route(endpoints.health, async ({ reply }) => {
    db.prepare("SELECT 1").get();
    reply.header("Cache-Control", "no-store");
    return { status: "ok", instanceId };
  });

  const accounts = registerAccounts(ctx, {
    joinPublicChannels,
    iconVersion: () => icon?.version ?? null,
  });

  route(endpoints.workspaceIcon, async ({ req, reply, query }) => {
    ration("publicByAddress", callerAddress(req));
    const current = icon;
    if (!current) {
      reply.header("cache-control", "no-store");
      throw new HttpError(404, "no_icon", "This workspace has no icon.");
    }
    const etag = `"${current.version}"`;
    reply
      .header("content-type", current.type)
      .header("x-content-type-options", "nosniff")
      .header("etag", etag)
      .header(
        "cache-control",
        query.v === current.version ? "public, max-age=31536000, immutable" : "no-cache",
      );
    if (req.headers["if-none-match"] === etag) return reply.status(304).send();
    return reply.header("content-length", String(current.bytes.length)).send(current.bytes);
  });

  // ---------- me / users ----------

  const people = registerPeople(ctx);

  // ---------- channels ----------

  // ---------- messages ----------

  const threads = registerThreads(ctx);

  // ---------- link previews ----------

  // ---------- files ----------

  // ---------- reactions ----------

  // ---------- apps, webhooks and the Slack-compatible API ----------

  // ---------- operational status (OPS-10) ----------

  const startedAt = Date.now();
  // How late the event loop runs, kept for the last full minute, so a slow
  // stretch shows without one bad second from an hour ago staying forever.
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  let lastMinuteDelay: WorkspaceStatus["eventLoopDelayMs"] = null;
  const toMs = (ns: number) => Math.round(ns / 1e5) / 10;
  const loopDelayTimer = setInterval(() => {
    lastMinuteDelay = {
      p50: toMs(loopDelay.percentile(50)),
      p99: toMs(loopDelay.percentile(99)),
      max: toMs(loopDelay.max),
    };
    loopDelay.reset();
  }, 60_000);
  loopDelayTimer.unref();
  /** A file's size, or 0 where there is none (a database in memory, no log yet). */
  const sizeOf = (path: string) => {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  };

  /** Scheduled backups for the status: times and counts, never the folder or an error's text. */
  const backupSummary = (): NonNullable<WorkspaceStatus["backups"]> => {
    const status = backups?.status();
    if (!status) return { enabled: false };
    return {
      enabled: true,
      everyMs: status.everyMs,
      keep: status.keep,
      lastSuccessAt: status.lastSuccessAt,
      failures: status.failures,
      nextAt: status.nextAt,
      running: status.running,
      ...(status.offsite
        ? {
            offsite: {
              lastSuccessAt: status.offsite.lastSuccessAt,
              failures: status.offsite.failures,
            },
          }
        : {}),
    };
  };

  route(endpoints.workspaceStatus, async ({ reply }) => {
    reply.header("Cache-Control", "no-store");
    const counts = store.operationalCounts();
    let diskFreeBytes: number | null = null;
    if (opts.dataDir !== ":memory:") {
      try {
        const disk = statfsSync(opts.dataDir);
        diskFreeBytes = disk.bavail * disk.bsize;
      } catch {
        // Not every platform or mount answers; saying so beats a guess.
      }
    }
    return {
      serverVersion: SERVER_VERSION,
      schemaVersion: SCHEMA_VERSION,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      database: {
        bytes: counts.databaseBytes,
        walBytes: dbPath === ":memory:" ? 0 : sizeOf(`${dbPath}-wal`),
      },
      attachments: {
        bytes: storage.usedBytes,
        limitBytes: storage.limitBytes,
        removal: store.files.deletionCounts(),
      },
      diskFreeBytes,
      deliveries: counts.deliveries,
      scheduled: counts.scheduled,
      retention: {
        enabled: messages.retentionOn,
        lastSuccessAt: retention.lastSuccessAt,
        failures: retention.failures,
      },
      backups: backupSummary(),
      connections: { sockets: gateway.socketCount(), people: gateway.onlineUserIds().length },
      eventLoopDelayMs: lastMinuteDelay,
      backgroundFailures: background.failures().map(([queue, failing]) => ({
        queue,
        ...failing,
      })),
      ...(extensions.length > 0
        ? {
            extensions: extensions.flatMap((extension) =>
              extension.status ? [extension.status()] : [],
            ),
          }
        : {}),
    };
  });

  // ---------- a copy for the owner to download (P4) ----------

  /** Room left beyond a copy, so making one never fills the disk the workspace writes to. */
  const COPY_HEADROOM_BYTES = 64 * 1024 * 1024;

  /** Free space at `path`, or at the nearest folder above it that exists; null if unknown. */
  const freeBytesAt = (path: string): number | null => {
    for (let dir = resolve(path); ; dir = dirname(dir)) {
      try {
        const disk = statfsSync(dir);
        return disk.bavail * disk.bsize;
      } catch {
        if (dirname(dir) === dir) return null;
      }
    }
  };

  const megabytes = (bytes: number) =>
    `${Math.ceil(bytes / (1024 * 1024)).toLocaleString("en-US")} MB`;

  /** Tickets to download the copy: like a file's, spent on first use and a minute long. */
  const copyTickets = new CapabilityMap<{
    copyId: string;
    userId: ID;
    sessionHash: string;
    expiresAt: number;
  }>(16);

  route(endpoints.workspaceCopy, async ({ reply }) => {
    reply.header("cache-control", "no-store");
    return { copy: copies?.state() ?? null };
  });

  route(endpoints.makeWorkspaceCopy, async ({ reply, user: me }) => {
    reply.header("cache-control", "no-store");
    if (!copies)
      throw new HttpError(409, "copies_unavailable", "A workspace kept in memory has no copy.");
    const current = copies.state();
    if (current?.state === "making") return { copy: current };
    // Checked first: a full disk stops every write, chat included.
    const needed =
      store.operationalCounts().databaseBytes + storage.usedBytes + COPY_HEADROOM_BYTES;
    const free = freeBytesAt(copies.root);
    if (free !== null && free < needed)
      throw new HttpError(
        507,
        "not_enough_space",
        `A copy needs about ${megabytes(needed)} free on the server, and it has ${megabytes(free)}.`,
      );
    const made = copies.make();
    if (!made)
      throw new HttpError(
        409,
        "copy_downloading",
        "The copy is being downloaded. Make a new one once that has finished.",
      );
    store.recordAudit({
      actorId: me.id,
      action: "workspace.copy_made",
      targetType: "workspace",
      targetId: null,
    });
    return { copy: made };
  });

  route(endpoints.copyDownloadToken, async ({ req, reply, user: me }) => {
    const current = copies?.state();
    if (current?.state !== "ready")
      throw new HttpError(404, "no_copy", "There is no copy ready to download.");
    const { token, tokenHash } = newSessionToken();
    const expiresAt = Date.now() + DOWNLOAD_TOKEN_TTL_MS;
    copyTickets.set(tokenHash, {
      copyId: current.id,
      userId: me.id,
      sessionHash: hashToken(bearerToken(req)!),
      expiresAt,
    });
    reply.header("cache-control", "no-store");
    return { token, expiresAt };
  });

  route(endpoints.copyFile, async ({ reply, params, query, user }) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    const ticket = query.download;
    let ownerId: ID;
    if (!user) {
      if (!ticket || !/^[a-f0-9]{64}$/.test(ticket)) throw new HttpError(404, "no_copy");
      const hash = hashToken(ticket);
      const spent = copyTickets.get(hash);
      copyTickets.delete(hash);
      const owner = spent ? store.accounts.getSessionUser(spent.sessionHash) : null;
      if (
        !spent ||
        spent.copyId !== params.id ||
        !owner ||
        owner.id !== spent.userId ||
        owner.role !== "owner" ||
        store.accounts.mustChangePassword(owner.id)
      )
        throw new HttpError(404, "no_copy");
      ownerId = owner.id;
    } else {
      ownerId = user.id;
    }
    const zip = copies?.open(params.id);
    if (!zip) throw new HttpError(404, "no_copy", "That copy is gone. Make a new one.");
    store.recordAudit({
      actorId: ownerId,
      action: "workspace.copy_downloaded",
      targetType: "workspace",
      targetId: null,
      details: { bytes: zip.length },
    });
    const day = new Date().toISOString().slice(0, 10);
    const name = `${workspaceName()} ${day}.zip`;
    return reply
      .header("content-type", "application/zip")
      .header("x-content-type-options", "nosniff")
      .header("content-length", String(zip.length))
      .header(
        "content-disposition",
        `attachment; filename="workspace-${day}.zip"; filename*=UTF-8''${encodeURIComponent(name)}`,
      )
      .send(zip.stream);
  });

  const apps = registerApps(ctx, { accounts, messages, files });

  // ---------- people ----------

  route(endpoints.listAudit, async ({ query }) => {
    const entries = store.listAudit({ before: query.before, limit: query.limit + 1 });
    const page = entries.slice(0, query.limit);
    return { entries: page, nextCursor: entries.length > query.limit ? page.at(-1)!.id : null };
  });

  route(endpoints.listAllUsers, async () => {
    const lastSeen = store.people.lastSeenByUser();
    const twoStepIds = store.accounts.twoStepUserIds();
    return {
      users: store.people.list().map((u) => ({
        ...u,
        lastSeenAt: lastSeen[u.id] ?? null,
        // Who has two-step sign-in, for an admin who may reset it (E11).
        twoStep: twoStepIds.has(u.id),
      })),
    };
  });

  route(endpoints.updateUserAdmin, async ({ user: me, body, params }) => {
    const target = store.people.get(params.id);
    if (!target) throw new HttpError(404, "user_not_found");
    if (target.id === me.id) throw new HttpError(400, "cannot_change_self");
    if (target.role === "owner") throw new HttpError(403, "owner_is_protected");
    if (target.role === "admin" && me.role !== "owner") {
      throw new HttpError(403, "admins_are_equals", "Only the owner can change another admin.");
    }
    if (body.role !== undefined && target.isBot) {
      throw new HttpError(400, "bots_have_no_role");
    }
    // A guest becomes a member only by choosing a handle and password itself.
    if (target.role === "guest" && (body.role !== undefined || body.canInvite !== undefined)) {
      throw new HttpError(400, "guest_account", "A guest can create an account themselves.");
    }
    if (body.canInvite !== undefined) {
      if (target.isBot) throw new HttpError(400, "bots_cannot_invite");
      // An admin can always invite, so allowing or refusing it would be a
      // setting that does nothing — refused rather than silently stored.
      const resultingRole = body.role ?? target.role;
      if (resultingRole !== "member") {
        throw new HttpError(400, "admins_can_always_invite");
      }
    }

    return mutate((emit, afterCommit) => {
      const hadInvitePermission =
        body.canInvite !== undefined && store.people.invitePermission(target.id);
      const updated = store.people.update(target.id, {
        role: body.role,
        deactivated: body.deactivated,
        canInvite: body.canInvite,
      });
      // Only what actually changed: setting a role someone already has is not
      // an event anybody needs to account for.
      if (body.role !== undefined && body.role !== target.role) {
        store.recordAudit({
          actorId: me.id,
          action: "user.role_changed",
          targetType: "user",
          targetId: target.id,
          details: { from: target.role, to: body.role },
        });
      }
      if (body.canInvite !== undefined && body.canInvite !== hadInvitePermission) {
        store.recordAudit({
          actorId: me.id,
          action: body.canInvite
            ? "user.invite_permission_granted"
            : "user.invite_permission_removed",
          targetType: "user",
          targetId: target.id,
        });
      }
      if (body.deactivated !== undefined && body.deactivated !== target.deactivated) {
        store.recordAudit({
          actorId: me.id,
          action: body.deactivated ? "user.deactivated" : "user.reactivated",
          targetType: "user",
          targetId: target.id,
        });
      }

      if (body.deactivated === true) {
        // Revoking access has to reach what is already in their hands: every
        // session token, and every socket that authenticated with one.
        store.accounts.deleteSessionsFor(target.id);
        afterCommit(() => gateway.disconnectUser(target.id));
      }
      // Everyone sees the change, so a deactivated person drops out of the member
      // lists and the composer's autocomplete without a reload.
      emit({ type: "user.updated", user: updated });
      return { user: updated };
    });
  });

  /**
   * Whose password or two-step sign-in an admin may reset (E11 shares them):
   * not their own, an app's or a guest's; never the owner's; another admin's
   * only as the owner. The admin asking, and whom.
   */
  const resettable = (me: User, targetId: ID): { me: User; target: User } => {
    const target = store.people.get(targetId);
    if (!target) throw new HttpError(404, "user_not_found");
    if (target.id === me.id) throw new HttpError(400, "cannot_reset_self");
    if (target.isBot) throw new HttpError(400, "bots_have_no_password");
    if (target.role === "guest") throw new HttpError(400, "guest_account");
    if (target.role === "owner") throw new HttpError(403, "owner_is_protected");
    if (target.role === "admin" && me.role !== "owner") {
      throw new HttpError(
        403,
        "admins_are_equals",
        "Only the owner can reset another admin's password.",
      );
    }
    return { me, target };
  };

  route(endpoints.resetPassword, async ({ req, params }) => {
    // Checked again after hashing, which yields.
    const authorize = () => resettable(requireUser(req), params.id);
    authorize();
    const temporaryPassword = secretToken().slice(0, 16);
    const credentials = await accounts.hashing(() => hashPassword(temporaryPassword));
    const { me: actor, target } = authorize();
    const revokedSessions = store.transaction(() => {
      store.accounts.setPassword(target.id, credentials.hash, credentials.salt, true);
      const revoked = store.accounts.revokeSessions(target.id);
      store.recordAudit({
        actorId: actor.id,
        action: "user.password_reset",
        targetType: "user",
        targetId: target.id,
        details: { sessionsEnded: revoked.length },
      });
      return revoked;
    });
    for (const tokenHash of revokedSessions) {
      gateway.disconnectSession(tokenHash);
    }
    return { temporaryPassword };
  });

  route(endpoints.resetTwoStep, async ({ user, params }) => {
    const { me: actor, target } = resettable(user, params.id);
    store.transaction(() => {
      if (!store.accounts.disableTwoStep(target.id))
        throw new HttpError(409, "two_step_off", "Their two-step sign-in is already off.");
      store.recordAudit({
        actorId: actor.id,
        action: "user.two_step_reset",
        targetType: "user",
        targetId: target.id,
        details: {},
      });
    });
    return { ok: true };
  });

  route(endpoints.listReports, async () => {
    const reports: ReportedMessage[] = [];
    for (const open of store.people.openReports()) {
      const channel = store.channels.get(open.channelId);
      if (!channel) continue;
      reports.push({ ...open, message: store.messages.get(open.messageId), channel });
    }
    return { reports };
  });

  route(endpoints.resolveReport, async ({ user: me, body, params }) => {
    const { action } = body;
    const open = store.people.openReports().find((held) => held.messageId === params.id);
    if (!open) throw new HttpError(404, "report_not_found");
    const author = store.people.get(open.authorId);
    if (action === "deactivate" && author) {
      if (author.id === me.id) throw new HttpError(400, "cannot_change_self");
      if (author.role === "owner") throw new HttpError(403, "owner_is_protected");
      if (author.role === "admin" && me.role !== "owner") {
        throw new HttpError(403, "admins_are_equals", "Only the owner can change another admin.");
      }
    }
    mutate((emit, afterCommit) => {
      const message = store.messages.get(open.messageId);
      if (action !== "dismiss" && message) removeMessageWithin(message, emit);
      if (action === "deactivate" && author && !author.deactivated) {
        const updated = store.people.update(author.id, { deactivated: true });
        store.recordAudit({
          actorId: me.id,
          action: "user.deactivated",
          targetType: "user",
          targetId: author.id,
        });
        store.accounts.deleteSessionsFor(author.id);
        afterCommit(() => gateway.disconnectUser(author.id));
        emit({ type: "user.updated", user: updated });
      }
      const reports = store.people.resolveReports(open.messageId, me.id, action);
      store.recordAudit({
        actorId: me.id,
        action: "report.resolved",
        targetType: "user",
        targetId: open.authorId,
        details: { resolution: action, reports },
      });
    });
    await flushFileDeletions();
    return { ok: true };
  });

  route(endpoints.transferOwnership, async ({ user: me, params }) => {
    const target = store.people.get(params.id);
    if (!target) throw new HttpError(404, "user_not_found");
    if (target.id === me.id) throw new HttpError(400, "already_owner");
    if (target.isBot || target.deactivated || target.role === "guest")
      throw new HttpError(400, "invalid_owner");
    return mutate((emit) => {
      const newOwner = store.people.update(target.id, { role: "owner" });
      const formerOwner = store.people.update(me.id, { role: "admin" });
      store.recordAudit({
        actorId: me.id,
        action: "workspace.ownership_transferred",
        targetType: "user",
        targetId: target.id,
        details: { previousOwner: me.id },
      });
      emit({ type: "user.updated", user: newOwner });
      emit({ type: "user.updated", user: formerOwner });
      return { owner: newOwner, previousOwner: formerOwner };
    });
  });

  // ---------- workspace settings (UX-60) ----------

  route(endpoints.renameWorkspace, async ({ user: me, body }) => {
    const { name } = body;
    return { workspaceName: renameWorkspace(name, me.id) };
  });

  route(endpoints.setAccessPolicy, async ({ user: me, body }) => {
    changeAccessPolicy(body.accessPolicy, me.id);
    return { accessPolicy: accessPolicy() };
  });

  route(endpoints.setLinkPreviews, async ({ user: me, body }) => {
    const { enabled } = body;
    if (enabled !== linkPreviewsOn()) {
      store.transaction(() => {
        store.setMeta("link_previews", enabled ? "on" : "off");
        store.recordAudit({
          actorId: me.id,
          action: "workspace.link_previews_changed",
          targetType: "workspace",
          targetId: null,
          details: { from: !enabled, to: enabled },
        });
      });
      gateway.tellEveryone({ type: "workspace.linkPreviews", enabled });
    }
    return { enabled: linkPreviewsOn() };
  });

  route(endpoints.setWorkspaceIcon, async ({ req, user: me, body }) => {
    const picture = checkedPicture(req, body);
    changeIcon(picture, me.id);
    return { iconVersion: picture.version };
  });

  route(endpoints.removeWorkspaceIcon, async ({ user: me }) => {
    changeIcon(null, me.id);
    return { iconVersion: null };
  });

  // ---------- scheduled messages ----------

  const scheduledMessages = registerScheduled(ctx, { posting });

  const saved = registerSaved(ctx);

  // ---------- invites & search ----------

  registerSearch(ctx);

  const reminders = registerReminders(ctx);

  gateway.useSnapshot((user) => ({
    ...reminders.snapshot(user),
    ...polls.snapshot(user),
    ...saved.snapshot(user),
    ...threads.snapshot(user),
    ...channels.snapshot(user),
    ...people.snapshot(user),
    accessPolicy: accessPolicy(),
    iconVersion: icon?.version ?? null,
    linkPreviews: linkPreviewsOn(),
    workspaceName: workspaceName(),
    workspaceId: settings.get("workspaceId"),
    ...(isAdministrator(user.role)
      ? { openReports: store.people.openReportCount(), ...notices() }
      : {}),
  }));
  /** The plan's member notice and the extensions' notices for a snapshot, when there are any. */
  const notices = (): { memberNotice?: MemberNotice; notices?: ServerNotice[] } => {
    const notice = opts.memberNotice ?? null;
    const told = extensions.flatMap((extension) => {
      const said = extension.notice?.();
      return said ? [said] : [];
    });
    return {
      ...(notice ? { memberNotice: notice } : {}),
      ...(told.length > 0 ? { notices: told } : {}),
    };
  };

  // ---------- extensions (P6) ----------

  await registerExtensions(ctx, { joinPublicChannels });

  route(endpoints.extensionSettings, async ({ reply }) => {
    reply.header("cache-control", "no-store");
    return { panels: extensions.flatMap((extension) => extension.settingsPanels?.() ?? []) };
  });

  // ---------- start ----------

  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? "0.0.0.0";
  gateway.attach(app.server);
  try {
    await app.listen({ port, host });
  } catch (err) {
    await gateway.close();
    await app.close();
    db.close();
    throw err;
  }
  const actualPort = (app.server.address() as { port: number }).port;
  ownership.hold?.describe({ port: actualPort });

  let mdnsHandle: MdnsHandle | null = null;
  // An isolated copy shares the original's name, and would be offered to
  // people looking for the real one.
  const announcing = opts.mdns !== false && !opts.isolated;
  const announcement = () => ({
    name: workspaceName(),
    port: actualPort,
    instanceId,
    iconVersion: icon?.version ?? null,
  });
  if (announcing) {
    mdnsHandle = advertise(announcement());
  }
  /** Replaces the announcement with one made now, under the current name and icon. */
  const announce = () => {
    if (!announcing || lifecycle.closing) return;
    mdnsHandle?.stop();
    // Losing the announcement is not worth failing what asked for it: the
    // workspace still answers at its address, and the next call tries again.
    try {
      mdnsHandle = advertise(announcement());
    } catch {
      mdnsHandle = null;
    }
  };

  /** Whatever shows the workspace from outside it, such as a desktop host's window. */
  const workspaceListeners = new Set<(change: WorkspaceChange) => void>();
  const workspaceChanged = (change: WorkspaceChange) => {
    for (const listener of [...workspaceListeners]) {
      try {
        listener(change);
      } catch (err) {
        // The change is made and told to everyone; one listener failing to
        // hear it must not undo that or keep it from the others.
        app.log.error({ err }, "a workspace change listener failed");
      }
    }
  };

  /**
   * Renames the workspace, for its host (`by` null) or for an owner or admin,
   * by the one rule both are held to. Everyone signed in is told at once, the
   * network announcement changes, and the record says who did it.
   */
  const renameWorkspace = (value: unknown, by: ID | null): string => {
    const parsed = workspaceNameSchema.safeParse(value);
    if (!parsed.success)
      throw new TypeError("A workspace name has 1 to 80 characters and no control characters.");
    if (lifecycle.closing) throw new Error("The workspace is stopping.");
    const name = parsed.data;
    const previous = workspaceName();
    if (name === previous) return name;
    store.transaction(() => {
      store.setMeta("workspace_name", name);
      store.recordAudit({
        actorId: by,
        action: "workspace.renamed",
        targetType: "workspace",
        targetId: null,
        details: { from: previous, to: name },
      });
    });
    gateway.tellEveryone({ type: "workspace.renamed", workspaceName: name });
    announce();
    workspaceChanged({ workspaceName: name, by });
    return name;
  };

  /**
   * Changes who may join, for the host (`by` null) or for an owner or admin.
   * Turning guests off signs every guest out at once, their sockets
   * included, and everyone signed in is told what the workspace now allows.
   */
  const changeAccessPolicy = (policy: AccessPolicy, by: ID | null): void => {
    const previous = accessPolicy();
    const ended = writeAccessPolicy(policy, () => {
      if (policy === previous) return;
      store.recordAudit({
        actorId: by,
        action: "workspace.access_policy_changed",
        targetType: "workspace",
        targetId: null,
        details: { from: previous, to: policy },
      });
    });
    for (const tokenHash of ended) gateway.disconnectSession(tokenHash);
    if (policy === previous) return;
    gateway.tellEveryone({ type: "workspace.accessPolicy", accessPolicy: policy });
    workspaceChanged({ accessPolicy: policy, by });
  };

  /**
   * Sets or removes the workspace's icon, for the host (`by` null) or for an
   * owner or admin, by the one rule both are held to. The rows change in one
   * write with the record of who did it, which names the image's type and
   * size but never holds it. Everyone signed in is told the new version.
   */
  const changeIcon = (next: WorkspaceIcon | null, by: ID | null): void => {
    if (lifecycle.closing) throw new Error("The workspace is stopping.");
    if ((icon?.version ?? null) === (next?.version ?? null)) return;
    store.transaction(() => {
      if (next) for (const [key, value] of storedIconRows(next)) store.setMeta(key, value);
      else for (const key of Object.values(ICON_META_KEYS)) store.deleteMeta(key);
      store.recordAudit({
        actorId: by,
        action: "workspace.icon_changed",
        targetType: "workspace",
        targetId: null,
        details: next
          ? { change: "set", type: next.type, bytes: next.bytes.length }
          : { change: "removed" },
      });
    });
    icon = next;
    const iconVersion = next?.version ?? null;
    gateway.tellEveryone({ type: "workspace.icon", iconVersion });
    announce();
    workspaceChanged({ iconVersion, by });
  };

  // Each queue on its own, so one failing neither stops the server starting
  // nor skips the others.
  apps.start();
  files.start();

  /** Set once the server is listening; null when scheduled backups are off. */
  let backups: BackupSchedule | null = null;
  /** The owner's downloadable copy; null for a workspace kept in memory. */
  let copies: WorkspaceCopies | null = null;
  const takeBackup =
    opts.takeBackup ?? ((out: string) => backupWorkspace({ dataDir: opts.dataDir, out }));
  backups = scheduled
    ? new BackupSchedule({
        ...scheduled,
        run: files.holdingRemovals(scheduled.run ?? takeBackup),
        log: app.log,
      })
    : null;
  await backups?.start();
  if (opts.dataDir !== ":memory:") {
    copies = new WorkspaceCopies({
      root:
        opts.copiesDir ??
        (scheduled
          ? join(scheduled.dir, ".copies")
          : join(
              tmpdir(),
              "ownbase-copies",
              createHash("sha256").update(resolve(opts.dataDir)).digest("hex").slice(0, 16),
            )),
      take: files.holdingRemovals(takeBackup),
      log: app.log,
    });
    await copies.start().catch((err: unknown) => {
      app.log.error({ err }, "copies left from before could not be removed");
    });
  }

  const pruneTimer = setInterval(() => {
    background.maintain("events", () => store.pruneEvents());
    scheduledMessages.hourly();
    background.maintain("sessions", () => store.accounts.pruneSessions());
    messages.hourly();
    apps.hourly();
    files.hourly();
    void sweepRetention();
  }, 3600_000);

  reminders.start();
  people.start();
  scheduledMessages.start();

  let stopping: Promise<void> | null = null;
  // The stages of stopping that have finished. A stop that fails part-way
  // can be asked again, and the next try picks up at the first stage not yet
  // done instead of repeating the failure or a stage that must happen once.
  const stopped = {
    started: false,
    gateway: false,
    http: false,
    extensions: false,
    backups: false,
    drained: false,
    database: false,
  };

  return {
    port: actualPort,
    instanceId,
    store,
    gateway,
    /** Set only while the workspace still has no owner. */
    claimCode: claimCode(),
    upgradeBackup,
    flushScheduled: scheduledMessages.flush,
    flushFileDeletions,
    expireAbandonedUploads,
    applyRetention,
    sweepRetention,
    retentionStatus: () => ({ ...retention }),
    backupStatus: () => backups?.status() ?? null,
    runBackup: () => backups?.runNow() ?? Promise.resolve(),
    flushEventDeliveries: apps.flushEventDeliveries,
    setPublicUrl: (url) => network.setPublicUrl(url),
    setTrustLoopbackProxy: (enabled) => network.setTrustLoopbackProxy(enabled),
    setIceServers: (servers) => huddles.setIceServers(servers),
    setRelay: (next) => huddles.setRelay(next),
    relayError: () => huddles.relayError(),
    inviteOnly,
    setInviteOnly: (value) => {
      if (typeof value !== "boolean") throw new TypeError("inviteOnly must be a boolean");
      changeAccessPolicy(withInvites(value), null);
    },
    accessPolicy,
    setAccessPolicy: (policy) => {
      if (!isAccessPolicy(policy)) throw new TypeError(`policy must be one of ${ACCESS_POLICIES}`);
      changeAccessPolicy(policy, null);
    },
    workspaceId: () => settings.get("workspaceId"),
    workspaceName,
    setWorkspaceName: (value) => {
      renameWorkspace(value, null);
    },
    workspaceIcon: () => icon,
    setWorkspaceIcon: (bytes, type) => {
      if (!(bytes instanceof Uint8Array)) throw new TypeError("An icon is the bytes of an image.");
      const checked = checkIcon(Buffer.from(bytes), typeof type === "string" ? type : undefined);
      if ("refused" in checked) throw new TypeError(checked.refused.message);
      changeIcon(checked.icon, null);
      return checked.icon.version;
    },
    removeWorkspaceIcon: () => changeIcon(null, null),
    onWorkspaceChange: (listener) => {
      workspaceListeners.add(listener);
      return () => workspaceListeners.delete(listener);
    },
    reannounce: () => announce(),
    connectedPeople: () => gateway.onlineUserIds().length,
    onConnectedChange: (listener) => gateway.onPresenceChange(listener),
    stop: () => {
      if (stopping) return stopping;
      if (!stopped.started) {
        stopped.started = true;
        clearInterval(pruneTimer);
        clearInterval(loopDelayTimer);
        loopDelay.disable();
        mdnsHandle?.stop();
        // Before waiting on anything, so whatever is waiting on an app hears
        // about it now rather than at the end of its timeout.
        lifecycle.close();
      }
      stopping = (async () => {
        if (!stopped.gateway) {
          await gateway.close();
          stopped.gateway = true;
        }
        if (!stopped.http) {
          await app.close();
          stopped.http = true;
        }
        if (!stopped.extensions) {
          for (const extension of extensions) await extension.stop?.();
          stopped.extensions = true;
        }
        if (!stopped.backups) {
          // Before the drain: removals held for a backup go once it has ended.
          await Promise.all([backups?.stop(), copies?.stop()]);
          stopped.backups = true;
        }
        if (!stopped.drained) {
          // Nothing new can arrive now, so this set only shrinks.
          while (runningHandlers.size > 0) await Promise.all(runningHandlers);
          await lifecycle.drain();
          stopped.drained = true;
        }
        if (!stopped.database) {
          db.close();
          stopped.database = true;
        }
        // Last, once nothing of this server can touch the folder again.
        ownership.hold?.release();
      })().catch((error: unknown) => {
        // Still held, and still stoppable: the next stop() carries on from here.
        stopping = null;
        throw error;
      });
      return stopping;
    },
  };
}
