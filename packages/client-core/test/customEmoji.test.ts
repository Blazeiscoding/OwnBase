import { crc32, deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { Api, WorkspaceClient } from "../src/index.js";

let server: WorkspaceServer;
let base: string;
let memberToken: string;
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
  });
  base = `http://127.0.0.1:${server.port}`;
  const api = new Api(base);
  const a = await api.register({ handle: "owner", displayName: "Owner", password: "password123" });
  const b = await api.register({
    handle: "member",
    displayName: "Member",
    password: "password123",
  });
  owner = new Api(base, a.token);
  memberToken = b.token;
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

const picture = () => new Blob([png()], { type: "image/png" });

/**
 * Custom emoji (J12): the list comes with the snapshot and follows every
 * addition and removal, on every device and for everyone, live.
 */
describe("custom emoji", () => {
  it("come with the snapshot", async () => {
    await owner.addCustomEmoji("ours", picture());
    const later = new WorkspaceClient(base, memberToken);
    later.connect();
    try {
      await expect.poll(() => later.state.status).toBe("online");
      expect(Object.keys(later.state.customEmoji)).toEqual(["ours"]);
      expect(later.state.emojiAddingAdminsOnly).toBe(false);
    } finally {
      later.destroy();
    }
  });

  it("follow what anyone adds and removes", async () => {
    const added = await member.addCustomEmoji("party-parrot", picture());
    if (added instanceof Error) throw added;
    // The adder's own list has it at once, the others when told.
    expect(member.state.customEmoji["party-parrot"]).toEqual(added);
    await expect.poll(() => ownerElsewhere.state.customEmoji["party-parrot"]).toEqual(added);

    expect(await ownerElsewhere.removeCustomEmoji(added)).toBeNull();
    expect(ownerElsewhere.state.customEmoji).toEqual({});
    await expect.poll(() => member.state.customEmoji).toEqual({});
  });

  it("keep a name added again after an old removal is heard", async () => {
    const first = await owner.addCustomEmoji("again", picture());
    await owner.removeCustomEmoji(first.emoji.id);
    const second = await owner.addCustomEmoji("again", picture());
    await expect.poll(() => member.state.customEmoji.again?.id).toBe(second.emoji.id);
  });

  it("follow who may add them", async () => {
    expect(await ownerElsewhere.setEmojiAdding(true)).toBeNull();
    await expect.poll(() => member.state.emojiAddingAdminsOnly).toBe(true);
    const refused = await member.addCustomEmoji("mine", picture());
    expect(refused).toMatchObject({ code: "emoji_adding_restricted" });
  });

  it("fetch a picture by the emoji's id", async () => {
    const { emoji } = await owner.addCustomEmoji("ours", picture());
    const blob = await member.api.fetchCustomEmoji(emoji.id);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(png());
  });
});
