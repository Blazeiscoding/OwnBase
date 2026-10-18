import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, statfsSync, statSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { open, stat, unlink } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { ZodError } from "zod";
import {
  PROTOCOL_VERSION,
  channelPermissions,
  canRemoveChannelMember,
  canSetChannelManager,
  channelManagerBody,
  createChannelBody,
  channelPrefsBody,
  savedMessagesQuery,
  pinnedMessagesQuery,
  followedThreadsQuery,
  threadFollowBody,
  threadReadBody,
  adminUserBody,
  createAppBody,
  createCommandBody,
  createSubscriptionBody,
  interactivityBody,
  messageActionBody,
  viewSubmitBody,
  createWebhookBody,
  runCommandBody,
  auditQuery,
  createInviteBody,
  scheduleMessageBody,
  rescheduleBody,
  editScheduledBody,
  changePasswordBody,
  editMessageBody,
  loginBody,
  guestAccountBody,
  guestJoinBody,
  accessPolicyBody,
  workspaceNameBody,
  workspaceNameSchema,
  ACCESS_POLICIES,
  type AccessPolicy,
  markReadBody,
  markUnreadBody,
  messageHistoryQuery,
  threadHistoryQuery,
  registerBody,
  parseSearchQuery,
  isTimeZone,
  hasSearchCriteria,
  searchQuery,
  activityQuery,
  sendMessageBody,
  SEND_RETRY_WINDOW_MS,
  updateChannelBody,
  updateMeBody,
  type EventEnvelope,
  type ID,
  type MessageAction,
  type Message,
  type ModalView,
  type ScheduledMessage,
  type ServerInfo,
  type User,
  type WorkspaceEvent,
  type WorkspaceStatus,
  type CallLogEntry,
} from "@slackoss/protocol";
import { openDb, SCHEMA_VERSION } from "./db.js";
import { holdWorkspace, type WorkspaceHold } from "./ownership.js";
import { Store } from "./store.js";
import { StorageBudget } from "./storageBudget.js";
import { Gateway } from "./gateway.js";
import { hashPassword, hashToken, newSessionToken, verifyPassword } from "./auth.js";
import { advertise, type MdnsHandle } from "./mdns.js";
import { imageSize } from "./imageSize.js";
import { blocksToActions, parseView, payloadToText } from "./blockKit.js";
import { OutboundError, postToUrl } from "./outbound.js";
import { parsePort, parsePublicUrl } from "./config.js";
import { callRelaySchema, createRelaySource, withRelay, type CallRelay } from "./relay.js";
import { iceServersSchema } from "./rtc.js";
import {
  APP_CALLS_IN_FLIGHT,
  CAPABILITIES_ALIVE,
  DEFAULT_LIMITS,
  RateLimiter,
  type Limits,
} from "./limits.js";
import { CapabilityMap } from "./capabilities.js";
import { LOGGER_OPTIONS } from "./redact.js";
import {
  firstHeaderValue,
  isLoopbackOrigin,
  originFromConnection,
  resolveClientAddress,
} from "./netTrust.js";
import { SECURITY_HEADERS } from "./securityHeaders.js";
import { isMissingAsset, webCacheControl } from "./webClient.js";
import { eventActorId, signatureHeaders, toSlackEvent } from "./integrations.js";
import { BUILTIN_COMMANDS } from "./commands.js";
import { secretToken, ulid } from "./ids.js";
import { SERVER_BUILD, SERVER_VERSION } from "./version.js";

export { SERVER_VERSION };

/** How many times an unexplained delivery error is retried before giving up. */
const SCHEDULED_ATTEMPTS = 3;

/**
 * Bounds on the scheduled queue. An account may have this many waiting, and
 * the workspace this many in all; the flush takes due rows a batch at a time,
 * yielding between batches; and a held row is looked at again after a pause,
 * or as soon as what held it clears, rather than on every tick. A batch of ten
 * held the loop for about 13 ms (median) when 2,000 came due at once, where
 * fifty held it for about 64 ms; draining took the same three seconds either
 * way.
 */
export const SCHEDULED_LIMITS = {
  perAccount: 200,
  perWorkspace: 10_000,
  batch: 10,
  heldRetryMs: 60_000,
};

/** Delivered queue rows are kept this long as proof of completion. */
const SCHEDULED_RETENTION_MS = 7 * 24 * 3600_000;

/**
 * How long a removed message's send key is kept after it was posted: an app's
 * whole retry window, and a week more for a clock that disagrees with this one.
 */
const PURGED_SEND_KEYS_MS = SEND_RETRY_WINDOW_MS + 7 * 24 * 3600_000;

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

/**
 * One hourly retention round runs passes of at most a few thousand messages
 * each, yielding between them, until nothing is left or it has spent this
 * long; a larger backlog is finished on later rounds.
 */
const RETENTION_PASSES = 200;
const RETENTION_SWEEP_MS = 30_000;

/** A guest's session lasts a day from joining, however much it is used. */
export const GUEST_SESSION_TTL_MS = 24 * 3600_000;
/** How many guests may be signed in at once; joining past it waits. */
const MAX_GUEST_SESSIONS = 200;

const isAccessPolicy = (value: unknown): value is AccessPolicy =>
  ACCESS_POLICIES.includes(value as AccessPolicy);

/** Guests read and take part in public channels; private rooms and DMs are closed to them. */
const guestRestricted = () =>
  new HttpError(403, "guest_restricted", "Guests can only be in public channels.");

/**
 * Everything a guest may ask of the server: reading and taking part in public
 * channels (messages, replies, reactions, files already shared, huddles),
 * keeping their own place (read state, saved items, followed threads,
 * preferences, profile), searching what they can read, and leaving or keeping
 * their identity as an account. Everything else, from creating rooms and DMs
 * to invites, uploads, pins, apps and scheduling, is refused in `requireUser`.
 * Channel visibility still decides which channels these reach.
 */
export const GUEST_ROUTES = new Set([
  "GET /api/rtc-config",
  "POST /api/auth/logout",
  "POST /api/auth/guest/account",
  "GET /api/me",
  "PATCH /api/me",
  "GET /api/users",
  "GET /api/friends",
  "GET /api/channels",
  "POST /api/channels/:id/join",
  "POST /api/channels/:id/leave",
  "GET /api/channels/:id/members",
  "POST /api/channels/:id/read",
  "POST /api/channels/:id/unread",
  "GET /api/channels/:id/messages",
  "POST /api/channels/:id/messages",
  "GET /api/channels/:id/threads/:rootId",
  "GET /api/channels/:id/messages/around/:messageId",
  "GET /api/channels/:id/messages/after/:messageId",
  "PATCH /api/messages/:id",
  "DELETE /api/messages/:id",
  "GET /api/files/:id",
  "POST /api/files/:id/download-token",
  "PUT /api/messages/:id/reactions/:emoji",
  "DELETE /api/messages/:id/reactions/:emoji",
  "GET /api/channels/:id/pins",
  "PUT /api/messages/:id/save",
  "DELETE /api/messages/:id/save",
  "PATCH /api/channels/:id/prefs",
  "PUT /api/messages/:id/follow",
  "POST /api/messages/:id/thread/read",
  "POST /api/messages/:id/thread/unread",
  "GET /api/threads/followed",
  "GET /api/saved",
  "GET /api/scheduled",
  "GET /api/commands",
  "GET /api/activity",
  "GET /api/search",
]);

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
  /** Private deployments default to LAN-only media with no external ICE service. */
  iceServers?: { urls: string | string[]; username?: string; credential?: string }[];
  /**
   * A TURN relay for calls between networks that will not connect directly,
   * given to calls after `iceServers`. A Cloudflare relay's password is asked
   * for when calls need one; its API token never leaves this server.
   */
  relay?: CallRelay | null;
  /**
   * How much one caller may do. `false` turns rationing off, which is
   * reasonable on a LAN where everyone is already trusted and unreasonable
   * anywhere reachable from outside it.
   */
  rateLimits?: Partial<Limits> | false;
  /** Overrides for the scheduled queue's bounds; see `SCHEDULED_LIMITS`. */
  scheduledLimits?: Partial<typeof SCHEDULED_LIMITS>;
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
   * Starts a copy for looking at, such as a backup restored to check it. The
   * copy holds the original's apps, their signing secrets and its queue of
   * scheduled messages, so an ordinary start would post those messages a
   * second time and call the same apps as the same workspace. An isolated one
   * posts nothing that is due, delivers no app events, refuses every call to
   * an app, and does not announce itself on the network. What was queued stays
   * queued, and goes out if the same data is later started normally.
   */
  isolated?: boolean;
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
  setRelay: (relay: CallRelay | null) => void;
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
  /** The workspace's name now. */
  workspaceName: () => string;
  /**
   * Renames the workspace while it runs, as the host, by the same rule as an
   * owner or admin: 1 to 80 characters without control characters, trimmed.
   * Everyone signed in is told at once, the network announcement changes,
   * and the name is stored for the next start.
   */
  setWorkspaceName: (name: string) => void;
  /**
   * Calls `listener` whenever the workspace is renamed or who may join
   * changes, by its host or by an owner or admin, so whatever shows either
   * outside the workspace can follow. Returns how to stop.
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
  /** The owner or admin who made the change, or null for the host. */
  by: ID | null;
}

export interface RetentionStatus {
  /** When a sweep last finished without an error; null before the first. */
  lastSuccessAt: number | null;
  /** Why the last sweep failed, or null when it did not. */
  lastError: string | null;
  /** Sweeps that have failed in a row. */
  failures: number;
}

