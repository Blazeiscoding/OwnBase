import { DEFAULT_PORT } from "@ownbase/protocol";

/**
 * Every setting the command line takes, each declared once: its flag, the
 * environment variable that sets it when the flag is not given, its help,
 * and whether OwnBase's hosting passes it to the servers it runs. The
 * parser, --help, the environment fallback and the hosting control plane
 * (ee/cloud) all read this table.
 */
export interface Flag {
  type: "string" | "boolean";
  default?: string | boolean;
  short?: string;
  /** Sets it when the flag is not given, as `OWNBASE_<env>`. */
  readonly env?: string;
  /** OwnBase's hosting may pass it to the workspace servers it runs. */
  cloud?: true;
  /** Its part of --help. Flags that only the usage lines name have none. */
  help?: { usage: string; gapBefore?: true; lines: readonly string[] };
}

export const FLAGS = {
  data: {
    type: "string",
    default: "./data",
    cloud: true,
    help: {
      usage: "--data <dir>",
      lines: ["Data directory (default ./data)"],
    },
  },
  port: {
    type: "string",
    default: String(DEFAULT_PORT),
    cloud: true,
    help: {
      usage: "--port <port>",
      lines: [`Port to listen on (default ${DEFAULT_PORT})`],
    },
  },
  host: {
    type: "string",
    cloud: true,
    help: {
      usage: "--host <host>",
      lines: ["Host to bind (default 0.0.0.0, or 127.0.0.1 with --isolated)"],
    },
  },
  name: {
    type: "string",
    cloud: true,
    help: {
      usage: "--name <name>",
      lines: [
        "Workspace name, until the workspace has an owner. After",
        "that it keeps its own; owners and admins rename it in",
        "Workspace settings",
      ],
    },
  },
  "invite-only": {
    type: "boolean",
    help: {
      usage: "--invite-only",
      lines: ["Require an invite code to register. The same as", "--access-policy invite_only"],
    },
  },
  "access-policy": {
    type: "string",
    help: {
      usage: "--access-policy <invite_only|account_required|guest_allowed>",
      lines: [
        "Who may join: invited accounts, any account, or guests",
        "with a display name too. Overrides --invite-only. Sets a",
        "new workspace's rule until it has an owner. After that",
        "the workspace keeps its own, which owners and admins",
        "change in Workspace settings",
      ],
    },
  },
  "no-mdns": {
    type: "boolean",
    default: false,
    cloud: true,
    help: {
      usage: "--no-mdns",
      lines: ["Do not advertise on the local network"],
    },
  },
  "storage-limit-mb": {
    type: "string",
    env: "STORAGE_LIMIT_MB",
    cloud: true,
    help: {
      usage: "--storage-limit-mb <n>",
      lines: [
        "Attachment storage cap in MiB; 0 is unlimited (default).",
        "Also settable with OWNBASE_STORAGE_LIMIT_MB.",
      ],
    },
  },
  "abandoned-upload-hours": {
    type: "string",
    env: "ABANDONED_UPLOAD_HOURS",
    help: {
      usage: "--abandoned-upload-hours <n>",
      lines: [
        "How long an upload may sit unattached before it is freed",
        "(default 24). Attachments a scheduled message still needs",
        "are never swept, however old they are. Also settable with",
        "OWNBASE_ABANDONED_UPLOAD_HOURS.",
      ],
    },
  },
  "retention-days": {
    type: "string",
    env: "RETENTION_DAYS",
    help: {
      usage: "--retention-days <n>",
      lines: [
        "Discard conversation older than this many days; 0 keeps",
        "everything (default). What it removes is removed from the",
        "database, not hidden: getting it back means restoring a",
        "backup taken before the sweep ran. A thread goes as one",
        "thing, once its newest reply is past the window too. Also",
        "settable with OWNBASE_RETENTION_DAYS.",
      ],
    },
  },
  "backup-dir": {
    type: "string",
    env: "BACKUP_DIR",
    cloud: true,
    help: {
      usage: "--backup-dir <dir>",
      lines: [
        "Take a backup on a timer into a dated folder in <dir>,",
        "which must be outside --data. Each one is verified before",
        "it is kept and restores with restore --from. Attachments",
        "are not removed while one is copied, so it is complete.",
        "Off unless set. Also settable with OWNBASE_BACKUP_DIR",
      ],
    },
  },
  "backup-every-hours": {
    type: "string",
    env: "BACKUP_EVERY_HOURS",
    cloud: true,
    help: {
      usage: "--backup-every-hours <n>",
      lines: [
        "Hours between scheduled backups (default 24). Also",
        "settable with OWNBASE_BACKUP_EVERY_HOURS",
      ],
    },
  },
  "backup-keep": {
    type: "string",
    env: "BACKUP_KEEP",
    cloud: true,
    help: {
      usage: "--backup-keep <n>",
      lines: [
        "How many scheduled backups to keep (default 7). Older",
        "ones in --backup-dir go; nothing else there is touched.",
        "Also settable with OWNBASE_BACKUP_KEEP",
      ],
    },
  },
  "backup-offsite": {
    type: "string",
    env: "BACKUP_OFFSITE_URL",
    cloud: true,
    help: {
      usage: "--backup-offsite <url>",
      lines: [
        "Also send each scheduled backup, as one zip, to an",
        "S3-compatible bucket such as Cloudflare R2:",
        "https://<host>/<bucket>[/<folder>]. The keys come from",
        "OWNBASE_BACKUP_OFFSITE_ACCESS_KEY_ID and",
        "OWNBASE_BACKUP_OFFSITE_SECRET_ACCESS_KEY, the region from",
        "OWNBASE_BACKUP_OFFSITE_REGION (default auto, for R2).",
        "Needs --backup-dir. Also settable with",
        "OWNBASE_BACKUP_OFFSITE_URL",
      ],
    },
  },
  "backup-offsite-keep": {
    type: "string",
    env: "BACKUP_OFFSITE_KEEP",
    help: {
      usage: "--backup-offsite-keep <n>",
      lines: [
        "How many copies to keep in the bucket (default: as many",
        "as --backup-keep). Only names it wrote are removed. Also",
        "settable with OWNBASE_BACKUP_OFFSITE_KEEP",
      ],
    },
  },
  "member-notice": {
    type: "string",
    env: "MEMBER_NOTICE",
    cloud: true,
    help: {
      usage: "--member-notice <n>",
      lines: [
        "For a workspace you host for others on a plan: past this",
        "many members, the owner and admins are told it has more",
        "than the plan includes. Nobody is locked out and people",
        "keep joining. Apps, guests and deactivated accounts are not",
        "counted. Off unless set. Also settable with",
        "OWNBASE_MEMBER_NOTICE",
      ],
    },
  },
  "plan-name": {
    type: "string",
    env: "PLAN_NAME",
    cloud: true,
    help: {
      usage: "--plan-name <name>",
      lines: [
        "The plan's name in that notice, such as Team. Also",
        "settable with OWNBASE_PLAN_NAME",
      ],
    },
  },
  "upgrade-url": {
    type: "string",
    env: "UPGRADE_URL",
    cloud: true,
    help: {
      usage: "--upgrade-url <u>",
      lines: [
        "Where the notice sends them to choose a bigger plan. Also",
        "settable with OWNBASE_UPGRADE_URL",
      ],
    },
  },
  web: {
    type: "string",
    help: {
      usage: "--web <dir>",
      lines: ["Serve the browser client from this directory"],
    },
  },
  "public-url": {
    type: "string",
    cloud: true,
    help: {
      usage: "--public-url <u>",
      lines: [
        "How others reach this server, e.g. https://chat.team.dev",
        "(set it behind a reverse proxy; used in URLs given to apps)",
      ],
    },
  },
  "trust-proxy": {
    type: "boolean",
    default: false,
    cloud: true,
    help: {
      usage: "--trust-proxy",
      lines: [
        "Believe the X-Forwarded-* headers. Only set this when a",
        "reverse proxy in front of this server writes them and",
        "nothing else can reach it directly; anyone can send those",
        "headers, and a forged one would decide where an app sends",
        "its reply. Setting --public-url is the better answer where",
        "the address is fixed, and does not require trusting anyone.",
      ],
    },
  },
  "no-rate-limits": {
    type: "boolean",
    default: false,
    help: {
      usage: "--no-rate-limits",
      gapBefore: true,
      lines: [
        "Do not ration requests. One caller is otherwise held to a",
        "fair share of sign-in attempts, messages, uploads, sockets",
        "and typing notices; limits are keyed on the account where",
        "there is one, so a whole office behind a single address",
        "does not share one person's allowance. Turn this off only",
        "on a network where everyone is already trusted. Also",
        "settable with OWNBASE_RATE_LIMITS=off.",
      ],
    },
  },
  "skip-upgrade-backup": {
    type: "boolean",
    default: false,
    help: {
      usage: "--skip-upgrade-backup",
      gapBefore: true,
      lines: [
        "Do not copy the workspace before upgrading it to a newer",
        "schema. The copy goes in pre-upgrade/ inside the data",
        "directory and the three most recent are kept; it is what",
        "rolling back an upgrade restores. Skip it only when you",
        "have just taken a backup yourself and have no disk space",
        "for a second copy.",
      ],
    },
  },
  isolated: {
    type: "boolean",
    default: false,
    help: {
      usage: "--isolated",
      gapBefore: true,
      lines: [
        "Start a copy only to look at it, such as a backup restored",
        "to check it. Messages scheduled in it are not posted, apps",
        "are sent nothing, and it is not announced on the network,",
        "so the copy cannot repeat what the original already did.",
        "It listens on this machine only unless --host says",
        "otherwise. Started again without it, the same data posts",
        "and delivers whatever is waiting.",
      ],
    },
  },
  "allow-private-hooks": {
    type: "boolean",
    default: false,
    help: {
      usage: "--allow-private-hooks",
      gapBefore: true,
      lines: [
        "Let slash commands and event subscriptions call private",
        "addresses (192.168.x, 10.x, localhost). Off by default:",
        "this server can reach your whole LAN, and an admin-typed",
        "URL should not become a way to probe it. Turn it on when",
        "your bots really do run on the same network.",
      ],
    },
  },
  out: {
    type: "string",
  },
  from: {
    type: "string",
  },
  handle: {
    type: "string",
  },
  "make-owner": {
    type: "boolean",
    default: false,
  },
  help: {
    type: "boolean",
    default: false,
    short: "h",
  },
} as const satisfies Record<string, Flag>;

