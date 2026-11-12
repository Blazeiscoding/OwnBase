import { parseArgs } from "node:util";
import { envName, envSetting, flagOrEnv, flagsHelp, parseArgsOptions } from "./flags.js";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { ACCESS_POLICIES, isAccessPolicy, type MemberNotice } from "@ownbase/protocol";
import { createWorkspaceServer, SERVER_VERSION } from "../server.js";
import {
  backupWorkspace,
  inventoryBackup,
  restoreWorkspace,
  verifyBackup,
} from "../backups/backup.js";
import { backupInChildProcess, type ScheduledBackups } from "../backups/backupSchedule.js";
import { OffsiteBackups, parseOffsiteUrl } from "../backups/offsite.js";
import { withBackupFolder } from "../backups/workspaceCopy.js";
import type { CommandLineExtension, ServerExtension } from "../extensions.js";
import { exportWorkspace } from "../import/slackExport.js";
import { importSlack } from "../import/slackImport.js";
import { listAccounts, recoverAccount } from "../recover.js";
import { relayFromEnvironment, type IceServer, type ServerRelay } from "../huddles/relay.js";
import { parseIceServers } from "../huddles/rtc.js";
import {
  ConfigError,
  describeStartupError,
  keptSettingsNotes,
  parseClaimCode,
  parseMemberNotice,
  parsePort,
  parsePublicUrl,
  parseWholeNumber,
} from "../config.js";

export interface CliOptions {
  /** The build's extensions (P6), such as ee/'s, with the flags and help they add. */
  extensions?: readonly CommandLineExtension[];
  /**
   * The file the command line runs from: a backup is taken by running it
   * again, and a `web/` folder beside it is served.
   */
  script: string;
}