class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message?: string,
    /** Seconds until the same call could succeed, for a refusal that will lift. */
    public retryAfter?: number,
  ) {
    super(message ?? code);
  }
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
  let publicUrl =
    opts.publicUrl === undefined ? undefined : parsePublicUrl(opts.publicUrl, "publicUrl");
  let iceServers = opts.iceServers ?? [];
  const relaySource = (relay: CallRelay | null) =>
    createRelaySource(relay === null ? null : callRelaySchema.parse(relay), {
      // The reason only: the request carried the API token.
      onError: (error) =>
        app.log.warn({ reason: error.message }, "the call relay gave no password"),
    });
  let relay = relaySource(opts.relay ?? null);
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

  // Before anyone owns the workspace, nobody in it could change its name or
  // who may join, so what it is started with decides both. Once it has an
  // owner they are its own, changed by its owner and admins, and a start
  // never puts back an older choice over theirs.
  const unowned = store.userCount() === 0;
  if (opts.workspaceName && (unowned || !store.getMeta("workspace_name")))
    store.setMeta("workspace_name", opts.workspaceName);
  if (!store.getMeta("workspace_name")) store.setMeta("workspace_name", "My Workspace");
  // Slack payloads carry a team id; ours is generated once and never changes.
  if (!store.getMeta("workspace_id")) store.setMeta("workspace_id", ulid());
  // Before guest access, invite_only alone said who could join: on, invited
  // accounts; off, any account. A workspace keeps that until someone chooses.
  if (!isAccessPolicy(store.getMeta("access_policy")))
    store.setMeta(
      "access_policy",
      store.getMeta("invite_only") === "1" ? "invite_only" : "account_required",
    );
  const accessPolicy = (): AccessPolicy => {
    const policy = store.getMeta("access_policy");
    return isAccessPolicy(policy) ? policy : "invite_only";
  };
  const workspaceName = () => store.getMeta("workspace_name")!;
  const inviteOnly = () => accessPolicy() === "invite_only";
  /**
   * Keeps the policy and the older invite_only flag in step, in one write with
   * whatever `record` adds, and ends every guest session when guests are no
   * longer allowed. Returns the ended sessions, whose sockets are the caller's
   * to close.
   */
  const writeAccessPolicy = (policy: AccessPolicy, record?: () => void): string[] =>
    store.transaction(() => {
      store.setMeta("access_policy", policy);
      store.setMeta("invite_only", policy === "invite_only" ? "1" : "0");
      record?.();
      return policy === "guest_allowed" ? [] : store.revokeGuestSessions();
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
   * stranger to find it on the network owns it.
   */
  if (store.userCount() === 0 && !store.getMeta("claim_code")) {
    store.setMeta("claim_code", secretToken());
  }
  const claimCode = () => store.getMeta("claim_code") || null;
  /** Whatever the client called itself. Shown back to its owner, never trusted. */
  const deviceName = (req: FastifyRequest) => String(req.headers["user-agent"] ?? "").slice(0, 200);
  /**
   * Whether this request came from the machine running the server.
   *
   * Behind a reverse proxy every request arrives from loopback, which would
   * hand the local bypass to the whole internet. So a request that shows any
   * sign of having been forwarded is never local, and neither is any request to
   * a server configured with a public URL.
   *
   * Arriving from loopback is not on its own proof that the person running this
   * machine meant it. A web page they merely visited can have their browser
   * post to localhost, and that request arrives from loopback like any other —
   * which, while a workspace still has no owner, would let that page claim it
   * without the claim code. A command line request carries no `Origin`; a
   * browser always sends one on a write, and a page served from anywhere else
   * names that somewhere else. So an `Origin` is required to be this same
   * server, if it is there at all.
   */
  const isLocalRequest = (req: FastifyRequest) => {
    if (publicUrl) return false;
    if (
      [
        "forwarded",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "x-real-ip",
        "cf-connecting-ip",
      ].some((name) => req.headers[name] !== undefined)
    )
      return false;
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin && !isLoopbackOrigin(origin, req.socket.localPort)) {
      return false;
    }
    const ip = (req.ip || "").replace(/^::ffff:/, "");
    return ip === "127.0.0.1" || ip === "::1";
  };

  /**
   * Rationing. The cap on concurrent password hashing keeps one burst from
   * exhausting this machine; this keeps a patient caller from grinding away at
   * it all day, which that cap alone does nothing about.
   */
  const limiter =
    opts.rateLimits === false
      ? null
      : new RateLimiter({ ...DEFAULT_LIMITS, ...(opts.rateLimits ?? {}) });
  const scheduledLimits = { ...SCHEDULED_LIMITS, ...opts.scheduledLimits };
  let trustLoopbackProxy = opts.trustedClientProxy === "loopback";

  /** The address a request came from, as the limiter keys on it. */
  const callerAddress = (req: FastifyRequest): string =>
    resolveClientAddress(
      req.socket.remoteAddress,
      req.headers,
      trustLoopbackProxy ? "loopback" : undefined,
    );

  /**
   * Clears what a handle has spent on authentication. Called when a password
   * turns out to be right: only wrong guesses are worth counting, so someone
   * who knows their own password never meets this limit at all, however often
   * they sign in or change it.
   */
  const authSucceeded = (handle: string): void => {
    limiter?.forget("authByHandle", handle.toLowerCase());
  };

  const ration = (name: keyof Limits, key: string): void => {
    if (!limiter) return;
    const { ok, retryAfterMs } = limiter.take(name, key);
    if (ok) return;
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    throw new HttpError(
      429,
      "too_many_requests",
      "That is more than this workspace allows for now. Try again shortly.",
      seconds,
    );
  };

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
    { name: workspaceName, accessPolicy },
    limiter,
    (req) =>
      resolveClientAddress(
        req.socket.remoteAddress,
        req.headers,
        trustLoopbackProxy ? "loopback" : undefined,
      ),
    (err, where) =>
      app.log.error({ err, where }, "socket work failed; its socket closes to reconnect"),
  );

  const recordEvent = (event: WorkspaceEvent, channelId: ID | null): EventEnvelope => {
    const envelope = store.appendEvent(event, channelId);
    if (event.type === "message.created") {
      store.stampMessageSeq(
        event.message.id,
        event.message.channelId,
        envelope.seq,
        !event.message.threadRootId || event.message.broadcast === true,
      );
      event.message.seq = envelope.seq;
      // Every way a reply can be written arrives here, so following belongs
      // here too rather than in each of the routes that can create one.
      if (event.message.threadRootId) {
        store.autoFollowThread(event.message.threadRootId, event.message.userId, envelope.seq);
      }
    }
    enqueueSubscriberDeliveries(envelope, channelId);
    return envelope;
  };
  /**
   * A reply follows its thread for its author and the root's author. Their
   * other devices only learn that from the handshake unless we say so, so tell
   * them here — after the commit that created the follow row.
   */
  const publishThreadFollows = (envelope: EventEnvelope): void => {
    const event = envelope.event;
    if (event.type !== "message.created" || !event.message.threadRootId) return;
    const root = store.getMessage(event.message.threadRootId);
    // Everyone following it needs the new watermark, not just the two accounts
    // this reply may have signed up.
    const recipients = new Set([
      ...store.threadFollowers(event.message.threadRootId),
      event.message.userId,
      ...(root ? [root.userId] : []),
    ]);
    for (const userId of recipients) {
      // Someone offline reads it from the handshake when they connect.
      if (!gateway.isOnline(userId)) continue;
      const state = store.threadFollow(userId, event.message.threadRootId);
      if (state) gateway.sendToUser(userId, { type: "thread.follow", state });
    }
  };
  /**
   * Recomputes and sends unread mention counts. Only the people whose counts
   * can have changed are told, so an ordinary message costs nothing, and only
   * those connected now are counted (REV-06): anyone else gets their counts
   * from the handshake when they connect, which reads the committed rows.
   */
  const pushMentionCounts = (userIds: Iterable<ID>): void => {
    for (const userId of new Set(userIds)) {
      if (!gateway.isOnline(userId)) continue;
      gateway.sendToUser(userId, { type: "mentions", counts: store.unreadMentionCounts(userId) });
    }
  };

  /**
   * Whose counts a message arriving or leaving changes: whoever it names.
   * Deletion is read from the event's own copy, since the row is already gone.
   */
  const mentionRecipients = (
    envelope: EventEnvelope,
    channelsRead: Set<ID>,
    audiences: Map<ID, Set<ID> | null>,
  ): ID[] => {
    const event = envelope.event;
    if (event.type === "message.created") {
      const { channelId, text, userId, replyTo } = event.message;
      const named = store.mentionedMemberIds(channelId, text, userId);
      // A reply that notified the author of what it answers counts for them.
      const pinged = replyTo?.ping ? replyTo.userId : null;
      return pinged && !named.includes(pinged) && store.isMember(channelId, pinged)
        ? [...named, pinged]
        : named;
    }
    if (event.type === "message.deleted" && event.channelId) {
      // Offline members are skipped anyway; with nobody connected, skip the read
      // too, and read a channel's members once however many of its messages went.
      if (gateway.socketCount() === 0 || channelsRead.has(event.channelId)) return [];
      channelsRead.add(event.channelId);
      // A private channel's audience is its members, already read to send
      // the deletions themselves (F10).
      const audience = audiences.get(event.channelId);
      return audience ? [...audience] : store.memberIds(event.channelId);
    }
    return [];
  };

  /**
   * Queues failing in the background now, by name: since when and how many
   * times in a row (REV-01). Cleared when the queue next succeeds. Times and
   * counts only, so admin status can show it without any error text.
   */
  const backgroundFailures = new Map<string, { since: number; failures: number }>();
  /** Runs already being watched: callers share one in-flight flush, which fails once. */
  const watchedRuns = new WeakSet<Promise<unknown>>();
  /**
   * Runs queue work from a timer, an immediate or startup, where a throw or a
   * rejection would end the process (REV-01). The failure is logged and
   * counted, and the queue tries again on its next round; the durable rows
   * it was working on stay as they were. Callers that must learn of a
   * failure, such as tests and operators, call the queue's own function.
   */
  const inBackground = (queue: string, work: () => unknown): void => {
    const failed = (err: unknown) => {
      const failing = backgroundFailures.get(queue);
      backgroundFailures.set(queue, {
        since: failing?.since ?? Date.now(),
        failures: (failing?.failures ?? 0) + 1,
      });
      app.log.error({ err, queue }, "background work failed; it will be tried again");
    };
    const succeeded = () => backgroundFailures.delete(queue);
    try {
      const result = work();
      if (!(result instanceof Promise)) succeeded();
      else if (!watchedRuns.has(result)) {
        watchedRuns.add(result);
        result.then(succeeded, failed);
      }
    } catch (err) {
      failed(err);
    }
  };
  /** Runs work that follows a commit, so its failure is logged instead of undoing the answer. */
  const afterCommitted = (what: string, work: () => void): void => {
    try {
      work();
    } catch (err) {
      app.log.error({ err }, `could not ${what} after a commit`);
    }
  };
  /**
   * Hands committed events to everyone allowed to see them (REV-10). The
   * change has happened, so nothing here may turn its answer into a failure
   * or stop the events after it: every durable frame goes out first, then the
   * follow states and mention counts that can be recomputed, each failing
   * alone. A frame that cannot be fanned out closes every socket, so each
   * client reconnects from the last event it has and replays the rest, rather
   * than taking the next event as its checkpoint and never asking for it.
   */
  const publishCommitted = (
    events: readonly { envelope: EventEnvelope; channelId: ID | null }[],
  ): void => {
    // Each channel's audience is read once for the whole change (F10).
    const audiences = new Map<ID, Set<ID> | null>();
    for (const { envelope, channelId } of events) {
      try {
        gateway.publish(envelope, channelId, audiences);
      } catch (err) {
        app.log.error(
          { err, seq: envelope.seq },
          "could not send a committed event; clients replay it",
        );
        gateway.resynchronize();
      }
    }
    if (events.length > 0) inBackground("event deliveries", flushEventDeliveries);
    // One recount per person per committed change, however many of its
    // events touched their counts: deleting a thread is one change (REV-06).
    const recount = new Set<ID>();
    const channelsRead = new Set<ID>();
    for (const { envelope } of events) {
      afterCommitted("send thread follow states", () => publishThreadFollows(envelope));
      afterCommitted("find whose mention counts changed", () => {
        for (const userId of mentionRecipients(envelope, channelsRead, audiences))
          recount.add(userId);
      });
    }
    if (recount.size > 0) afterCommitted("send mention counts", () => pushMentionCounts(recount));
  };
  /** Commit synchronous state and its event log before exposing any side effects. */
  const mutate = <T>(
    work: (record: typeof recordEvent, afterCommit: (effect: () => void) => void) => T,
  ): T => {
    const events: { envelope: EventEnvelope; channelId: ID | null }[] = [];
    const effects: (() => void)[] = [];
    const result = store.transaction(() =>
      work(
        (event, channelId) => {
          const envelope = recordEvent(event, channelId);
          events.push({ envelope, channelId });
          return envelope;
        },
        (effect) => effects.push(effect),
      ),
    );
    // Access revocation must happen before fanout, but only after a successful commit.
    // Fanout reads access from the committed rows, so a failed effect leaks nothing.
    for (const effect of effects) afterCommitted("apply a committed change", effect);
    publishCommitted(events);
    return result;
  };

  /** Edits from people and apps refresh both removed and newly added mentions after commit. */
  const updateMessage = (existing: Message, text: string, clearActions = false): Message =>
    mutate((emit, afterCommit) => {
      const recipients = new Set([
        ...store.mentionedMemberIds(existing.channelId, existing.text, existing.userId),
        ...store.mentionedMemberIds(existing.channelId, text, existing.userId),
      ]);
      if (clearActions) store.clearMessageActions(existing.id);
      const message = store.editMessage(existing.id, text);
      emit({ type: "message.updated", message }, message.channelId);
      afterCommit(() => pushMentionCounts(recipients));
      return message;
    });

  /**
   * Adds every eligible subscriber beside the event, inside its transaction.
   * What does not depend on the subscription is worked out once per event,
   * however many subscriptions one bot has (F11): whether each bot is in the
   * channel, the workspace's id and the callback body every one of them gets.
   */
  const enqueueSubscriberDeliveries = (envelope: EventEnvelope, channelId: ID | null): void => {
    const subs = store.listAllSubscriptions();
    if (subs.length === 0) return;
    const payload = toSlackEvent(envelope.event);
    if (!payload) return;
    const actor = eventActorId(envelope.event);
    const inChannel = new Map<ID, boolean>();
    const botInChannel = (botUserId: ID, channel: ID): boolean => {
      let member = inChannel.get(botUserId);
      if (member === undefined)
        inChannel.set(botUserId, (member = store.isMember(channel, botUserId)));
      return member;
    };
    let body: string | null = null;
    const callback = (): string =>
      (body ??= JSON.stringify({
        type: "event_callback",
        event_id: `Ev${envelope.seq}`,
        event_time: Math.floor(Date.now() / 1000),
        team_id: store.getMeta("workspace_id"),
        event: payload,
        // Our own event beside Slack's shape, so a native app need not
        // reverse-engineer the mapping.
        slackoss: { type: envelope.event.type, seq: envelope.seq },
      }));

    for (const { subscription, app: owner } of subs) {
      if (
        subscription.eventTypes.length > 0 &&
        !subscription.eventTypes.includes(envelope.event.type)
      ) {
        continue;
      }
      // Never hand an app back its own bot's actions — that is how a bot that
      // replies to messages ends up replying to itself forever.
      if (actor !== null && actor === owner.botUserId) continue;
      // An app sees a channel only once its bot has been added to it, so
      // subscribing does not quietly expose every private conversation.
      if (channelId !== null && !botInChannel(owner.botUserId, channelId)) continue;

      const queued = store.enqueueEventDelivery(
        subscription.id,
        channelId,
        envelope.seq,
        callback(),
        Date.now(),
        Store.eventMessageId(envelope.event),
      );
      if (!queued) {
        app.log.warn(
          { subscriptionId: subscription.id, eventSeq: envelope.seq },
          "event subscription backlog full, event dropped",
        );
      }
    }
  };

  /**
   * Shutdown, as the parts of the server that outlive a single call see it.
   * `closing` stops loops from starting another round; the signal ends outbound
   * calls already under way, so an app slow to answer cannot hold the process
   * open for its whole timeout.
   */
  let closing = false;
  const shutdown = new AbortController();

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
        signal: shutdown.signal,
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
        while (!closing && failures.length === 0) {
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

  /** Posts a message and fans it out. Used by the API and the scheduler alike. */
  const postMessage = (input: {
    channelId: ID;
    userId: ID;
    text: string;
    threadRootId: ID | null;
    nonce: string | null;
    fileIds: ID[];
    actions?: MessageAction[];
    /** For a reply: show it in the channel's own timeline as well. */
    broadcast?: boolean;
    /** The message this one answers in place, in the same conversation. */
    replyToId?: ID | null;
    /** Notify that message's author. */
    replyPing?: boolean;
    /** Marks this queue row delivered in the same transaction as the message. */
    scheduledId?: ID;
  }) => {
    const events: EventEnvelope[] = [];
    const message = store.transaction(() => {
      const channel = store.getChannel(input.channelId);
      if (!channel || !store.canAccess(channel.id, input.userId))
        throw new HttpError(404, "channel_not_found");
      if (store.getUser(input.userId)?.deactivated) throw new HttpError(403, "account_deactivated");
      const requestHash = hashToken(
        JSON.stringify([
          input.channelId,
          input.text,
          input.threadRootId,
          input.broadcast ?? false,
          [...input.fileIds].sort(),
          // Absent unless it answers something, so a request recorded before still matches.
          ...(input.replyToId ? [input.replyToId, input.replyPing ?? false] : []),
        ]),
      );
      if (input.nonce !== null) {
        const previous = store.messageRequest(input.userId, input.nonce);
        if (previous) {
          const existing = store.getMessage(previous.messageId);
          if (!existing) throw new HttpError(409, "message_deleted");
          if (
            (previous.requestHash !== null && previous.requestHash !== requestHash) ||
            existing.channelId !== input.channelId ||
            existing.threadRootId !== input.threadRootId
          ) {
            throw new HttpError(409, "nonce_conflict");
          }
          return existing;
        }
        // Posted once, then removed with the workspace's older history.
        if (store.messageRequestPurged(input.userId, input.nonce))
          throw new HttpError(
            409,
            "message_deleted",
            "This was already sent, and has since been removed with older messages.",
          );
      }
      if (channel.archived) throw new HttpError(400, "channel_archived");
      if (input.threadRootId) {
        const root = store.getMessage(input.threadRootId);
        if (!root || root.channelId !== channel.id || root.threadRootId)
          throw new HttpError(400, "bad_thread_root");
      }
      // A reply answers something in its own conversation: in a channel, what
      // the channel shows; in a thread, its first message or another reply.
      // Deleted since it was chosen, it still goes and says so; removed with
      // older history, it goes as an ordinary message.
      const target = input.replyToId ? store.replyTarget(input.replyToId) : null;
      if (
        target &&
        (target.channelId !== channel.id ||
          (input.threadRootId
            ? input.replyToId !== input.threadRootId && target.threadRootId !== input.threadRootId
            : target.threadRootId !== null && !target.broadcast))
      )
        throw new HttpError(400, "bad_reply_target");
      if (channel.type === "public" && !store.isMember(channel.id, input.userId)) {
        store.addMember(channel.id, input.userId);
        events.push(
          recordEvent(
            { type: "member.joined", channelId: channel.id, userId: input.userId },
            channel.id,
          ),
        );
      }
      // A file a scheduled message is waiting to send is already promised.
      if (store.filesHeldBySchedule(input.fileIds, input.scheduledId ?? null))
        throw new HttpError(
          409,
          "attachments_scheduled",
          "One of these files is part of a scheduled message. Cancel that message to use it here.",
        );
      const created = store.createMessage({
        ...input,
        replyToId: target ? input.replyToId : null,
      });
      if (
        !store.attachFiles(
          input.fileIds,
          created.id,
          input.channelId,
          input.userId,
          input.scheduledId ?? null,
        )
      )
        throw new HttpError(400, "invalid_attachments");
      const hydrated = store.getMessage(created.id)!;
      if (input.nonce !== null)
        store.recordMessageRequest(input.userId, input.nonce, created.id, requestHash);
      if (input.scheduledId) store.markScheduledSent(input.scheduledId, created.id);
      events.push(recordEvent({ type: "message.created", message: hydrated }, input.channelId));
      return hydrated;
    });
    publishCommitted(events.map((envelope) => ({ envelope, channelId: input.channelId })));
    return message;
  };

  // Uploads live beside the database so one folder is the whole workspace.
  const filesDir = opts.dataDir === ":memory:" ? null : join(opts.dataDir, "files");
  if (filesDir) mkdirSync(filesDir, { recursive: true });
  const maxFileSize = opts.maxFileSize ?? 100 * 1024 * 1024;
  const blobPath = (fileId: string) => join(filesDir!, fileId);
  const storage = new StorageBudget(filesDir, opts.maxStorageBytes || null);
  const abandonedUploadTtlMs = opts.abandonedUploadTtlMs ?? 24 * 3600_000;
  const retentionMs = (opts.retentionDays ?? 0) * 24 * 3600_000;

  /** Removals taken per turn; a full page means more may be due, taken on the next turn. */
  const FILE_CLEANUP_PAGE = 100;
  let fileCleanup: Promise<void> | null = null;
  let fileCleanupNext: ReturnType<typeof setImmediate> | null = null;
  /**
   * Removes the blobs of committed deletions due by `now`, a page at a time
   * (REV-02). One that fails waits longer each time while the rest go on, so
   * a few that cannot be removed never hold back the many that can, and a
   * full page is followed by the next on a later turn rather than fifteen
   * seconds on. A name this server never gives a file is set aside for good,
   * still counted. Storage stays counted until a blob is actually gone.
   */
  const flushFileDeletions = (now = Date.now()): Promise<void> => {
    if (fileCleanup) return fileCleanup;
    let more = false;
    fileCleanup = (async () => {
      const due = store.dueFileDeletions(now, FILE_CLEANUP_PAGE);
      more = due.length === FILE_CLEANUP_PAGE;
      for (const id of due) {
        if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) {
          app.log.error({ fileId: id }, "invalid attachment cleanup id; set aside");
          store.rejectFileDeletion(id);
          continue;
        }
        try {
          if (filesDir) await unlink(blobPath(id));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            app.log.warn({ fileId: id, err }, "attachment cleanup deferred");
            store.deferFileDeletion(id, Date.now());
            continue;
          }
        }
        store.completeFileDeletion(id);
        storage.release(id);
      }
    })()
      .catch((err) => {
        more = false;
        app.log.error({ err }, "attachment cleanup failed; pending work retained");
      })
      .finally(() => {
        fileCleanup = null;
        if (more && !closing && !fileCleanupNext) {
          fileCleanupNext = setImmediate(() => {
            fileCleanupNext = null;
            inBackground("attachment cleanup", () => flushFileDeletions(Math.max(now, Date.now())));
          });
        }
      });
    return fileCleanup;
  };

  /**
   * Frees uploads nobody ever sent. Without this an attachment chosen and then
   * thought better of holds its bytes for the life of the workspace, which the
   * storage cap turns from untidy into a workspace that slowly fills up.
   */
  const expireAbandonedUploads = (): number => {
    const ids = store.abandonedFileIds(Date.now() - abandonedUploadTtlMs);
    if (ids === null) {
      app.log.error("scheduled queue unreadable; abandoned uploads left alone this round");
      return 0;
    }
    if (ids.length === 0) return 0;
    store.transaction(() => {
      store.deleteFiles(ids);
      store.queueFileDeletions(ids);
    });
    app.log.info({ count: ids.length }, "expired abandoned uploads");
    return ids.length;
  };

  /**
   * Blobs on disk that no `files` row accounts for. A process killed between
   * writing the bytes and recording them leaves one behind: it counts against
   * the workspace cap, and without this nothing would ever ask to delete it.
   *
   * Safe only before uploads can start, since a blob being written right now
   * has no row yet either. It runs once, at startup, for that reason.
   */
  const reconcileOrphanedBlobs = (): number => {
    if (!filesDir) return 0;
    const orphans = store.unknownFileIds(storage.storedIds());
    if (orphans.length === 0) return 0;
    // Through the usual queue, so a blob that will not delete is retried rather
    // than lost track of, and its bytes are released when it really goes.
    store.queueFileDeletions(orphans);
    app.log.warn({ count: orphans.length }, "queued orphaned attachment blobs");
    return orphans.length;
  };

  /**
   * Discards conversation older than the configured retention window.
   *
   * Each pass logs one `history.removed` per conversation it touched, naming
   * the threads that went, rather than a deletion per message: a month of
   * those would put thousands of events into the very log this is meant to
   * keep small. Like any event, it reaches only those who can read the
   * conversation, and a client that was away hears it when it catches up.
   * Whoever is connected and belongs to one of those conversations is sent
   * their mention counts afresh, since a removed mention no longer counts.
   */
  const applyRetention = (): number => {
    if (!retentionMs) return 0;
    const events: { envelope: EventEnvelope; channelId: ID }[] = [];
    const { messages, fileIds } = store.transaction(() => {
      const purged = store.purgeMessagesBefore(Date.now() - retentionMs);
      const byChannel = new Map<ID, ID[]>();
      for (const root of purged.roots) {
        const ids = byChannel.get(root.channelId) ?? [];
        ids.push(root.id);
        byChannel.set(root.channelId, ids);
      }
      for (const [channelId, rootIds] of byChannel) {
        events.push({
          envelope: recordEvent({ type: "history.removed", channelId, rootIds }, channelId),
          channelId,
        });
      }
      return purged;
    });
    if (messages === 0) return 0;
    publishCommitted(events);
    afterCommitted("send mention counts", () => {
      const online = new Set(gateway.onlineUserIds());
      pushMentionCounts(
        events.flatMap(({ channelId }) =>
          store.memberIds(channelId).filter((id) => online.has(id)),
        ),
      );
    });
    app.log.info(
      { messages, files: fileIds.length, retentionDays: opts.retentionDays },
      "discarded conversation past the retention window",
    );
    if (fileIds.length > 0) void flushFileDeletions();
    return messages;
  };

  /**
   * What the last retention sweep came to. A sweep that throws is caught, so
   * it cannot take the server down from a timer, and is tried again on the
   * next round; until one succeeds, this is how its failure stays visible.
   */
  const retention: RetentionStatus = { lastSuccessAt: null, lastError: null, failures: 0 };

  /**
   * Runs retention passes until one finds nothing left or the round's budget
   * is spent, giving the event loop back between passes so posts and reads
   * are served while a large backlog drains. Each pass is its own transaction:
   * stopping between two of them leaves nothing half removed.
   */
  const sweepRetention = async (): Promise<number> => {
    if (!retentionMs) return 0;
    const started = Date.now();
    let removed = 0;
    try {
      for (let pass = 0; pass < RETENTION_PASSES && !closing; pass++) {
        const went = applyRetention();
        removed += went;
        if (went === 0 || Date.now() - started > RETENTION_SWEEP_MS) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      retention.lastSuccessAt = Date.now();
      retention.lastError = null;
      retention.failures = 0;
    } catch (err) {
      retention.failures++;
      retention.lastError = err instanceof Error ? err.message : String(err);
      app.log.error(
        { err, failures: retention.failures, retentionDays: opts.retentionDays },
        "retention sweep failed; it will be tried again",
      );
    }
    return removed;
  };

  /**
   * Deletes a message, and when it started a thread, every reply in it.
   *
   * A reply has nothing to hang from once its thread's first message is gone:
   * the thread cannot be opened, and keeping the replies stored where nobody can
   * reach them served no one. So they go the same way, in the same transaction —
   * words blanked, attachments released, and the copies in the event log
   * redacted — and each is announced, replies before the message they answered,
   * so an open thread empties before it closes.
   */
  const removeMessage = (existing: Message) =>
    mutate((emit) => {
      const replies = existing.threadRootId === null ? store.threadReplyIds(existing.id) : [];
      const doomed = [
        ...replies.map((id) => ({ id, threadRootId: existing.id as ID | null })),
        { id: existing.id, threadRootId: existing.threadRootId },
      ];
      for (const message of doomed) {
        const fileIds = store.fileIdsForMessage(message.id);
        store.deleteFiles(fileIds);
        store.queueFileDeletions(fileIds);
        store.deleteMessage(message.id);
        emit(
          {
            type: "message.deleted",
            channelId: existing.channelId,
            messageId: message.id,
            threadRootId: message.threadRootId,
          },
          existing.channelId,
        );
      }
    });

  const app = Fastify({
    // Redacting where the log is configured rather than at each call site: the
    // leak is Fastify's own request logging, which no route goes through.
    logger: opts.logger
      ? { ...LOGGER_OPTIONS, ...(typeof opts.logger === "object" ? opts.logger : {}) }
      : false,
    forceCloseConnections: true,
  });

  /**
   * Every route handler still running. Closing the listener destroys the
   * connections but not the handlers behind them: a slash command waiting on
   * its app wakes up afterwards and goes on to read and write the database. So
   * shutdown waits for these to finish before closing it.
   *
   * Registered before any route, since it only applies to routes added after.
   */
  if (upgradeBackup) {
    app.log.info({ file: upgradeBackup }, "backed up the workspace before upgrading it");
  }
  for (const { file, error } of unprunedCopies) {
    app.log.warn({ file, err: error }, "could not remove an older pre-upgrade copy");
  }

  const runningHandlers = new Set<Promise<void>>();
  app.addHook("onRoute", (route) => {
    const handler = route.handler;
    route.handler = function (req, reply) {
      const result = handler.call(this, req, reply) as unknown;
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        const settled = Promise.resolve(result).then(
          () => {},
          () => {},
        );
        runningHandlers.add(settled);
        void settled.then(() => runningHandlers.delete(settled));
      }
      return result as ReturnType<typeof handler>;
    };
  });
  // The default allow-list is GET/HEAD/POST only, which silently breaks
  // reactions, edits, deletes, pins and saves in the browser.
  await app.register(cors, {
    origin: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
  });
  await app.register(multipart, { limits: { fileSize: maxFileSize, files: 1 } });

  // On every response rather than only on the client's HTML. An API reply is
  // not a page, but it can be navigated to directly, and a header that is
  // always there cannot be forgotten on the one route that needed it.
  app.addHook("onSend", async (_req, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
  });

  // Slack-style integrations often post `payload=<json>` as a form rather than
  // JSON, so accept that shape too. Small enough not to warrant a plugin.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error);
      }
    },
  );

  // Serve the browser client (if bundled) so teammates without the app can join.
  const servesWebClient = !!opts.webDistPath && existsSync(join(opts.webDistPath, "index.html"));
  if (servesWebClient) {
    const root = opts.webDistPath!;
    // The build writes a Brotli and a gzip copy of each text file beside it;
    // the plugin sends the one the browser accepts, with Vary: Accept-Encoding.
    await app.register(fastifyStatic, {
      root,
      preCompressed: true,
      setHeaders: (reply, file) => reply.header("cache-control", webCacheControl(root, file)),
    });
  }
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? "";
    // A Slack Web API method this server does not implement. Slack's answer is
    // `unknown_method`, which its SDK reports by name; a bare 404 would reach
    // a bot as a transport failure that says nothing about why.
    if (/^\/api\/[a-z]+(?:\.[A-Za-z]+)+(?:[?#]|$)/.test(url)) {
      return reply.status(200).send({ ok: false, error: "unknown_method" });
    }
    if (!servesWebClient || url.startsWith("/api/") || url.startsWith("/ws")) {
      return reply.status(404).send({ error: "not_found" });
    }
    if (isMissingAsset(url)) {
      return reply.status(404).header("cache-control", "no-store").send({ error: "not_found" });
    }
    return reply.sendFile("index.html");
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "invalid_request", details: err.issues });
    }
    if (err instanceof HttpError) {
      if (err.retryAfter !== undefined) reply.header("retry-after", String(err.retryAfter));
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    const fastifyErr = err as { statusCode?: number; code?: string; message?: string };
    if (typeof fastifyErr.statusCode === "number" && fastifyErr.statusCode < 500) {
      return reply
        .status(fastifyErr.statusCode)
        .send({ error: fastifyErr.code ?? "bad_request", message: fastifyErr.message });
    }
    app.log.error(err);
    return reply.status(500).send({ error: "internal" });
  });

  // ---------- auth plumbing ----------

  const bearerToken = (req: FastifyRequest): string | null => {
    const h = req.headers.authorization;
    if (h?.startsWith("Bearer ")) return h.slice(7);
    return null;
  };

  /**
   * How this server is addressed from outside, for the URLs we hand to apps.
   *
   * These become a `response_url`, which carries a token and which an app posts
   * its reply to. Building one from the `Host` header meant whoever sent the
   * request chose where that reply went: a forged header pointed the app at
   * somewhere else entirely, and sent the token with it. So the configured
   * public URL is used when there is one, forwarded headers only when a proxy
   * has been declared, and otherwise the address the connection actually
   * arrived on, which no header can change.
   */
  const requestOrigin = (req: FastifyRequest): string => {
    if (publicUrl) return publicUrl;
    if (opts.trustProxy) {
      const proto = firstHeaderValue(req.headers["x-forwarded-proto"]) || "http";
      const host =
        firstHeaderValue(req.headers["x-forwarded-host"]) || firstHeaderValue(req.headers.host);
      if (host) return `${proto}://${host}`;
    }
    return originFromConnection(req.socket.localAddress, req.socket.localPort);
  };

  /**
   * Routes an account may reach while it still holds a password someone else
   * chose: replacing that password, and getting out.
   */
  const ALLOWED_WHILE_LOCKED = new Set(["/api/auth/password", "/api/auth/logout"]);

  const requireUser = (req: FastifyRequest): User => {
    const token = bearerToken(req);
    const user = token ? store.getSessionUser(hashToken(token)) : null;
    if (!user) throw new HttpError(401, "unauthorized");
    // Also here rather than per route: a route added later is closed to
    // guests until someone decides otherwise.
    if (user.role === "guest" && !GUEST_ROUTES.has(`${req.method} ${req.routeOptions.url}`)) {
      throw new HttpError(
        403,
        "guest_not_allowed",
        "Guests cannot do this. Create an account to do it.",
      );
    }
    // Checked here rather than per route, so a route added later is covered.
    if (
      !ALLOWED_WHILE_LOCKED.has(req.routeOptions.url ?? "") &&
      store.mustChangePassword(user.id)
    ) {
      throw new HttpError(
        403,
        "password_change_required",
        "Choose a new password before using this workspace.",
      );
    }
    return user;
  };

  const requireChannelAccess = (channelId: ID, user: User) => {
    const channel = store.getChannel(channelId);
    if (!channel || !store.canAccess(channelId, user.id)) {
      throw new HttpError(404, "channel_not_found");
    }
    return channel;
  };

  // ---------- unauthenticated ----------

  app.get("/api/health", async (_req, reply) => {
    db.prepare("SELECT 1").get();
    reply.header("Cache-Control", "no-store");
    return { status: "ok", instanceId };
  });

  app.get("/api/rtc-config", async (req, reply) => {
    requireUser(req);
    reply.header("Cache-Control", "no-store");
    return { iceServers: withRelay(iceServers, await relay.servers()) };
  });

  // Bound simultaneous password derivations; each scrypt job uses substantial
  // memory. Do the expensive work off the event loop so calls/chat stay responsive.
  let authJobs = 0;
  const beginAuth = () => {
    if (authJobs >= 2) throw new HttpError(429, "auth_busy", "Please retry in a moment");
    authJobs++;
  };

  app.get("/api/server-info", async (req): Promise<ServerInfo> => {
    const userCount = store.userCount();
    return {
      app: "slackoss",
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: SERVER_VERSION,
      ...(SERVER_BUILD ? { build: SERVER_BUILD } : {}),
      workspaceName: workspaceName(),
      userCount,
      requiresInvite: userCount > 0 && inviteOnly(),
      accessPolicy: accessPolicy(),
      requiresClaim: userCount === 0 && !!claimCode() && !isLocalRequest(req),
      schedulingIdempotency: true,
      downloadTickets: true,
      ...(publicUrl ? { publicUrl } : {}),
    };
  });

  /** Puts someone new in every open public channel, as a new channel takes in everyone. */
  const joinPublicChannels = (userId: ID, emit: typeof recordEvent) => {
    for (const channel of store.listChannelsVisibleTo(userId)) {
      if (channel.type !== "public" || channel.archived) continue;
      if (store.addMember(channel.id, userId)) {
        emit({ type: "member.joined", channelId: channel.id, userId }, channel.id);
      }
    }
  };

  app.post("/api/auth/register", async (req, reply) => {
    const body = registerBody.parse(req.body);
    ration("authByAddress", callerAddress(req));
    ration("authByHandle", body.handle.toLowerCase());
    beginAuth();
    let credentials: Awaited<ReturnType<typeof hashPassword>>;
    try {
      credentials = await hashPassword(body.password);
    } finally {
      authJobs--;
    }
    // Everything after hashing is synchronous: concurrent registrations cannot
    // both become owner or consume the same final invitation use.
    const { token, user } = mutate((emit) => {
      const isFirstUser = store.userCount() === 0;

      if (store.getUserAuthByHandle(body.handle)) {
        throw new HttpError(409, "handle_taken");
      }

      if (isFirstUser) {
        const expected = claimCode();
        if (expected && !isLocalRequest(req) && body.claimCode !== expected) {
          throw new HttpError(
            403,
            "claim_required",
            "this workspace has no owner yet; enter the claim code its host printed at startup",
          );
        }
      }

      if (!isFirstUser && inviteOnly()) {
        if (!body.inviteCode || !store.consumeInvite(body.inviteCode)) {
          throw new HttpError(403, "invite_required", "a valid invite code is required to join");
        }
      }
      const { hash, salt } = credentials;
      const user = store.createUser({
        handle: body.handle,
        displayName: body.displayName,
        passwordHash: hash,
        salt,
        role: isFirstUser ? "owner" : "member",
      });

      if (isFirstUser) {
        // Single use: the workspace now has an owner and cannot be claimed again.
        store.setMeta("claim_code", "");
        // Bootstrap the workspace with #general.
        const general = store.createChannel({
          type: "public",
          name: "general",
          description: "This channel is for workspace-wide communication.",
          creatorId: user.id,
          memberIds: [user.id],
        });
        emit({ type: "channel.created", channel: general }, general.id);
      } else {
        emit({ type: "user.joined", user }, null);
        joinPublicChannels(user.id, emit);
      }

      const { token, tokenHash } = newSessionToken();
      store.createSession(tokenHash, user.id, deviceName(req));
      return { token, user };
    });
    // A handle that is now yours was not a guess at someone else's, and a new
    // account mistyping its own password twice should not then be locked out.
    authSucceeded(body.handle);
    return reply.status(201).send({ token, user });
  });

  /**
   * Joining with a display name alone, where the host allows guests. The
   * policy is read inside the same write that creates the guest, so a page
   * that still says guests are welcome cannot let one in after the host said
   * no. Rationed by address like any sign-in, and bounded in number.
   */
  app.post("/api/auth/guest", async (req, reply) => {
    const body = guestJoinBody.parse(req.body);
    ration("authByAddress", callerAddress(req));
    const { token, user } = mutate((emit) => {
      if (accessPolicy() !== "guest_allowed")
        throw new HttpError(403, "guest_access_off", "This workspace needs an account to join.");
      // The first person here claims it as owner, which a guest never does.
      if (store.userCount() === 0)
        throw new HttpError(403, "workspace_unclaimed", "This workspace has no owner yet.");
      if (store.liveGuestSessions() >= MAX_GUEST_SESSIONS)
        throw new HttpError(429, "guests_full", "Too many guests are here now. Try again later.");
      let handle = "";
      do handle = `guest-${secretToken().slice(0, 10).toLowerCase()}`;
      while (store.getUserAuthByHandle(handle));
      // No password can match these: a guest cannot sign in, only resume.
      const user = store.createUser({
        handle,
        displayName: body.displayName,
        passwordHash: "",
        salt: "",
        role: "guest",
      });
      emit({ type: "user.joined", user }, null);
      joinPublicChannels(user.id, emit);
      const { token, tokenHash } = newSessionToken();
      store.createSession(tokenHash, user.id, deviceName(req), GUEST_SESSION_TTL_MS);
      return { token, user };
    });
    return reply.status(201).send({ token, user });
  });

  /**
   * A guest keeping who they are as an account: same id, so their messages
   * and rooms stay theirs. Only while accounts can be created without an
   * invite, and a new session replaces every guest one.
   */
  app.post("/api/auth/guest/account", async (req) => {
    const me = requireUser(req);
    const body = guestAccountBody.parse(req.body);
    if (me.role !== "guest") throw new HttpError(400, "not_a_guest");
    ration("authByAddress", callerAddress(req));
    ration("authByHandle", body.handle.toLowerCase());
    beginAuth();
    let credentials: Awaited<ReturnType<typeof hashPassword>>;
    try {
      credentials = await hashPassword(body.password);
    } finally {
      authJobs--;
    }
    const { token, user, revoked } = mutate((emit) => {
      // Hashing yields: the guest may have been signed out meanwhile.
      const current = requireUser(req);
      if (current.id !== me.id || current.role !== "guest")
        throw new HttpError(409, "credentials_changed");
      if (inviteOnly())
        throw new HttpError(403, "invite_required", "This workspace needs an invite to join.");
      if (store.getUserAuthByHandle(body.handle)) throw new HttpError(409, "handle_taken");
      const user = store.convertGuest(me.id, body.handle, credentials.hash, credentials.salt);
      const revoked = store.revokeSessions(me.id);
      const { token, tokenHash } = newSessionToken();
      store.createSession(tokenHash, me.id, deviceName(req));
      emit({ type: "user.updated", user }, null);
      return { token, user, revoked };
    });
    for (const tokenHash of revoked) gateway.disconnectSession(tokenHash);
    authSucceeded(body.handle);
    return { token, user };
  });

  app.post("/api/auth/login", async (req) => {
    const body = loginBody.parse(req.body);
    // Keyed on the handle as well as the address: an account is worth
    // protecting from many machines, and an address from many accounts.
    ration("authByAddress", callerAddress(req));
    ration("authByHandle", body.handle.toLowerCase());
    const auth = store.getUserAuthByHandle(body.handle);
    beginAuth();
    let valid = false;
    try {
      valid =
        !!auth &&
        !auth.deactivated &&
        // A guest has no password: it resumes its session or joins again.
        auth.role !== "guest" &&
        (await verifyPassword(body.password, auth.salt, auth.passwordHash));
    } finally {
      authJobs--;
    }
    const latest = auth ? store.getUserAuthByHandle(auth.handle) : null;
    if (
      !auth ||
      !valid ||
      !latest ||
      latest.deactivated ||
      latest.passwordHash !== auth.passwordHash ||
      latest.salt !== auth.salt
    ) {
      throw new HttpError(401, "invalid_credentials");
    }
    authSucceeded(auth.handle);
    const { token, tokenHash } = newSessionToken();
    store.createSession(tokenHash, auth.id, deviceName(req));
    const { passwordHash: _p, salt: _s, ...user } = latest;
    return { token, user, mustChangePassword: store.mustChangePassword(auth.id) };
  });

  app.post("/api/auth/logout", async (req) => {
    const token = bearerToken(req);
    if (token) {
      const tokenHash = hashToken(token);
      store.deleteSession(tokenHash);
      gateway.disconnectSession(tokenHash);
    }
    return { ok: true };
  });

  /**
   * Changing a password proves you know the current one, then signs out
   * everywhere else. A password is usually changed because someone else might
   * know it; leaving their sessions running would defeat the whole exercise.
   */
  app.post("/api/auth/password", async (req) => {
    const me = requireUser(req);
    const body = changePasswordBody.parse(req.body);
    // The current password is guessable here too, by whoever has the session.
    ration("authByHandle", me.handle.toLowerCase());
    const auth = store.getUserAuthByHandle(me.handle);
    if (!auth) throw new HttpError(404, "user_not_found");
    beginAuth();
    let valid = false;
    try {
      valid = await verifyPassword(body.currentPassword, auth.salt, auth.passwordHash);
    } finally {
      authJobs--;
    }
    if (!valid)
      throw new HttpError(403, "invalid_credentials", "that is not your current password");
    authSucceeded(me.handle);
    beginAuth();
    let credentials: Awaited<ReturnType<typeof hashPassword>>;
    try {
      credentials = await hashPassword(body.newPassword);
    } finally {
      authJobs--;
    }
    // Hashing yields: sign-out, deactivation, or another reset may have happened meanwhile.
    requireUser(req);
    const latest = store.getUserAuthByHandle(me.handle);
    if (!latest || latest.passwordHash !== auth.passwordHash || latest.salt !== auth.salt) {
      throw new HttpError(
        409,
        "credentials_changed",
        "Your password changed while this request was running. Sign in again.",
      );
    }
    const keep = hashToken(bearerToken(req)!);
    const revokedSessions = store.transaction(() => {
      store.setPassword(me.id, credentials.hash, credentials.salt);
      return store.revokeSessions(me.id, { exceptTokenHash: keep });
    });
    for (const revoked of revokedSessions) {
      gateway.disconnectSession(revoked);
    }
    return { ok: true };
  });

  /** Everywhere this account is signed in, so its owner can see and end them. */
  app.get("/api/auth/sessions", async (req) => {
    const me = requireUser(req);
    const current = hashToken(bearerToken(req)!);
    const currentId = store.sessionIdFor(current);
    return {
      sessions: store
        .listSessions(me.id)
        .map((session) => ({ ...session, current: session.id === currentId })),
    };
  });

  app.delete<{ Params: { id: string } }>("/api/auth/sessions/:id", async (req) => {
    const me = requireUser(req);
    const revoked = store.revokeSessions(me.id, { id: req.params.id });
    if (revoked.length === 0) throw new HttpError(404, "session_not_found");
    for (const tokenHash of revoked) gateway.disconnectSession(tokenHash);
    return { ok: true };
  });

  /** "Sign out my other devices" — the one asking stays signed in. */
  app.delete("/api/auth/sessions", async (req) => {
    const me = requireUser(req);
    const keep = hashToken(bearerToken(req)!);
    const revoked = store.revokeSessions(me.id, { exceptTokenHash: keep });
    for (const tokenHash of revoked) gateway.disconnectSession(tokenHash);
    return { revoked: revoked.length };
  });

  // ---------- me / users ----------

  app.get("/api/me", async (req) => ({ user: requireUser(req) }));

  app.patch("/api/me", async (req) => {
    const me = requireUser(req);
    const body = updateMeBody.parse(req.body);
    const statusChanged =
      body.statusText !== undefined ||
      body.statusEmoji !== undefined ||
      body.statusExpiresAt !== undefined;
    const result = mutate((emit) => {
      const user = store.updateUser(me.id, {
        ...body,
        // A new status without an end keeps no earlier status's end.
        ...((body.statusText !== undefined || body.statusEmoji !== undefined) &&
        body.statusExpiresAt === undefined
          ? { statusExpiresAt: null }
          : {}),
      });
      emit({ type: "user.updated", user }, null);
      return { user };
    });
    if (statusChanged) armStatusExpiry();
    return result;
  });

  app.get("/api/users", async (req) => {
    requireUser(req);
    return { users: store.listUsers() };
  });

  // ---------- channels ----------

  const publishFriends = (a: ID, b: ID) => {
    for (const id of [a, b])
      gateway.sendToUser(id, { type: "friends", friends: store.listFriends(id) });
  };
  app.get("/api/friends", async (req) => ({ friends: store.listFriends(requireUser(req).id) }));
  app.post<{ Params: { id: string } }>("/api/friends/:id", async (req) => {
    const me = requireUser(req);
    const other = store.getUser(req.params.id);
    if (!other || other.deactivated || other.isBot || other.id === me.id)
      throw new HttpError(400, "invalid_friend");
    if (other.role === "guest") throw guestRestricted();
    store.requestFriend(me.id, other.id);
    publishFriends(me.id, other.id);
    return { friends: store.listFriends(me.id) };
  });
  app.put<{ Params: { id: string } }>("/api/friends/:id", async (req) => {
    const me = requireUser(req);
    if (!store.acceptFriend(me.id, req.params.id)) throw new HttpError(404, "request_not_found");
    publishFriends(me.id, req.params.id);
    return { friends: store.listFriends(me.id) };
  });
  app.delete<{ Params: { id: string } }>("/api/friends/:id", async (req) => {
    const me = requireUser(req);
    store.removeFriend(me.id, req.params.id);
    publishFriends(me.id, req.params.id);
    return { friends: store.listFriends(me.id) };
  });

  app.get("/api/channels", async (req) => {
    const me = requireUser(req);
    return { channels: store.listChannelsVisibleTo(me.id) };
  });

  app.post("/api/channels", async (req, reply) => {
    const me = requireUser(req);
    const body = createChannelBody.parse(req.body);
    return mutate((emit) => {
      if (body.type === "public" || body.type === "private") {
        if (store.getChannelByName(body.name)) throw new HttpError(409, "name_taken");
        // A public channel takes in everyone here, as Discord's do, so it
        // shows up for them at once; each can leave it. A private one only
        // the people it was made for.
        const memberIds = [
          ...new Set([
            me.id,
            ...(body.type === "private" ? (body.memberIds ?? []) : store.listPeopleIds()),
          ]),
        ];
        if (body.type === "private") {
          for (const id of memberIds) {
            const member = store.getUser(id);
            if (!member) throw new HttpError(400, "unknown_user", id);
            if (member.role === "guest") throw guestRestricted();
          }
        }
        const channel = store.createChannel({
          type: body.type,
          name: body.name,
          topic: body.topic,
          description: body.description,
          creatorId: me.id,
          memberIds,
        });
        emit({ type: "channel.created", channel }, channel.id);
        // Named channels carry no memberIds, so announce the founding members
        // explicitly or clients won't know they belong to it.
        for (const userId of memberIds) {
          emit({ type: "member.joined", channelId: channel.id, userId }, channel.id);
        }
        reply.status(201);
        return { channel };
      }

      // dm / group_dm — idempotent on the member set.
      const memberIds = [...new Set([me.id, ...body.memberIds])].sort();
      for (const id of memberIds) {
        const member = store.getUser(id);
        if (!member) throw new HttpError(400, "unknown_user", id);
        if (member.role === "guest") throw guestRestricted();
      }
      const dmKey = memberIds.join(":");
      const existing = store.findDmByKey(dmKey);
      if (existing) {
        if ([...(existing.memberIds ?? [])].sort().join(":") === dmKey)
          return { channel: existing };
        // Legacy groups may still have the original key after someone left.
        // Never restore that person's access to the group's intervening history.
        store.retireDmKey(existing.id);
      }

      const channel = store.createChannel({
        type: memberIds.length === 2 ? "dm" : "group_dm",
        creatorId: me.id,
        memberIds,
        dmKey,
      });
      emit({ type: "channel.created", channel }, channel.id);
      reply.status(201);
      return { channel };
    });
  });

  app.patch<{ Params: { id: string } }>("/api/channels/:id", async (req) => {
    const me = requireUser(req);
    const existing = requireChannelAccess(req.params.id, me);
    if (existing.type === "dm" || existing.type === "group_dm") {
      throw new HttpError(400, "cannot_edit_dm");
    }
    const body = updateChannelBody.parse(req.body);
    if (!channelPermissions(me, existing, store.isMember(existing.id, me.id)).manage) {
      throw new HttpError(403, "channel_management_required");
    }
    if (body.name && body.name !== existing.name && store.getChannelByName(body.name)) {
      throw new HttpError(409, "name_taken");
    }
    return mutate((emit) => {
      const channel = store.updateChannel(existing.id, body);
      emit({ type: "channel.updated", channel }, channel.id);
      return { channel };
    });
  });

  app.post<{ Params: { id: string } }>("/api/channels/:id/join", async (req) => {
    const me = requireUser(req);
    const channel = store.getChannel(req.params.id);
    if (!channel || channel.type !== "public") throw new HttpError(404, "channel_not_found");
    if (channel.archived) throw new HttpError(400, "channel_archived");
    mutate((emit) => {
      if (store.addMember(channel.id, me.id)) {
        emit({ type: "member.joined", channelId: channel.id, userId: me.id }, channel.id);
      }
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/channels/:id/leave", async (req) => {
    const me = requireUser(req);
    const channel = requireChannelAccess(req.params.id, me);
    if (channel.type === "dm") throw new HttpError(400, "cannot_leave_dm");
    mutate((emit, afterCommit) => {
      if (store.removeMember(channel.id, me.id)) {
        afterCommit(() => gateway.updateChannelAccess(channel.id, me.id));
        emit({ type: "member.left", channelId: channel.id, userId: me.id }, channel.id);
        if (channel.type === "group_dm")
          emit({ type: "channel.updated", channel: store.getChannel(channel.id)! }, channel.id);
        if (channel.managerIds?.includes(me.id))
          emit({ type: "channel.updated", channel: store.getChannel(channel.id)! }, channel.id);
      }
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/channels/:id/invite-member", async (req) => {
    const me = requireUser(req);
    const channel = requireChannelAccess(req.params.id, me);
    const { userId } = (req.body ?? {}) as { userId?: string };
    const invited = typeof userId === "string" ? store.getUser(userId) : null;
    if (!invited || typeof userId !== "string") throw new HttpError(400, "unknown_user");
    if (channel.type === "dm" || channel.type === "group_dm") {
      throw new HttpError(400, "cannot_invite_to_dm");
    }
    if (invited.role === "guest" && channel.type !== "public") throw guestRestricted();
    if (!channelPermissions(me, channel, store.isMember(channel.id, me.id)).invite) {
      throw new HttpError(403, "channel_invite_forbidden");
    }
    mutate((emit, afterCommit) => {
      if (store.addMember(channel.id, userId)) {
        afterCommit(() => gateway.updateChannelAccess(channel.id, userId));
        emit({ type: "member.joined", channelId: channel.id, userId }, channel.id);
      }
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; userId: string } }>(
    "/api/channels/:id/members/:userId",
    async (req) => {
      const me = requireUser(req);
      const channel = requireChannelAccess(req.params.id, me);
      const target = store.getUser(req.params.userId);
      if (
        !canRemoveChannelMember(me, target ?? undefined, channel, store.isMember(channel.id, me.id))
      ) {
        throw new HttpError(403, "channel_removal_forbidden");
      }
      mutate((emit, afterCommit) => {
        if (store.removeMember(channel.id, req.params.userId)) {
          afterCommit(() => gateway.updateChannelAccess(channel.id, req.params.userId));
          if (channel.managerIds?.includes(req.params.userId))
            emit({ type: "channel.updated", channel: store.getChannel(channel.id)! }, channel.id);
          emit(
            { type: "member.left", channelId: channel.id, userId: req.params.userId },
            channel.id,
          );
        }
      });
      return { ok: true };
    },
  );

  app.patch<{ Params: { id: string; userId: string } }>(
    "/api/channels/:id/managers/:userId",
    async (req) => {
      const me = requireUser(req);
      const channel = requireChannelAccess(req.params.id, me);
      const target = store.getUser(req.params.userId);
      const { manager } = channelManagerBody.parse(req.body);
      if (
        !canSetChannelManager(
          me,
          target ?? undefined,
          channel,
          store.isMember(channel.id, me.id),
          manager,
        )
      ) {
        throw new HttpError(403, "channel_manager_assignment_forbidden");
      }
      if (!store.isMember(channel.id, req.params.userId))
        throw new HttpError(409, "channel_membership_required");
      return mutate((emit) => {
        const changed = store.setChannelManager(channel.id, req.params.userId, manager);
        const updated = store.getChannel(channel.id)!;
        if (changed) emit({ type: "channel.updated", channel: updated }, channel.id);
        return { channel: updated };
      });
    },
  );

  app.get<{ Params: { id: string } }>("/api/channels/:id/members", async (req) => {
    const me = requireUser(req);
    requireChannelAccess(req.params.id, me);
    return { memberIds: store.memberIds(req.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/channels/:id/read", async (req) => {
    const me = requireUser(req);
    requireChannelAccess(req.params.id, me);
    const { seq } = markReadBody.parse(req.body);
    if (!store.isMember(req.params.id, me.id)) throw new HttpError(404, "channel_not_found");
    const { seq: acknowledged, threads } = store.markRead(req.params.id, me.id, seq);
    gateway.sendToUser(me.id, {
      type: "channel.read",
      channelId: req.params.id,
      seq: acknowledged,
    });
    // Replies also sent to the channel were read there, and so in their threads.
    for (const rootId of threads) {
      const state = store.threadFollow(me.id, rootId);
      if (state) gateway.sendToUser(me.id, { type: "thread.follow", state });
    }
    pushMentionCounts([me.id]);
    return { ok: true, seq: acknowledged };
  });

  app.post<{ Params: { id: string } }>("/api/channels/:id/unread", async (req) => {
    const me = requireUser(req);
    requireChannelAccess(req.params.id, me);
    const { seq } = markUnreadBody.parse(req.body);
    if (!store.isMember(req.params.id, me.id)) throw new HttpError(404, "channel_not_found");
    const seqNow = store.markUnread(req.params.id, me.id, seq);
    if (seqNow === null) throw new HttpError(400, "invalid_unread_target");
    gateway.sendToUser(me.id, { type: "channel.unread", channelId: req.params.id, seq: seqNow });
    pushMentionCounts([me.id]);
    return { ok: true, seq: seqNow };
  });

  // ---------- messages ----------

  app.get<{ Params: { id: string; rootId: string } }>(
    "/api/channels/:id/threads/:rootId",
    async (req) => {
      const me = requireUser(req);
      requireChannelAccess(req.params.id, me);
      const query = threadHistoryQuery.parse(req.query);
      const root = store.getMessage(req.params.rootId);
      if (!root || root.channelId !== req.params.id || root.threadRootId)
        throw new HttpError(404, "thread_not_found");
      if (query.around) {
        const target = store.getMessage(query.around);
        if (!target || target.channelId !== root.channelId || target.threadRootId !== root.id)
          throw new HttpError(404, "message_not_found");
      }
      return {
        root,
        ...store.threadHistory(root.channelId, root.id, query),
        seq: store.currentSeq(),
      };
    },
  );

  app.get<{ Params: { id: string } }>("/api/channels/:id/messages", async (req) => {
    const me = requireUser(req);
    requireChannelAccess(req.params.id, me);
    const q = messageHistoryQuery.parse(req.query);
    const messages = store.listMessages({
      channelId: req.params.id,
      before: q.before,
      limit: q.limit,
      threadRootId: q.threadRootId,
    });
    return {
      messages,
      readThroughSeq: store.lastMessageSeq(req.params.id),
      seq: store.currentSeq(),
    };
  });

  app.get<{ Params: { id: string; messageId: string } }>(
    "/api/channels/:id/messages/around/:messageId",
    async (req) => {
      const me = requireUser(req);
      requireChannelAccess(req.params.id, me);
      const { limit } = messageHistoryQuery.parse(req.query);
      const target = store.getMessage(req.params.messageId);
      if (!target || target.channelId !== req.params.id)
        throw new HttpError(404, "message_not_found");
      const rootId = target.threadRootId ?? target.id;
      if (target.threadRootId && !store.getMessage(rootId))
        throw new HttpError(404, "thread_not_found");
      return {
        ...store.listMessagesAround(req.params.id, rootId, limit),
        threadRootId: target.threadRootId,
        seq: store.currentSeq(),
      };
    },
  );

  app.get<{ Params: { id: string; messageId: string } }>(
    "/api/channels/:id/messages/after/:messageId",
    async (req) => {
      const me = requireUser(req);
      requireChannelAccess(req.params.id, me);
      const { limit } = messageHistoryQuery.parse(req.query);
      return {
        messages: store.listMessagesAfter(req.params.id, req.params.messageId, limit),
        seq: store.currentSeq(),
      };
    },
  );

  app.post<{ Params: { id: string } }>("/api/channels/:id/messages", async (req, reply) => {
    const me = requireUser(req);
    // Keyed on the account, not the address: a whole office behind one address
    // should not share one person's allowance.
    ration("post", me.id);
    const channel = requireChannelAccess(req.params.id, me);
    if (channel.archived) throw new HttpError(400, "channel_archived");
    const body = sendMessageBody.parse(req.body);

    const message = postMessage({
      channelId: channel.id,
      userId: me.id,
      text: body.text,
      threadRootId: body.threadRootId ?? null,
      nonce: body.nonce ?? null,
      fileIds: body.fileIds ?? [],
      broadcast: body.alsoSendToChannel ?? false,
      replyToId: body.replyToId ?? null,
      // Discord notifies the author unless the reply says not to.
      replyPing: body.replyPing ?? true,
    });
    return reply.status(201).send({ message });
  });

  app.patch<{ Params: { id: string } }>("/api/messages/:id", async (req) => {
    const me = requireUser(req);
    const existing = store.getMessage(req.params.id);
    if (!existing || !store.canAccess(existing.channelId, me.id)) {
      throw new HttpError(404, "message_not_found");
    }
    if (existing.userId !== me.id) throw new HttpError(403, "not_your_message");
    const body = editMessageBody.parse(req.body);
    // Words already the new ones are a retry whose answer was lost, not a conflict.
    if (
      body.expectedText !== undefined &&
      existing.text !== body.expectedText &&
      existing.text !== body.text
    ) {
      throw new HttpError(
        409,
        "message_changed",
        "This message has changed. Choose which version to keep before saving.",
      );
    }
    return { message: updateMessage(existing, body.text) };
  });

  app.delete<{ Params: { id: string } }>("/api/messages/:id", async (req) => {
    const me = requireUser(req);
    const existing = store.getMessage(req.params.id);
    if (!existing || !store.canAccess(existing.channelId, me.id)) {
      throw new HttpError(404, "message_not_found");
    }
    const isPrivileged = me.role === "owner" || me.role === "admin";
    if (existing.userId !== me.id && !isPrivileged) throw new HttpError(403, "not_your_message");

    removeMessage(existing);
    await flushFileDeletions();
    return { ok: true };
  });

  // ---------- files ----------

  app.get("/api/storage", async (req) => {
    requireUser(req);
    return {
      usedBytes: storage.usedBytes,
      limitBytes: storage.limitBytes,
      maxFileBytes: maxFileSize,
      availableBytes:
        storage.limitBytes === null ? null : Math.max(0, storage.limitBytes - storage.usedBytes),
    };
  });

  app.post<{ Params: { id: string } }>("/api/channels/:id/files", async (req, reply) => {
    const me = requireUser(req);
    ration("upload", me.id);
    const channel = requireChannelAccess(req.params.id, me);
    if (!filesDir) throw new HttpError(501, "uploads_disabled");

    const part = await req.file();
    if (!part) throw new HttpError(400, "no_file");

    const id = ulid();
    let size = 0;
    let headerSize = 0;
    const header: Buffer[] = [];
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        if (!storage.reserve(id, chunk.length)) {
          done(
            new HttpError(
              507,
              "storage_quota_exceeded",
              "Workspace attachment storage is full. Ask the host to free space or raise the limit.",
            ),
          );
          return;
        }
        size += chunk.length;
        if (headerSize < 64 * 1024) {
          const part = Buffer.from(chunk.subarray(0, 64 * 1024 - headerSize));
          header.push(part);
          headerSize += part.length;
        }
        done(null, chunk);
      },
    });
    try {
      await pipeline(part.file, meter, createWriteStream(blobPath(id), { flags: "wx" }));
      if (part.file.truncated)
        throw new HttpError(413, "file_too_large", `files must be under ${maxFileSize} bytes`);
      // Upload streaming yields; access may have been revoked while bytes arrived.
      requireUser(req);
      requireChannelAccess(channel.id, me);
      const dims = part.mimetype.startsWith("image/") ? imageSize(Buffer.concat(header)) : null;
      const file = store.createFile({
        id,
        channelId: channel.id,
        userId: me.id,
        name: part.filename.slice(0, 255),
        mime: part.mimetype,
        size,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
      });
      return reply.status(201).send({ file });
    } catch (err) {
      try {
        await unlink(blobPath(id));
        storage.release(id);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code === "ENOENT") storage.release(id);
        else store.queueFileDeletions([id]);
      }
      throw err;
    }
  });

  /**
   * A one-shot ticket for downloading one file.
   *
   * A browser saving a file to disk cannot send an Authorization header on the
   * navigation that does it, so without this the only way to reach an
   * auth-gated file is to fetch the whole thing into memory first. That turns
   * every large download into a browser-sized blob. The ticket lets the
   * download be an ordinary navigation the browser streams straight to disk.
   *
   * It is short-lived and spent on first use, so the copy that appears in a URL
   * is worth little for long. Access is checked again when it is redeemed
   * rather than trusted from when it was issued.
   */
  const DOWNLOAD_TOKEN_TTL_MS = 60_000;

  app.post<{ Params: { id: string } }>("/api/files/:id/download-token", async (req, reply) => {
    const me = requireUser(req);
    const file = store.getFile(req.params.id);
    if (!file || !filesDir || !store.canAccess(file.channelId, me.id)) {
      throw new HttpError(404, "file_not_found");
    }
    try {
      const stored = await stat(blobPath(file.id));
      if (!stored.isFile() || stored.size !== file.size) throw new Error("file unavailable");
    } catch {
      throw new HttpError(404, "file_not_found");
    }
    // Disk access yields; issue nothing if the session or file disappeared.
    requireUser(req);
    if (!store.getFile(file.id) || !store.canAccess(file.channelId, me.id)) {
      throw new HttpError(404, "file_not_found");
    }
    const { token, tokenHash } = newSessionToken();
    const expiresAt = Date.now() + DOWNLOAD_TOKEN_TTL_MS;
    store.createDownloadToken(tokenHash, file.id, me.id, hashToken(bearerToken(req)!), expiresAt);
    reply.header("cache-control", "no-store");
    return { token, expiresAt };
  });

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    "/api/files/:id",
    async (req, reply) => {
      // A ticket stands in for the header a navigation cannot carry. Whoever
      // spends it still has to pass the checks its issuer passed.
      const ticket = req.query.download;
      let viewerId: ID;
      let sessionHash: string;
      if (ticket !== undefined) {
        if (req.method !== "GET" || typeof ticket !== "string" || !/^[a-f0-9]{64}$/.test(ticket))
          throw new HttpError(404, "file_not_found");
        reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
        const spent = store.consumeDownloadToken(hashToken(ticket));
        if (!spent || spent.fileId !== req.params.id) throw new HttpError(404, "file_not_found");
        const viewer = store.getSessionUser(spent.sessionHash);
        if (!viewer || viewer.id !== spent.userId || store.mustChangePassword(viewer.id)) {
          throw new HttpError(404, "file_not_found");
        }
        viewerId = viewer.id;
        sessionHash = spent.sessionHash;
      } else {
        viewerId = requireUser(req).id;
        sessionHash = hashToken(bearerToken(req)!);
      }

      const file = store.getFile(req.params.id);
      if (!file || !filesDir || !store.canAccess(file.channelId, viewerId)) {
        throw new HttpError(404, "file_not_found");
      }
      let body;
      let handle;
      try {
        handle = await open(blobPath(file.id), "r");
        const stored = await handle.stat();
        if (!stored.isFile() || stored.size !== file.size) throw new Error("file unavailable");
        // Disk access yields; sign-out, deletion or private-room departure may have happened.
        const current = store.getSessionUser(sessionHash);
        if (
          !current ||
          !store.getFile(file.id) ||
          store.mustChangePassword(current.id) ||
          !store.canAccess(file.channelId, current.id)
        )
          throw new Error("file access changed");
        body = handle.createReadStream();
      } catch {
        await handle?.close();
        throw new HttpError(404, "file_not_found");
      }
      const encodedName = encodeURIComponent(file.name);
      // A member can lose access after a download. A fresh request must reach
      // the server so the current session and channel permissions are checked.
      return reply
        .header("content-type", file.mime)
        .header("x-content-type-options", "nosniff")
        .header("content-length", String(file.size))
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .header("accept-ranges", "none")
        .header(
          "content-disposition",
          `${ticket ? "attachment" : "inline"}; filename*=UTF-8''${encodedName}`,
        )
        .send(body);
    },
  );

  // ---------- reactions ----------

  app.put<{ Params: { id: string; emoji: string } }>(
    "/api/messages/:id/reactions/:emoji",
    async (req) => {
      const me = requireUser(req);
      const msg = store.getMessage(req.params.id);
      if (!msg || !store.canAccess(msg.channelId, me.id)) {
        throw new HttpError(404, "message_not_found");
      }
      const emoji = decodeURIComponent(req.params.emoji).slice(0, 64);
      mutate((emit) => {
        if (store.addReaction(msg.id, me.id, emoji)) {
          emit(
            {
              type: "reaction.added",
              channelId: msg.channelId,
              messageId: msg.id,
              emoji,
              userId: me.id,
            },
            msg.channelId,
          );
        }
      });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; emoji: string } }>(
    "/api/messages/:id/reactions/:emoji",
    async (req) => {
      const me = requireUser(req);
      const msg = store.getMessage(req.params.id);
      if (!msg || !store.canAccess(msg.channelId, me.id)) {
        throw new HttpError(404, "message_not_found");
      }
      const emoji = decodeURIComponent(req.params.emoji).slice(0, 64);
      mutate((emit) => {
        if (store.removeReaction(msg.id, me.id, emoji)) {
          emit(
            {
              type: "reaction.removed",
              channelId: msg.channelId,
              messageId: msg.id,
              emoji,
              userId: me.id,
            },
            msg.channelId,
          );
        }
      });
      return { ok: true };
    },
  );

  // ---------- apps, webhooks and the Slack-compatible API ----------

  const requireAdmin = (req: FastifyRequest): User => {
    const me = requireUser(req);
    if (me.role !== "owner" && me.role !== "admin") throw new HttpError(403, "admin_only");
    return me;
  };

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

  /**
   * For the owner and admins: whether the server is keeping up, from counts,
   * sizes and times alone. Nothing from a conversation, an app's delivery
   * error or a credential is in it.
   */
  app.get("/api/admin/status", async (req, reply): Promise<WorkspaceStatus> => {
    requireAdmin(req);
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
        removal: store.fileDeletionCounts(),
      },
      diskFreeBytes,
      deliveries: counts.deliveries,
      scheduled: counts.scheduled,
      retention: {
        enabled: retentionMs > 0,
        lastSuccessAt: retention.lastSuccessAt,
        failures: retention.failures,
      },
      connections: { sockets: gateway.socketCount(), people: gateway.onlineUserIds().length },
      eventLoopDelayMs: lastMinuteDelay,
      backgroundFailures: [...backgroundFailures].map(([queue, failing]) => ({
        queue,
        ...failing,
      })),
    };
  });

  /**
   * For the owner and admins: what happened in huddles lately (see
   * `CallLog`), in the conversations they can see themselves. Memory only.
   */
  app.get("/api/admin/calls", async (req, reply): Promise<{ entries: CallLogEntry[] }> => {
    const me = requireAdmin(req);
    reply.header("Cache-Control", "no-store");
    return { entries: gateway.calls.entries((channelId) => store.canAccess(channelId, me.id)) };
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
    while (store.getUserAuthByHandle(handle)) handle = `${base}-bot-${n++}`;
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

  /** Identifies an invite in the audit log without writing down the code itself. */
  const inviteFingerprint = (code: string) => hashToken(code).slice(0, 12);

  app.post("/api/apps", async (req, reply) => {
    const me = requireAdmin(req);
    const body = createAppBody.parse(req.body);

    // A bot posts as a real (non-human) user, so messages render normally.
    beginAuth();
    let credentials: Awaited<ReturnType<typeof hashPassword>>;
    try {
      credentials = await hashPassword(secretToken());
    } finally {
      authJobs--;
    }
    requireAdmin(req);
    const result = mutate((emit) => {
      const { hash, salt } = credentials;
      const bot = store.createBotUser(botHandle(body.name), body.name, hash, salt);
      const signingSecret = secretToken();
      const created = store.createApp({
        name: body.name,
        botUserId: bot.id,
        createdBy: me.id,
        signingSecret,
      });

      const token = secretToken("xoxb-");
      store.addAppToken(created.id, hashToken(token));
      store.recordAudit({
        actorId: me.id,
        action: "app.created",
        targetType: "app",
        targetId: created.id,
        details: { name: created.name },
      });
      emit({ type: "user.joined", user: bot }, null);

      // The bot token is shown once and only stored hashed; the signing secret
      // stays readable to admins because verification needs the key itself.
      return { app: created, botUser: bot, token, signingSecret };
    });
    return reply.status(201).send(result);
  });

  app.get("/api/apps", async (req) => {
    requireAdmin(req);
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

  /**
   * A new bot token, replacing every one the app had. For a token that has
   * leaked, and for an admin who closed the dialog before copying the one they
   * were shown at creation, which is otherwise a working app nobody can use.
   *
   * Logged without the token: who replaced which app's credentials is what an
   * operator wants to find afterwards.
   */
  app.post<{ Params: { id: string } }>("/api/apps/:id/token", async (req) => {
    const me = requireAdmin(req);
    const target = store.getApp(req.params.id);
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

  /**
   * A new signing secret. Every request signed from here on uses it, including
   * event deliveries already waiting in the queue, which are signed when they
   * are sent rather than when they were queued. The app refuses them until it
   * has the new secret, which is the point when the old one has leaked.
   */
  app.post<{ Params: { id: string } }>("/api/apps/:id/signing-secret", async (req) => {
    const me = requireAdmin(req);
    const target = store.getApp(req.params.id);
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

  app.delete<{ Params: { id: string } }>("/api/apps/:id", async (req) => {
    const me = requireAdmin(req);
    const target = store.getApp(req.params.id);
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

  app.post<{ Params: { id: string } }>("/api/apps/:id/webhooks", async (req, reply) => {
    const me = requireAdmin(req);
    const owner = store.getApp(req.params.id);
    if (!owner) throw new HttpError(404, "not_found");
    const body = createWebhookBody.parse(req.body);
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
      if (store.addMember(channel.id, owner.botUserId)) {
        emit({ type: "member.joined", channelId: channel.id, userId: owner.botUserId }, channel.id);
      }
      return created;
    });
    return reply.status(201).send({ webhook, url: `/hooks/${token}` });
  });

  /**
   * A new URL for an existing webhook. The secret is the whole of a webhook's
   * authority, so a URL pasted somewhere public has to be replaceable without
   * removing the webhook and choosing its channel again.
   */
  app.post<{ Params: { id: string } }>("/api/webhooks/:id/url", async (req) => {
    const me = requireAdmin(req);
    const token = secretToken();
    const webhook = store.transaction(() => {
      const replaced = store.replaceWebhookToken(req.params.id, hashToken(token));
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

  app.delete<{ Params: { id: string } }>("/api/webhooks/:id", async (req) => {
    const me = requireAdmin(req);
    const deleted = store.transaction(() => {
      const webhook = store.getWebhook(req.params.id);
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

  /**
   * Incoming webhook, shaped like Slack's: POST a JSON body with `text` and/or
   * `blocks`. Form-encoded `payload=<json>` is accepted too, since many older
   * integrations send it that way.
   */
  app.post<{ Params: { token: string } }>("/hooks/:token", async (req, reply) => {
    // Before the lookup, so a wrong token costs as much as a right one.
    ration("hookByAddress", callerAddress(req));
    const found = store.webhookForToken(hashToken(req.params.token));
    if (!found) return reply.status(404).send({ ok: false, error: "invalid_webhook" });
    ration("hook", found.webhook.id);

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

    const text = payloadToText(payload);
    if (!text) return reply.status(400).send({ ok: false, error: "no_text" });

    const channel = store.getChannel(found.webhook.channelId);
    if (!channel || channel.archived) {
      return reply.status(404).send({ ok: false, error: "channel_not_found" });
    }

    if (channel.type !== "public" && !store.isMember(channel.id, found.app.botUserId)) {
      return reply.status(403).send({ ok: false, error: "not_in_channel" });
    }
    postMessage({
      channelId: channel.id,
      userId: found.app.botUserId,
      text,
      threadRootId: null,
      nonce: null,
      fileIds: [],
      actions: blocksToActions(payload.blocks),
    });
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

  /**
   * The app a Web API call is made as. Slack takes the token as a bearer header
   * or as a `token` field in the body, and code written against it uses both.
   */
  const slackCaller = (req: FastifyRequest) => {
    const body = req.body as { token?: unknown } | undefined;
    const token = bearerToken(req) ?? (typeof body?.token === "string" ? body.token : null);
    return token ? store.appForToken(hashToken(token)) : null;
  };

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

  /**
   * Slack's auth.test. Bolt calls it before it will start, and gives up if it
   * fails, so without it no Bolt app could run against this server at all.
   * `bot_id` is the app's id: this server has no separate bot identity.
   */
  app.post("/api/auth.test", async (req) => {
    const owner = slackCaller(req);
    if (!owner) return slackError("invalid_auth");
    const bot = store.getUser(owner.botUserId)!;
    return {
      ok: true,
      url: `${requestOrigin(req)}/`,
      team: workspaceName(),
      user: bot.handle,
      team_id: store.getMeta("workspace_id") ?? "",
      user_id: bot.id,
      bot_id: owner.id,
      is_enterprise_install: false,
    };
  });

  /**
   * Slack Web API compatible send, so existing bot code works by pointing at
   * this server. Errors use Slack's `{ok:false, error}` shape.
   */
  app.post("/api/chat.postMessage", async (req) => {
    const owner = slackCaller(req);
    if (!owner) return slackError("invalid_auth");
    // A bot stuck in a loop is the version of this that nobody is watching.
    ration("post", owner.botUserId);

    const body = (req.body ?? {}) as {
      channel?: string;
      text?: unknown;
      blocks?: unknown;
      thread_ts?: string;
    };
    if (typeof body.channel !== "string" || !body.channel) return slackError("channel_not_found");

    // Slack accepts an id or a #name; so do we.
    const named = body.channel.replace(/^#/, "");
    const channel = store.getChannel(body.channel) ?? store.getChannelByName(named);
    if (!channel || channel.archived) return slackError("channel_not_found");

    if (channel.type !== "public" && !store.isMember(channel.id, owner.botUserId)) {
      return slackError("not_in_channel");
    }

    const blocks = structured(body.blocks);
    const text = payloadToText({ text: body.text, blocks });
    if (!text) return slackError("no_text");

    let threadRootId: ID | null = null;
    if (body.thread_ts) {
      const root = store.getMessage(body.thread_ts);
      // An unknown thread parent is not worth failing the whole send over.
      if (root && root.channelId === channel.id && !root.threadRootId) threadRootId = root.id;
    }

    const message = postMessage({
      channelId: channel.id,
      userId: owner.botUserId,
      text,
      threadRootId,
      nonce: null,
      fileIds: [],
      actions: blocksToActions(blocks),
    });
    // `ts` is Slack's message identifier; ours is the message id.
    return { ok: true, channel: channel.id, ts: message.id, message };
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
    const bot = store.getUser(target.botUserId);
    if (!bot || bot.deactivated) return false;
    if (!store.appForBotUser(target.botUserId)) return false;
    const channel = store.getChannel(target.channelId);
    if (!channel || channel.archived) return false;
    if (!store.canAccess(channel.id, bot.id)) return false;
    const invoker = store.getUser(target.invokerId);
    if (!invoker || invoker.deactivated) return false;
    return store.canAccess(channel.id, invoker.id);
  };

  /** A private note back to the person who ran the command. */
  const sayEphemeral = (channelId: ID, toUserId: ID, fromUserId: ID, text: string): void => {
    gateway.sendToUser(toUserId, {
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
   * the command, which is Slack's default and the safer one.
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
      const existing = store.getMessage(originMessageId);
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
      postMessage({
        channelId: target.channelId,
        userId: target.botUserId,
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

  app.post<{ Params: { id: string } }>("/api/apps/:id/commands", async (req, reply) => {
    const me = requireAdmin(req);
    const owner = store.getApp(req.params.id);
    if (!owner) throw new HttpError(404, "not_found");
    const body = createCommandBody.parse(req.body);
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
    return reply.status(201).send({ command });
  });

  app.delete<{ Params: { id: string } }>("/api/commands/:id", async (req) => {
    const me = requireAdmin(req);
    const deleted = store.transaction(() => {
      const command = store.getSlashCommand(req.params.id);
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

  /** Every command anyone can run, for the composer's hint list. */
  app.get("/api/commands", async (req) => {
    requireUser(req);
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

  /** Runs `/whatever …` typed in a channel. */
  app.post<{ Params: { id: string } }>("/api/channels/:id/commands", async (req) => {
    const me = requireUser(req);
    const channel = requireChannelAccess(req.params.id, me);
    if (channel.archived) throw new HttpError(400, "channel_archived");
    const body = runCommandBody.parse(req.body);
    const threadRootId = body.threadRootId ?? null;

    const parsed = /^\/([a-zA-Z0-9_-]+)\s*([\s\S]*)$/.exec(body.text.trim());
    if (!parsed) throw new HttpError(400, "not_a_command");
    const name = parsed[1]!.toLowerCase();
    const argText = parsed[2]!.trim();

    const builtin = BUILTIN_COMMANDS.get(name);
    if (builtin) {
      const text = builtin.run(argText, me);
      if (text === null) throw new HttpError(400, "usage", `usage: /${name} ${builtin.usageHint}`);
      // Built-ins create ordinary messages, so they spend the sender's post budget.
      ration("post", me.id);
      postMessage({
        channelId: channel.id,
        userId: me.id,
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
        if (store.addMember(channel.id, found.app.botUserId)) {
          emit(
            { type: "member.joined", channelId: channel.id, userId: found.app.botUserId },
            channel.id,
          );
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
        team_id: store.getMeta("workspace_id") ?? "",
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
          signal: shutdown.signal,
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
        const why =
          err instanceof OutboundError && err.code === "blocked_host"
            ? err.message
            : "the app did not answer";
        sayEphemeral(channel.id, me.id, found.app.botUserId, `\`/${name}\` failed: ${why}.`);
        return { ok: false, error: "command_failed", message: why };
      }
    } finally {
      release();
    }
  });

  /** Slack's `response_url`: how an app replies after its first few seconds. */
  app.post<{ Params: { token: string } }>("/api/commands/response/:token", async (req, reply) => {
    const target = responseTargets.get(req.params.token);
    if (!target || target.expiresAt < Date.now() || !capabilityHolds(target)) {
      // A url whose app, channel or audience has gone is spent, not merely
      // unusable this once: keeping it would only invite the same call again.
      responseTargets.delete(req.params.token);
      return reply.status(404).send({ ok: false, error: "expired_url" });
    }
    if (--target.usesLeft <= 0) responseTargets.delete(req.params.token);

    const raw = req.body;
    const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
    deliverCommandReply(target, text, "application/json", target.originMessageId);
    return { ok: true };
  });

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
  app.get("/api/admin/audit", async (req) => {
    requireAdmin(req);
    const query = auditQuery.parse(req.query);
    const entries = store.listAudit({ before: query.before, limit: query.limit + 1 });
    const page = entries.slice(0, query.limit);
    return { entries: page, nextCursor: entries.length > query.limit ? page.at(-1)!.id : null };
  });

  app.get("/api/admin/users", async (req) => {
    requireAdmin(req);
    const lastSeen = store.lastSeenByUser();
    return {
      users: store.listUsers().map((u) => ({ ...u, lastSeenAt: lastSeen[u.id] ?? null })),
    };
  });

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
  app.patch<{ Params: { id: string } }>("/api/admin/users/:id", async (req) => {
    const me = requireAdmin(req);
    const body = adminUserBody.parse(req.body);
    const target = store.getUser(req.params.id);
    if (!target) throw new HttpError(404, "user_not_found");
    if (target.id === me.id) throw new HttpError(400, "cannot_change_self");
    if (target.role === "owner") throw new HttpError(403, "owner_is_protected");
    if (target.role === "admin" && me.role !== "owner") {
      throw new HttpError(403, "admins_are_equals", "only the owner can change another admin");
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
        body.canInvite !== undefined && store.getMemberInvitePermission(target.id);
      const updated = store.updateUser(target.id, {
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
        store.deleteSessionsFor(target.id);
        afterCommit(() => gateway.disconnectUser(target.id));
      }
      // Everyone sees the change, so a deactivated person drops out of the member
      // lists and the composer's autocomplete without a reload.
      emit({ type: "user.updated", user: updated }, null);
      return { user: updated };
    });
  });

  /**
   * Password recovery for an installation with no email: an admin issues a
   * temporary password and reads it to the person over whatever channel they
   * trust. It is shown once, all their sessions end, and they are expected to
   * change it. The rules match those above — the owner cannot be reset by an
   * admin, and nobody resets themselves, since that is what the ordinary
   * password change is for.
   */
  app.post<{ Params: { id: string } }>("/api/admin/users/:id/password", async (req) => {
    const authorize = () => {
      const me = requireAdmin(req);
      const target = store.getUser(req.params.id);
      if (!target) throw new HttpError(404, "user_not_found");
      if (target.id === me.id) throw new HttpError(400, "cannot_reset_self");
      if (target.isBot) throw new HttpError(400, "bots_have_no_password");
      if (target.role === "guest") throw new HttpError(400, "guest_account");
      if (target.role === "owner") throw new HttpError(403, "owner_is_protected");
      if (target.role === "admin" && me.role !== "owner") {
        throw new HttpError(403, "admins_are_equals", "only the owner can reset another admin");
      }
      return target;
    };
    authorize();
    const temporaryPassword = secretToken().slice(0, 16);
    beginAuth();
    let credentials: Awaited<ReturnType<typeof hashPassword>>;
    try {
      credentials = await hashPassword(temporaryPassword);
    } finally {
      authJobs--;
    }
    const target = authorize();
    const actor = requireAdmin(req);
    const revokedSessions = store.transaction(() => {
      store.setPassword(target.id, credentials.hash, credentials.salt, true);
      const revoked = store.revokeSessions(target.id);
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

  /**
   * Hands the workspace to someone else. Only the owner can do it, and they
   * become an admin rather than losing their access — a workspace with no owner
   * is the state this whole area exists to prevent.
   */
  app.post<{ Params: { id: string } }>("/api/admin/users/:id/owner", async (req) => {
    const me = requireUser(req);
    if (me.role !== "owner") throw new HttpError(403, "owner_only");
    const target = store.getUser(req.params.id);
    if (!target) throw new HttpError(404, "user_not_found");
    if (target.id === me.id) throw new HttpError(400, "already_owner");
    if (target.isBot || target.deactivated || target.role === "guest")
      throw new HttpError(400, "invalid_owner");
    return mutate((emit) => {
      const newOwner = store.updateUser(target.id, { role: "owner" });
      const formerOwner = store.updateUser(me.id, { role: "admin" });
      store.recordAudit({
        actorId: me.id,
        action: "workspace.ownership_transferred",
        targetType: "user",
        targetId: target.id,
        details: { previousOwner: me.id },
      });
      emit({ type: "user.updated", user: newOwner }, null);
      emit({ type: "user.updated", user: formerOwner }, null);
      return { owner: newOwner, previousOwner: formerOwner };
    });
  });

  // ---------- workspace settings (UX-60) ----------

  /**
   * The workspace's name, for its owner and admins. The host renames it by
   * the same rule, so the two cannot drift apart.
   */
  app.put("/api/admin/workspace/name", async (req) => {
    const me = requireAdmin(req);
    const { name } = workspaceNameBody.parse(req.body);
    return { workspaceName: renameWorkspace(name, me.id) };
  });

  /**
   * Who may join, for its owner and admins: the stored choice every start
   * keeps, and the same one the desktop host changes. Leaving guests allowed
   * signs every guest out at once.
   */
  app.put("/api/admin/workspace/access-policy", async (req) => {
    const me = requireAdmin(req);
    const body = accessPolicyBody.parse(req.body);
    changeAccessPolicy(body.accessPolicy, me.id);
    return { accessPolicy: accessPolicy() };
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
    expiresAt: number;
  }
  const openViews = new CapabilityMap<OpenView>(CAPABILITIES_ALIVE.openViews);
  const submittingViews = new Set<ID>();

  /**
   * Slack's views.open. The trigger_id decides who sees it, so an app cannot
   * open a modal in front of someone who did not just ask for one.
   */
  app.post("/api/views.open", async (req) => {
    const owner = slackCaller(req);
    if (!owner) return slackError("invalid_auth");

    const body = (req.body ?? {}) as { trigger_id?: unknown; view?: unknown };
    const trigger = typeof body.trigger_id === "string" ? triggers.get(body.trigger_id) : undefined;
    if (!trigger || trigger.expiresAt < Date.now()) {
      if (typeof body.trigger_id === "string") triggers.delete(body.trigger_id);
      return slackError("expired_trigger_id");
    }
    // The trigger belongs to whoever it was issued for, and to that app alone.
    if (trigger.appId !== owner.id) return slackError("trigger_not_yours");
    if (!capabilityHolds({ ...trigger, invokerId: trigger.userId })) {
      triggers.delete(body.trigger_id as string);
      return slackError("expired_trigger_id");
    }
    triggers.delete(body.trigger_id as string);

    const id = ulid();
    const { droppedFields, ...view } = parseView(structured(body.view), id);
    if (view.fields.length === 0) {
      // Either there was nothing to fill in, or everything in it was a control
      // we cannot draw. Saying so beats showing an empty box.
      return slackError(droppedFields > 0 ? "unsupported_elements" : "no_inputs");
    }

    const now = Date.now();
    openViews.set(
      id,
      {
        view,
        userId: trigger.userId,
        channelId: trigger.channelId,
        appId: owner.id,
        botUserId: owner.botUserId,
        expiresAt: now + 30 * 60_000,
      },
      now,
    );
    gateway.sendToUser(trigger.userId, { type: "view.open", view });
    return { ok: true, view: { id, callback_id: view.callbackId } };
  });

  /**
   * Someone filled the form in and pressed submit. The values go to the app as
   * Slack's `view_submission`; field errors it answers with come back to the
   * client so they can be shown against the fields they belong to.
   */
  app.post<{ Params: { id: string } }>("/api/views/:id/submit", async (req) => {
    const me = requireUser(req);
    const body = viewSubmitBody.parse(req.body);
    const open = openViews.get(req.params.id);
    // A view belongs to the one person it was opened for.
    if (!open || open.userId !== me.id || open.expiresAt < Date.now()) {
      // A request from another account must not consume the owner's view.
      if (!open || open.expiresAt < Date.now()) openViews.delete(req.params.id);
      throw new HttpError(404, "view_not_found");
    }
    const owner = store.getApp(open.appId);
    if (!owner?.interactivityUrl) {
      openViews.delete(open.view.id);
      throw new HttpError(400, "no_interactivity_url");
    }
    // A form can sit open for half an hour before anyone presses submit.
    if (!capabilityHolds({ ...open, invokerId: open.userId })) {
      openViews.delete(open.view.id);
      throw new HttpError(404, "view_not_found");
    }

    // Only the fields the app actually asked for, in Slack's nested shape.
    const values: Record<string, Record<string, unknown>> = {};
    const missing: Record<string, string> = {};
    for (const field of open.view.fields) {
      const raw = body.values[field.blockId]?.[field.actionId] ?? "";
      const value = raw.trim();
      if (!value && !field.optional) {
        missing[field.blockId] = "This is required.";
        continue;
      }
      // A select can only answer with something it offered. Otherwise a
      // hand-written request could hand the app a value it never listed, and
      // an app is entitled to trust its own options.
      if (field.type === "select" && value && !field.options.some((o) => o.value === value)) {
        missing[field.blockId] = "Choose one of the options.";
        continue;
      }
      values[field.blockId] = {
        ...values[field.blockId],
        [field.actionId]:
          field.type === "select"
            ? { type: "static_select", selected_option: value ? { value } : null }
            : { type: "plain_text_input", value },
      };
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
        team: { id: store.getMeta("workspace_id") ?? "", domain: workspaceName() },
        user: { id: me.id, username: me.handle, name: me.displayName },
        api_app_id: owner.id,
        trigger_id: newTrigger({
          userId: me.id,
          channelId: open.channelId,
          appId: owner.id,
          botUserId: owner.botUserId,
        }),
        view: {
          id: open.view.id,
          type: "modal",
          callback_id: open.view.callbackId,
          private_metadata: open.view.privateMetadata,
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
            signal: shutdown.signal,
            headers: signatureHeaders(store.appSigningSecret(owner.id) ?? "", form),
          },
        );
        if (res.status < 200 || res.status >= 300) {
          return { ok: false, errors: {}, message: `The app answered ${res.status}.` };
        }
        const answered = res.body.trim();
        if (answered.startsWith("{")) {
          let parsed: { response_action?: unknown; errors?: Record<string, string> };
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
        openViews.delete(open.view.id);
        return { ok: true };
      } catch (err) {
        const why =
          err instanceof OutboundError && err.code === "blocked_host"
            ? err.message
            : "the app did not answer";
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
        signal: shutdown.signal,
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
        "the endpoint did not echo the url_verification challenge",
      );
    }
  };

  /**
   * Where this app's button clicks are delivered. Verified the same way a
   * subscription URL is: an endpoint that cannot echo the challenge has not
   * agreed to receive anything, which is also what stops this server being
   * aimed at an unrelated host.
   */
  app.put<{ Params: { id: string } }>("/api/apps/:id/interactivity", async (req) => {
    requireAdmin(req);
    const owner = store.getApp(req.params.id);
    if (!owner) throw new HttpError(404, "not_found");
    const body = interactivityBody.parse(req.body);

    const record = (url: string) =>
      store.transaction(() => {
        // Verification waited on another server; access and the app may have
        // changed while this request was away from the event loop.
        const me = requireAdmin(req);
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
        return store.getApp(current.id);
      });
    if (!body.url) {
      return { app: record("") };
    }
    await verifyCallbackUrl(body.url, owner.id);
    return { app: record(body.url) };
  });

  /**
   * Someone pressed a button. This posts Slack's `block_actions` payload to
   * the owning app and renders whatever comes back, so an integration written
   * for Slack works unchanged.
   */
  app.post<{ Params: { id: string } }>("/api/messages/:id/actions", async (req) => {
    const me = requireUser(req);
    const body = messageActionBody.parse(req.body);
    const message = store.getMessage(req.params.id);
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
        team: { id: store.getMeta("workspace_id") ?? "", domain: workspaceName() },
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
            signal: shutdown.signal,
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
        const why =
          err instanceof OutboundError && err.code === "blocked_host"
            ? err.message
            : "the app did not answer";
        sayEphemeral(channel.id, me.id, owner.botUserId, `That button failed: ${why}.`);
        return { ok: false, error: "action_failed" };
      }
    } finally {
      release();
    }
  });

  // ---------- outgoing event subscriptions ----------

  app.post<{ Params: { id: string } }>("/api/apps/:id/subscriptions", async (req, reply) => {
    requireAdmin(req);
    const owner = store.getApp(req.params.id);
    if (!owner) throw new HttpError(404, "not_found");
    const body = createSubscriptionBody.parse(req.body);

    await verifyCallbackUrl(body.url, owner.id);

    const subscription = store.transaction(() => {
      const me = requireAdmin(req);
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
    return reply.status(201).send({ subscription });
  });

  app.delete<{ Params: { id: string } }>("/api/subscriptions/:id", async (req) => {
    const me = requireAdmin(req);
    const deleted = store.transaction(() => {
      const subscription = store.getSubscription(req.params.id);
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

  app.post<{ Params: { id: string } }>("/api/subscriptions/:id/retry", async (req) => {
    const me = requireAdmin(req);
    const subscription = store.getSubscription(req.params.id);
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

  /** Tells the author's devices their queue changed, so a list open there reads it again. */
  const scheduledChanged = (userId: ID) => gateway.sendToUser(userId, { type: "scheduled" });

  app.post<{ Params: { id: string } }>("/api/channels/:id/scheduled", async (req, reply) => {
    const me = requireUser(req);
    const channel = requireChannelAccess(req.params.id, me);
    const body = scheduleMessageBody.parse(req.body);
    const fileIds = body.fileIds ?? [];
    // Only a reply can also be shown in the channel, as with an ordinary send.
    const broadcast = !!body.threadRootId && body.alsoSendToChannel === true;
    const requestHash = hashToken(
      JSON.stringify([
        channel.id,
        body.text,
        body.threadRootId ?? null,
        [...fileIds].sort(),
        body.sendAt,
        // Absent when false, so a request recorded before this existed still matches.
        ...(broadcast ? [true] : []),
      ]),
    );
    const result = store.transaction(() => {
      if (body.nonce) {
        const previous = store.scheduledRequest(me.id, body.nonce);
        if (previous) {
          if (previous.requestHash !== requestHash) throw new HttpError(409, "nonce_conflict");
          const scheduled = store.getScheduled(previous.scheduledId);
          if (!scheduled)
            throw new HttpError(
              410,
              "scheduled_removed",
              "This scheduling request was already accepted, but its queue record has been removed. It will not be recreated.",
            );
          return { scheduled, replayed: true };
        }
      }
      if (channel.archived) throw new HttpError(400, "channel_archived");
      if (body.sendAt <= Date.now()) {
        throw new HttpError(400, "send_at_in_past", "pick a time in the future");
      }
      // Queuing validates what sending validates, so a message cannot sit in the
      // queue for hours only to be rejected when it comes due.
      if (body.threadRootId) {
        const root = store.getMessage(body.threadRootId);
        if (!root || root.channelId !== channel.id || root.threadRootId) {
          throw new HttpError(400, "bad_thread_root");
        }
      }
      if (
        new Set(fileIds).size !== fileIds.length ||
        !store.unattachedFiles(fileIds, channel.id, me.id)
      ) {
        throw new HttpError(400, "invalid_attachments");
      }
      if (store.filesHeldBySchedule(fileIds)) {
        throw new HttpError(
          409,
          "attachments_scheduled",
          "One of these files is already part of another scheduled message.",
        );
      }
      // A replay above has already returned, so a retry never meets these.
      if (store.outstandingScheduled(me.id) >= scheduledLimits.perAccount) {
        throw new HttpError(
          409,
          "scheduled_limit",
          `You already have ${scheduledLimits.perAccount} messages waiting to be sent. Send or cancel some before scheduling more.`,
        );
      }
      if (store.outstandingScheduled() >= scheduledLimits.perWorkspace) {
        throw new HttpError(
          409,
          "scheduled_limit",
          "This workspace has as many scheduled messages waiting as it holds. Try again once some have been sent.",
        );
      }
      // Queuing a message is posting it later, so it spends the post budget here,
      // once. Delivery spends nothing, so an accepted message is never held back.
      ration("post", me.id);
      const scheduled = store.scheduleMessage({
        channelId: channel.id,
        userId: me.id,
        text: body.text,
        threadRootId: body.threadRootId ?? null,
        fileIds,
        sendAt: body.sendAt,
        broadcast,
      });
      if (body.nonce) store.recordScheduledRequest(me.id, body.nonce, scheduled.id, requestHash);
      return { scheduled, replayed: false };
    });
    if (!result.replayed) scheduledChanged(me.id);
    return reply.status(result.replayed ? 200 : 201).send({ scheduled: result.scheduled });
  });

  app.get("/api/scheduled", async (req) => {
    const me = requireUser(req);
    return { scheduled: store.listScheduled(me.id) };
  });

  app.delete<{ Params: { id: string } }>("/api/scheduled/:id", async (req) => {
    const me = requireUser(req);
    const scheduled = store.getScheduled(req.params.id);
    // Only the author may cancel, and a missing one is simply gone.
    if (!scheduled || scheduled.userId !== me.id) throw new HttpError(404, "not_found");
    store.deleteScheduled(scheduled.id);
    scheduledChanged(me.id);
    return { ok: true };
  });

  /** The recovery path for a held or failed message: a past time sends it now. */
  app.patch<{ Params: { id: string } }>("/api/scheduled/:id", async (req) => {
    const me = requireUser(req);
    const scheduled = store.getScheduled(req.params.id);
    if (!scheduled || scheduled.userId !== me.id || scheduled.status === "sent") {
      throw new HttpError(404, "not_found");
    }
    const body = rescheduleBody.parse(req.body);
    requireChannelAccess(scheduled.channelId, me);
    store.rescheduleMessage(scheduled.id, body.sendAt);
    scheduledChanged(me.id);
    return { scheduled: store.getScheduled(scheduled.id)! };
  });

  app.patch<{ Params: { id: string } }>("/api/scheduled/:id/text", async (req) => {
    const me = requireUser(req);
    const scheduled = store.getScheduled(req.params.id);
    if (!scheduled || scheduled.userId !== me.id || scheduled.status === "sent") {
      throw new HttpError(404, "not_found");
    }
    requireChannelAccess(scheduled.channelId, me);
    const body = editScheduledBody.parse(req.body);
    if (!body.text.trim() && scheduled.fileIds.length === 0) {
      throw new HttpError(400, "empty_message", "A message needs text or attachments.");
    }
    if (!store.editScheduledText(scheduled.id, body.text, body.expectedText)) {
      throw new HttpError(
        409,
        "scheduled_changed",
        "This scheduled message has changed. Refresh before editing again.",
      );
    }
    scheduledChanged(me.id);
    return { scheduled: store.getScheduled(scheduled.id)! };
  });

  // ---------- pins & saved items ----------

  /** Resolves a message the caller is allowed to see, or 404s. */
  const requireVisibleMessage = (messageId: ID, user: User) => {
    const message = store.getMessage(messageId);
    if (!message || !store.canAccess(message.channelId, user.id)) {
      throw new HttpError(404, "message_not_found");
    }
    return message;
  };

  app.put<{ Params: { id: string } }>("/api/messages/:id/pin", async (req) => {
    const me = requireUser(req);
    const message = requireVisibleMessage(req.params.id, me);
    mutate((emit) => {
      if (store.addPin(message.channelId, message.id, me.id)) {
        emit(
          { type: "pin.added", channelId: message.channelId, messageId: message.id, userId: me.id },
          message.channelId,
        );
      }
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/messages/:id/pin", async (req) => {
    const me = requireUser(req);
    const message = requireVisibleMessage(req.params.id, me);
    mutate((emit) => {
      if (store.removePin(message.id)) {
        emit(
          { type: "pin.removed", channelId: message.channelId, messageId: message.id },
          message.channelId,
        );
      }
    });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/channels/:id/pins", async (req) => {
    const me = requireUser(req);
    requireChannelAccess(req.params.id, me);
    const query = pinnedMessagesQuery.parse(req.query);
    return store.listPins(req.params.id, query.limit, query.cursor);
  });

  app.put<{ Params: { id: string } }>("/api/messages/:id/save", async (req) => {
    const me = requireUser(req);
    const message = requireVisibleMessage(req.params.id, me);
    if (store.addSaved(me.id, message.id)) {
      gateway.sendToUser(me.id, { type: "saved", messageId: message.id, saved: true });
    }
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/messages/:id/save", async (req) => {
    const me = requireUser(req);
    if (store.removeSaved(me.id, req.params.id)) {
      gateway.sendToUser(me.id, { type: "saved", messageId: req.params.id, saved: false });
    }
    return { ok: true };
  });

  app.patch<{ Params: { id: string } }>("/api/channels/:id/prefs", async (req) => {
    const me = requireUser(req);
    requireChannelAccess(req.params.id, me);
    if (!store.isMember(req.params.id, me.id)) throw new HttpError(400, "not_a_member");
    const body = channelPrefsBody.parse(req.body ?? {});
    const prefs = store.setChannelPrefs(req.params.id, me.id, body);
    if (!prefs) throw new HttpError(404, "channel_not_found");
    // Preferences are personal: only this user's own devices need to know.
    gateway.sendToUser(me.id, { type: "prefs", channelId: req.params.id, prefs });
    return { prefs };
  });

  app.put<{ Params: { id: string } }>("/api/messages/:id/follow", async (req) => {
    const me = requireUser(req);
    const message = requireVisibleMessage(req.params.id, me);
    if (message.threadRootId) throw new HttpError(400, "not_a_thread_root");
    const body = threadFollowBody.parse(req.body ?? {});
    const state = store.setThreadFollow(me.id, message.id, body.following);
    if (!state) throw new HttpError(404, "message_not_found");
    gateway.sendToUser(me.id, { type: "thread.follow", state });
    return { state };
  });

  app.post<{ Params: { id: string } }>("/api/messages/:id/thread/read", async (req) => {
    const me = requireUser(req);
    const message = requireVisibleMessage(req.params.id, me);
    if (message.threadRootId) throw new HttpError(400, "not_a_thread_root");
    const body = threadReadBody.parse(req.body ?? {});
    const state = store.markThreadRead(me.id, message.id, body.seq);
    if (!state) throw new HttpError(404, "message_not_found");
    gateway.sendToUser(me.id, { type: "thread.follow", state });
    // Reading a thread can read a mention in its replies.
    pushMentionCounts([me.id]);
    return { state };
  });

  app.post<{ Params: { id: string } }>("/api/messages/:id/thread/unread", async (req) => {
    const me = requireUser(req);
    const message = requireVisibleMessage(req.params.id, me);
    if (message.threadRootId) throw new HttpError(400, "not_a_thread_root");
    const { seq } = markUnreadBody.parse(req.body);
    const state = store.markThreadUnread(me.id, message.id, seq);
    if (!state) {
      if (!store.threadFollow(me.id, message.id)) throw new HttpError(404, "message_not_found");
      throw new HttpError(400, "invalid_unread_target");
    }
    gateway.sendToUser(me.id, { type: "thread.follow", state });
    // A mention in what is unread again counts again.
    pushMentionCounts([me.id]);
    return { state };
  });

  app.get("/api/threads/followed", async (req) => {
    const me = requireUser(req);
    const query = followedThreadsQuery.parse(req.query);
    return store.followedThreads(me.id, query.limit, query.cursor, query.unreadOnly === "true");
  });

  app.get("/api/saved", async (req) => {
    const me = requireUser(req);
    const query = savedMessagesQuery.parse(req.query);
    return store.listSaved(me.id, query.limit, query.cursor);
  });

  // ---------- invites & search ----------

  app.post("/api/invites", async (req, reply) => {
    const me = requireUser(req);
    // A code is a way into the workspace, so making one is something a member
    // is given. Owners and admins always may; see `canInvite` on the user.
    if (!me.canInvite) {
      throw new HttpError(
        403,
        "invite_permission_required",
        "Only people an administrator has allowed can create invite codes.",
      );
    }
    const body = createInviteBody.parse(req.body ?? {});
    const invite = store.transaction(() => {
      const created = store.createInvite({
        createdBy: me.id,
        expiresAt: body.expiresInHours ? Date.now() + body.expiresInHours * 3600_000 : null,
        maxUses: body.maxUses ?? null,
      });
      store.recordAudit({
        actorId: me.id,
        action: "invite.created",
        targetType: "invite",
        targetId: inviteFingerprint(created.code),
        details: { expiresAt: created.expiresAt, maxUses: created.maxUses },
      });
      return created;
    });
    return reply.status(201).send({ invite });
  });

  /**
   * The invites someone can do something about: every one for an administrator,
   * and a member's own for everyone else. Codes are credentials for an
   * invite-only workspace, so a member is never shown anyone else's.
   */
  app.get("/api/invites", async (req) => {
    const me = requireUser(req);
    const admin = me.role === "owner" || me.role === "admin";
    return { invites: store.listInvites(admin ? {} : { createdBy: me.id }) };
  });

  /**
   * Withdraws an invite, for a link that has been shared further than meant.
   * Its creator or an administrator may; anyone else is told there is no such
   * invite, so trying codes cannot confirm which ones exist.
   */
  app.delete<{ Params: { code: string } }>("/api/invites/:code", async (req) => {
    const me = requireUser(req);
    const admin = me.role === "owner" || me.role === "admin";
    const invite = store.getInvite(req.params.code);
    if (!invite || (!admin && invite.createdBy !== me.id)) {
      throw new HttpError(404, "invite_not_found");
    }
    const revoked = store.transaction(() => {
      if (!store.revokeInvite(invite.code, me.id)) return false;
      store.recordAudit({
        actorId: me.id,
        action: "invite.revoked",
        targetType: "invite",
        targetId: inviteFingerprint(invite.code),
        details: { createdBy: invite.createdBy },
      });
      return true;
    });
    if (revoked) {
      // Without the code: the log is not somewhere a credential should end up.
      req.log.info({ createdBy: invite.createdBy, by: me.id }, "invite revoked");
    }
    return { invite: store.getInvite(invite.code) };
  });

  app.get("/api/activity", async (req) => {
    const me = requireUser(req);
    const query = activityQuery.parse(req.query);
    const matches = store.activityMessages(me.id, { ...query, limit: query.limit + 1 });
    const messages = matches.slice(0, query.limit);
    return { messages, nextCursor: matches.length > query.limit ? messages.at(-1)!.id : null };
  });

  app.get("/api/search", async (req) => {
    const me = requireUser(req);
    const q = searchQuery.parse(req.query);
    if (q.channelId) requireChannelAccess(q.channelId, me);
    if (q.tz !== undefined && !isTimeZone(q.tz))
      throw new HttpError(
        400,
        "invalid_time_zone",
        `${q.tz} is not a time zone this server knows.`,
      );
    const parsed = parseSearchQuery(q.q, { timeZone: q.tz });
    // A date that is not one would otherwise be dropped, and the search would
    // quietly cover more than was asked for.
    if (parsed.invalid.length > 0)
      throw new HttpError(
        400,
        "invalid_search_date",
        `Not a date: ${parsed.invalid.join(", ")}. Write dates as YYYY-MM-DD.`,
      );
    // A query of nothing but stray punctuation should return nothing, not everything.
    if (!hasSearchCriteria(parsed) && !q.channelId) return { messages: [], nextCursor: null };
    const matches = store.searchMessages(me.id, parsed, q.limit + 1, q);
    const messages = matches.slice(0, q.limit);
    return { messages, nextCursor: matches.length > q.limit ? messages.at(-1)!.id : null };
  });

  // ---------- start ----------

  const port = opts.port ?? 8543;
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
  if (announcing) {
    mdnsHandle = advertise({ name: workspaceName(), port: actualPort, instanceId });
  }
  /** Replaces the announcement with one made now, under the current name. */
  const announce = () => {
    if (!announcing || closing) return;
    mdnsHandle?.stop();
    // Losing the announcement is not worth failing what asked for it: the
    // workspace still answers at its address, and the next call tries again.
    try {
      mdnsHandle = advertise({ name: workspaceName(), port: actualPort, instanceId });
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
    if (closing) throw new Error("The workspace is stopping.");
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
    gateway.broadcastEphemeral({ type: "workspace.renamed", workspaceName: name }, null);
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
    gateway.broadcastEphemeral({ type: "workspace.accessPolicy", accessPolicy: policy }, null);
    workspaceChanged({ accessPolicy: policy, by });
  };

  /**
   * Posts anything that has come due. Runs on a timer and once at startup, so
   * messages scheduled while the server was down still go out.
   *
   * Nothing is dropped silently. Delivery marks the queue row sent inside the
   * message transaction, so a crash between the two replays rather than losing
   * or duplicating the message. An obstacle that the author can clear holds the
   * row; one they cannot fails it. Either way the reason is theirs to read.
   */
  let scheduledDrain: ReturnType<typeof setImmediate> | null = null;
  const flushScheduled = () => {
    if (opts.isolated) return;
    const due = store.dueScheduled(Date.now(), scheduledLimits.batch);
    const retryAt = Date.now() + scheduledLimits.heldRetryMs;
    for (const item of due) {
      try {
        sendScheduled(item, retryAt);
      } catch (err) {
        // Recording what happened failed too. The row is as it was, so it is
        // due again next round; the rest of the batch still goes.
        app.log.error({ err, scheduledId: item.id }, "scheduled message not handled; it stays due");
      }
    }
    // A full batch may mean more are due. They are taken on a later turn, so
    // the window and every other request get the loop between batches.
    if (due.length === scheduledLimits.batch && !scheduledDrain && !closing) {
      scheduledDrain = setImmediate(() => {
        scheduledDrain = null;
        inBackground("scheduled messages", flushScheduled);
      });
    }
  };
  /** Posts one due scheduled message, or records why it waits or failed. */
  const sendScheduled = (item: ScheduledMessage, retryAt: number): void => {
    const channel = store.getChannel(item.channelId);
    const held = !channel
      ? "That channel no longer exists."
      : channel.archived
        ? "That channel is archived."
        : !store.canAccess(channel.id, item.userId)
          ? "You are no longer a member of that channel."
          : store.getUser(item.userId)?.deactivated
            ? "Your account is deactivated."
            : null;
    // A row held again for the same reason looks no different to its author.
    const hold = (reason: string) => {
      store.holdScheduled(item.id, reason, retryAt);
      if (item.status !== "held" || item.failureReason !== reason) scheduledChanged(item.userId);
    };
    const fail = (reason: string) => {
      store.failScheduled(item.id, reason);
      scheduledChanged(item.userId);
    };
    if (held) {
      hold(held);
      return;
    }
    try {
      postMessage({
        channelId: item.channelId,
        userId: item.userId,
        text: item.text,
        threadRootId: item.threadRootId,
        broadcast: item.broadcast,
        nonce: null,
        fileIds: item.fileIds,
        scheduledId: item.id,
      });
      scheduledChanged(item.userId);
    } catch (err) {
      const code = err instanceof HttpError ? err.code : null;
      if (code === "bad_thread_root") {
        fail("The message this replied to was deleted.");
      } else if (code === "invalid_attachments") {
        fail("Its attachments are no longer available.");
      } else if (store.countScheduledAttempt(item.id) >= SCHEDULED_ATTEMPTS) {
        fail("Sending failed repeatedly, so it was not posted.");
      } else {
        hold("Sending failed. It will be tried again shortly.");
      }
    }
  };
  // Each queue on its own, so one failing neither stops the server starting
  // nor skips the others.
  inBackground("scheduled messages", flushScheduled);
  inBackground("event deliveries", flushEventDeliveries);
  inBackground("orphaned attachments", reconcileOrphanedBlobs);
  inBackground("abandoned uploads", expireAbandonedUploads);
  inBackground("attachment cleanup", flushFileDeletions);
  const scheduleTimer = setInterval(() => {
    inBackground("scheduled messages", flushScheduled);
    inBackground("attachment cleanup", flushFileDeletions);
  }, 15_000);
  const eventDeliveryTimer = setInterval(
    () => inBackground("event deliveries", flushEventDeliveries),
    5_000,
  );

  /**
   * An exception thrown from a timer is an uncaught exception, which ends the
   * process. Housekeeping that fails is reported and tried again next round,
   * and one step failing does not skip the rest.
   */
  const maintain = (step: string, work: () => void) => {
    try {
      work();
    } catch (err) {
      app.log.error({ err, step }, "maintenance step failed; it will be tried again");
    }
  };
  const pruneTimer = setInterval(() => {
    maintain("events", () => store.pruneEvents());
    maintain("scheduled", () => store.pruneScheduled(Date.now() - SCHEDULED_RETENTION_MS));
    maintain("sessions", () => store.pruneSessions());
    maintain("removed messages' send keys", () =>
      store.pruneMessageRequestsPurged(Date.now() - PURGED_SEND_KEYS_MS),
    );
    maintain("download tokens", () => store.pruneDownloadTokens());
    maintain("event deliveries", () =>
      store.pruneEventDeliveries(Date.now() - EVENT_DELIVERY_RETENTION_MS),
    );
    // After pruning the queue, so a scheduled message that has just gone stops
    // holding its attachments in the same round rather than an hour later.
    maintain("abandoned uploads", () => {
      if (expireAbandonedUploads() > 0) void flushFileDeletions();
    });
    void sweepRetention();
  }, 3600_000);
  // A status set to clear itself (UX-61) is cleared at its time, for everyone
  // to see, by one timer set for the soonest.
  let statusExpiry: ReturnType<typeof setTimeout> | null = null;
  function clearExpiredStatuses() {
    statusExpiry = null;
    if (closing) return;
    maintain("expired statuses", () => {
      const due = store.expiredStatusUserIds(Date.now());
      if (due.length > 0)
        mutate((emit) => {
          for (const id of due) {
            const user = store.updateUser(id, {
              statusText: "",
              statusEmoji: "",
              statusExpiresAt: null,
            });
            emit({ type: "user.updated", user }, null);
          }
        });
    });
    armStatusExpiry();
  }
  /** Sets the timer for the soonest end. One later than a timer can wait wakes it to wait again. */
  function armStatusExpiry() {
    if (statusExpiry) clearTimeout(statusExpiry);
    statusExpiry = null;
    if (closing) return;
    const next = store.nextStatusExpiry();
    if (next === null) return;
    statusExpiry = setTimeout(
      clearExpiredStatuses,
      Math.min(Math.max(0, next - Date.now()), 2_147_483_647),
    );
    statusExpiry.unref();
  }
  // Statuses that ended while the server was stopped clear as it starts.
  armStatusExpiry();

  let stopping: Promise<void> | null = null;
  // The stages of stopping that have finished. A stop that fails part-way
  // can be asked again, and the next try picks up at the first stage not yet
  // done instead of repeating the failure or a stage that must happen once.
  const stopped = { started: false, gateway: false, http: false, drained: false, database: false };

  return {
    port: actualPort,
    instanceId,
    store,
    gateway,
    /** Set only while the workspace still has no owner. */
    claimCode: claimCode(),
    upgradeBackup,
    flushScheduled,
    flushFileDeletions,
    expireAbandonedUploads,
    applyRetention,
    sweepRetention,
    retentionStatus: () => ({ ...retention }),
    flushEventDeliveries,
    setPublicUrl: (url) => {
      // Checked before anything changes, so a refused address leaves the old one.
      publicUrl = url === null ? undefined : parsePublicUrl(url, "publicUrl");
    },
    setTrustLoopbackProxy: (enabled) => {
      if (typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean");
      trustLoopbackProxy = enabled;
    },
    setIceServers: (servers) => {
      iceServers = iceServersSchema.parse(servers);
    },
    setRelay: (next) => {
      // Parsed before anything changes, so a refused relay leaves the old one.
      relay = relaySource(next);
    },
    relayError: () => relay.error(),
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
    workspaceName,
    setWorkspaceName: (value) => {
      renameWorkspace(value, null);
    },
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
        closing = true;
        clearInterval(scheduleTimer);
        if (scheduledDrain) clearImmediate(scheduledDrain);
        if (fileCleanupNext) clearImmediate(fileCleanupNext);
        clearInterval(eventDeliveryTimer);
        clearInterval(pruneTimer);
        clearInterval(loopDelayTimer);
        if (statusExpiry) clearTimeout(statusExpiry);
        loopDelay.disable();
        mdnsHandle?.stop();
        // Before waiting on anything, so whatever is waiting on an app hears
        // about it now rather than at the end of its timeout.
        shutdown.abort();
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
        if (!stopped.drained) {
          // Nothing new can arrive now, so this set only shrinks.
          while (runningHandlers.size > 0) await Promise.all(runningHandlers);
          await Promise.all([flushFileDeletions(), eventDeliveryFlush ?? Promise.resolve()]);
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