export type FlagName = keyof typeof FLAGS;

/**
 * Settings only the environment gives, so they stay out of a process list,
 * and whether OwnBase's hosting passes them on from its own environment.
 */
export const ENV_SETTINGS = {
  /** The code that claims a workspace nobody owns yet (P7). Hosting sets its own per workspace. */
  CLAIM_CODE: {},
  /** `off` turns rationing off, as --no-rate-limits does. */
  RATE_LIMITS: {},
  ICE_SERVERS: { cloud: true },
  TURN_URLS: { cloud: true },
  TURN_SECRET: { cloud: true },
  CLOUDFLARE_TURN_KEY_ID: { cloud: true },
  CLOUDFLARE_TURN_API_TOKEN: { cloud: true },
  BACKUP_OFFSITE_ACCESS_KEY_ID: { cloud: true },
  BACKUP_OFFSITE_SECRET_ACCESS_KEY: { cloud: true },
  BACKUP_OFFSITE_REGION: { cloud: true },
} satisfies Record<string, { cloud?: true }>;

/** Every environment variable the server reads, without its `OWNBASE_` prefix. */
export type EnvName =
  | keyof typeof ENV_SETTINGS
  | {
      [K in FlagName]: (typeof FLAGS)[K] extends { env: infer E extends string } ? E : never;
    }[FlagName];

