import {
  ACCESS_POLICIES,
  DEFAULT_PORT,
  endpoints,
  isAdministrator,
  planMembers,
  PROTOCOL_VERSION,
  workspaceNameSchema,
  type AccessPolicy,
  type App,
  type AppScope,
  type ID,
  type MemberNotice,
  type Message,
  type ModalView,
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
import { hashPassword, hashToken, newSessionToken } from "./auth.js";
import type { BackupManifest } from "./backup.js";
import { backupWorkspace, separateDirectories } from "./backup.js";
import {
  BackupSchedule,
  type BackupScheduleStatus,
  type ScheduledBackups,
} from "./backupSchedule.js";
import {
  blocksToActions,
  parseView,
  payloadToText,
  readAnswer,
  type AnswerContext,
} from "./blockKit.js";
import { CapabilityMap } from "./capabilities.js";
import { registerChannels } from "./channels/feature.js";
import { BUILTIN_COMMANDS } from "./commands.js";
import { ConfigError, parsePort } from "./config.js";
import { BackgroundWork } from "./core/background.js";
import { createCommits } from "./core/commit.js";
import {
  checkedPicture,
  rationWith,
  requireChannelAccess as requireChannelAccessIn,
  requireVisibleMessage as requireVisibleMessageIn,
  type ServerContext,
} from "./core/context.js";
import { createHttp } from "./core/http.js";
import { Lifecycle } from "./core/lifecycle.js";
import { bearerToken, Network } from "./core/network.js";
import { openDb, SCHEMA_VERSION } from "./db.js";
import type { ServerExtension } from "./extensions.js";
import { DOWNLOAD_TOKEN_TTL_MS, maxFileSizeOf, registerFiles } from "./files/feature.js";
import { Gateway } from "./gateway.js";
import { HttpError } from "./httpError.js";
import { registerHuddles } from "./huddles/feature.js";
import { secretToken, ulid } from "./ids.js";
import { signatureHeaders } from "./integrations.js";
import {
  APP_CALLS_IN_FLIGHT,
  CAPABILITIES_ALIVE,
  DEFAULT_LIMITS,
  RateLimiter,
  type Limits,
} from "./limits.js";
import { type FetchedPreview } from "./linkPreview.js";
import { advertise, type MdnsHandle } from "./mdns.js";
import { registerMessages, type RetentionStatus } from "./messages/feature.js";
import { requireMessageText, slackRefusal } from "./messages/posting.js";
import { OutboundError, postToUrl } from "./outbound.js";
import { holdWorkspace, type WorkspaceHold } from "./ownership.js";
import { registerPeople } from "./people/feature.js";
import { registerPolls } from "./polls/feature.js";
import { serverRelaySchema, type ServerRelay } from "./relay.js";
import { registerReminders, REMINDER_LIMITS } from "./reminders/feature.js";
import { createRouter } from "./route.js";
import { registerSaved } from "./saved/feature.js";
import { registerScheduled, SCHEDULED_LIMITS } from "./scheduled/feature.js";
import { registerSearch } from "./search/feature.js";
import { Store } from "./store.js";
import { registerThreads } from "./threads/feature.js";
import { SERVER_BUILD, SERVER_VERSION } from "./version.js";
import { WorkspaceCopies } from "./workspaceCopy.js";
import { checkIcon, ICON_META_KEYS, storedIconRows, type WorkspaceIcon } from "./workspaceIcon.js";

export { GUEST_SESSION_TTL_MS } from "./accounts/feature.js";
export type { RetentionStatus } from "./messages/feature.js";
export { SERVER_VERSION };

/** Delays after failures; the eighth failed attempt becomes terminal. */
const EVENT_DELIVERY_RETRY_MS = [
  5_000,
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  3600_000,
  6 * 3600_000,
];
const EVENT_DELIVERY_ATTEMPTS = EVENT_DELIVERY_RETRY_MS.length + 1;
/** App events on their way at once, across every endpoint; one per subscription. */
const EVENT_DELIVERY_CONCURRENCY = 10;
/** App events one round of delivery starts before it waits to be asked again. */
const EVENT_DELIVERY_ROUND = 50;
const EVENT_DELIVERY_RETENTION_MS = 7 * 24 * 3600_000;

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
  const requestOrigin = (req: FastifyRequest) => network.requestOrigin(req);

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

  /** Calls to apps in flight, keyed `account:<id>` and `app:<id>`. */
  const appCallsInFlight = new Map<string, number>();
  /**
   * Admits one call out to an app on an account's behalf, before anything is
   * prepared for it: a slow app holds its slot until it answers, so a person
   * pressing a button again and again, or everyone pressing one app's buttons,
   * is refused rather than queued without end. Returns the release, which the
   * caller runs however the call ends.
   */
  const admitAppCall = (accountId: ID, appId: ID): (() => void) => {
    if (!limiter) return () => {};
    const keys = [`account:${accountId}`, `app:${appId}`] as const;
    if ((appCallsInFlight.get(keys[0]) ?? 0) >= APP_CALLS_IN_FLIGHT.perAccount)
      throw new HttpError(
        429,
        "too_many_requests",
        "Your earlier requests to apps have not been answered yet. Try again when they finish.",
        1,
      );
    if ((appCallsInFlight.get(keys[1]) ?? 0) >= APP_CALLS_IN_FLIGHT.perApp)
      throw new HttpError(
        429,
        "app_busy",
        "That app is still answering other requests. Try again shortly.",
        1,
      );
    ration("appCall", accountId);
    for (const key of keys) appCallsInFlight.set(key, (appCallsInFlight.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of keys) {
        const left = (appCallsInFlight.get(key) ?? 1) - 1;
        if (left > 0) appCallsInFlight.set(key, left);
        else appCallsInFlight.delete(key);
      }
    };
  };

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
  const inBackground = (queue: string, work: () => unknown) => background.run(queue, work);
  const { recordEvent, mutate, onPublished } = createCommits({
    store,
    gateway,
    log: app.log,
    background,
  });
  onPublished(() => inBackground("event deliveries", flushEventDeliveries));
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
  const requireChannelAccess = (channelId: ID, user: User) =>
    requireChannelAccessIn(store, channelId, user);
  const requireVisibleMessage = (messageId: ID, user: User) =>
    requireVisibleMessageIn(store, messageId, user);

  const files = registerFiles(ctx);
  const { flushFileDeletions, expireAbandonedUploads, storage } = files;

  const messages = registerMessages(ctx, { files });
  const polls = registerPolls(ctx);
  const {
    posting,
    updateMessage,
    queuePreviews,
    removeMessage,
    removeMessageWithin,
    applyRetention,
    sweepRetention,
    retention,
  } = messages;

  /**
   * Every request to an app goes through here, so an isolated copy has one
   * place to refuse them. The refusal is a `blocked_host`, whose message the
   * callers already show to whoever pressed the button or ran the command.
   */
  const postToApp: typeof postToUrl = (url, body, contentType, options) =>
    opts.isolated
      ? Promise.reject(
          new OutboundError(
            "blocked_host",
            "this is an isolated copy of the workspace, which does not contact apps",
          ),
        )
      : postToUrl(url, body, contentType, options);

  type DueDelivery = ReturnType<Store["dueEventDeliveries"]>[number];
  /** Sends one event to its endpoint and records how that went. */
  const deliverEvent = async (delivery: DueDelivery): Promise<void> => {
    try {
      const retryHeaders: Record<string, string> =
        delivery.attempts > 0
          ? {
              "x-slack-retry-num": String(delivery.attempts),
              "x-slack-retry-reason": "http_error",
            }
          : {};
      const res = await postToApp(delivery.url, delivery.body, "application/json", {
        allowPrivate: opts.allowPrivateHooks,
        signal: lifecycle.signal,
        headers: {
          ...signatureHeaders(delivery.signingSecret, delivery.body),
          ...retryHeaders,
        },
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      store.completeEventDelivery(delivery.id, delivery.subscriptionId);
    } catch (err) {
      // Cut short by this server stopping, which says nothing about the
      // endpoint. The row stays due and goes out after the restart,
      // rather than spending one of the endpoint's attempts.
      if (err instanceof OutboundError && err.code === "aborted") return;
      const message = err instanceof Error ? err.message : "unknown delivery error";
      const delay =
        EVENT_DELIVERY_RETRY_MS[Math.min(delivery.attempts, EVENT_DELIVERY_RETRY_MS.length - 1)]!;
      const failure = store.failEventDelivery(
        delivery.id,
        message,
        Date.now() + delay,
        EVENT_DELIVERY_ATTEMPTS,
      );
      // Deleting the subscription/app or revoking channel membership
      // while the request was in flight deliberately removed the row.
      if (!failure) return;
      // An endpoint that has used up a whole ladder of attempts is not
      // coming back on its own, so the rest of its queue goes with it
      // rather than each event repeating the same hours of retries.
      const alsoAbandoned = failure.terminal
        ? store.abandonEventBacklog(delivery.subscriptionId, message)
        : 0;
      app.log.warn(
        {
          subscriptionId: delivery.subscriptionId,
          eventSeq: delivery.eventSeq,
          attempt: failure.attempts,
          terminal: failure.terminal,
          alsoAbandoned,
          err: message,
        },
        failure.terminal
          ? "event subscription delivery abandoned"
          : "event subscription delivery will retry",
      );
    }
  };

  let eventDeliveryFlush: Promise<void> | null = null;
  /** While a flush runs: starts a fresh round, looking for due events now. */
  let eventDeliveryNudge: (() => void) | null = null;
  /**
   * Delivers in sequence per subscription and in parallel across endpoints.
   * A receiver can see a duplicate if this process dies after its HTTP 2xx but
   * before the row is deleted; event_id remains stable so it can deduplicate.
   *
   * A pump rather than batches (REV-15): each slot freed goes straight to the
   * next due event of a subscription with nothing on its way, so an endpoint
   * slow to answer holds back only its own events. At most
   * `EVENT_DELIVERY_CONCURRENCY` are out at once and one per subscription. A
   * round starts at most `EVENT_DELIVERY_ROUND`; another flush asked for while
   * this one runs (new events, the timer) starts a fresh round in it.
   */
  const flushEventDeliveries = (): Promise<void> => {
    // Left queued rather than refused, so nothing is spent against an
    // endpoint's attempts and it all goes out if this data is started normally.
    if (opts.isolated) return Promise.resolve();
    if (eventDeliveryFlush) {
      eventDeliveryNudge?.();
      return eventDeliveryFlush;
    }
    eventDeliveryFlush = (async () => {
      const out = new Map<ID, Promise<void>>();
      const failures: unknown[] = [];
      let remaining = 0;
      let freshRound = true;
      let wake = () => {};
      eventDeliveryNudge = () => {
        freshRound = true;
        wake();
      };
      try {
        while (!lifecycle.closing && failures.length === 0) {
          if (freshRound) {
            freshRound = false;
            remaining = EVENT_DELIVERY_ROUND;
            // Retries waiting for room take any that has freed up (REV-15).
            store.promoteAllEventRetries();
          }
          const room = Math.min(EVENT_DELIVERY_CONCURRENCY - out.size, remaining);
          if (room > 0) {
            for (const delivery of store.dueEventDeliveries(Date.now(), room, [...out.keys()])) {
              remaining--;
              const sending = deliverEvent(delivery)
                .catch((error: unknown) => {
                  failures.push(error);
                })
                .finally(() => {
                  out.delete(delivery.subscriptionId);
                  wake();
                });
              out.set(delivery.subscriptionId, sending);
            }
          }
          if (out.size === 0) break;
          // Until one finishes or more work is announced.
          await new Promise<void>((resolve) => (wake = resolve));
        }
      } finally {
        // Stopping, or a step failed: what is already out ends on its own (the
        // shutdown signal cuts calls short) before the flush does, so the next
        // flush never sends an event that is still on its way.
        await Promise.all(out.values());
      }
      if (failures.length > 0) throw failures[0];
    })().finally(() => {
      eventDeliveryFlush = null;
      eventDeliveryNudge = null;
    });
    return eventDeliveryFlush;
  };

  const huddles = registerHuddles(ctx, { posting });

  const channels = registerChannels(ctx);
  const { joinPublicChannels } = channels;

  // ---------- unauthenticated ----------

  route(endpoints.health, async ({ reply }) => {
    db.prepare("SELECT 1").get();
    reply.header("Cache-Control", "no-store");
    return { status: "ok", instanceId };
  });

  const accounts = registerAccounts(ctx, { joinPublicChannels });

  route(endpoints.serverInfo, async ({ req }) => {
    const userCount = store.people.count();
    const signIn = accounts.signInInfo();
    return {
      app: "ownbase",
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: SERVER_VERSION,
      ...(SERVER_BUILD ? { build: SERVER_BUILD } : {}),
      workspaceName: workspaceName(),
      userCount,
      requiresInvite: userCount > 0 && inviteOnly(),
      accessPolicy: accessPolicy(),
      requiresClaim: userCount === 0 && !!claimCode() && !isLocalRequest(req),
      workspaceCopies: opts.dataDir !== ":memory:",
      ...(network.publicUrl() ? { publicUrl: network.publicUrl() } : {}),
      iconVersion: icon?.version ?? null,
      ...(signIn ? { signIn } : {}),
    };
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

  /** A handle for the app's bot user that cannot collide with a person's. */
  const botHandle = (name: string): string => {
    const base =
      name
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, "-")
        .replaceAll(/^-|-$/g, "")
        .slice(0, 24) || "bot";
    let handle = `${base}-bot`;
    let n = 2;
    while (store.people.authByHandle(handle)) handle = `${base}-bot-${n++}`;
    return handle;
  };

  /**
   * The host of a URL an admin gave an app, for the audit log. The whole URL
   * stays out: webhook and callback URLs often carry a secret in their path.
   */
  const hostOf = (url: string): string => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  };

  route(endpoints.createApp, async ({ req, user: me, body }) => {
    // A bot posts as a real (non-human) user, so messages render normally.
    const credentials = await accounts.hashing(() => hashPassword(secretToken()));
    requireUser(req);
    const result = mutate((emit) => {
      const { hash, salt } = credentials;
      const bot = store.createBotUser(botHandle(body.name), body.name, hash, salt);
      const signingSecret = secretToken();
      const created = store.createApp({
        name: body.name,
        botUserId: bot.id,
        createdBy: me.id,
        signingSecret,
        scopes: body.scopes,
      });

      const token = secretToken("xoxb-");
      store.addAppToken(created.id, hashToken(token));
      store.recordAudit({
        actorId: me.id,
        action: "app.created",
        targetType: "app",
        targetId: created.id,
        details: { name: created.name, scopes: (created.scopes ?? []).join(", ") },
      });
      emit({ type: "user.joined", user: bot });

      // The bot token is shown once and only stored hashed; the signing secret
      // stays readable to admins because verification needs the key itself.
      return { app: created, botUser: bot, token, signingSecret };
    });
    return result;
  });

  route(endpoints.listApps, async () => {
    const apps = store.listApps();
    return {
      apps: apps.map((a) => ({
        ...a,
        webhooks: store.listWebhooks(a.id),
        commands: store.listSlashCommands(a.id),
        subscriptions: store.listSubscriptions(a.id),
        signingSecret: store.appSigningSecret(a.id) ?? "",
      })),
    };
  });

  route(endpoints.setAppScopes, async ({ user: me, body, params }) => {
    return store.transaction(() => {
      const target = store.getApp(params.id);
      if (!target) throw new HttpError(404, "not_found");
      const before = target.scopes ?? [];
      store.setAppScopes(target.id, body.scopes);
      const after = store.getApp(target.id)!;
      const added = (after.scopes ?? []).filter((scope) => !before.includes(scope));
      const removed = before.filter((scope) => !(after.scopes ?? []).includes(scope));
      if (added.length > 0 || removed.length > 0) {
        store.recordAudit({
          actorId: me.id,
          action: "app.scopes_changed",
          targetType: "app",
          targetId: target.id,
          details: { name: target.name, added: added.join(", "), removed: removed.join(", ") },
        });
      }
      return { app: after };
    });
  });

  route(endpoints.replaceAppToken, async ({ req, user: me, params }) => {
    const target = store.getApp(params.id);
    if (!target) throw new HttpError(404, "not_found");
    const token = secretToken("xoxb-");
    store.transaction(() => {
      store.replaceAppTokens(target.id, hashToken(token));
      store.recordAudit({
        actorId: me.id,
        action: "app.token_replaced",
        targetType: "app",
        targetId: target.id,
        details: { name: target.name },
      });
    });
    req.log.info({ appId: target.id, by: me.id }, "app bot token replaced");
    return { token };
  });

  route(endpoints.replaceSigningSecret, async ({ req, user: me, params }) => {
    const target = store.getApp(params.id);
    if (!target) throw new HttpError(404, "not_found");
    const signingSecret = secretToken();
    store.transaction(() => {
      store.setAppSigningSecret(target.id, signingSecret);
      store.recordAudit({
        actorId: me.id,
        action: "app.signing_secret_replaced",
        targetType: "app",
        targetId: target.id,
        details: { name: target.name },
      });
    });
    req.log.info({ appId: target.id, by: me.id }, "app signing secret replaced");
    return { signingSecret };
  });

  route(endpoints.deleteApp, async ({ user: me, params }) => {
    const target = store.getApp(params.id);
    if (!target) throw new HttpError(404, "not_found");
    store.transaction(() => {
      store.deleteApp(target.id);
      store.recordAudit({
        actorId: me.id,
        action: "app.deleted",
        targetType: "app",
        targetId: target.id,
        details: { name: target.name },
      });
    });
    return { ok: true };
  });

  route(endpoints.createWebhook, async ({ user: me, body, params }) => {
    const owner = store.getApp(params.id);
    if (!owner) throw new HttpError(404, "not_found");
    const channel = requireChannelAccess(body.channelId, me);

    const token = secretToken();
    const webhook = mutate((emit) => {
      const created = store.createWebhook({
        appId: owner.id,
        channelId: channel.id,
        tokenHash: hashToken(token),
      });
      store.recordAudit({
        actorId: me.id,
        action: "webhook.created",
        targetType: "webhook",
        targetId: created.id,
        details: { appId: owner.id, name: owner.name, channelId: channel.id },
      });
      // The bot must be in the channel to post to it.
      if (store.channels.addMember(channel.id, owner.botUserId)) {
        emit({ type: "member.joined", channelId: channel.id, userId: owner.botUserId });
      }
      return created;
    });
    return { webhook, url: `/hooks/${token}` };
  });

  route(endpoints.replaceWebhookUrl, async ({ req, user: me, params }) => {
    const token = secretToken();
    const webhook = store.transaction(() => {
      const replaced = store.replaceWebhookToken(params.id, hashToken(token));
      if (replaced) {
        store.recordAudit({
          actorId: me.id,
          action: "webhook.url_replaced",
          targetType: "webhook",
          targetId: replaced.id,
          details: {
            appId: replaced.appId,
            name: store.getApp(replaced.appId)?.name ?? null,
            channelId: replaced.channelId,
          },
        });
      }
      return replaced;
    });
    if (!webhook) throw new HttpError(404, "not_found");
    req.log.info(
      { webhookId: webhook.id, appId: webhook.appId, by: me.id },
      "webhook url replaced",
    );
    return { webhook, url: `/hooks/${token}` };
  });

  route(endpoints.deleteWebhook, async ({ user: me, params }) => {
    const deleted = store.transaction(() => {
      const webhook = store.getWebhook(params.id);
      if (!webhook || !store.deleteWebhook(webhook.id)) return false;
      store.recordAudit({
        actorId: me.id,
        action: "webhook.deleted",
        targetType: "webhook",
        targetId: webhook.id,
        details: {
          appId: webhook.appId,
          name: store.getApp(webhook.appId)?.name ?? null,
          channelId: webhook.channelId,
        },
      });
      return true;
    });
    if (!deleted) throw new HttpError(404, "not_found");
    return { ok: true };
  });

  route(endpoints.postToWebhook, async ({ req, reply, params }) => {
    // Before the lookup, so a wrong token costs as much as a right one.
    ration("hookByAddress", callerAddress(req));
    const found = store.webhookForToken(hashToken(params.token));
    if (!found) return reply.status(404).send({ ok: false, error: "invalid_webhook" });

    let payload: { text?: unknown; blocks?: unknown } = {};
    const raw = req.body as Record<string, unknown> | string | undefined;
    if (typeof raw === "string") {
      try {
        payload = JSON.parse(raw) as typeof payload;
      } catch {
        return reply.status(400).send({ ok: false, error: "invalid_payload" });
      }
    } else if (raw && typeof raw === "object") {
      if (typeof raw.payload === "string") {
        try {
          payload = JSON.parse(raw.payload) as typeof payload;
        } catch {
          return reply.status(400).send({ ok: false, error: "invalid_payload" });
        }
      } else {
        payload = raw as typeof payload;
      }
    }

    try {
      posting.post({
        poster: { kind: "webhook", app: found.app, webhookId: found.webhook.id },
        channelId: found.webhook.channelId,
        text: payloadToText(payload),
        threadRootId: null,
        nonce: null,
        fileIds: [],
        actions: blocksToActions(payload.blocks),
      });
    } catch (err) {
      const refused = slackRefusal(err);
      return reply.status(refused.status).send({ ok: false, error: refused.error });
    }
    // Slack replies with the literal string "ok"; tools check for it.
    return reply.type("text/plain").send("ok");
  });

  // ---------- Slack Web API methods ----------

  /**
   * A failed Slack Web API call, answered the way Slack answers one: HTTP 200
   * with `ok: false`. Slack's own SDK treats every status other than 200 and
   * 429 as a transport failure and never reads the body, so a 4xx here reaches
   * a bot as a generic HTTP error instead of the `channel_not_found` it checks
   * for. Rate limiting keeps its 429, which the SDK does understand.
   */
  const slackError = (error: string) => ({ ok: false as const, error });

  /** Slack's refusal for a method this token's scopes do not reach, naming what would. */
  const missingScope = (owner: App, needed: AppScope) => ({
    ok: false as const,
    error: "missing_scope",
    needed,
    provided: (owner.scopes ?? []).join(","),
  });

  /**
   * A structured argument. Slack's SDK sends every call form-encoded, with
   * anything that is not a plain value JSON-encoded into a string, so `blocks`
   * and `view` arrive as text from the most common client of all. Read as-is,
   * a message silently lost its buttons and no modal could be opened.
   */
  const structured = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  };

  route(endpoints.authTest, async ({ req, bot: owner }) => {
    const bot = store.people.get(owner.botUserId)!;
    return {
      ok: true,
      url: `${requestOrigin(req)}/`,
      team: workspaceName(),
      user: bot.handle,
      team_id: store.settings.get("workspaceId"),
      user_id: bot.id,
      bot_id: owner.id,
      is_enterprise_install: false,
    };
  });

  route(endpoints.chatPostMessage, async ({ req, reply, bot: owner }) => {
    reply.header("x-accepted-oauth-scopes", "chat:write");
    const body = (req.body ?? {}) as {
      channel?: unknown;
      text?: unknown;
      blocks?: unknown;
      thread_ts?: unknown;
    };
    // Slack accepts an id or a #name; so do we.
    const named = typeof body.channel === "string" ? body.channel : "";
    const channel = named
      ? (store.channels.get(named) ?? store.channels.byName(named.replace(/^#/, "")))
      : null;

    let threadRootId: ID | null = null;
    if (channel && typeof body.thread_ts === "string" && body.thread_ts) {
      const root = store.messages.get(body.thread_ts);
      // An unknown thread parent is not worth failing the whole send over.
      if (root && root.channelId === channel.id && !root.threadRootId) threadRootId = root.id;
    }

    const blocks = structured(body.blocks);
    try {
      const message = posting.post({
        poster: { kind: "bot", app: owner },
        channelId: channel?.id ?? named,
        text: payloadToText({ text: body.text, blocks }),
        threadRootId,
        nonce: null,
        fileIds: [],
        actions: blocksToActions(blocks),
      });
      // `ts` is Slack's message identifier; ours is the message id.
      return { ok: true, channel: message.channelId, ts: message.id, message };
    } catch (err) {
      const { error, needed } = slackRefusal(err);
      if (error === "missing_scope" && needed) return missingScope(owner, needed);
      return needed ? { ...slackError(error), needed } : slackError(error);
    }
  });

  // ---------- slash commands ----------

  /**
   * Where a command's delayed replies go. Slack gives an app 30 minutes and
   * five uses of a `response_url`; so do we. Purely in memory — a reply that
   * outlives a restart is not worth a table.
   */
  interface ResponseTarget {
    channelId: ID;
    invokerId: ID;
    botUserId: ID;
    threadRootId: ID | null;
    /**
     * The message whose button was pressed, when there was one. A later reply
     * may rewrite or remove it just as an immediate answer can: Bolt always
     * acknowledges a press at once with an empty body and rewrites the message
     * afterwards through this url, so honouring `replace_original` only in the
     * immediate answer turned "Approve" into a second message instead.
     */
    originMessageId?: ID;
    /** The version pressed: a delayed reply cannot replace a subsequent edit. */
    originRevision?: { value: string };
    expiresAt: number;
    usesLeft: number;
  }
  const responseTargets = new CapabilityMap<ResponseTarget>(CAPABILITIES_ALIVE.responseUrls);
  const messageRevision = (message: Message): string =>
    hashToken(JSON.stringify([message.text, message.editedAt, message.actions]));

  const newResponseUrl = (
    target: Omit<ResponseTarget, "expiresAt" | "usesLeft">,
    origin: string,
  ): string => {
    const now = Date.now();
    const token = secretToken();
    responseTargets.set(token, { ...target, expiresAt: now + 30 * 60_000, usesLeft: 5 }, now);
    return `${origin}/api/commands/response/${token}`;
  };

  /**
   * Whether a capability handed to an app is still good at the moment it is
   * being spent.
   *
   * A `response_url` lives half an hour, a `trigger_id` three minutes, and
   * even an ordinary reply arrives only after the app's own endpoint has
   * answered. In any of those gaps the app can be deleted or its bot
   * deactivated, the bot can be removed from the channel, the channel can be
   * archived or deleted, and the person being answered can be deactivated or
   * lose access. Checking only when the capability was handed out would make
   * every one of those revocations avoidable by waiting, so it is all checked
   * again here, where the reply would actually be posted.
   */
  const capabilityHolds = (target: { channelId: ID; botUserId: ID; invokerId: ID }): boolean => {
    const bot = store.people.get(target.botUserId);
    if (!bot || bot.deactivated) return false;
    if (!store.appForBotUser(target.botUserId)) return false;
    const channel = store.channels.get(target.channelId);
    if (!channel || channel.archived) return false;
    if (!store.canAccess(channel.id, bot.id)) return false;
    const invoker = store.people.get(target.invokerId);
    if (!invoker || invoker.deactivated) return false;
    return store.canAccess(channel.id, invoker.id);
  };

  /** Why a call to an app came to nothing, in words for the person who made it. */
  const whyAppCallFailed = (err: unknown): string => {
    if (err instanceof HttpError) {
      const reason = err.message.replace(/\.$/, "");
      return `its answer could not be posted: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`;
    }
    return err instanceof OutboundError && err.code === "blocked_host"
      ? err.message
      : "the app did not answer";
  };

  /** A private note back to the person who ran the command. */
  const sayEphemeral = (channelId: ID, toUserId: ID, fromUserId: ID, text: string): void => {
    gateway.tellPerson(toUserId, {
      type: "ephemeral.message",
      channelId,
      id: ulid(),
      userId: fromUserId,
      text,
      createdAt: Date.now(),
    });
  };

  /**
   * Turns whatever an app answered with into a message. `in_channel` posts for
   * everyone as the bot; anything else stays private to the person who typed
   * the command, which is Slack's default and the safer one. An answer that
   * may not be posted throws its refusal, for the caller to answer in its
   * own shape.
   */
  const deliverCommandReply = (
    target: Omit<ResponseTarget, "expiresAt" | "usesLeft">,
    raw: string,
    contentType: string,
    /** The message a button lives on, which the app may ask to replace. */
    originMessageId?: ID,
  ): void => {
    const trimmed = raw.trim();
    if (!trimmed) return; // an empty 200 is a silent acknowledgement
    // The app had its seconds to answer; a lot can be revoked in them.
    if (!capabilityHolds(target)) return;

    let payload: {
      text?: unknown;
      blocks?: unknown;
      response_type?: unknown;
      replace_original?: unknown;
      delete_original?: unknown;
    } = {};
    if (contentType.includes("json") || trimmed.startsWith("{")) {
      try {
        payload = JSON.parse(trimmed) as typeof payload;
      } catch {
        payload = { text: trimmed };
      }
    } else {
      payload = { text: trimmed };
    }

    // Slack lets a button's handler rewrite the message it sits on, which is
    // how "Approve" becomes "Approved by @alice" with the buttons gone.
    if (
      originMessageId &&
      (payload.replace_original === true || payload.delete_original === true)
    ) {
      const existing = store.messages.get(originMessageId);
      // Replacement/deletion is a no-op when the origin disappeared or
      // changed while the app answered. Never reinterpret it as a new post.
      if (
        !existing ||
        (target.originRevision && target.originRevision.value !== messageRevision(existing))
      )
        return;
      if (payload.delete_original === true) {
        removeMessage(existing);
        void flushFileDeletions();
        return;
      }
      const replacement = payloadToText(payload);
      if (replacement) {
        requireMessageText(replacement);
        const updated = updateMessage(existing, replacement, true);
        // An app may use this response URL again to update its own result;
        // only intervening changes from another operation invalidate it.
        if (target.originRevision) target.originRevision.value = messageRevision(updated);
      }
      return;
    }

    const text = payloadToText(payload);
    if (!text) return;

    if (payload.response_type === "in_channel") {
      posting.post({
        poster: { kind: "appReply", botUserId: target.botUserId },
        channelId: target.channelId,
        text,
        threadRootId: target.threadRootId,
        nonce: null,
        fileIds: [],
        actions: blocksToActions(payload.blocks),
      });
    } else {
      sayEphemeral(target.channelId, target.invokerId, target.botUserId, text);
    }
  };

  route(endpoints.createCommand, async ({ user: me, body, params }) => {
    const owner = store.getApp(params.id);
    if (!owner) throw new HttpError(404, "not_found");
    if (BUILTIN_COMMANDS.has(body.command) || store.slashCommandByName(body.command)) {
      throw new HttpError(409, "command_taken", `/${body.command} is already in use`);
    }
    const command = store.transaction(() => {
      const created = store.createSlashCommand({
        appId: owner.id,
        command: body.command,
        url: body.url,
        description: body.description ?? "",
        usageHint: body.usageHint ?? "",
      });
      store.recordAudit({
        actorId: me.id,
        action: "command.created",
        targetType: "command",
        targetId: created.id,
        details: {
          appId: owner.id,
          name: owner.name,
          command: `/${body.command}`,
          host: hostOf(body.url),
        },
      });
      return created;
    });
    return { command };
  });

  route(endpoints.deleteCommand, async ({ user: me, params }) => {
    const deleted = store.transaction(() => {
      const command = store.getSlashCommand(params.id);
      if (!command || !store.deleteSlashCommand(command.id)) return false;
      store.recordAudit({
        actorId: me.id,
        action: "command.deleted",
        targetType: "command",
        targetId: command.id,
        details: {
          appId: command.appId,
          name: store.getApp(command.appId)?.name ?? null,
          command: `/${command.command}`,
        },
      });
      return true;
    });
    if (!deleted) throw new HttpError(404, "not_found");
    return { ok: true };
  });

  route(endpoints.listCommands, async () => {
    const builtins = [...BUILTIN_COMMANDS.entries()].map(([command, b]) => ({
      command,
      description: b.description,
      usageHint: b.usageHint,
      builtin: true,
    }));
    const fromApps = store.listAllSlashCommands().map((c) => ({
      command: c.command,
      description: c.description,
      usageHint: c.usageHint,
      builtin: false,
    }));
    return { commands: [...builtins, ...fromApps] };
  });

  route(endpoints.runCommand, async ({ req, user: me, body, params }) => {
    const channel = requireChannelAccess(params.id, me);
    if (channel.archived) throw new HttpError(400, "channel_archived");
    const threadRootId = body.threadRootId ?? null;

    const parsed = /^\/([a-zA-Z0-9_-]+)\s*([\s\S]*)$/.exec(body.text.trim());
    if (!parsed) throw new HttpError(400, "not_a_command");
    const name = parsed[1]!.toLowerCase();
    const argText = parsed[2]!.trim();

    const builtin = BUILTIN_COMMANDS.get(name);
    if (builtin) {
      if (builtin.inApp) throw new HttpError(400, "in_app_command", builtin.inApp);
      const text = builtin.run(argText, me);
      if (text === null)
        throw new HttpError(400, "usage", `Use it like this: /${name} ${builtin.usageHint}`);
      posting.post({
        poster: { kind: "person", userId: me.id },
        channelId: channel.id,
        text,
        threadRootId,
        nonce: null,
        fileIds: [],
      });
      return { ok: true };
    }

    const found = store.slashCommandByName(name);
    if (!found) throw new HttpError(404, "unknown_command", `/${name} is not a command here`);

    const release = admitAppCall(me.id, found.app.id);
    try {
      // The bot has to be in the channel to answer in it.
      mutate((emit) => {
        if (store.channels.addMember(channel.id, found.app.botUserId)) {
          emit({ type: "member.joined", channelId: channel.id, userId: found.app.botUserId });
        }
      });

      const target = {
        channelId: channel.id,
        invokerId: me.id,
        botUserId: found.app.botUserId,
        threadRootId,
      };
      const form = new URLSearchParams({
        command: `/${name}`,
        text: argText,
        team_id: store.settings.get("workspaceId"),
        team_domain: workspaceName(),
        channel_id: channel.id,
        channel_name: channel.name,
        user_id: me.id,
        user_name: me.handle,
        api_app_id: found.app.id,
        response_url: newResponseUrl(target, requestOrigin(req)),
        trigger_id: newTrigger({
          userId: me.id,
          channelId: channel.id,
          appId: found.app.id,
          botUserId: found.app.botUserId,
        }),
      }).toString();

      try {
        const res = await postToApp(found.command.url, form, "application/x-www-form-urlencoded", {
          allowPrivate: opts.allowPrivateHooks,
          signal: lifecycle.signal,
          headers: signatureHeaders(store.appSigningSecret(found.app.id) ?? "", form),
        });
        // Why it failed goes in the answer as well as to the channel: a test
        // from Apps and integrations is drawn over the conversation the note
        // lands in. Older clients read only `ok` and `error`.
        if (res.status < 200 || res.status >= 300) {
          const why = `the app answered ${res.status}`;
          sayEphemeral(channel.id, me.id, found.app.botUserId, `\`/${name}\` failed: ${why}.`);
          return { ok: false, error: "command_failed", message: why };
        }
        deliverCommandReply(target, res.body, res.contentType);
        return { ok: true };
      } catch (err) {
        const why = whyAppCallFailed(err);
        sayEphemeral(channel.id, me.id, found.app.botUserId, `\`/${name}\` failed: ${why}.`);
        return { ok: false, error: "command_failed", message: why };
      }
    } finally {
      release();
    }
  });

  route(endpoints.commandResponse, async ({ req, reply, params }) => {
    const target = responseTargets.get(params.token);
    if (!target || target.expiresAt < Date.now() || !capabilityHolds(target)) {
      // A url whose app, channel or audience has gone is spent, not merely
      // unusable this once: keeping it would only invite the same call again.
      responseTargets.delete(params.token);
      return reply.status(404).send({ ok: false, error: "expired_url" });
    }
    if (--target.usesLeft <= 0) responseTargets.delete(params.token);

    const raw = req.body;
    const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
    try {
      deliverCommandReply(target, text, "application/json", target.originMessageId);
    } catch (err) {
      const refused = slackRefusal(err);
      return reply.status(refused.status).send({ ok: false, error: refused.error });
    }
    return { ok: true };
  });

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

  // ---------- interactive buttons and modals ----------

  /**
   * A `trigger_id` is permission to open one modal, on behalf of one person,
   * for a short while. Slack gives an app three seconds to use it; three
   * minutes is friendlier to a self-hosted app on a cold start and still short
   * enough that a leaked id is worthless. In memory, like a response_url.
   */
  interface Trigger {
    userId: ID;
    channelId: ID;
    appId: ID;
    botUserId: ID;
    expiresAt: number;
  }
  const triggers = new CapabilityMap<Trigger>(CAPABILITIES_ALIVE.triggers);

  const newTrigger = (trigger: Omit<Trigger, "expiresAt">): string => {
    const now = Date.now();
    const id = ulid();
    triggers.set(id, { ...trigger, expiresAt: now + 3 * 60_000 }, now);
    return id;
  };

  /** An open modal, waiting for the person it was shown to. */
  interface OpenView {
    view: ModalView;
    userId: ID;
    channelId: ID;
    appId: ID;
    botUserId: ID;
    /** The app's own name for it, unique among its open views; empty when it gave none. */
    externalId: string;
    expiresAt: number;
  }
  const openViews = new CapabilityMap<OpenView>(CAPABILITIES_ALIVE.openViews);
  const submittingViews = new Set<ID>();
  const VIEW_LIFE = 30 * 60_000;

  /**
   * The forms each person has open, bottom first: the one an app opened and
   * any pushed on it, at most three as on Slack. One stack a person, since a
   * client shows one form at a time: opening a new one closes the old stack.
   */
  const viewStacks = new Map<ID, ID[]>();
  const MAX_STACK = 3;

  /** A person's stack, without any view that expired or was let go. */
  const stackOf = (userId: ID): ID[] => {
    const ids = (viewStacks.get(userId) ?? []).filter((id) => openViews.get(id));
    if (ids.length > 0) viewStacks.set(userId, ids);
    else viewStacks.delete(userId);
    return ids;
  };

  /**
   * Tells the person's devices what they have open now: the whole stack, with
   * the form to show on top, or which forms closed when none is left.
   */
  const showStack = (userId: ID, closed: ID[] = []): void => {
    const ids = stackOf(userId);
    if (ids.length > 0) {
      const stack = ids.map((id) => openViews.get(id)!.view);
      gateway.tellPerson(userId, { type: "view.open", view: stack.at(-1)!, stack });
    } else if (closed.length > 0) {
      gateway.tellPerson(userId, { type: "view.close", viewIds: closed });
    }
  };

  /** Closes a view and everything stacked on it; returns what closed. */
  const closeFrom = (userId: ID, viewId: ID): ID[] => {
    const ids = stackOf(userId);
    const at = ids.indexOf(viewId);
    if (at < 0) return [];
    const closed = ids.slice(at);
    for (const id of closed) openViews.delete(id);
    if (at === 0) viewStacks.delete(userId);
    else viewStacks.set(userId, ids.slice(0, at));
    return closed;
  };

  const closeStack = (userId: ID): ID[] => {
    const root = stackOf(userId)[0];
    return root ? closeFrom(userId, root) : [];
  };

  /**
   * Keeps or puts a view in the map with a fresh half hour, and with it the
   * rest of its stack: an app still changing a form is a form still in use,
   * and the one under it must not expire while the person is on top.
   */
  const keepOpen = (open: Omit<OpenView, "expiresAt">): void => {
    const now = Date.now();
    for (const id of stackOf(open.userId)) {
      const other = openViews.get(id, now);
      if (other && id !== open.view.id)
        openViews.set(id, { ...other, expiresAt: now + VIEW_LIFE }, now);
    }
    openViews.set(open.view.id, { ...open, expiresAt: now + VIEW_LIFE }, now);
  };

  /** One of this app's open views by the name it gave it. */
  const viewByExternalId = (appId: ID, externalId: string): OpenView | undefined => {
    for (const userId of [...viewStacks.keys()]) {
      for (const id of stackOf(userId)) {
        const open = openViews.get(id);
        if (open?.appId === appId && open.externalId === externalId) return open;
      }
    }
    return undefined;
  };

  /**
   * An app's view object read for showing, or Slack's name for why it cannot
   * be: every input it held was a kind this server cannot draw (a form that
   * silently lost its questions is worse than none), or there is nothing in
   * it at all. A view of text alone is fine: an app shows "Loading" that way
   * before it updates the view with the real form, or "Done" after one.
   */
  const readView = (
    raw: unknown,
    id: ID,
    channelId: ID,
  ): { view: ModalView; externalId: string } | { error: string } => {
    const { droppedFields, wordless, ...parsed } = parseView(raw, id, { channelId });
    if (parsed.fields.length === 0 && (droppedFields > 0 || wordless)) {
      return { error: droppedFields > 0 ? "unsupported_elements" : "no_inputs" };
    }
    const named = (raw as { external_id?: unknown } | null)?.external_id;
    return {
      view: { ...parsed, hash: ulid() },
      externalId: typeof named === "string" ? named.slice(0, 255) : "",
    };
  };

  /** The view as Slack's methods answer with it, so an app can keep its id and hash. */
  const describeView = (open: OpenView) => {
    const ids = stackOf(open.userId);
    const at = ids.indexOf(open.view.id);
    return {
      id: open.view.id,
      type: "modal",
      callback_id: open.view.callbackId,
      external_id: open.externalId,
      hash: open.view.hash,
      private_metadata: open.view.privateMetadata,
      root_view_id: ids[0] ?? open.view.id,
      previous_view_id: at > 0 ? ids[at - 1]! : null,
    };
  };

  /**
   * Spends a trigger_id for this app, or names why it cannot be. The trigger
   * decides who sees the view, so an app cannot open a modal in front of
   * someone who did not just ask for one.
   */
  const spendTrigger = (owner: { id: ID }, triggerId: unknown): Trigger | { error: string } => {
    const trigger = typeof triggerId === "string" ? triggers.get(triggerId) : undefined;
    if (!trigger || trigger.expiresAt < Date.now()) {
      if (typeof triggerId === "string") triggers.delete(triggerId);
      return { error: "expired_trigger_id" };
    }
    // The trigger belongs to whoever it was issued for, and to that app alone.
    if (trigger.appId !== owner.id) return { error: "trigger_not_yours" };
    triggers.delete(triggerId as string);
    if (!capabilityHolds({ ...trigger, invokerId: trigger.userId })) {
      return { error: "expired_trigger_id" };
    }
    return trigger;
  };

  /**
   * Shows a new view to the person a trigger was issued for: pushed on the
   * stack they have open from this app, or as the first of a new stack,
   * which closes whatever they had open before.
   */
  const placeView = (
    owner: { id: ID; botUserId: ID },
    trigger: Trigger,
    raw: unknown,
    push: boolean,
  ) => {
    const ids = stackOf(trigger.userId);
    const top = ids.length > 0 ? openViews.get(ids.at(-1)!) : undefined;
    const stacking = push && top?.appId === owner.id;
    if (stacking && ids.length >= MAX_STACK) return slackError("push_limit_reached");
    const read = readView(raw, ulid(), trigger.channelId);
    if ("error" in read) return slackError(read.error);
    if (read.externalId && viewByExternalId(owner.id, read.externalId)) {
      return slackError("duplicate_external_id");
    }
    if (!stacking) closeStack(trigger.userId);
    keepOpen({
      view: read.view,
      userId: trigger.userId,
      channelId: trigger.channelId,
      appId: owner.id,
      botUserId: owner.botUserId,
      externalId: read.externalId,
    });
    viewStacks.set(trigger.userId, [...(stacking ? ids : []), read.view.id]);
    showStack(trigger.userId);
    return { ok: true, view: describeView(openViews.get(read.view.id)!) };
  };

  route(endpoints.viewsOpen, async ({ req, bot: owner }) => {
    const body = (req.body ?? {}) as { trigger_id?: unknown; view?: unknown };
    const trigger = spendTrigger(owner, body.trigger_id);
    if ("error" in trigger) return slackError(trigger.error);
    return placeView(owner, trigger, structured(body.view), false);
  });

  route(endpoints.viewsPush, async ({ req, bot: owner }) => {
    const body = (req.body ?? {}) as { trigger_id?: unknown; view?: unknown };
    const trigger = spendTrigger(owner, body.trigger_id);
    if ("error" in trigger) return slackError(trigger.error);
    return placeView(owner, trigger, structured(body.view), true);
  });

  route(endpoints.viewsUpdate, async ({ req, bot: owner }) => {
    // An app updating in a loop pushes a form at someone with every call.
    ration("post", owner.botUserId);
    const body = (req.body ?? {}) as {
      view_id?: unknown;
      external_id?: unknown;
      hash?: unknown;
      view?: unknown;
    };
    const found =
      typeof body.view_id === "string" && body.view_id
        ? openViews.get(body.view_id)
        : typeof body.external_id === "string" && body.external_id
          ? viewByExternalId(owner.id, body.external_id)
          : undefined;
    // Another app's view is answered as no view at all.
    if (!found || found.appId !== owner.id || !stackOf(found.userId).includes(found.view.id)) {
      return slackError("not_found");
    }
    if (!capabilityHolds({ ...found, invokerId: found.userId })) {
      showStack(found.userId, closeStack(found.userId));
      return slackError("not_found");
    }
    if (typeof body.hash === "string" && body.hash && body.hash !== found.view.hash) {
      return slackError("hash_conflict");
    }
    const raw = structured(body.view);
    const read = readView(raw, found.view.id, found.channelId);
    if ("error" in read) return slackError(read.error);
    // An update that names the view keeps or changes its name; one that does not keeps it.
    const externalId = read.externalId || found.externalId;
    const named = externalId ? viewByExternalId(owner.id, externalId) : undefined;
    if (named && named.view.id !== found.view.id) return slackError("duplicate_external_id");
    keepOpen({ ...found, view: read.view, externalId });
    showStack(found.userId);
    return { ok: true, view: describeView(openViews.get(found.view.id)!) };
  });

  route(endpoints.closeView, async ({ user: me, params }) => {
    const closed = closeFrom(me.id, params.id);
    if (closed.length > 0) showStack(me.id, closed);
    return { ok: true };
  });

  route(endpoints.submitView, async ({ user: me, body, params }) => {
    const open = openViews.get(params.id);
    // A view belongs to the one person it was opened for.
    if (!open || open.userId !== me.id || open.expiresAt < Date.now()) {
      // A request from another account must not consume the owner's view.
      if (!open || open.expiresAt < Date.now()) openViews.delete(params.id);
      throw new HttpError(404, "view_not_found");
    }
    // Only the form on top is in front of the person; one under it waits
    // until they come back to it.
    if (stackOf(me.id).at(-1) !== open.view.id) throw new HttpError(404, "view_not_found");
    // A view of text alone, such as "Loading", has nothing to submit.
    if (!open.view.submitLabel) throw new HttpError(400, "view_has_no_submit");
    const owner = store.getApp(open.appId);
    if (!owner?.interactivityUrl) {
      showStack(me.id, closeStack(me.id));
      throw new HttpError(400, "no_interactivity_url");
    }
    // A form can sit open for half an hour before anyone presses submit.
    if (!capabilityHolds({ ...open, invokerId: open.userId })) {
      showStack(me.id, closeStack(me.id));
      throw new HttpError(404, "view_not_found");
    }

    // Only the fields the app actually asked for, in Slack's nested shape.
    const values: Record<string, Record<string, unknown>> = {};
    const missing: Record<string, string> = {};
    const answering: AnswerContext = {
      isPerson: (id) => {
        const person = store.people.get(id);
        return !!person && !person.deactivated;
      },
      conversationType: (id) => {
        const channel = store.channels.get(id);
        return channel && !channel.archived && store.canAccess(id, me.id) ? channel.type : null;
      },
    };
    for (const field of open.view.fields) {
      const answer = readAnswer(field, body.values[field.blockId]?.[field.actionId], answering);
      if ("error" in answer) {
        missing[field.blockId] = answer.error;
        continue;
      }
      values[field.blockId] = { ...values[field.blockId], [field.actionId]: answer.state };
    }
    // Required fields are checked here as well as in the browser: the app
    // should never have to defend against a submission the form itself forbids.
    if (Object.keys(missing).length > 0) return { ok: false, errors: missing };

    if (submittingViews.has(open.view.id))
      throw new HttpError(
        409,
        "view_submitting",
        "This form is already being submitted. Wait for its answer before trying again.",
      );
    const release = admitAppCall(me.id, owner.id);
    submittingViews.add(open.view.id);
    try {
      const payload = JSON.stringify({
        type: "view_submission",
        team: { id: store.settings.get("workspaceId"), domain: workspaceName() },
        user: { id: me.id, username: me.handle, name: me.displayName },
        api_app_id: owner.id,
        trigger_id: newTrigger({
          userId: me.id,
          channelId: open.channelId,
          appId: owner.id,
          botUserId: owner.botUserId,
        }),
        view: {
          ...describeView(open),
          title: { type: "plain_text", text: open.view.title },
          state: { values },
        },
      });
      const form = new URLSearchParams({ payload }).toString();

      try {
        const res = await postToApp(
          owner.interactivityUrl,
          form,
          "application/x-www-form-urlencoded",
          {
            allowPrivate: opts.allowPrivateHooks,
            signal: lifecycle.signal,
            headers: signatureHeaders(store.appSigningSecret(owner.id) ?? "", form),
          },
        );
        if (res.status < 200 || res.status >= 300) {
          return { ok: false, errors: {}, message: `The app answered ${res.status}.` };
        }
        const answered = res.body.trim();
        let parsed: { response_action?: unknown; errors?: Record<string, string>; view?: unknown } =
          {};
        if (answered.startsWith("{")) {
          try {
            parsed = JSON.parse(answered) as typeof parsed;
          } catch {
            // The app did answer, so saying it did not would send someone
            // looking for a network problem that is not there.
            return {
              ok: false,
              errors: {},
              message: "The app answered with something that could not be read.",
            };
          }
          // Slack's shape for "your answers are not acceptable, here is why".
          if (parsed.response_action === "errors" && parsed.errors) {
            return { ok: false, errors: parsed.errors };
          }
        }
        // Accepted. The app may change this form or stack another on it,
        // provided the person has not closed it while the app was deciding.
        const still = stackOf(me.id).includes(open.view.id) ? openViews.get(open.view.id) : null;
        const action = parsed.response_action;
        if (still && (action === "update" || action === "push")) {
          const pushing = action === "push";
          if (pushing && stackOf(me.id).length >= MAX_STACK) {
            return {
              ok: false,
              errors: {},
              message: "The app tried to open more forms on top of this one than can be open.",
            };
          }
          const read = readView(
            structured(parsed.view),
            pushing ? ulid() : open.view.id,
            open.channelId,
          );
          const named =
            "error" in read || !read.externalId
              ? undefined
              : viewByExternalId(owner.id, read.externalId);
          if ("error" in read || (named && named.view.id !== read.view.id)) {
            return {
              ok: false,
              errors: {},
              message: "The app answered with a form that cannot be shown.",
            };
          }
          if (pushing) {
            keepOpen({ ...still, view: read.view, externalId: read.externalId });
            viewStacks.set(me.id, [...stackOf(me.id), read.view.id]);
          } else {
            keepOpen({
              ...still,
              view: read.view,
              externalId: read.externalId || still.externalId,
            });
          }
          showStack(me.id);
          return { ok: true, closedViewIds: [] };
        }
        // Anything else closes this form, and "clear" every form under it too.
        const closed = action === "clear" ? closeStack(me.id) : closeFrom(me.id, open.view.id);
        showStack(me.id, closed);
        return { ok: true, closedViewIds: closed.length > 0 ? closed : [open.view.id] };
      } catch (err) {
        const why = whyAppCallFailed(err);
        return { ok: false, errors: {}, message: `That did not go through: ${why}.` };
      }
    } finally {
      submittingViews.delete(open.view.id);
      release();
    }
  });

  /**
   * Slack's url_verification handshake, worth keeping for more than
   * compatibility: an endpoint that cannot echo the challenge has not agreed to
   * receive anything, so this is also what stops the server being aimed at an
   * unrelated host as a way of flooding it.
   */
  const verifyCallbackUrl = async (url: string, appId: ID): Promise<void> => {
    const challenge = secretToken();
    const probe = JSON.stringify({ type: "url_verification", token: "", challenge });
    let answered: string;
    try {
      const res = await postToApp(url, probe, "application/json", {
        allowPrivate: opts.allowPrivateHooks,
        signal: lifecycle.signal,
        headers: signatureHeaders(store.appSigningSecret(appId) ?? "", probe),
      });
      answered = res.body.trim();
      if (answered.startsWith("{")) {
        answered = String((JSON.parse(answered) as { challenge?: unknown }).challenge ?? "");
      }
    } catch (err) {
      throw new HttpError(
        400,
        err instanceof OutboundError ? err.code : "unreachable",
        (err as Error).message,
      );
    }
    if (answered !== challenge) {
      throw new HttpError(
        400,
        "challenge_failed",
        "The URL did not answer the url_verification check with the challenge it was sent.",
      );
    }
  };

  route(endpoints.setInteractivityUrl, async ({ req, body, params }) => {
    const owner = store.getApp(params.id);
    if (!owner) throw new HttpError(404, "not_found");

    const record = (url: string) =>
      store.transaction(() => {
        // Verification waited on another server; access and the app may have
        // changed while this request was away from the event loop.
        const me = requireUser(req);
        const current = store.getApp(owner.id);
        if (!current) throw new HttpError(404, "not_found");
        store.setInteractivityUrl(current.id, url);
        store.recordAudit({
          actorId: me.id,
          action: "app.interactivity_url_changed",
          targetType: "app",
          targetId: current.id,
          details: url
            ? { name: current.name, host: hostOf(url) }
            : { name: current.name, cleared: true },
        });
        return store.getApp(current.id)!;
      });
    if (!body.url) {
      return { app: record("") };
    }
    await verifyCallbackUrl(body.url, owner.id);
    return { app: record(body.url) };
  });

  route(endpoints.runMessageAction, async ({ req, user: me, body, params }) => {
    const message = store.messages.get(params.id);
    if (!message) throw new HttpError(404, "message_not_found");
    const channel = requireChannelAccess(message.channelId, me);
    if (channel.archived) throw new HttpError(400, "channel_archived");

    const action = message.actions.find((a) => a.actionId === body.actionId);
    // A stale button — the message was edited or its buttons cleared — is a
    // 404 rather than a silent success, so the UI can say so.
    if (!action) throw new HttpError(404, "action_not_found");
    // A link button is handled entirely in the client; nothing to call.
    if (action.url) throw new HttpError(400, "link_action");

    const owner = store.appForBotUser(message.userId);
    if (!owner) throw new HttpError(400, "not_an_app_message");
    if (!owner.interactivityUrl) throw new HttpError(400, "no_interactivity_url");

    const release = admitAppCall(me.id, owner.id);
    try {
      const target = {
        channelId: channel.id,
        invokerId: me.id,
        botUserId: owner.botUserId,
        threadRootId: message.threadRootId,
        originRevision: { value: messageRevision(message) },
      };
      const responseUrl = newResponseUrl(
        { ...target, originMessageId: message.id },
        requestOrigin(req),
      );
      const payload = JSON.stringify({
        type: "block_actions",
        // Slack sends this as a form field named payload; so do we below.
        team: { id: store.settings.get("workspaceId"), domain: workspaceName() },
        user: { id: me.id, username: me.handle, name: me.displayName },
        api_app_id: owner.id,
        channel: { id: channel.id, name: channel.name },
        message: { ts: message.id, text: message.text, user: message.userId },
        container: { type: "message", message_ts: message.id, channel_id: channel.id },
        trigger_id: newTrigger({
          userId: me.id,
          channelId: channel.id,
          appId: owner.id,
          botUserId: owner.botUserId,
        }),
        response_url: responseUrl,
        actions: [
          {
            type: "button",
            action_id: action.actionId,
            block_id: action.blockId,
            text: { type: "plain_text", text: action.text },
            value: action.value,
            style: action.style === "default" ? undefined : action.style,
            action_ts: String(Date.now() / 1000),
          },
        ],
      });
      const form = new URLSearchParams({ payload }).toString();

      try {
        const res = await postToApp(
          owner.interactivityUrl,
          form,
          "application/x-www-form-urlencoded",
          {
            allowPrivate: opts.allowPrivateHooks,
            signal: lifecycle.signal,
            headers: signatureHeaders(store.appSigningSecret(owner.id) ?? "", form),
          },
        );
        if (res.status < 200 || res.status >= 300) {
          sayEphemeral(
            channel.id,
            me.id,
            owner.botUserId,
            `That button failed: the app answered ${res.status}.`,
          );
          return { ok: false, error: "action_failed" };
        }
        deliverCommandReply(target, res.body, res.contentType, message.id);
        return { ok: true };
      } catch (err) {
        const why = whyAppCallFailed(err);
        sayEphemeral(channel.id, me.id, owner.botUserId, `That button failed: ${why}.`);
        return { ok: false, error: "action_failed" };
      }
    } finally {
      release();
    }
  });

  // ---------- outgoing event subscriptions ----------

  route(endpoints.createSubscription, async ({ req, body, params }) => {
    const owner = store.getApp(params.id);
    if (!owner) throw new HttpError(404, "not_found");

    await verifyCallbackUrl(body.url, owner.id);

    const subscription = store.transaction(() => {
      const me = requireUser(req);
      const current = store.getApp(owner.id);
      if (!current) throw new HttpError(404, "not_found");
      const created = store.createSubscription({
        appId: current.id,
        url: body.url,
        eventTypes: body.eventTypes ?? [],
      });
      store.recordAudit({
        actorId: me.id,
        action: "subscription.created",
        targetType: "subscription",
        targetId: created.id,
        details: { appId: current.id, name: current.name, host: hostOf(body.url) },
      });
      return created;
    });
    return { subscription };
  });

  route(endpoints.deleteSubscription, async ({ user: me, params }) => {
    const deleted = store.transaction(() => {
      const subscription = store.getSubscription(params.id);
      if (!subscription || !store.deleteSubscription(subscription.id)) return false;
      store.recordAudit({
        actorId: me.id,
        action: "subscription.deleted",
        targetType: "subscription",
        targetId: subscription.id,
        details: {
          appId: subscription.appId,
          name: store.getApp(subscription.appId)?.name ?? null,
          host: hostOf(subscription.url),
        },
      });
      return true;
    });
    if (!deleted) throw new HttpError(404, "not_found");
    return { ok: true };
  });

  route(endpoints.retrySubscription, async ({ user: me, params }) => {
    const subscription = store.getSubscription(params.id);
    if (!subscription) throw new HttpError(404, "not_found");
    const { retried, waiting } = store.transaction(() => {
      const result = store.retryFailedEventDeliveries(subscription.id);
      store.recordAudit({
        actorId: me.id,
        action: "subscription.retried",
        targetType: "subscription",
        targetId: subscription.id,
        details: {
          appId: subscription.appId,
          name: store.getApp(subscription.appId)?.name ?? null,
          retried: result.retried,
          waiting: result.waiting,
        },
      });
      return result;
    });
    inBackground("event deliveries", flushEventDeliveries);
    return { ok: true, retried, waiting };
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

  /** A member made by an extension, such as single sign-on's first sign-in (P9). */
  const createMember = async (input: { handle: string; displayName: string }) => {
    // Nobody knows it: the account signs in the extension's way.
    const credentials = await hashPassword(secretToken());
    return mutate((emit) => {
      if (store.people.count() === 0)
        throw new HttpError(409, "workspace_unclaimed", "The workspace has no owner yet.");
      if (store.people.authByHandle(input.handle)) throw new HttpError(409, "handle_taken");
      const user = store.people.create({
        handle: input.handle,
        displayName: input.displayName,
        passwordHash: credentials.hash,
        salt: credentials.salt,
        role: "member",
      });
      emit({ type: "user.joined", user });
      joinPublicChannels(user.id, emit);
      return user;
    });
  };

  for (const extension of extensions) {
    const prefix = `extension:${extension.name}:`;
    await extension.register?.({
      route,
      memberCount: () => planMembers(store.people.list()),
      log: app.log.child({ extension: extension.name }),
      storage: {
        get: (key) => store.getMeta(prefix + key),
        set: (key, value) => store.setMeta(prefix + key, value),
        delete: (key) => store.deleteMeta(prefix + key),
        list: (start) =>
          store
            .listMeta(prefix + start)
            .map(({ key, value }) => ({ key: key.slice(prefix.length), value })),
      },
      users: {
        get: (id) => store.people.get(id),
        byHandle: (handle) => {
          const auth = store.people.authByHandle(handle.toLowerCase());
          if (!auth) return null;
          const { passwordHash: _p, salt: _s, ...user } = auth;
          return user;
        },
        create: createMember,
      },
      startSession: (userId, req) => {
        const user = store.people.get(userId);
        if (!user || user.deactivated) throw new HttpError(401, "invalid_credentials");
        const { token, tokenHash } = newSessionToken();
        store.accounts.createSession(tokenHash, user.id, deviceName(req));
        return { token, user };
      },
      publicUrl: () => network.publicUrl(),
    });
  }

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
  inBackground("event deliveries", flushEventDeliveries);
  files.start();
  const eventDeliveryTimer = setInterval(
    () => inBackground("event deliveries", flushEventDeliveries),
    5_000,
  );

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
    background.maintain("event deliveries", () =>
      store.pruneEventDeliveries(Date.now() - EVENT_DELIVERY_RETENTION_MS),
    );
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
    flushEventDeliveries,
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
        clearInterval(eventDeliveryTimer);
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
          await Promise.all([lifecycle.drain(), eventDeliveryFlush ?? Promise.resolve()]);
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
