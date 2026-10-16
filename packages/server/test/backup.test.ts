import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupWorkspace,
  inventoryBackup,
  restoreWorkspace,
  verifyBackup,
  type BackupManifest,
} from "../src/backup.js";
import { SCHEMA_VERSION } from "../src/db.js";
import { createWorkspaceServer, type ServerOptions, type WorkspaceServer } from "../src/server.js";

let server: WorkspaceServer | undefined;
let root: string;
let dataDir: string;
let base: string;

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

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "slackoss-backup-"));
  dataDir = join(root, "data");
  await start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server?.stop();
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

/**
 * A file's digest, for saying it is unchanged. Deep equality on the bytes of a
 * whole database walks them one by one: about a second here, and past the
 * five-second limit when the machine is also running every other suite.
 */
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A workspace with something of every kind worth losing. */
async function populate() {
  const owner = (
    await api("/api/auth/register", undefined, "POST", {
      handle: "owner",
      displayName: "Owner",
      password: "password123",
    })
  ).body;
  const code = (await api("/api/invites", owner.token, "POST", { maxUses: 5 })).body.invite.code;
  const guest = (
    await api("/api/auth/register", undefined, "POST", {
      handle: "guest",
      displayName: "Guest",
      password: "password123",
      inviteCode: code,
    })
  ).body;
  const general = server!.store.getChannelByName("general")!.id;
  const private_ = (
    await api("/api/channels", owner.token, "POST", { type: "private", name: "leadership" })
  ).body.channel;
  await api(`/api/channels/${private_.id}/invite-member`, owner.token, "POST", {
    userId: guest.user.id,
  });
  await api(`/api/friends/${guest.user.id}`, owner.token, "POST");
  await api(`/api/friends/${owner.user.id}`, guest.token, "PUT");
  await api(`/api/channels/${general}/messages`, owner.token, "POST", {
    text: "kept across a restore",
  });
  await api(`/api/channels/${private_.id}/scheduled`, owner.token, "POST", {
    text: "still queued",
    sendAt: Date.now() + 3_600_000,
  });

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array([1, 2, 3, 4, 5])]), "attachment.bin");
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
  return { owner, guest, general, private: private_, fileId: file.id };
}