export const envName = (name: string) => `OWNBASE_${name}`;

export function envSetting(name: EnvName): string | undefined {
  return process.env[envName(name)];
}

/** The options `node:util` parseArgs takes, for every flag. */
export function parseArgsOptions() {
  return Object.fromEntries(
    Object.entries(FLAGS as Record<string, Flag>).map(([name, flag]) => [
      name,
      {
        type: flag.type,
        ...(flag.default !== undefined ? { default: flag.default } : {}),
        ...(flag.short ? { short: flag.short } : {}),
      },
    ]),
  ) as { [K in FlagName]: ParseOption<(typeof FLAGS)[K]> };
}

type ParseOption<F> = (F extends { type: "boolean" } ? { type: "boolean" } : { type: "string" }) &
  (F extends { default: infer D } ? { default: D } : unknown) & { short?: string };

export function flagOrEnv(
  values: Partial<Record<FlagName, string | boolean | undefined>>,
  name: FlagName,
  env: (name: EnvName) => string | undefined,
): string | undefined {
  const given = values[name];
  if (typeof given === "string") return given;
  const flag: Flag & { env?: EnvName } = FLAGS[name];
  return flag.env ? env(flag.env) : undefined;
}

/** The options part of --help, every flag with help, in the table's order. */
export function flagsHelp(): string {
  const out: string[] = [];
  for (const flag of Object.values(FLAGS as Record<string, Flag>)) {
    if (!flag.help) continue;
    const { usage, lines, gapBefore } = flag.help;
    if (gapBefore) out.push("");
    const [first, ...rest] = lines;
    if (usage.length <= 17) out.push(`  ${usage.padEnd(18)}${first}`);
    else out.push(`  ${usage}`, `${" ".repeat(20)}${first}`);
    for (const line of rest) out.push(`${" ".repeat(20)}${line}`);
  }
  return out.join("\n");
}

export type CloudFlag = {
  [K in FlagName]: (typeof FLAGS)[K] extends { cloud: true } ? K : never;
}[FlagName];

/** A server's command line, from flags hosting may pass; `true` gives a flag that takes no value. */
export function serverArgs(values: { [K in CloudFlag]?: string | true }): string[] {
  return Object.entries(values).flatMap(([name, value]) =>
    value === undefined ? [] : value === true ? [`--${name}`] : [`--${name}`, value],
  );
}

export const CLOUD_ENV: readonly string[] = Object.entries(
  ENV_SETTINGS as Record<string, { cloud?: true }>,
)
  .filter(([, setting]) => setting.cloud)
  .map(([name]) => envName(name));
