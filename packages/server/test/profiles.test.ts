import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient, type User } from "@slackoss/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * Profiles (E9): a picture checked as the workspace icon is and served to
 * whoever is signed in, a time zone, and away: by hand, or by every device
 * of the account being idle.
 */
let server: WorkspaceServer | undefined;
let dataDir: string;
let base: string;
let owner: { token: string; id: string };
let peer: { token: string; id: string };
const sockets: WebSocket[] = [];

async function start() {
  server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    logger: false,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function stop() {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.stop();
  server = undefined;
}

async function request(
  path: string,
  body?: unknown,
  method = "POST",
  auth: string | null = owner.token,
  type = "application/json",
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(body === undefined ? {} : { "content-type": type }),
    },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString("utf8");
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // A picture, not JSON.
  }
  return { status: response.status, body: json, bytes, headers: response.headers };
}

async function register(handle: string) {
  const made = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
  });
  const body = (await made.json()) as any;
  return { token: body.token as string, id: body.user.id as string };
}

/** A socket signed in as `auth`, and every frame it hears. */
async function connect(auth: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const frames: ServerToClient[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerToClient));
  ws.on("open", () =>
    ws.send(
      JSON.stringify({
        type: "hello",
        token: auth,
        lastSeq: null,
        protocolVersion: PROTOCOL_VERSION,
      }),
    ),
  );
  await expect.poll(() => frames.some((f) => f.type === "ready")).toBe(true);
  return { ws, frames, idle: (idle: boolean) => ws.send(JSON.stringify({ type: "idle", idle })) };
}
const ready = (frames: ServerToClient[]) => frames.find((f) => f.type === "ready") as any;
/** The presence this socket was told for `userId`, oldest first. */
const presenceOf = (frames: ServerToClient[], userId: string) =>
  frames.flatMap((f) =>
    f.type === "ephemeral" && f.event.type === "presence" && f.event.userId === userId
      ? [f.event.presence]
      : [],
  );
const userUpdates = (frames: ServerToClient[]) =>
  frames.flatMap((f) =>
    f.type === "event" && f.envelope.event.type === "user.updated" ? [f.envelope.event.user] : [],
  );

/** A real PNG of one colour. */
function png(width = 4, height = 4): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array(width).fill([90, 60, 200]).flat()),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const upload = (bytes: Buffer, type = "image/png", auth = owner.token) =>
  request("/api/me/avatar", bytes, "PUT", auth, type);
const me = async (auth = owner.token) =>
  (await request("/api/users", undefined, "GET", auth)).body.users.find(
    (u: User) => u.id === (auth === owner.token ? owner.id : peer.id),
  ) as User;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "slackoss-profiles-"));
  await start();
  owner = await register("owner");
  peer = await register("peer");
});