describe("backup and restore", () => {
  it("refuses to certify a snapshot whose attachment has disappeared", async () => {
    const world = await populate();
    await server!.stop();
    rmSync(join(dataDir, "files", world.fileId));
    const out = join(root, "incomplete");
    await expect(backupWorkspace({ dataDir, out })).rejects.toThrow();
    expect(existsSync(join(out, "manifest.json"))).toBe(false);
  });

  it("uses the copied database for counts when the live workspace changes before capture", async () => {
    const world = await populate();
    const prepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === "VACUUM INTO ?") {
        server!.store.createChannel({
          type: "public",
          name: "during-backup",
          creatorId: world.owner.user.id,
          memberIds: [world.owner.user.id],
        });
      }
      return prepare.call(this, sql);
    });
    const out = join(root, "live-backup");
    const manifest = await backupWorkspace({ dataDir, out });
    expect(manifest.counts.channels).toBe(3);
    await expect(verifyBackup(out)).resolves.toMatchObject({ counts: { channels: 3 } });
  });

  it("rejects missing inventory entries even when the listed checksums all match", async () => {
    await populate();
    await server!.stop();
    const out = join(root, "backup");
    const manifest = await backupWorkspace({ dataDir, out });
    writeFileSync(join(out, "manifest.json"), JSON.stringify({ ...manifest, files: [] }));
    const before = readFileSync(join(dataDir, "workspace.db"));
    await expect(restoreWorkspace({ backupDir: out, dataDir })).rejects.toThrow(
      /attachment.*missing/,
    );
    expect(sha256(readFileSync(join(dataDir, "workspace.db")))).toBe(sha256(before));
  });

  it.each(["../escape", "..\\escape", "C:\\escape", "file:stream"])(
    "rejects unsafe attachment paths: %s",
    async (name) => {
      await populate();
      await server!.stop();
      const out = join(root, "backup");
      const manifest = await backupWorkspace({ dataDir, out });
      manifest.files[0]!.name = name;
      writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest));
      await expect(restoreWorkspace({ backupDir: out, dataDir })).rejects.toThrow(/manifest/);
    },
  );

  it("checks the actual schema even if a manifest claims an older version", async () => {
    await populate();
    await server!.stop();
    const out = join(root, "backup");
    const manifest: BackupManifest = await backupWorkspace({ dataDir, out });
    const db = new DatabaseSync(join(out, "workspace.db"));
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    const bytes = readFileSync(join(out, "workspace.db"));
    manifest.database = {
      name: "workspace.db",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest));
    await expect(verifyBackup(out)).rejects.toThrow(/newer server/);
  });

  it("rejects overlapping directories without moving the workspace", async () => {
    await populate();
    await server!.stop();
    const before = readFileSync(join(dataDir, "workspace.db"));
    await expect(backupWorkspace({ dataDir, out: join(dataDir, "backup") })).rejects.toThrow(
      /separate/,
    );
    await expect(restoreWorkspace({ backupDir: dataDir, dataDir })).rejects.toThrow(/separate/);
    await expect(restoreWorkspace({ backupDir: dataDir, dataDir: root })).rejects.toThrow(
      /separate/,
    );
    expect(sha256(readFileSync(join(dataDir, "workspace.db")))).toBe(sha256(before));
  });

  it("preserves accounts, messages, attachments, memberships, friendships and queued work", async () => {
    const world = await populate();
    const out = join(root, "backup");
    await server!.stop();
    const manifest = await backupWorkspace({ dataDir, out });
    expect(manifest.counts.users).toBe(2);
    expect(manifest.files).toHaveLength(1);

    // Lose the workspace entirely, then bring it back from the backup alone.
    rmSync(dataDir, { recursive: true, force: true });
    const { supersededDir } = await restoreWorkspace({ backupDir: out, dataDir });
    expect(supersededDir).toBeNull();
    await start();

    const login = (
      await api("/api/auth/login", undefined, "POST", { handle: "guest", password: "password123" })
    ).body;
    expect(login.user.id).toBe(world.guest.user.id);
    const messages = (await api(`/api/channels/${world.general}/messages`, login.token)).body
      .messages;
    expect(messages.map((m: { text: string }) => m.text)).toContain("kept across a restore");
    // The guest kept private-channel membership, so this is not a 404.
    expect((await api(`/api/channels/${world.private.id}/messages`, login.token)).status).toBe(200);

    const owner = (
      await api("/api/auth/login", undefined, "POST", { handle: "owner", password: "password123" })
    ).body;
    expect((await api("/api/scheduled", owner.token)).body.scheduled).toHaveLength(1);
    expect((await api("/api/friends", owner.token)).body.friends).toEqual([
      expect.objectContaining({ userId: world.guest.user.id, status: "accepted" }),
    ]);
    const blob = await fetch(`${base}/api/files/${world.fileId}`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("refuses a damaged backup before touching the workspace", async () => {
    await populate();
    const out = join(root, "backup");
    await server!.stop();
    await backupWorkspace({ dataDir, out });
    const before = readFileSync(join(dataDir, "workspace.db"));

    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as {
      files: { name: string }[];
    };
    writeFileSync(join(out, "files", manifest.files[0]!.name), "tampered");
    await expect(verifyBackup(out)).rejects.toThrow(/checksum/);
    await expect(restoreWorkspace({ backupDir: out, dataDir })).rejects.toThrow(/checksum/);
    expect(sha256(readFileSync(join(dataDir, "workspace.db")))).toBe(sha256(before));
  });

  it("refuses a backup written by a newer server", async () => {
    await populate();
    const out = join(root, "backup");
    await server!.stop();
    const manifest = await backupWorkspace({ dataDir, out });
    writeFileSync(
      join(out, "manifest.json"),
      JSON.stringify({ ...manifest, schemaVersion: manifest.schemaVersion + 5 }),
    );
    await expect(verifyBackup(out)).rejects.toThrow(/newer server/);
  });

  it("keeps the superseded workspace rather than deleting it", async () => {
    await populate();
    const out = join(root, "backup");
    await server!.stop();
    await backupWorkspace({ dataDir, out });
    const { supersededDir } = await restoreWorkspace({ backupDir: out, dataDir });
    expect(supersededDir).not.toBeNull();
    expect(readFileSync(join(supersededDir!, "workspace.db")).length).toBeGreaterThan(0);
  });

  it("will not write a backup into a directory that already holds something", async () => {
    await populate();
    const out = join(root, "backup");
    await server!.stop();
    await backupWorkspace({ dataDir, out });
    await expect(backupWorkspace({ dataDir, out })).rejects.toThrow(/not empty/);
  });
});

describe("an isolated restore", () => {
  let app: Server;
  let appOrigin: string;
  /** Every request the stand-in app received, other than the address check. */
  let received: { url: string; body: string }[];
  let answer: number;

  beforeEach(async () => {
    received = [];
    answer = 200;
    app = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        const challenge = body.startsWith("{")
          ? (JSON.parse(body) as { challenge?: string }).challenge
          : undefined;
        if (challenge) return res.end(JSON.stringify({ challenge }));
        received.push({ url: req.url ?? "", body });
        res.writeHead(answer, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
    appOrigin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    // The stand-in app is on loopback, which apps may only use with this.
    await server!.stop();
    await start({ allowPrivateHooks: true });
  });

  afterEach(async () => {
    await new Promise<void>((done) => app.close(() => done()));
  });

  /** The populated workspace, plus an app that receives events and a command. */
  async function withApp() {
    const world = await populate();
    const made = (await api("/api/apps", world.owner.token, "POST", { name: "Deploy Bot" })).body;
    const subscribed = await api(
      `/api/apps/${made.app.id}/subscriptions`,
      world.owner.token,
      "POST",
      {
        url: `${appOrigin}/events`,
        eventTypes: ["message.created"],
      },
    );
    expect(subscribed.status).toBe(201);
    const command = await api(`/api/apps/${made.app.id}/commands`, world.owner.token, "POST", {
      command: "/deploy",
      url: `${appOrigin}/deploy`,
    });
    expect(command.status).toBe(201);
    server!.store.addMember(world.general, made.botUser.id);
    // Refused, so the event is still waiting when the backup is taken.
    answer = 503;
    await api(`/api/channels/${world.general}/messages`, world.owner.token, "POST", {
      text: "an event the app has not had",
    });
    await server!.flushEventDeliveries();
    expect(received.map((r) => r.url)).toContain("/events");
    return world;
  }

  it("lists the apps, queued work and sign-ins a backup would bring with it", async () => {
    await withApp();
    const out = join(root, "backup");
    await server!.stop();
    await backupWorkspace({ dataDir, out });

    const found = inventoryBackup(out);
    expect(found.appAddresses).toEqual([{ origin: appOrigin, uses: ["commands", "events"] }]);
    expect(found.scheduled.waiting).toBe(1);
    expect(found.scheduled.earliestAt).toBeGreaterThan(Date.now());
    expect(found.undeliveredEvents).toBe(1);
    // The owner and the guest are both still signed in.
    expect(found.sessions).toBe(2);
    expect(inventoryBackup(out, Date.now() + 365 * 24 * 3600_000).sessions).toBe(0);
  });

  it("posts nothing and calls no app until the copy is started normally", async () => {
    const world = await withApp();
    const out = join(root, "backup");
    await server!.stop();
    await backupWorkspace({ dataDir, out });

    // A fresh directory, where the scheduled message and the app's retry are
    // both already due.
    dataDir = join(root, "check");
    await restoreWorkspace({ backupDir: out, dataDir });
    const restored = new DatabaseSync(join(dataDir, "workspace.db"));
    restored.prepare("UPDATE scheduled_messages SET send_at = 0").run();
    restored.prepare("UPDATE event_deliveries SET next_attempt_at = 0").run();
    restored.close();

    answer = 200;
    received = [];
    await start({ allowPrivateHooks: true, isolated: true });
    server!.flushScheduled();
    await server!.flushEventDeliveries();
    const owner = (
      await api("/api/auth/login", undefined, "POST", { handle: "owner", password: "password123" })
    ).body;
    const texts = async () =>
      (await api(`/api/channels/${world.private.id}/messages`, owner.token)).body.messages.map(
        (m: { text: string }) => m.text,
      );
    expect(await texts()).not.toContain("still queued");
    await api(`/api/channels/${world.general}/messages`, owner.token, "POST", {
      text: "in the copy",
    });
    const ran = await api(`/api/channels/${world.general}/commands`, owner.token, "POST", {
      text: "/deploy staging",
    });
    expect(ran.body).toEqual({
      ok: false,
      error: "command_failed",
      message: "this is an isolated copy of the workspace, which does not contact apps",
    });
    await server!.flushEventDeliveries();
    expect(received).toEqual([]);

    // Started normally, the same data catches up on what it held back.
    await server!.stop();
    await start({ allowPrivateHooks: true });
    expect(await texts()).toContain("still queued");
    await server!.flushEventDeliveries();
    const delivered = received
      .filter((r) => r.url === "/events")
      .map((r) => (JSON.parse(r.body) as { event: { text: string } }).event.text);
    expect(delivered).toContain("an event the app has not had");
  });
});