/** The `ownbase-server` command line: parses its arguments and does what they ask. */
export async function runServerCli({ extensions = [], script }: CliOptions): Promise<void> {
  /** Says what was wrong and stops, without a stack trace nobody asked for. */
  function refuse(message: string, code = 1): never {
    console.error(`
  ${message}
`);
    process.exit(code);
  }

  /**
   * Flags the build's extensions read (P6), beside the server's own. Their
   * values are read by name, so the server's own keep their types.
   */
  const extensionOptions = Object.fromEntries(
    extensions.flatMap((extension) => Object.entries(extension.options)),
  );

  const { values, positionals } = (() => {
    try {
      return parseArgs({
        allowPositionals: true,
        options: {
          ...(extensionOptions as Record<never, never>),
          ...parseArgsOptions(),
        },
      });
    } catch (err) {
      // An unknown or malformed flag. Node's own message says which one.
      return refuse(
        `${(err as Error).message}
  Run ownbase-server --help to see the options.`,
        2,
      );
    }
  })();

  if (values.help) {
    console.log(`ownbase-server v${SERVER_VERSION}

Usage: ownbase-server [options]
       ownbase-server backup  --data <dir> --out <dir>
       ownbase-server restore --from <dir or .zip> --data <dir>
       ownbase-server verify-backup --from <dir or .zip>
       ownbase-server recover --data <dir> [--handle <handle>] [--make-owner]
       ownbase-server import-slack --from <export.zip> --data <new dir> --owner <username>
                                   [--name <name>] [--fetch-files]
       ownbase-server export --data <dir> --to <file.zip> [--everything]

${flagsHelp()}

Claiming a new workspace

  A new workspace has no owner. The first account made in it becomes the
  owner. Made from another computer, or with --public-url set, that account
  needs the claim code. The server makes the code when it starts and prints
  it, unless OWNBASE_CLAIM_CODE gives one. A host that sends people the link
  to claim the workspace sets that.

Backups

  backup          Copy a workspace to a new, empty directory: the database as
                  a consistent snapshot, every attachment, and a manifest with
                  checksums and the schema version. Stop the server first for a
                  backup that is certain to be complete.
  verify-backup   Check a backup's checksums and database without restoring it,
                  and list what starting it would reach outside itself: the
                  addresses of its apps, messages waiting to be posted, app
                  events not yet delivered and sign-ins it would accept.
  restore         Replace --data with a backup, after verifying it. The old
                  directory is renamed rather than deleted. Stop the server
                  before restoring. To check a backup without replacing
                  anything, restore it into a new directory and start that
                  with --isolated.

  Both take a backup folder or a copy the owner downloaded from Workspace
  settings, which is a zip of one; it is unpacked beside itself while used.

Recovery

  recover         Get back into a workspace nobody can sign in to. Run it on
                  this machine, with the server stopped. Without --handle it
                  lists the accounts; with one it issues a temporary password
                  for that account, ends its sessions, and requires a new
                  password at next sign-in. --make-owner also hands the
                  workspace to that account, which is the way back from an
                  owner who has left. This needs the workspace file, so it
                  gives away nothing that reading the file did not already.

Moving in from Slack, and taking your data out

  import-slack    Make a new workspace from a Slack export (Workspace settings,
                  Import and export data, in Slack). --data must be a new or
                  empty folder. People come in deactivated, with no password;
                  --owner names the Slack username that becomes the owner and
                  gets a temporary password, printed once. The owner brings the
                  others back from People. Slack's export holds links to files,
                  not the files: each message keeps a file's name, and
                  --fetch-files fetches the files through those links instead.
                  Join and leave notices are left out. Reads a zip of up to
                  64 GB and 2 million files, up to 256 MB in one JSON file and
                  100 MB in one attachment.
  export          Write a workspace out in Slack's export format, which tools
                  that read Slack's exports read, and import-slack reads back.
                  Public channels only; --everything adds private channels and
                  direct messages. The zip holds the files too. No passwords,
                  sessions or keys are in it. It can run while the server does.

Calls between networks

  Calls go straight between people's devices. Where their networks will not
  allow that, a TURN relay carries the call. Set one in the environment:
  OWNBASE_TURN_URLS and OWNBASE_TURN_SECRET for your own (coturn with
  use-auth-secret; each member is given a password that lasts a day), or
  OWNBASE_CLOUDFLARE_TURN_KEY_ID and OWNBASE_CLOUDFLARE_TURN_API_TOKEN for
  Cloudflare's. OWNBASE_ICE_SERVERS adds STUN servers, or a relay whose
  password every member may see.
${extensions.map((extension) => `\n${extension.help.replace(/\n+$/, "")}\n`).join("")}`);
    process.exit(0);
  }

  const command = positionals[0];

  if (command === "backup") {
    if (!values.out) {
      console.error("backup needs --out <dir>, an empty directory to write into");
      process.exit(1);
    }
    const manifest = await backupWorkspace({
      dataDir: resolve(values.data),
      out: resolve(values.out),
    }).catch((err: unknown) => refuse(err instanceof Error ? err.message : String(err)));
    const totals = Object.entries(manifest.counts)
      .map(([table, n]) => `${n} ${table.replace(/_/g, " ")}`)
      .join(", ");
    console.log(`
  Backed up "${manifest.workspaceName}" to ${resolve(values.out)}`);
    console.log(`  Schema v${manifest.schemaVersion}, ${manifest.files.length} attachments`);
    console.log(`  ${totals}
`);
    process.exit(0);
  }

  if (command === "verify-backup" || command === "restore") {
    if (!values.from) {
      console.error(`${command} needs --from <dir or .zip>, the backup or a downloaded copy`);
      process.exit(1);
    }
    try {
      // A downloaded copy is a zip of a backup, unpacked beside it while it is used.
      await withBackupFolder(resolve(values.from), async (from) => {
        if (command === "verify-backup") {
          const manifest = await verifyBackup(from);
          const when = new Date(manifest.createdAt).toISOString();
          console.log(`
  Backup of "${manifest.workspaceName}" is intact`);
          console.log(`  Taken ${when} by server v${manifest.serverVersion}, schema v${manifest.schemaVersion}
`);
          const found = inventoryBackup(from);
          const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
          console.log("  Starting it would reach outside the backup:");
          if (found.appAddresses.length === 0) console.log("    No app addresses.");
          else {
            console.log(`    ${count(found.appAddresses.length, "app address", "app addresses")}:`);
            for (const { origin, uses } of found.appAddresses) {
              console.log(`      ${origin} (${uses.join(", ")})`);
            }
            console.log("    Their signing secrets are in the backup, so a copy calls them");
            console.log("    as this workspace.");
          }
          const { waiting, earliestAt } = found.scheduled;
          if (waiting > 0) {
            console.log(
              `    ${count(waiting, "scheduled message waits", "scheduled messages wait")} to be posted, the earliest at ${new Date(earliestAt!).toISOString()}.`,
            );
            console.log("    Any already due are posted as soon as it starts.");
          }
          if (found.undeliveredEvents > 0) {
            console.log(
              `    ${count(found.undeliveredEvents, "app event waits", "app events wait")} to be delivered.`,
            );
          }
          console.log(
            `    ${count(found.sessions, "sign-in", "sign-ins")} still valid, including any ended since it was taken.`,
          );
          console.log(`
  Not in any backup, so set them again where it is restored: --public-url,
  --retention-days, --storage-limit-mb, --allow-private-hooks, --trust-proxy,
  OWNBASE_ICE_SERVERS, the call relay, and any proxy or certificate in front
  of the server.

  To look inside it first, restore it into a new directory and start that
  with --isolated. Its apps and scheduled messages wait until it is started
  without it.
`);
        } else {
          const { manifest, supersededDir } = await restoreWorkspace({
            backupDir: from,
            dataDir: resolve(values.data),
          });
          console.log(`
  Restored "${manifest.workspaceName}" into ${resolve(values.data)}`);
          if (supersededDir)
            console.log(`  The previous data directory is kept at ${supersededDir}`);
          console.log("");
        }
      });
    } catch (err) {
      console.error(`
  ${err instanceof Error ? err.message : String(err)}
`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (command === "recover") {
    try {
      if (!values.handle) {
        const accounts = listAccounts(resolve(values.data));
        if (accounts.length === 0) {
          console.log("\n  This workspace has no accounts yet.\n");
          process.exit(0);
        }
        console.log("\n  Accounts in this workspace\n");
        for (const account of accounts) {
          const notes = [
            account.role,
            account.deactivated ? "deactivated" : null,
            account.mustChangePassword ? "must choose a new password" : null,
          ].filter(Boolean);
          console.log(
            `  ${account.handle.padEnd(20)} ${account.displayName} (${notes.join(", ")})`,
          );
        }
        console.log(`
  Run again with --handle <handle> to issue a temporary password.
`);
        process.exit(0);
      }
      const result = await recoverAccount({
        dataDir: resolve(values.data),
        handle: values.handle,
        makeOwner: values["make-owner"],
      });
      console.log(`
  Temporary password for "${values.handle}" (${result.role}):

      ${result.temporaryPassword}

  ${result.revokedSessions} existing ${result.revokedSessions === 1 ? "session was" : "sessions were"} ended.${
    result.twoStepCleared ? "\n  Two-step sign-in was turned off; they can set it up again." : ""
  }
  Signing in with this password leads straight to choosing a new one; nothing
  else in the workspace is reachable until then. It is not stored anywhere, so
  copy it now.
`);
    } catch (err) {
      console.error(`
  ${err instanceof Error ? err.message : String(err)}
`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (command === "import-slack") {
    if (!values.from) refuse("import-slack needs --from <export.zip>, the export Slack made");
    if (!values.owner)
      refuse("import-slack needs --owner <username>, the Slack username that becomes the owner");
    const started = Date.now();
    // Only a folder that was new or empty is the import's, to say nothing was kept in.
    const freshFolder =
      !existsSync(resolve(values.data)) || readdirSync(resolve(values.data)).length === 0;
    console.log(`
  Importing ${resolve(values.from)} into ${resolve(values.data)}
`);
    try {
      const result = await importSlack({
        from: resolve(values.from),
        dataDir: resolve(values.data),
        owner: values.owner,
        workspaceName: values.name,
        fetchFiles: values["fetch-files"],
        log: (line) => console.log(line),
      });
      const n = (count: number) => count.toLocaleString("en-US");
      const of = (count: number, one: string, many = `${one}s`) =>
        `${n(count)} ${count === 1 ? one : many}`;
      const { counts } = result;
      console.log(`
  Made "${result.workspaceName}" in ${resolve(values.data)} in ${Math.round((Date.now() - started) / 1000)} s
  ${of(counts.people, "person", "people")}, ${of(counts.bots, "bot")}, ${of(counts.channels, "channel")}, ${of(counts.directMessages, "direct or group message")}
  ${of(counts.messages, "message")} (${n(counts.replies)} in threads), ${of(counts.reactions, "reaction")}, ${of(counts.pins, "pin")}, ${of(counts.files, "file")}`);
      if (result.skipped.length) {
        console.log("\n  Left out:");
        for (const { reason, count } of result.skipped) console.log(`    ${n(count)} ${reason}`);
      }
      console.log(`
  The owner, ${result.owner.displayName} (${result.owner.handle}), signs in with this
  temporary password and then chooses their own:

      ${result.owner.temporaryPassword}

  It is not stored anywhere, so copy it now. Everyone else is deactivated:
  bring them back from People, which gives each a temporary password.
  Start the server with --data ${resolve(values.data)} to open it.
`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      refuse(
        freshFolder
          ? `${message}
  Nothing from this import was kept.`
          : message,
      );
    }
    process.exit(0);
  }

  if (command === "export") {
    if (!values.to) refuse("export needs --to <file.zip>, a new file to write the export to");
    try {
      const result = await exportWorkspace({
        dataDir: resolve(values.data),
        to: resolve(values.to),
        everything: values.everything,
        log: (line) => console.log(line),
      });
      const n = (count: number) => count.toLocaleString("en-US");
      const of = (count: number, one: string, many = `${one}s`) =>
        `${n(count)} ${count === 1 ? one : many}`;
      console.log(`
  Exported to ${resolve(values.to)} (${n(Math.ceil(result.bytes / 1024))} kB)
  ${of(result.people, "person", "people")}, ${of(result.channels, "channel")}, ${of(result.directMessages, "direct or group message")}
  ${of(result.messages, "message")}, ${of(result.files, "file")}`);
      if (result.skipped.length) {
        console.log("\n  Left out:");
        for (const { reason, count } of result.skipped) console.log(`    ${n(count)} ${reason}`);
      }
      console.log("");
    } catch (err) {
      refuse(err instanceof Error ? err.message : String(err));
    }
    process.exit(0);
  }

  if (command !== undefined) {
    console.error(`Unknown command "${command}". Run with --help to see what is available.`);
    process.exit(1);
  }

  function lanAddresses(): string[] {
    const out: string[] = [];
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const iface of ifaces ?? []) {
        if (iface.family === "IPv4" && !iface.internal) out.push(iface.address);
      }
    }
    return out;
  }

  // A `web/` folder next to the executable is picked up automatically (how the
  // bundled CLI and Docker image ship the browser client).
  const besideScript = join(dirname(script), "web");
  const webDistPath = values.web
    ? resolve(values.web)
    : existsSync(besideScript)
      ? besideScript
      : undefined;

  /**
   * Reads a numeric setting, naming the flag someone actually typed rather than
   * letting a stray character surface as an internal option name in a stack trace.
   */
  function numericOption(flag: string, raw: string | undefined, fallback: number): number {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      console.error(`
  ${flag} needs a non-negative number, not "${raw}"
`);
      process.exit(1);
    }
    return value;
  }

  const storageLimitMb = numericOption(
    "--storage-limit-mb",
    flagOrEnv(values, "storage-limit-mb", envSetting),
    0,
  );
  const abandonedUploadHours = numericOption(
    "--abandoned-upload-hours",
    flagOrEnv(values, "abandoned-upload-hours", envSetting),
    24,
  );
  let port: number;
  let retentionDays: number;
  let publicUrl: string | undefined;
  let scheduledBackups: ScheduledBackups | undefined;
  let memberNotice: MemberNotice | undefined;
  let claimCode: string | undefined;
  let iceServers: IceServer[];
  let relay: ServerRelay | null;
  const made: ServerExtension[] = [];
  try {
    port = parsePort(values.port);
    // Whole days: 1.5 would otherwise be announced as 1.5 and applied as 2.
    retentionDays = parseWholeNumber(
      flagOrEnv(values, "retention-days", envSetting),
      "--retention-days",
      0,
    );
    publicUrl =
      values["public-url"] === undefined ? undefined : parsePublicUrl(values["public-url"]);
    scheduledBackups = scheduledBackupsOption();
    memberNotice = parseMemberNotice({
      members: flagOrEnv(values, "member-notice", envSetting),
      planName: flagOrEnv(values, "plan-name", envSetting),
      upgradeUrl: flagOrEnv(values, "upgrade-url", envSetting),
    });
    claimCode = parseClaimCode(envSetting("CLAIM_CODE"));
    iceServers = parseIceServers(envSetting("ICE_SERVERS"));
    relay = relayFromEnvironment(envSetting);
    for (const extension of extensions) {
      made.push(
        await extension.create(
          values as Record<string, string | boolean | undefined>,
          (name) => process.env[envName(name)],
        ),
      );
    }
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    refuse(err.message);
  }
  if (abandonedUploadHours <= 0) {
    console.error(`
  --abandoned-upload-hours must be greater than zero
`);
    process.exit(1);
  }

  function scheduledBackupsOption(): ScheduledBackups | undefined {
    const dir = flagOrEnv(values, "backup-dir", envSetting);
    const everyRaw = flagOrEnv(values, "backup-every-hours", envSetting);
    const keepRaw = flagOrEnv(values, "backup-keep", envSetting);
    const offsiteRaw = flagOrEnv(values, "backup-offsite", envSetting);
    const offsiteKeepRaw = flagOrEnv(values, "backup-offsite-keep", envSetting);
    if (!dir) {
      if (everyRaw !== undefined || keepRaw !== undefined)
        throw new ConfigError(
          "--backup-every-hours and --backup-keep need --backup-dir, the place to put the backups",
        );
      if (offsiteRaw !== undefined || offsiteKeepRaw !== undefined)
        throw new ConfigError(
          "--backup-offsite needs --backup-dir: each backup is taken there first, then sent",
        );
      return undefined;
    }
    const everyHours = parseWholeNumber(everyRaw, "--backup-every-hours", 24);
    const keep = parseWholeNumber(keepRaw, "--backup-keep", 7);
    if (everyHours < 1) throw new ConfigError("--backup-every-hours must be at least 1");
    if (keep < 1) throw new ConfigError("--backup-keep must be at least 1");
    return {
      dir: resolve(dir),
      everyMs: everyHours * 3600_000,
      keep,
      offsite: offsiteOption(offsiteRaw, offsiteKeepRaw, keep),
    };
  }

  /** --backup-offsite, its keys from the environment only, so they are not in a process list. */
  function offsiteOption(
    raw: string | undefined,
    keepRaw: string | undefined,
    fallbackKeep: number,
  ) {
    if (raw === undefined) {
      if (keepRaw !== undefined)
        throw new ConfigError(
          "--backup-offsite-keep needs --backup-offsite, the bucket to keep them in",
        );
      return undefined;
    }
    const accessKeyId = envSetting("BACKUP_OFFSITE_ACCESS_KEY_ID")?.trim();
    const secretAccessKey = envSetting("BACKUP_OFFSITE_SECRET_ACCESS_KEY")?.trim();
    if (!accessKeyId || !secretAccessKey)
      throw new ConfigError(
        "--backup-offsite needs OWNBASE_BACKUP_OFFSITE_ACCESS_KEY_ID and OWNBASE_BACKUP_OFFSITE_SECRET_ACCESS_KEY",
      );
    const keep = parseWholeNumber(keepRaw, "--backup-offsite-keep", fallbackKeep);
    if (keep < 1) throw new ConfigError("--backup-offsite-keep must be at least 1");
    return new OffsiteBackups(
      {
        ...parseOffsiteUrl(raw),
        region: envSetting("BACKUP_OFFSITE_REGION")?.trim() || "auto",
        accessKeyId,
        secretAccessKey,
      },
      keep,
    );
  }

  const accessPolicy = values["access-policy"];
  if (accessPolicy !== undefined && !isAccessPolicy(accessPolicy))
    refuse(`--access-policy must be one of ${ACCESS_POLICIES.join(", ")}`);

  // An isolated copy stays on this machine unless told otherwise, since the
  // people who use the original would otherwise find a second one to sign in to.
  const host = values.host ?? (values.isolated ? "127.0.0.1" : "0.0.0.0");
  const loopbackOnly = ["127.0.0.1", "localhost", "::1"].includes(host);

  const server = await createWorkspaceServer({
    dataDir: resolve(values.data),
    maxStorageBytes: Math.round(storageLimitMb * 1024 * 1024),
    abandonedUploadTtlMs: Math.round(abandonedUploadHours * 3600_000),
    retentionDays,
    scheduledBackups,
    memberNotice,
    claimCode,
    extensions: made,
    // Scheduled backups and the owner's copies, in a child process, so the
    // copy and its checks never hold up chat.
    takeBackup: backupInChildProcess({
      script: script,
      dataDir: resolve(values.data),
    }),
    port,
    host,
    workspaceName: values.name,
    // --invite-only is --access-policy invite_only, which outranks it.
    ...(accessPolicy || values["invite-only"]
      ? { accessPolicy: accessPolicy ?? "invite_only" }
      : {}),
    mdns: !values["no-mdns"],
    isolated: values.isolated,
    webDistPath,
    publicUrl,
    allowPrivateHooks: values["allow-private-hooks"],
    trustProxy: values["trust-proxy"],
    backupBeforeUpgrade: !values["skip-upgrade-backup"],
    rateLimits: values["no-rate-limits"] || envSetting("RATE_LIMITS") === "off" ? false : undefined,
    logger: true,
    iceServers,
    relay,
  }).catch((err: unknown) => refuse(describeStartupError(err, { port, host })));

  console.log(`\n  OwnBase server v${SERVER_VERSION} is running`);
  console.log(`  Data: ${resolve(values.data)}`);
  if (server.upgradeBackup) {
    console.log(`  Upgraded this workspace. The copy from before is at ${server.upgradeBackup}`);
  }
  console.log(`  Local:   http://localhost:${server.port}`);
  if (values.isolated) {
    console.log("  Isolated: scheduled messages wait, apps are sent nothing, and it is");
    console.log("  not announced. Start it without --isolated to let them go.");
  }
  for (const line of keptSettingsNotes({
    name: values.name,
    accessPolicy,
    inviteOnly: values["invite-only"],
    kept: { name: server.workspaceName(), accessPolicy: server.accessPolicy() },
  })) {
    console.log(`  ${line}`);
  }
  if (retentionDays > 0) {
    // Said out loud on every start. A setting that quietly discards history is
    // one somebody should be reminded they turned on.
    console.log(`  Retention: conversation older than ${retentionDays} days is discarded`);
  }
  if (scheduledBackups && !values.isolated) {
    const status = server.backupStatus();
    console.log(
      `  Backups: every ${scheduledBackups.everyMs / 3600_000} h to ${scheduledBackups.dir}, keeping ${scheduledBackups.keep}`,
    );
    if (status?.nextAt) console.log(`  Next backup: ${new Date(status.nextAt).toISOString()}`);
    if (scheduledBackups.offsite) {
      console.log(
        `  Offsite: each backup also goes to ${scheduledBackups.offsite.where}, keeping ${scheduledBackups.offsite.keep}`,
      );
    }
  }
  for (const extension of made) {
    const status = extension.status?.();
    if (status) console.log(`  ${status.summary}`);
  }
  if (memberNotice) {
    const plan = memberNotice.planName ? `the ${memberNotice.planName} plan` : "the plan";
    console.log(
      `  Members: ${plan} includes ${memberNotice.members}. Past that, the owner and admins are told`,
    );
  }
  for (const addr of loopbackOnly ? [] : lanAddresses()) {
    console.log(`  Network: http://${addr}:${server.port}  <- share this with your team`);
  }
  if (server.claimCode) {
    console.log("");
    console.log("  This workspace has no owner yet.");
    console.log(`  Claim code: ${server.claimCode}`);
    if (publicUrl) {
      // Behind a proxy or tunnel every request arrives from this machine, so
      // none of them is let off.
      console.log("  With --public-url set, enter it when you create that account,");
      console.log("  from this machine too.");
    } else {
      console.log("  Creating the first account from this machine does not need it.");
      console.log("  From anywhere else, enter it when you create that account.");
    }
  }
  console.log("");

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void server.stop().then(() => process.exit(0));
    });
  }
}
