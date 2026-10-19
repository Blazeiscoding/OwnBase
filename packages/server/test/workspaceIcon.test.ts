import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  WORKSPACE_ICON_MAX_BYTES,
  type AuditEntry,
  type ReadySnapshot,
  type ServerToClient,
} from "@slackoss/protocol";
import {
  createWorkspaceServer,
  type ServerOptions,
  type WorkspaceChange,
  type WorkspaceServer,
} from "../src/server.js";
import { checkIcon, iconTypeOf, readStoredIcon } from "../src/workspaceIcon.js";

/**
 * The workspace's icon (UX-60): its owner and admins set and remove it, it is
 * checked by its own bytes, and anyone may read it, before signing in too.
 */
type Person = { token: string; user: { id: string; handle: string; role: string } };
let server: WorkspaceServer | undefined;
let dataDir: string | undefined;
let base = "";
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.stop();
  server = undefined;
  const folder = dataDir;
  dataDir = undefined;
  if (folder) rmSync(folder, { recursive: true, force: true });
});

/** A real PNG of one colour, made here so no test holds an image's bytes. */
function png(width = 4, height = 4, rgb: [number, number, number] = [200, 80, 40]): Buffer {
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
  header[8] = 8; // bits per channel
  header[9] = 2; // truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill(rgb).flat())]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The start of a JPEG: its marker, an APP0 segment, and a frame header naming its size. */
function jpeg(width = 4, height = 4): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
    0xff,
    0xd9,
  ]);
}

/** The start of a lossless WebP naming its size. */
function webp(width = 4, height = 4): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(24, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8L", 12, "ascii");
  bytes.writeUInt32LE(8, 16);
  bytes[20] = 0x2f;
  bytes.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  return bytes;
}

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(1)</script></svg>',
);

async function start(opts: Partial<ServerOptions> = {}) {
  dataDir ??= mkdtempSync(join(tmpdir(), "slackoss-workspace-icon-"));
  server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    logger: false,
    ...opts,
  });
  base = `http://127.0.0.1:${server.port}`;
  return server;
}

async function call(method: string, path: string, token?: string, body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: (text ? JSON.parse(text) : {}) as any };
}

/** Sends `bytes` as the icon, saying they are `type`. */
async function upload(token: string | undefined, bytes: Buffer, type = "image/png") {
  const response = await fetch(base + "/api/admin/workspace/icon", {
    method: "PUT",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": type },
    body: new Uint8Array(bytes),
  });
  const text = await response.text();
  return { status: response.status, data: (text ? JSON.parse(text) : {}) as any };
}

const remove = (token: string | undefined) => call("DELETE", "/api/admin/workspace/icon", token);

async function register(handle: string): Promise<Person> {
  const { status, data } = await call("POST", "/api/auth/register", undefined, {
    handle,
    displayName: handle,
    password: "password123",
  });
  expect(status, JSON.stringify(data)).toBe(201);
  return data;
}

/** An owner, an admin and a member. */
async function workspace(opts: Partial<ServerOptions> = {}) {
  await start(opts);
  const owner = await register("owner");
  const admin = await register("admin");
  const member = await register("member");
  expect(
    (await call("PATCH", `/api/admin/users/${admin.user.id}`, owner.token, { role: "admin" }))
      .status,
  ).toBe(200);
  return { owner, admin, member };
}

async function connect(token: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const frames: ServerToClient[] = [];
  ws.on("message", (raw) => frames.push(JSON.parse(String(raw)) as ServerToClient));
  ws.on("open", () =>
    ws.send(
      JSON.stringify({ type: "hello", token, lastSeq: null, protocolVersion: PROTOCOL_VERSION }),
    ),
  );
  await expect.poll(() => frames.some((f) => f.type === "ready")).toBe(true);
  return {
    ready: () => frames.find((f): f is ReadySnapshot => f.type === "ready")!,
    icons: () =>
      frames.flatMap((f) =>
        f.type === "ephemeral" && f.event.type === "workspace.icon" ? [f.event.iconVersion] : [],
      ),
  };
}

