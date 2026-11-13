import type { AccessPolicy, MemberNotice } from "@ownbase/protocol";
import type { BackupManifest } from "./backups/backup.js";
import type { ScheduledBackups } from "./backups/backupSchedule.js";
import type { ServerExtension } from "./extensions.js";
import type { Limits } from "./limits.js";
import type { FetchedPreview } from "./linkPreview.js";
import type { ServerRelay } from "./huddles/relay.js";
import type { PushLimits } from "./push/sender.js";
import type { REMINDER_LIMITS } from "./reminders/feature.js";
import type { SCHEDULED_LIMITS } from "./scheduled/feature.js";

/** How a workspace server is started: by the command line, the desktop app or a test. */
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
   * Who may join a workspace nobody owns yet. Once it has an owner, who may join is the workspace's own
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
  /** Overrides for pushes to closed browsers; see `PUSH_LIMITS`. */
  pushLimits?: Partial<PushLimits>;
  /**
   * How push services can reach whoever runs this server, as a `mailto:` or
   * `https:` address (RFC 8292). OwnBase's own site when not given.
   */
  pushContact?: string;
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
   * Turns on `GET /metrics` in Prometheus's text format, answered only to a
   * request bearing this token (G15). Counts only: no names, ids or text.
   * At least 16 characters. Omitted, the path does not exist.
   */
  metricsToken?: string;
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
