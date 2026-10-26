import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBackup, type BackupManifest } from "../src/backup.js";
import {
  backupFolderName,
  backupFolderTime,
  backupInChildProcess,
  listScheduledBackups,
} from "../src/backupSchedule.js";
import { createWorkspaceServer, type ServerOptions, type WorkspaceServer } from "../src/server.js";

let server: WorkspaceServer | undefined;
let root: string;
let dataDir: string;
let backupDir: string;
let base: string;
let token: string;

const HOUR = 3600_000;
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

async function start(extra: Partial<ServerOptions> = {}) {
  server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    workspaceName: "Backed Up",
    ...extra,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function register() {
  token = "";
  token = (
    await api("/api/auth/register", "POST", {
      handle: "owner",
      displayName: "Owner",
      password: "password123",
    })
  ).body.token;
}

/** A message with a file, and where the file's bytes are kept. */
async function attachedMessage() {
  const channelId = server!.store.getChannelByName("general")!.id;
  const form = new FormData();
  form.append("file", new Blob(["kept until the copy is done"]), "notes.txt");
  const uploaded = await fetch(`${base}/api/channels/${channelId}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const { file } = (await uploaded.json()) as { file: { id: string } };
  const { body } = await api(`/api/channels/${channelId}/messages`, "POST", {
    text: "with a file",
    fileIds: [file.id],
  });
  return { messageId: body.message.id as string, path: join(dataDir, "files", file.id) };
}

const schedule = (extra: Partial<NonNullable<ServerOptions["scheduledBackups"]>> = {}) => ({
  scheduledBackups: { dir: backupDir, everyMs: 24 * HOUR, keep: 7, ...extra },
});

/** A promise and the function that settles it, for holding a backup open. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ownbase-scheduled-backups-"));
  dataDir = join(root, "data");
  backupDir = join(root, "backups");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server?.stop();
  server = undefined;
  token = "";
  rmSync(root, { recursive: true, force: true });
});

describe("backup folder names", () => {
  it("are sortable, legal on Windows, and read back to the second they were taken", () => {
    const at = Date.UTC(2026, 9, 25, 3, 4, 5, 678);
    expect(backupFolderName(at)).toBe("backup-2026-10-25T03-04-05Z");
    expect(backupFolderTime("backup-2026-10-25T03-04-05Z")).toBe(Date.UTC(2026, 9, 25, 3, 4, 5));
  });

  it("are the only folders counted as this schedule's", () => {
    for (const name of [
      "backup-2026-10-25T03-04-05Z-copy",
      "backup-2026-13-25T03-04-05Z",
      "backup-2026-02-30T03-04-05Z",
      "Backup-2026-10-25T03-04-05Z",
      "notes",
    ])
      expect(backupFolderTime(name), name).toBeNull();
  });
});

describe("scheduled backups", () => {
  it("takes a verified backup when one is due, then waits the interval", async () => {
    await start(schedule({ firstDelayMs: 0 }));
    await vi.waitFor(() => expect(server!.backupStatus()!.lastSuccessAt).not.toBeNull(), {
      timeout: 15_000,
    });
    const status = server!.backupStatus()!;
    const [taken] = await listScheduledBackups(backupDir);
    expect(taken!.at).toBe(status.lastSuccessAt! - (status.lastSuccessAt! % 1000));
    const manifest = await verifyBackup(join(backupDir, taken!.name));
    expect(manifest.workspaceName).toBe("Backed Up");
    expect(status).toMatchObject({ failures: 0, lastError: null, running: false });
    expect(status.nextAt).toBe(status.lastSuccessAt! + 24 * HOUR);
  });

  it("copies the workspace's attachments, by default in this process", async () => {
    await start(schedule({ firstDelayMs: HOUR }));
    await register();
    await attachedMessage();
    await server!.runBackup();
    const [taken] = await listScheduledBackups(backupDir);
    const manifest = await verifyBackup(join(backupDir, taken!.name));
    expect(manifest.files).toHaveLength(1);
    expect(manifest.counts.messages).toBeGreaterThan(0);
  });

  it("counts from the newest backup already there, so a restart does not take another", async () => {
    mkdirSync(join(backupDir, backupFolderName(Date.now() - HOUR)), { recursive: true });
    const run = vi.fn();
    await start(schedule({ firstDelayMs: 0, run }));
    const status = server!.backupStatus()!;
    const newest = (await listScheduledBackups(backupDir)).at(-1)!.at;
    expect(status.lastSuccessAt).toBe(newest);
    expect(status.nextAt).toBe(newest + 24 * HOUR);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(run).not.toHaveBeenCalled();
  });

  it("takes one soon after starting when the last is overdue", async () => {
    mkdirSync(join(backupDir, backupFolderName(Date.now() - 30 * HOUR)), { recursive: true });
    const before = Date.now();
    await start(schedule({ firstDelayMs: 60_000, run: vi.fn() }));
    const nextAt = server!.backupStatus()!.nextAt!;
    expect(nextAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(nextAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it("keeps the newest few and touches nothing else in the folder", async () => {
    const old = [3, 2, 1].map((days) => backupFolderName(Date.now() - days * 24 * HOUR));
    for (const name of old) mkdirSync(join(backupDir, name), { recursive: true });
    mkdirSync(join(backupDir, "notes"));
    mkdirSync(join(backupDir, `${old[0]}-copy`));
    writeFileSync(join(backupDir, "README.txt"), "mine");
    await start(schedule({ keep: 2 }));
    await server!.runBackup();
    expect(server!.backupStatus()!.failures).toBe(0);
    const left = readdirSync(backupDir).sort();
    const newest = (await listScheduledBackups(backupDir)).at(-1)!.name;
    expect(left).toEqual([`${old[0]}-copy`, "README.txt", old[2], newest, "notes"].sort());
  });

  it("records a failure, keeps every earlier backup, and tries again within the hour", async () => {
    const kept = backupFolderName(Date.now() - 48 * HOUR);
    mkdirSync(join(backupDir, kept), { recursive: true });
    const run = vi.fn().mockRejectedValueOnce(new Error("disk full"));
    await start(schedule({ keep: 1, run }));
    const before = Date.now();
    await server!.runBackup();
    const status = server!.backupStatus()!;
    expect(status).toMatchObject({ failures: 1, lastError: "disk full", running: false });
    expect(status.nextAt).toBeGreaterThanOrEqual(before + HOUR);
    expect(status.nextAt).toBeLessThanOrEqual(Date.now() + HOUR);
    expect(readdirSync(backupDir)).toEqual([kept]);
  });

  it("never runs two at once", async () => {
    const held = gate();
    const run = vi.fn(async () => {
      await held.opened;
      return {} as BackupManifest;
    });
    await start(schedule({ run, keep: 1 }));
    const first = server!.runBackup();
    const second = server!.runBackup();
    expect(server!.backupStatus()!.running).toBe(true);
    held.open();
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("removes no attachment while one is copied, and removes it once the copy ends", async () => {
    const held = gate();
    const copying = gate();
    await start(
      schedule({
        keep: 1,
        run: async () => {
          copying.open();
          await held.opened;
          return {} as BackupManifest;
        },
      }),
    );
    await register();
    const item = await attachedMessage();
    const running = server!.runBackup();
    await copying.opened;
    expect((await api(`/api/messages/${item.messageId}`, "DELETE")).status).toBe(200);
    await server!.flushFileDeletions();
    expect(existsSync(item.path)).toBe(true);
    expect(server!.store.pendingFileDeletions()).toHaveLength(1);
    held.open();
    await running;
    await vi.waitFor(() => {
      expect(existsSync(item.path)).toBe(false);
      expect(server!.store.pendingFileDeletions()).toEqual([]);
    });
  });

  it("stops a running backup when the server stops, without counting it as failed", async () => {
    const aborted = vi.fn();
    await start(
      schedule({
        run: (_out, signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => {
              aborted();
              reject(new Error("killed"));
            }),
          ),
      }),
    );
    void server!.runBackup();
    const status = server!.backupStatus;
    await server!.stop();
    server = undefined;
    expect(aborted).toHaveBeenCalledOnce();
    expect(status()).toMatchObject({ failures: 0, lastError: null, nextAt: null });
  });

  it("tells owners and admins in the status, and says when they are off", async () => {
    await start(schedule({ run: vi.fn(), firstDelayMs: HOUR }));
    await register();
    expect((await api("/api/admin/status")).body.backups).toEqual({
      enabled: true,
      everyMs: 24 * HOUR,
      keep: 7,
      lastSuccessAt: null,
      failures: 0,
      nextAt: server!.backupStatus()!.nextAt,
      running: false,
    });
    await server!.stop();
    await start();
    expect((await api("/api/admin/status")).body.backups).toEqual({ enabled: false });
  });

  it("takes none in an isolated copy, which would prune the original's", async () => {
    await start({ ...schedule({ firstDelayMs: 0 }), isolated: true });
    expect(server!.backupStatus()).toBeNull();
  });

  it("refuses settings it cannot keep, before taking the workspace", async () => {
    for (const [scheduledBackups, message] of [
      [{ dir: join(dataDir, "backups"), everyMs: HOUR, keep: 1 }, "outside the workspace folder"],
      [{ dir: root, everyMs: HOUR, keep: 1 }, "outside the workspace folder"],
      [{ dir: backupDir, everyMs: 0, keep: 1 }, "greater than zero"],
      [{ dir: backupDir, everyMs: HOUR, keep: 0 }, "at least one"],
    ] as const) {
      await expect(start({ scheduledBackups })).rejects.toThrow(message);
    }
    await expect(
      start({ dataDir: ":memory:", scheduledBackups: { dir: backupDir, everyMs: HOUR, keep: 1 } }),
    ).rejects.toThrow("not one in memory");
    // Nothing held the folder: an ordinary start still works.
    await start();
  });
});

describe("a backup in a child process", () => {
  const run = () => backupInChildProcess({ script: main, dataDir, execArgv: ["--import", "tsx"] });

  it("copies a running workspace without holding its event loop", async () => {
    await start();
    await register();
    await attachedMessage();
    const out = join(backupDir, backupFolderName(Date.now()));
    const manifest = await run()(out, new AbortController().signal);
    expect(manifest.files).toHaveLength(1);
    expect((await verifyBackup(out)).counts.messages).toBe(manifest.counts.messages);
  }, 30_000);

  it("rejects with what the backup command said", async () => {
    await start();
    const out = join(backupDir, "taken");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "something.txt"), "already here");
    await expect(run()(out, new AbortController().signal)).rejects.toThrow("is not empty");
  }, 30_000);
});

describe("the command line", () => {
  function cli(args: string[]) {
    const child = spawn(process.execPath, ["--import", "tsx", main, ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout!.on("data", (chunk) => (output += String(chunk)));
    child.stderr!.on("data", (chunk) => (output += String(chunk)));
    return {
      child,
      output: () => output,
      exited: new Promise<number | null>((resolve) => child.once("exit", resolve)),
    };
  }

  it("refuses --backup-keep without --backup-dir", async () => {
    const run = cli(["--data", dataDir, "--port", "0", "--no-mdns", "--backup-keep", "3"]);
    expect(await run.exited).toBe(1);
    expect(run.output()).toContain("need --backup-dir");
  }, 30_000);

  it("says where backups go and when the next is due", async () => {
    const run = cli([
      "--data",
      dataDir,
      "--port",
      "0",
      "--host",
      "127.0.0.1",
      "--no-mdns",
      "--backup-dir",
      backupDir,
      "--backup-every-hours",
      "6",
      "--backup-keep",
      "3",
    ]);
    try {
      await vi.waitFor(() => expect(run.output()).toContain("Next backup:"), { timeout: 20_000 });
      expect(run.output()).toContain(`Backups: every 6 h to ${backupDir}, keeping 3`);
    } finally {
      run.child.kill();
      await run.exited;
    }
  }, 30_000);
});
