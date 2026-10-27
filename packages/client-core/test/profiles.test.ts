import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { currentZoneName } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { Api, WorkspaceClient, type WorkspaceState } from "../src/index.js";

/**
 * Profiles on the client (E9): the device's time zone is kept for an account
 * with none; idle and away reach everyone's presence; a picture is kept and
 * fetched with the session into an object URL.
 */
let server: WorkspaceServer;
let base: string;
let dataDir: string;
let aliceToken: string;
let bobToken: string;
let aliceId: string;

function until(
  client: WorkspaceClient,
  predicate: (s: WorkspaceState) => boolean,
  label = "condition",
): Promise<WorkspaceState> {
  return new Promise((resolve, reject) => {
    if (predicate(client.state)) return resolve(client.state);
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${label}`));
    }, 5000);
    const unsubscribe = client.store.subscribe((s) => {
      if (predicate(s)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(s);
      }
    });
  });
}

async function online(token = aliceToken) {
  const client = new WorkspaceClient(base, token);
  onTestFinished(() => client.destroy());
  client.connect();
  await until(client, (s) => s.status === "online", "connection");
  return client;
}

function png(size = 8): Blob {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 120)]);
  return new Blob(
    [
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(Buffer.concat(Array(size).fill(row)))),
        chunk("IEND", Buffer.alloc(0)),
      ]),
    ],
    { type: "image/png" },
  );
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-client-profiles-"));
  server = await createWorkspaceServer({ dataDir, port: 0, mdns: false, rateLimits: false });
  base = `http://127.0.0.1:${server.port}`;
  const api = new Api(base);
  const alice = await api.register({
    handle: "alice",
    displayName: "Alice",
    password: "password123",
  });
  aliceToken = alice.token;
  aliceId = alice.user.id;
  bobToken = (await api.register({ handle: "bob", displayName: "Bob", password: "password123" }))
    .token;
});

afterAll(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("profiles on the client", () => {
  it("keep this device's time zone for an account with none, and no other's over it", async () => {
    // Under its current name, as the server keeps it: this runtime may say Asia/Calcutta.
    const device = currentZoneName(Intl.DateTimeFormat().resolvedOptions().timeZone);
    const laptop = await online();
    expect(laptop.state.profiles).toBe(true);
    await until(laptop, (s) => s.self?.timeZone === device, "the detected zone");
    expect(await laptop.setTimeZone("Pacific/Auckland")).toBe(true);
    expect(laptop.state.self?.timeZone).toBe("Pacific/Auckland");
    // Another device signing in keeps the one chosen.
    const phone = await online();
    await new Promise((settled) => setTimeout(settled, 200));
    expect(phone.state.self?.timeZone).toBe("Pacific/Auckland");
    expect(await laptop.setTimeZone("Not/A_Zone")).toBe(false);
  });

  it("make the account away when every device is idle, or by hand", async () => {
    const watcher = await online(bobToken);
    const laptop = await online();
    const phone = await online();
    const seen = () => watcher.state.presence[aliceId];
    await until(watcher, () => seen() === "online", "alice online");

    laptop.setIdle(true);
    await new Promise((settled) => setTimeout(settled, 150));
    expect(seen()).toBe("online");
    phone.setIdle(true);
    await until(watcher, () => seen() === "away", "alice away by idling");
    phone.setIdle(false);
    await until(watcher, () => seen() === "online", "alice back");

    expect(await laptop.setAway(true)).toBe(true);
    expect(laptop.state.self?.away).toBe(true);
    await until(watcher, () => seen() === "away", "alice away by hand");
    await until(phone, (s) => s.users[aliceId]?.away === true, "her phone to hear it");
    expect(await phone.setAway(false)).toBe(true);
    await until(watcher, () => seen() === "online", "alice back by hand");
  });

  it("says it is idle again on a new connection", async () => {
    const watcher = await online(bobToken);
    const laptop = await online();
    laptop.setIdle(true);
    await until(watcher, () => watcher.state.presence[aliceId] === "away", "away");
    // The server restarts its sockets; the laptop, still idle, says so again.
    const connection = laptop as unknown as { ws: WebSocket; reconnectDelay: number };
    connection.reconnectDelay = 10;
    connection.ws.close();
    await until(watcher, () => watcher.state.presence[aliceId] === "offline", "gone");
    await until(laptop, (s) => s.status === "online", "reconnected");
    await until(watcher, () => watcher.state.presence[aliceId] === "away", "away again");
    laptop.setIdle(false);
    await until(watcher, () => watcher.state.presence[aliceId] === "online", "online");
  });

  it("keep a picture, and fetch it with the session into an object URL", async () => {
    const laptop = await online();
    const watcher = await online(bobToken);
    expect(await laptop.setAvatar(png())).toBe(true);
    const version = laptop.state.self!.avatarVersion!;
    expect(version).toMatch(/^[0-9a-f]{16}$/);
    await until(watcher, (s) => s.users[aliceId]?.avatarVersion === version, "bob to hear it");

    expect(watcher.avatars.peek(aliceId, version)).toBeNull();
    const url = await watcher.avatars.load(aliceId, version);
    expect(url).toMatch(/^blob:/);
    expect(watcher.avatars.peek(aliceId, version)).toBe(url);
    // Asked for twice at once, it is fetched once and is the same URL.
    expect(await watcher.avatars.load(aliceId, version)).toBe(url);
    // A picture that is not there is none.
    expect(await watcher.avatars.load(aliceId, "0000000000000000")).toBeNull();

    expect(await laptop.removeAvatar()).toBe(true);
    expect(laptop.state.self!.avatarVersion).toBeUndefined();
  });

  it("say idle only to a server that keeps profiles, and only when it changes", async () => {
    const laptop = await online();
    const sent: { type?: string; idle?: boolean }[] = [];
    const send = WebSocket.prototype.send;
    const spy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
      this: WebSocket,
      data,
    ) {
      sent.push(JSON.parse(String(data)));
      return send.call(this, data);
    });
    try {
      // An older server closes a socket on a message it does not know (4000),
      // so it is told nothing, though this device still knows it is idle.
      laptop.store.setState({ profiles: false });
      laptop.setIdle(true);
      laptop.setIdle(false);
      laptop.store.setState({ profiles: true });
      laptop.setIdle(true);
      laptop.setIdle(true);
      laptop.setIdle(false);
      expect(sent.filter((message) => message.type === "idle")).toEqual([
        { type: "idle", idle: true },
        { type: "idle", idle: false },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("show this account's own change from the answer, before any event of it", async () => {
    // Never connected, so only the server's answer can say what changed.
    const quiet = new WorkspaceClient(base, aliceToken);
    onTestFinished(() => quiet.destroy());
    const { user } = await quiet.api.me();
    quiet.store.setState({ self: user, users: { [user.id]: user } });
    expect(await quiet.setTimeZone("Europe/Oslo")).toBe(true);
    expect(quiet.state.self?.timeZone).toBe("Europe/Oslo");
    expect(await quiet.setAway(true)).toBe(true);
    expect(quiet.state.self?.away).toBe(true);
    expect(await quiet.setAway(false)).toBe(true);
    expect(quiet.state.self?.away).toBeUndefined();
    expect(await quiet.setAvatar(png())).toBe(true);
    expect(quiet.state.self?.avatarVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(quiet.state.users[user.id]?.avatarVersion).toBe(quiet.state.self?.avatarVersion);
    expect(await quiet.removeAvatar()).toBe(true);
    expect(quiet.state.self?.avatarVersion).toBeUndefined();
  });
});
