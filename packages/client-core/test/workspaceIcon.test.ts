import { crc32, deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@slackoss/server";
import { Api, WorkspaceClient } from "../src/index.js";

let server: WorkspaceServer;
let owner: Api;
let member: WorkspaceClient;
/** The owner's own client, on another device than `owner`. */
let ownerElsewhere: WorkspaceClient;

/** A real one-colour PNG, made here so no test holds an image's bytes. */
function png(size = 4): Uint8Array<ArrayBuffer> {
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
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x80)]);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.concat(Array(size).fill(row)))),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    workspaceName: "Rocket Team",
  });
  const base = `http://127.0.0.1:${server.port}`;
  const api = new Api(base);
  const a = await api.register({ handle: "owner", displayName: "Owner", password: "password123" });
  const b = await api.register({
    handle: "member",
    displayName: "Member",
    password: "password123",
  });
  owner = new Api(base, a.token);
  member = new WorkspaceClient(base, b.token);
  ownerElsewhere = new WorkspaceClient(base, a.token);
  member.connect();
  ownerElsewhere.connect();
  await expect.poll(() => member.state.status).toBe("online");
  await expect.poll(() => ownerElsewhere.state.status).toBe("online");
});

afterEach(async () => {
  member?.destroy();
  ownerElsewhere?.destroy();
  await server?.stop();
});

describe("the workspace's icon", () => {
  it("comes with the snapshot, with the server saying it keeps one", () => {
    for (const client of [member, ownerElsewhere])
      expect(client.state).toMatchObject({ workspaceIcon: true, iconVersion: null });
  });

  it("follows a change an admin or the host makes, on every device and for everyone", async () => {
    const { iconVersion } = await owner.setWorkspaceIcon(new Blob([png()], { type: "image/png" }));
    for (const client of [member, ownerElsewhere])
      await expect.poll(() => client.state.iconVersion).toBe(iconVersion);
    expect(await owner.removeWorkspaceIcon()).toEqual({ iconVersion: null });
    for (const client of [member, ownerElsewhere])
      await expect.poll(() => client.state.iconVersion).toBeNull();
    const hosts = server.setWorkspaceIcon(png(6), "image/png");
    await expect.poll(() => member.state.iconVersion).toBe(hosts);
  });

  it("shows the new version as soon as the server answers, for the admin who changed it", async () => {
    const version = await ownerElsewhere.setWorkspaceIcon(new Blob([png()], { type: "image/png" }));
    expect(ownerElsewhere.state.iconVersion).toBe(version);
    await ownerElsewhere.removeWorkspaceIcon();
    expect(ownerElsewhere.state.iconVersion).toBeNull();
  });

  it("is read by anyone, by its version, and is said to be missing when there is none", async () => {
    const anyone = new Api(owner.baseUrl);
    await expect(anyone.workspaceIcon("0000000000000000")).rejects.toMatchObject({
      status: 404,
      code: "no_icon",
    });
    const bytes = png(5);
    const { iconVersion } = await owner.setWorkspaceIcon(new Blob([bytes], { type: "image/png" }));
    expect((await anyone.serverInfo()).iconVersion).toBe(iconVersion);
    const image = await anyone.workspaceIcon(iconVersion);
    expect(image.type).toBe("image/png");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes);
  });

  it("is refused to a member, who sees nothing change, and refused when it is not an image", async () => {
    await expect(
      member.api.setWorkspaceIcon(new Blob([png()], { type: "image/png" })),
    ).rejects.toMatchObject({ code: "admin_only" });
    await expect(member.api.removeWorkspaceIcon()).rejects.toMatchObject({ code: "admin_only" });
    await expect(
      owner.setWorkspaceIcon(new Blob(["<svg/>"], { type: "image/svg+xml" })),
    ).rejects.toMatchObject({ status: 415, code: "unsupported_icon_type" });
    expect(member.state.iconVersion).toBeNull();
  });

  it("is not offered by a server that does not keep one", () => {
    // A server before workspace icons sends neither the flag nor a version.
    const older = new WorkspaceClient("http://127.0.0.1:9", "token");
    try {
      const self = member.state.self!;
      const connection = older as unknown as { handleServerMessage(message: unknown): void };
      connection.handleServerMessage({
        type: "ready",
        seq: 0,
        self,
        users: [self],
        channels: [],
        memberships: [],
        channelLastSeq: {},
        presence: {},
        savedMessageIds: [],
        huddles: {},
        workspaceName: "W",
        // Even a version without the flag is not taken as one.
        iconVersion: "0123456789abcdef",
      });
      expect(older.state.workspaceIcon).toBe(false);
      expect(older.state.iconVersion).toBeNull();
    } finally {
      older.destroy();
    }
  });
});