const fetchIcon = (query = "", headers: Record<string, string> = {}) =>
  fetch(`${base}/api/workspace/icon${query}`, { headers });

describe("setting and removing the workspace's icon", () => {
  it("is for the owner and admins; a member, a guest and nobody are refused", async () => {
    const { owner, admin, member } = await workspace();
    server!.setAccessPolicy("guest_allowed");
    const guest = (await call("POST", "/api/auth/guest", undefined, { displayName: "Visitor" }))
      .data as Person;

    const first = await upload(owner.token, png());
    expect(first.status).toBe(200);
    expect(first.data.iconVersion).toMatch(/^[0-9a-f]{16}$/);
    const second = await upload(admin.token, png(8, 8, [10, 120, 200]));
    expect(second.status).toBe(200);
    expect(second.data.iconVersion).not.toBe(first.data.iconVersion);
    expect(server!.workspaceIcon()?.version).toBe(second.data.iconVersion);

    for (const refused of [await upload(member.token, png()), await remove(member.token)])
      expect([refused.status, refused.data.error]).toEqual([403, "admin_only"]);
    for (const refused of [await upload(guest.token, png()), await remove(guest.token)])
      expect([refused.status, refused.data.error]).toEqual([403, "guest_not_allowed"]);
    for (const refused of [await upload(undefined, png()), await remove(undefined)])
      expect(refused.status).toBe(401);
    expect(server!.workspaceIcon()?.version).toBe(second.data.iconVersion);

    expect(await remove(admin.token)).toEqual({ status: 200, data: { iconVersion: null } });
    expect(server!.workspaceIcon()).toBeNull();
    // Removing what is not there is no change, and no failure either.
    expect(await remove(owner.token)).toEqual({ status: 200, data: { iconVersion: null } });
  });

  it("takes a PNG, a JPEG or a WebP, by what its bytes are", async () => {
    const { owner } = await workspace();
    for (const [bytes, type] of [
      [png(), "image/png"],
      [jpeg(), "image/jpeg"],
      [webp(), "image/webp"],
      // A parameter after the type changes nothing.
      [png(2, 2), "image/png; charset=binary"],
    ] as const) {
      const kept = await upload(owner.token, bytes, type);
      expect(kept.status, type).toBe(200);
      expect(server!.workspaceIcon()?.type).toBe(type.split(";")[0]);
    }
  });

  it("refuses SVG, a type its bytes deny, garbage, a body too large and a picture too big", async () => {
    const { owner } = await workspace();
    const refusals: [Buffer, string, number, string][] = [
      // Script can ride in an SVG, and an icon is shown to everyone.
      [SVG, "image/svg+xml", 415, "unsupported_icon_type"],
      [SVG, "image/png", 400, "invalid_icon"],
      [png(), "image/gif", 415, "unsupported_icon_type"],
      [png(), "text/plain", 415, "unsupported_icon_type"],
      [png(), "application/octet-stream", 415, "unsupported_icon_type"],
      [jpeg(), "image/png", 400, "invalid_icon"],
      [png(), "image/webp", 400, "invalid_icon"],
      [Buffer.from("not an image at all, only some words"), "image/png", 400, "invalid_icon"],
      [Buffer.alloc(0), "image/png", 400, "invalid_icon"],
      [
        Buffer.concat([png(), Buffer.alloc(WORKSPACE_ICON_MAX_BYTES)]),
        "image/png",
        413,
        "icon_too_large",
      ],
      // Small to send, huge to show: every client would decode 25 million pixels.
      [png(5000, 1), "image/png", 400, "icon_too_large"],
      [webp(2000, 2000), "image/webp", 400, "icon_too_large"],
    ];
    for (const [bytes, type, status, code] of refusals) {
      const refused = await upload(owner.token, bytes, type);
      expect([refused.status, refused.data.error], `${type} ${bytes.length}`).toEqual([
        status,
        code,
      ]);
      expect(refused.data.message).toBeTruthy();
    }
    // JSON is not an image either.
    const json = await call("PUT", "/api/admin/workspace/icon", owner.token, { icon: "x" });
    expect([json.status, json.data.error]).toEqual([415, "unsupported_icon_type"]);
    expect(server!.workspaceIcon()).toBeNull();
    expect((await call("GET", "/api/admin/audit?limit=50", owner.token)).data.entries).toEqual([
      expect.objectContaining({ action: "user.role_changed" }),
    ]);
  });

  it("refuses the same things from the host, saying why", async () => {
    await start();
    expect(() => server!.setWorkspaceIcon(SVG, "image/svg+xml")).toThrow(
      "A workspace icon is a PNG, JPEG or WebP image.",
    );
    expect(() => server!.setWorkspaceIcon(jpeg(), "image/png")).toThrow(
      "That file says it is PNG but holds a JPEG image.",
    );
    expect(() => server!.setWorkspaceIcon("png" as unknown as Uint8Array, "image/png")).toThrow(
      TypeError,
    );
    expect(server!.workspaceIcon()).toBeNull();
  });
});

