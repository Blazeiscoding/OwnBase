import {
  ACCESS_POLICIES,
  DEFAULT_PORT,
  type AccessPolicy,
  type ID,
  type MemberNotice,
} from "@ownbase/protocol";
import { randomUUID } from "node:crypto";
import { registerAccounts } from "./accounts/feature.js";
import { registerApps } from "./apps/feature.js";
import { registerAdmin } from "./admin/feature.js";
import {
  checkWorkspaceOptions,
  createWorkspace,
  isAccessPolicy,
  type WorkspaceChange,
} from "./admin/workspace.js";
import { registerBackups, scheduledBackupsOf } from "./backups/feature.js";
import type { BackupManifest } from "./backups/backup.js";
import { type BackupScheduleStatus, type ScheduledBackups } from "./backups/backupSchedule.js";
import { registerChannels } from "./channels/feature.js";
import { parsePort } from "./config.js";
import { BackgroundWork } from "./core/background.js";
import { createCommits } from "./core/commit.js";
import { rationWith, type ServerContext } from "./core/context.js";
import { createHttp } from "./core/http.js";
import { Lifecycle } from "./core/lifecycle.js";
import { Network } from "./core/network.js";
import { openDb } from "./db.js";
import type { ServerExtension } from "./extensions.js";
import { maxFileSizeOf, registerFiles } from "./files/feature.js";
import { Gateway } from "./gateway.js";
import { registerHuddles } from "./huddles/feature.js";
import { DEFAULT_LIMITS, RateLimiter, type Limits } from "./limits.js";
import { type FetchedPreview } from "./linkPreview.js";
import { advertise, type MdnsHandle } from "./mdns.js";
import { registerMessages, type RetentionStatus } from "./messages/feature.js";
import { holdWorkspace, type WorkspaceHold } from "./core/ownership.js";
import { workspaceDatabase } from "./core/workspaceFile.js";
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
import { checkIcon, type WorkspaceIcon } from "./admin/workspaceIcon.js";

export { GUEST_SESSION_TTL_MS } from "./accounts/feature.js";
export type { RetentionStatus } from "./messages/feature.js";
export { SERVER_VERSION };

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
  workspaceName: () => string;
  /**
   * Renames the workspace while it runs, as the host, by the same rule as an
   * owner or admin: 1 to 80 characters without control characters, trimmed.
   * Everyone signed in is told at once, the network announcement changes,
   * and the name is stored for the next start.
   */
  setWorkspaceName: (name: string) => void;
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
  /** How many accounts there are; none until the owner's is made. */
  accountCount: () => number;
  stop: () => Promise<void>;
}

export type { WorkspaceChange } from "./admin/workspace.js";

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
  checkWorkspaceOptions(opts);
  const network = new Network(opts);
  // Before the database opens, so a refused relay leaves nothing open in the folder.
  if (opts.relay) serverRelaySchema.parse(opts.relay);
  const scheduled = await scheduledBackupsOf(opts);
  const dbPath = opts.dataDir === ":memory:" ? ":memory:" : workspaceDatabase(opts.dataDir);
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
  const workspace = createWorkspace(ctx);
  const workspaceName = () => settings.get("workspaceName");

  const files = registerFiles(ctx);
  const { flushFileDeletions, expireAbandonedUploads } = files;
  const backups = registerBackups(ctx, { files, scheduled });

  const messages = registerMessages(ctx, { files });
  const polls = registerPolls(ctx);
  const { posting, applyRetention, sweepRetention, retention } = messages;

  const huddles = registerHuddles(ctx, { posting });

  const channels = registerChannels(ctx);
  const { joinPublicChannels } = channels;

  const accounts = registerAccounts(ctx, {
    joinPublicChannels,
    iconVersion: () => workspace.icon()?.version ?? null,
  });
  registerAdmin(ctx, { instanceId, workspace, accounts, messages, files, backups });

  const people = registerPeople(ctx);

  const threads = registerThreads(ctx);

  const apps = registerApps(ctx, { accounts, messages, files });

  const scheduledMessages = registerScheduled(ctx, { posting });

  const saved = registerSaved(ctx);

  registerSearch(ctx);

  const reminders = registerReminders(ctx);

  gateway.useSnapshot((user) => ({
    ...reminders.snapshot(user),
    ...polls.snapshot(user),
    ...saved.snapshot(user),
    ...threads.snapshot(user),
    ...channels.snapshot(user),
    ...people.snapshot(user),
    ...workspace.snapshot(user),
  }));

  await registerExtensions(ctx, { joinPublicChannels });

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
    iconVersion: workspace.icon()?.version ?? null,
  });
  if (announcing) {
    mdnsHandle = advertise(announcement());
  }
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

  workspace.onChange((change) => {
    if (change.workspaceName !== undefined || change.iconVersion !== undefined) announce();
  });

  // Each queue on its own, so one failing neither stops the server starting
  // nor skips the others.
  apps.start();
  files.start();

  await backups.start();

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
    claimCode: settings.get("claimCode"),
    upgradeBackup,
    flushScheduled: scheduledMessages.flush,
    flushFileDeletions,
    expireAbandonedUploads,
    applyRetention,
    sweepRetention,
    retentionStatus: () => ({ ...retention }),
    backupStatus: backups.status,
    runBackup: backups.runNow,
    flushEventDeliveries: apps.flushEventDeliveries,
    setPublicUrl: (url) => network.setPublicUrl(url),
    setTrustLoopbackProxy: (enabled) => network.setTrustLoopbackProxy(enabled),
    setIceServers: (servers) => huddles.setIceServers(servers),
    setRelay: (next) => huddles.setRelay(next),
    relayError: () => huddles.relayError(),
    accessPolicy: workspace.accessPolicy,
    setAccessPolicy: (policy) => {
      if (!isAccessPolicy(policy)) throw new TypeError(`policy must be one of ${ACCESS_POLICIES}`);
      workspace.changeAccessPolicy(policy, null);
    },
    workspaceId: () => settings.get("workspaceId"),
    workspaceName,
    setWorkspaceName: (value) => {
      workspace.rename(value, null);
    },
    workspaceIcon: workspace.icon,
    setWorkspaceIcon: (bytes, type) => {
      if (!(bytes instanceof Uint8Array)) throw new TypeError("An icon is the bytes of an image.");
      const checked = checkIcon(Buffer.from(bytes), typeof type === "string" ? type : undefined);
      if ("refused" in checked) throw new TypeError(checked.refused.message);
      workspace.changeIcon(checked.icon, null);
      return checked.icon.version;
    },
    removeWorkspaceIcon: () => workspace.changeIcon(null, null),
    onWorkspaceChange: workspace.onChange,
    reannounce: () => announce(),
    connectedPeople: () => gateway.onlineUserIds().length,
    onConnectedChange: (listener) => gateway.onPresenceChange(listener),
    accountCount: () => store.people.count(),
    stop: () => {
      if (stopping) return stopping;
      if (!stopped.started) {
        stopped.started = true;
        clearInterval(pruneTimer);
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
          await backups.stop();
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
