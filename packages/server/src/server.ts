import {
  ACCESS_POLICIES,
  DEFAULT_PORT,
  isAccessPolicy,
  type AccessPolicy,
  type ID,
} from "@ownbase/protocol";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { registerAccounts } from "./accounts/feature.js";
import { registerApps } from "./apps/feature.js";
import { registerAdmin } from "./admin/feature.js";
import { checkWorkspaceOptions, createWorkspace, type WorkspaceChange } from "./admin/workspace.js";
import { registerBackups, scheduledBackupsOf } from "./backups/feature.js";
import { type BackupScheduleStatus } from "./backups/backupSchedule.js";
import { registerChannels } from "./channels/feature.js";
import { parsePort } from "./config.js";
import { BackgroundWork } from "./core/background.js";
import { createCommits } from "./core/commit.js";
import { rationWith, type ServerContext } from "./core/context.js";
import { createHttp } from "./core/http.js";
import { Lifecycle } from "./core/lifecycle.js";
import { Network } from "./core/network.js";
import { openDb } from "./db.js";
import type { ServerOptions } from "./options.js";
import { maxFileSizeOf, registerFiles } from "./files/feature.js";
import { Gateway } from "./gateway.js";
import { registerHuddles } from "./huddles/feature.js";
import { DEFAULT_LIMITS, RateLimiter } from "./limits.js";
import { advertise, type MdnsHandle } from "./mdns.js";
import { registerMessages, type RetentionStatus } from "./messages/feature.js";
import { holdWorkspace, type WorkspaceHold } from "./core/ownership.js";
import { registerPeople } from "./people/feature.js";
import { registerPolls } from "./polls/feature.js";
import { serverRelaySchema, type ServerRelay } from "./relay.js";
import { registerReminders } from "./reminders/feature.js";
import { createRouter } from "./route.js";
import { registerSaved } from "./saved/feature.js";
import { registerScheduled } from "./scheduled/feature.js";
import { registerSearch } from "./search/feature.js";
import { registerExtensions } from "./sso/feature.js";
import { Store } from "./store.js";
import { registerThreads } from "./threads/feature.js";
import { SERVER_VERSION } from "./version.js";
import type { WorkspaceIcon } from "./core/workspaceIcon.js";

export type { ServerOptions } from "./options.js";
export { GUEST_SESSION_TTL_MS } from "./accounts/feature.js";
export type { RetentionStatus } from "./messages/feature.js";
export { SERVER_VERSION };

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
  const { recordEvent, mutate, onRecorded, onPublished } = createCommits({
    store,
    gateway,
    log: app.log,
    background,
  });
  const lifecycle = new Lifecycle();
  lifecycle.hourly(() => background.maintain("events", () => store.pruneEvents()));

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
    onRecorded,
    onPublished,
    background,
    network,
    lifecycle,
  };
  const workspace = createWorkspace(ctx);
  const workspaceName = () => settings.get("workspaceName");

  const files = registerFiles(ctx);
  const backups = registerBackups(ctx, { files, scheduled });

  const messages = registerMessages(ctx);
  const polls = registerPolls(ctx);
  const { posting } = messages;

  const huddles = registerHuddles(ctx, { posting });

  const channels = registerChannels(ctx);
  const { joinPublicChannels } = channels;

  registerAccounts(ctx, {
    joinPublicChannels,
    iconVersion: () => workspace.icon()?.version ?? null,
  });
  registerAdmin(ctx, { instanceId, workspace, messages, files, backups });
  const people = registerPeople(ctx);
  const threads = registerThreads(ctx);
  const apps = registerApps(ctx, { messages });
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

  await lifecycle.start();

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
    flushFileDeletions: files.flushFileDeletions,
    expireAbandonedUploads: files.expireAbandonedUploads,
    applyRetention: messages.applyRetention,
    sweepRetention: messages.sweepRetention,
    retentionStatus: () => ({ ...messages.retention }),
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
      return workspace.setIcon(
        Buffer.from(bytes),
        typeof type === "string" ? type : undefined,
        null,
      );
    },
    removeWorkspaceIcon: () => workspace.removeIcon(null),
    onWorkspaceChange: workspace.onChange,
    reannounce: () => announce(),
    connectedPeople: () => gateway.onlineUserIds().length,
    onConnectedChange: (listener) => gateway.onPresenceChange(listener),
    stop: () => {
      if (stopping) return stopping;
      if (!stopped.started) {
        stopped.started = true;
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