describe("reading the icon", () => {
  it("serves its bytes to anyone, typed, versioned and kept, and 404 when there is none", async () => {
    const { owner } = await workspace();
    const none = await fetchIcon();
    expect(none.status).toBe(404);
    expect(none.headers.get("cache-control")).toBe("no-store");
    expect((await call("GET", "/api/server-info")).data.iconVersion).toBeNull();

    const bytes = png(6, 6);
    const { iconVersion } = (await upload(owner.token, bytes)).data;
    expect((await call("GET", "/api/server-info")).data.iconVersion).toBe(iconVersion);

    const unversioned = await fetchIcon();
    expect(unversioned.status).toBe(200);
    expect(Buffer.from(await unversioned.arrayBuffer())).toEqual(bytes);
    expect(unversioned.headers.get("content-type")).toBe("image/png");
    expect(unversioned.headers.get("x-content-type-options")).toBe("nosniff");
    expect(unversioned.headers.get("etag")).toBe(`"${iconVersion}"`);
    expect(unversioned.headers.get("cache-control")).toBe("no-cache");

    const versioned = await fetchIcon(`?v=${iconVersion}`);
    expect(Buffer.from(await versioned.arrayBuffer())).toEqual(bytes);
    expect(versioned.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    const unchanged = await fetchIcon("", { "if-none-match": `"${iconVersion}"` });
    expect(unchanged.status).toBe(304);
    expect((await unchanged.arrayBuffer()).byteLength).toBe(0);

    // A new picture has a new version; asking by the old one gets the new
    // picture, checked again each time rather than kept.
    const next = webp(8, 8);
    const changed = (await upload(owner.token, next, "image/webp")).data.iconVersion;
    expect(changed).not.toBe(iconVersion);
    const stale = await fetchIcon(`?v=${iconVersion}`, { "if-none-match": `"${iconVersion}"` });
    expect(stale.status).toBe(200);
    expect(stale.headers.get("content-type")).toBe("image/webp");
    expect(stale.headers.get("cache-control")).toBe("no-cache");
    expect(Buffer.from(await stale.arrayBuffer())).toEqual(next);

    await remove(owner.token);
    expect((await fetchIcon(`?v=${changed}`)).status).toBe(404);
    expect((await call("GET", "/api/server-info")).data.iconVersion).toBeNull();
  });

  it("is kept in the database, so a restart, a backup and a restore carry it", async () => {
    const { owner } = await workspace();
    const bytes = png(5, 5);
    const { iconVersion } = (await upload(owner.token, bytes)).data;
    await server!.stop();
    await start();
    expect(server!.workspaceIcon()?.version).toBe(iconVersion);
    expect(Buffer.from(await (await fetchIcon()).arrayBuffer())).toEqual(bytes);
  });

  it("is rationed per address like other public routes", async () => {
    await start({ rateLimits: { publicByAddress: { burst: 2, perMinute: 1 } } });
    expect((await fetchIcon()).status).toBe(404);
    expect((await fetchIcon()).status).toBe(404);
    const refused = await fetchIcon();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBeTruthy();
  });
});

describe("telling everyone", () => {
  it("puts the icon's version in the snapshot and tells every socket when it changes", async () => {
    const { owner, member } = await workspace();
    const watching = await connect(member.token);
    expect(watching.ready()).toMatchObject({ workspaceIcon: true, iconVersion: null });
    const ownerElsewhere = await connect(owner.token);

    const { iconVersion } = (await upload(owner.token, png())).data;
    for (const socket of [watching, ownerElsewhere])
      await expect.poll(() => socket.icons()).toEqual([iconVersion]);
    await remove(owner.token);
    for (const socket of [watching, ownerElsewhere])
      await expect.poll(() => socket.icons()).toEqual([iconVersion, null]);

    server!.setWorkspaceIcon(jpeg(), "image/jpeg");
    const hostVersion = server!.workspaceIcon()!.version;
    await expect.poll(() => watching.icons()).toEqual([iconVersion, null, hostVersion]);
    const later = await connect(member.token);
    expect(later.ready()).toMatchObject({ workspaceIcon: true, iconVersion: hostVersion });
  });

  it("tells whatever follows the workspace, naming who changed it", async () => {
    const { owner } = await workspace();
    const heard: WorkspaceChange[] = [];
    server!.onWorkspaceChange((change) => heard.push(change));
    const { iconVersion } = (await upload(owner.token, png())).data;
    // The same picture again changes nothing, and nobody is told.
    await upload(owner.token, png());
    server!.removeWorkspaceIcon();
    expect(heard).toEqual([
      { iconVersion, by: owner.user.id },
      { iconVersion: null, by: null },
    ]);
  });

  it("records each change, without the image", async () => {
    const { owner, admin } = await workspace();
    const bytes = png(3, 3);
    await upload(admin.token, bytes);
    await remove(owner.token);
    server!.setWorkspaceIcon(webp(), "image/webp");
    const { data } = await call("GET", "/api/admin/audit?limit=50", owner.token);
    const icons = (data.entries as AuditEntry[])
      .filter((e) => e.action === "workspace.icon_changed")
      .reverse();
    expect(icons).toEqual([
      expect.objectContaining({
        actorId: admin.user.id,
        targetType: "workspace",
        targetId: null,
        details: { change: "set", type: "image/png", bytes: bytes.length },
      }),
      expect.objectContaining({ actorId: owner.user.id, details: { change: "removed" } }),
      expect.objectContaining({
        actorId: null,
        details: { change: "set", type: "image/webp", bytes: webp().length },
      }),
    ]);
  });
});

describe("what an icon is", () => {
  it("is told by its first bytes", () => {
    expect(iconTypeOf(png())).toBe("image/png");
    expect(iconTypeOf(jpeg())).toBe("image/jpeg");
    expect(iconTypeOf(webp())).toBe("image/webp");
    expect(iconTypeOf(SVG)).toBeNull();
    expect(iconTypeOf(Buffer.from("GIF89a"))).toBeNull();
  });

  it("is read back only when its rows make a whole icon", () => {
    const checked = checkIcon(png(), "image/png");
    if (!("icon" in checked)) throw new Error("refused");
    const rows = new Map<string, string>([
      ["workspace_icon_type", "image/png"],
      ["workspace_icon_version", checked.icon.version],
      ["workspace_icon_data", png().toString("base64")],
    ]);
    const read = (changes: Record<string, string | null> = {}) =>
      readStoredIcon((key) => (key in changes ? changes[key]! : (rows.get(key) ?? null)));
    expect(read()?.version).toBe(checked.icon.version);
    expect(read({ workspace_icon_type: "image/svg+xml" })).toBeNull();
    expect(read({ workspace_icon_type: "image/jpeg" })).toBeNull();
    expect(read({ workspace_icon_version: "0000000000000000" })).toBeNull();
    expect(read({ workspace_icon_data: null })).toBeNull();
  });
});