afterEach(async () => {
  await stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("a profile picture", () => {
  it("is kept, told to everyone, and served to whoever is signed in", async () => {
    const theirs = await connect(peer.token);
    const picture = png(64, 64);
    const kept = await upload(picture);
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    const version = kept.body.user.avatarVersion as string;
    expect(version).toMatch(/^[0-9a-f]{16}$/);
    await expect.poll(() => userUpdates(theirs.frames).at(-1)?.avatarVersion).toBe(version);
    expect(ready(theirs.frames).profiles).toBe(true);

    const served = await request(
      `/api/users/${owner.id}/avatar?v=${version}`,
      undefined,
      "GET",
      peer.token,
    );
    expect(served.status).toBe(200);
    expect(served.bytes.equals(picture)).toBe(true);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    // Without the version, it is asked about again each time.
    expect(
      (await request(`/api/users/${owner.id}/avatar`, undefined, "GET", peer.token)).headers.get(
        "cache-control",
      ),
    ).toBe("no-cache");
    // A version that is not the picture's is a picture that is gone.
    expect(
      (
        await request(
          `/api/users/${owner.id}/avatar?v=0000000000000000`,
          undefined,
          "GET",
          peer.token,
        )
      ).status,
    ).toBe(404);
    // Not to someone signed out.
    expect((await request(`/api/users/${owner.id}/avatar`, undefined, "GET", null)).status).toBe(
      401,
    );

    // A new one has a new version; removing it shows the initials again.
    const next = await upload(png(32, 32));
    expect(next.body.user.avatarVersion).not.toBe(version);
    const removed = await request("/api/me/avatar", undefined, "DELETE");
    expect(removed.status).toBe(200);
    expect(removed.body.user.avatarVersion).toBeUndefined();
    expect(
      (await request(`/api/users/${owner.id}/avatar`, undefined, "GET", peer.token)).status,
    ).toBe(404);
  });

  it("is refused unless it is a small PNG, JPEG or WebP that is what it says", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    const refused = async (bytes: Buffer, type: string) => {
      const answer = await upload(bytes, type);
      return [answer.status, answer.body.message];
    };
    expect(await refused(svg, "image/svg+xml")).toEqual([
      415,
      "A profile picture is a PNG, JPEG or WebP image.",
    ]);
    expect(await refused(png(), "image/jpeg")).toEqual([
      400,
      "That file says it is JPEG but holds a PNG image.",
    ]);
    expect((await upload(Buffer.alloc(300 * 1024, 1)))[`status`]).toBe(413);
    expect(await refused(png(1100, 2), "image/png")).toEqual([
      400,
      "A profile picture is at most 1024 pixels on either side.",
    ]);
    expect((await me()).avatarVersion).toBeUndefined();
  });

  it("is not for guests, who still see everyone's", async () => {
    server!.setAccessPolicy("guest_allowed");
    const joined = await fetch(`${base}/api/auth/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Visitor" }),
    });
    const guest = (await joined.json()) as { token: string };
    expect((await upload(png(), "image/png", guest.token)).status).toBe(403);
    expect((await request("/api/me/avatar", undefined, "DELETE", guest.token)).status).toBe(403);
    const version = (await upload(png())).body.user.avatarVersion;
    expect(
      (await request(`/api/users/${owner.id}/avatar?v=${version}`, undefined, "GET", guest.token))
        .status,
    ).toBe(200);
  });
});

describe("a time zone", () => {
  it("is kept and told, checked as a real one, and forgotten with null", async () => {
    const theirs = await connect(peer.token);
    const set = await request("/api/me", { timeZone: "Asia/Kolkata" }, "PATCH");
    expect(set.status).toBe(200);
    expect(set.body.user.timeZone).toBe("Asia/Kolkata");
    await expect.poll(() => userUpdates(theirs.frames).at(-1)?.timeZone).toBe("Asia/Kolkata");
    expect((await request("/api/me", { timeZone: "Mars/Olympus_Mons" }, "PATCH")).status).toBe(400);
    expect((await me()).timeZone).toBe("Asia/Kolkata");
    const forgotten = await request("/api/me", { timeZone: null }, "PATCH");
    expect(forgotten.body.user.timeZone).toBeUndefined();
  });

  it("is kept under its current name, where Chromium sends India's old one", async () => {
    const set = await request("/api/me", { timeZone: "Asia/Calcutta" }, "PATCH");
    expect(set.status).toBe(200);
    expect(set.body.user.timeZone).toBe("Asia/Kolkata");
    expect((await me()).timeZone).toBe("Asia/Kolkata");
  });
});

describe("away", () => {
  it("set by hand is told to everyone, and stands until set back, across a reconnect", async () => {
    const theirs = await connect(peer.token);
    const mine = await connect(owner.token);
    await expect.poll(() => presenceOf(theirs.frames, owner.id).at(-1)).toBe("online");

    const away = await request("/api/me", { away: true }, "PATCH");
    expect(away.body.user.away).toBe(true);
    await expect.poll(() => presenceOf(theirs.frames, owner.id).at(-1)).toBe("away");

    // Signing in again on another device keeps it.
    mine.ws.terminate();
    await expect.poll(() => presenceOf(theirs.frames, owner.id).at(-1)).toBe("offline");
    const again = await connect(owner.token);
    await expect.poll(() => presenceOf(theirs.frames, owner.id).at(-1)).toBe("away");
    expect(ready(again.frames).presence[owner.id]).toBe("away");
    // Being in use does not undo what was set by hand.
    again.idle(false);

    const back = await request("/api/me", { away: false }, "PATCH");
    expect(back.body.user.away).toBeUndefined();
    await expect.poll(() => presenceOf(theirs.frames, owner.id).at(-1)).toBe("online");
  });

  it("comes by itself once every device is idle, and goes as soon as one is used", async () => {
    const theirs = await connect(peer.token);
    const laptop = await connect(owner.token);
    const phone = await connect(owner.token);
    const told = () => presenceOf(theirs.frames, owner.id);
    await expect.poll(() => told().at(-1)).toBe("online");

    laptop.idle(true);
    await new Promise((settled) => setTimeout(settled, 100));
    // The phone is still in use.
    expect(told().at(-1)).toBe("online");
    phone.idle(true);
    await expect.poll(() => told().at(-1)).toBe("away");
    expect(ready((await connect(peer.token)).frames).presence[owner.id]).toBe("away");

    laptop.idle(false);
    await expect.poll(() => told().at(-1)).toBe("online");

    // The device in use leaves, and the one left is idle.
    laptop.idle(true);
    await expect.poll(() => told().at(-1)).toBe("away");
    const desk = await connect(owner.token);
    // A device signing in is in use.
    await expect.poll(() => told().at(-1)).toBe("online");
    desk.ws.terminate();
    await expect.poll(() => told().at(-1)).toBe("away");

    // Saying the same again tells nobody.
    const count = told().length;
    phone.idle(true);
    laptop.idle(true);
    await new Promise((settled) => setTimeout(settled, 100));
    expect(told().length).toBe(count);
  });
});

describe("a profile", () => {
  it("keeps its picture, time zone and away across a restart", async () => {
    const version = (await upload(png())).body.user.avatarVersion;
    await request("/api/me", { timeZone: "Europe/Lisbon", away: true }, "PATCH");
    await stop();
    await start();
    const kept = await me();
    expect(kept).toMatchObject({ avatarVersion: version, timeZone: "Europe/Lisbon", away: true });
    const served = await request(`/api/users/${owner.id}/avatar?v=${version}`, undefined, "GET");
    expect(served.status).toBe(200);
  });
});
