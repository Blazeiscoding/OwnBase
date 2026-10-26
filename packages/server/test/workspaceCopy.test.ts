import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import type { WorkspaceCopy } from "@slackoss/protocol";
import { backupWorkspace, restoreWorkspace, verifyBackup } from "../src/backup.js";
import { WorkspaceCopies, withBackupFolder } from "../src/workspaceCopy.js";
import { createWorkspaceServer, type ServerOptions, type WorkspaceServer } from "../src/server.js";

/** Free space the server is told it has, or null for the disk's own answer. */
const disk = vi.hoisted(() => ({ free: null as number | null }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statfsSync: ((...args: Parameters<typeof actual.statfsSync>) => {
      const real = actual.statfsSync(...args);
      return disk.free === null ? real : { ...real, bavail: disk.free, bsize: 1 };
    }) as typeof actual.statfsSync,
  };
});

let server: WorkspaceServer | undefined;
let root: string;
let dataDir: string;
let copiesDir: string;
let base: string;

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

async function start(extra: Partial<ServerOptions> = {}) {
  server = await createWorkspaceServer({
    dataDir,
    copiesDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    workspaceName: "Copied",
    ...extra,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function api(path: string, token?: string, method = "GET", body?: unknown) {
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

/** An owner, an admin and a member, a message with a file, and the owner's token. */
async function populate() {
  const owner = (
    await api("/api/auth/register", undefined, "POST", {
      handle: "owner",
      displayName: "Owner",
      password: "password123",
    })
  ).body;
  const join = async (handle: string) => {
    const code = (await api("/api/invites", owner.token, "POST", { maxUses: 1 })).body.invite.code;
    return (
      await api("/api/auth/register", undefined, "POST", {
        handle,
        displayName: handle,
        password: "password123",
        inviteCode: code,
      })
    ).body;
  };
  const admin = await join("admin");
  const member = await join("member");
  await api(`/api/admin/users/${admin.user.id}`, owner.token, "PATCH", { role: "admin" });
  const general = server!.store.getChannelByName("general")!.id;
  const form = new FormData();
  form.append("file", new Blob(["in the copy"]), "notes.txt");
  const uploaded = await fetch(`${base}/api/channels/${general}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${owner.token}` },
    body: form,
  });
  const { file } = (await uploaded.json()) as { file: { id: string } };
  await api(`/api/channels/${general}/messages`, owner.token, "POST", {
    text: "with a file",
    fileIds: [file.id],
  });
  return { owner, admin, member };
}

async function ready(token: string): Promise<Extract<WorkspaceCopy, { state: "ready" }>> {
  let copy: WorkspaceCopy | null = null;
  await vi.waitFor(
    async () => {
      copy = (await api("/api/admin/copy", token)).body.copy;
      expect(copy?.state).toBe("ready");
    },
    { timeout: 15_000, interval: 50 },
  );
  return copy! as Extract<WorkspaceCopy, { state: "ready" }>;
}

async function ticket(token: string): Promise<string> {
  const { status, body } = await api("/api/admin/copy/download-token", token, "POST");
  expect(status).toBe(200);
  return body.token;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ownbase-copy-"));
  dataDir = join(root, "data");
  copiesDir = join(root, "copies");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  disk.free = null;
  await server?.stop();
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("a copy for the owner", () => {
  it("is made on asking, downloads as one zip, and restores to the same workspace", async () => {
    await start();
    const { owner } = await populate();
    expect((await api("/api/server-info")).body.workspaceCopies).toBe(true);
    expect((await api("/api/admin/copy", owner.token)).body).toEqual({ copy: null });
    const made = await api("/api/admin/copy", owner.token, "POST");
    expect(made.status).toBe(200);
    expect(made.body.copy).toMatchObject({ state: "making" });
    const copy = await ready(owner.token);
    expect(copy.id).toBe(made.body.copy.id);

    const response = await fetch(
      `${base}/api/admin/copy/${copy.id}?download=${await ticket(owner.token)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(Number(response.headers.get("content-length"))).toBe(copy.bytes);
    const zip = join(root, "copy.zip");
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(zip));

    const manifest = await withBackupFolder(zip, (dir) => verifyBackup(dir));
    expect(manifest.workspaceName).toBe("Copied");
    expect(manifest.files).toHaveLength(1);
    expect(manifest.counts.users).toBe(3);
    // Its files are dated when the backup was taken, in the server's local time.
    const taken = new Date(manifest.createdAt);
    const firstEntry = readFileSync(zip);
    expect(firstEntry.readUInt16LE(12)).toBe(
      ((taken.getFullYear() - 1980) << 9) | ((taken.getMonth() + 1) << 5) | taken.getDate(),
    );
    expect(firstEntry.readUInt16LE(10)).toBe(
      (taken.getHours() << 11) | (taken.getMinutes() << 5) | (taken.getSeconds() >> 1),
    );

    await server!.stop();
    server = undefined;
    const restored = join(root, "restored");
    await withBackupFolder(zip, (backupDir) => restoreWorkspace({ backupDir, dataDir: restored }));
    await start({ dataDir: restored, copiesDir: join(root, "copies-2"), isolated: true });
    const login = await api("/api/auth/login", undefined, "POST", {
      handle: "owner",
      password: "password123",
    });
    expect(login.status).toBe(200);
    const general = server!.store.getChannelByName("general")!.id;
    const messages = (await api(`/api/channels/${general}/messages`, login.body.token)).body;
    expect(messages.messages.map((m: { text: string }) => m.text)).toContain("with a file");
  });

  it("is the owner's alone", async () => {
    await start();
    const { owner, admin, member } = await populate();
    for (const who of [admin, member]) {
      expect((await api("/api/admin/copy", who.token)).status).toBe(403);
      expect((await api("/api/admin/copy", who.token, "POST")).status).toBe(403);
      expect((await api("/api/admin/copy/download-token", who.token, "POST")).status).toBe(403);
    }
    const copy = (await api("/api/admin/copy", owner.token, "POST")).body.copy;
    await ready(owner.token);
    expect((await fetch(`${base}/api/admin/copy/${copy.id}`)).status).toBe(401);
    const asAdmin = await fetch(`${base}/api/admin/copy/${copy.id}`, {
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(asAdmin.status).toBe(403);
    expect((await api("/api/admin/copy")).status).toBe(401);
  });

  it("downloads once per ticket, for that copy, while the owner is still signed in as owner", async () => {
    await start();
    const { owner, admin } = await populate();
    const copy = (await api("/api/admin/copy", owner.token, "POST")).body.copy;
    await ready(owner.token);
    const url = (t: string, id = copy.id) => `${base}/api/admin/copy/${id}?download=${t}`;

    const once = await ticket(owner.token);
    const first = await fetch(url(once));
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    expect((await fetch(url(once))).status).toBe(404);

    expect((await fetch(url(await ticket(owner.token), "another-copy"))).status).toBe(404);
    // A ticket opens the copy it was given for, not the one made after it.
    const forFirst = await ticket(owner.token);
    const second = (await api("/api/admin/copy", owner.token, "POST")).body.copy;
    expect(second.id).not.toBe(copy.id);
    await ready(owner.token);
    expect((await fetch(url(forFirst, second.id))).status).toBe(404);
    const fresh = await fetch(url(await ticket(owner.token), second.id));
    expect(fresh.status).toBe(200);
    await fresh.arrayBuffer();
    expect((await fetch(url("a".repeat(64)))).status).toBe(404);
    expect((await fetch(url("not-a-ticket"))).status).toBe(404);

    // Handing the workspace over spends nothing, but the ticket no longer opens it.
    const beforeHandover = await ticket(owner.token);
    await api(`/api/admin/users/${admin.user.id}/owner`, owner.token, "POST");
    expect((await fetch(url(beforeHandover, second.id))).status).toBe(404);

    // A ticket from a session that has signed out is worth nothing either.
    const newOwner = admin.token;
    const fromNewOwner = await ticket(newOwner);
    await api("/api/auth/logout", newOwner, "POST");
    expect((await fetch(url(fromNewOwner, second.id))).status).toBe(404);
  });

  it("expires its ticket after a minute", async () => {
    await start();
    const { owner } = await populate();
    const copy = (await api("/api/admin/copy", owner.token, "POST")).body.copy;
    await ready(owner.token);
    const t = await ticket(owner.token);
    const later = Date.now() + 61_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    expect((await fetch(`${base}/api/admin/copy/${copy.id}?download=${t}`)).status).toBe(404);
  });

  it("gives the copy being made when asked again, and says who made and downloaded it", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await start({
      takeBackup: async (out) => {
        await held;
        return backupWorkspace({ dataDir, out });
      },
    });
    const { owner } = await populate();
    const first = (await api("/api/admin/copy", owner.token, "POST")).body.copy;
    const second = (await api("/api/admin/copy", owner.token, "POST")).body.copy;
    expect(second.id).toBe(first.id);
    release();
    const copy = await ready(owner.token);
    const download = await fetch(
      `${base}/api/admin/copy/${copy.id}?download=${await ticket(owner.token)}`,
    );
    await download.arrayBuffer();
    const actions = (await api("/api/admin/audit", owner.token)).body.entries.map(
      (e: { action: string; actorId: string; details: object }) => ({
        action: e.action,
        actorId: e.actorId,
      }),
    );
    expect(actions).toContainEqual({ action: "workspace.copy_made", actorId: owner.user.id });
    expect(actions).toContainEqual({ action: "workspace.copy_downloaded", actorId: owner.user.id });
    expect(
      actions.filter((a: { action: string }) => a.action === "workspace.copy_made"),
    ).toHaveLength(1);
  });

  it("will not replace the copy while it is being downloaded", async () => {
    await start();
    const { owner } = await populate();
    const copy = (await api("/api/admin/copy", owner.token, "POST")).body.copy;
    await ready(owner.token);
    const downloading = await fetch(`${base}/api/admin/copy/${copy.id}`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(downloading.status).toBe(200);
    const again = await api("/api/admin/copy", owner.token, "POST");
    // A small copy may have been sent already; a large one is still going.
    if (again.status === 409) expect(again.body.error).toBe("copy_downloading");
    await downloading.arrayBuffer();
    await vi.waitFor(async () => {
      expect((await api("/api/admin/copy", owner.token, "POST")).status).toBe(200);
    });
  });

  it("removes no attachment while the copy is made", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let copying!: () => void;
    const started = new Promise<void>((resolve) => (copying = resolve));
    await start({
      takeBackup: async (out) => {
        copying();
        await held;
        return backupWorkspace({ dataDir, out });
      },
    });
    const { owner } = await populate();
    await api("/api/admin/copy", owner.token, "POST");
    await started;
    const general = server!.store.getChannelByName("general")!.id;
    const message = (
      await api(`/api/channels/${general}/messages`, owner.token)
    ).body.messages.find((m: { files: unknown[] }) => m.files.length > 0);
    const blob = join(dataDir, "files", message.files[0].id);
    expect((await api(`/api/messages/${message.id}`, owner.token, "DELETE")).status).toBe(200);
    await server!.flushFileDeletions();
    expect(existsSync(blob)).toBe(true);
    release();
    const copy = await ready(owner.token);
    expect(copy.state).toBe("ready");
    await vi.waitFor(() => expect(existsSync(blob)).toBe(false));
  });

  it("says why a copy failed, and clears what it left", async () => {
    await start({
      takeBackup: async () => {
        throw new Error("No room left on the disk.");
      },
    });
    const { owner } = await populate();
    await api("/api/admin/copy", owner.token, "POST");
    await vi.waitFor(async () => {
      expect((await api("/api/admin/copy", owner.token)).body.copy).toMatchObject({
        state: "failed",
        error: "No room left on the disk.",
      });
    });
    expect(readdirSync(copiesDir)).toEqual([]);
  });

  it("refuses to start a copy the disk has no room for", async () => {
    await start();
    const { owner } = await populate();
    disk.free = 1024 * 1024;
    const refused = await api("/api/admin/copy", owner.token, "POST");
    expect(refused.status).toBe(507);
    expect(refused.body.error).toBe("not_enough_space");
    expect(refused.body.message).toMatch(/needs about .* MB free on the server, and it has 1 MB/);
  });

  it("clears copies a previous run left behind when it starts", async () => {
    mkdirSync(join(copiesDir, "left-over"), { recursive: true });
    await writeFile(join(copiesDir, "left-over", "workspace.db"), "old");
    await start();
    expect(existsSync(copiesDir)).toBe(false);
  });

  it("is not offered for a workspace kept in memory", async () => {
    await start({ dataDir: ":memory:" });
    expect((await api("/api/server-info")).body.workspaceCopies).toBe(false);
  });
});

describe("keeping a copy", () => {
  it("removes a ready copy when its time is up, but not under a download", async () => {
    let now = 1_000_000;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const copies = new WorkspaceCopies({
      root: copiesDir,
      take: async (out) => {
        mkdirSync(join(out, "files"), { recursive: true });
        await writeFile(join(out, "manifest.json"), "{}");
        await writeFile(join(out, "workspace.db"), "db");
        return {} as never;
      },
      keepMs: 20,
      log: { error: () => {} },
      now: () => now,
    });
    const made = copies.make()!;
    for (let turns = 0; copies.state()?.state !== "ready"; turns++) {
      expect(turns).toBeLessThan(10_000);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const zip = copies.open(made.id)!;
    expect(zip).not.toBeNull();
    now += 25;
    vi.advanceTimersByTime(25);
    // Still there: a download is reading it, so it is kept five minutes more.
    expect(copies.state()).toMatchObject({ state: "ready", expiresAt: now + 300_000 });
    expect(copies.make()).toBeNull();
    for await (const _ of zip.stream) void _;
    now += 300_000;
    vi.advanceTimersByTime(300_000);
    expect(copies.state()).toBeNull();
    await vi.waitFor(() => expect(readdirSync(copiesDir)).toEqual([]));
    await copies.stop();
  });
});

describe("the command line", () => {
  it("restores from a downloaded copy's zip and says what it holds", async () => {
    await start();
    const { owner } = await populate();
    const copy = (await api("/api/admin/copy", owner.token, "POST")).body.copy;
    await ready(owner.token);
    const response = await fetch(
      `${base}/api/admin/copy/${copy.id}?download=${await ticket(owner.token)}`,
    );
    const zip = join(root, "copy.zip");
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(zip));
    await server!.stop();
    server = undefined;
    const run = (args: string[]) =>
      new Promise<{ code: number | null; output: string }>((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", main, ...args], {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout!.on("data", (chunk) => (output += String(chunk)));
        child.stderr!.on("data", (chunk) => (output += String(chunk)));
        child.once("exit", (code) => resolve({ code, output }));
      });
    const verified = await run(["verify-backup", "--from", zip]);
    expect(verified.output).toContain('Backup of "Copied" is intact');
    expect(verified.code).toBe(0);
    const restored = await run(["restore", "--from", zip, "--data", join(root, "from-zip")]);
    expect(restored.output).toContain('Restored "Copied"');
    expect(restored.code).toBe(0);
    // Unpacked beside the zip while it was used, and gone after.
    expect(readdirSync(root).filter((name) => name.startsWith(".ownbase-unzip-"))).toEqual([]);
  }, 60_000);
});
