import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "@slackoss/server";
import type { Message } from "@slackoss/protocol";
import { Api, WorkspaceClient, previewImageKey, type WorkspaceState } from "../src/index.js";

/**
 * Link previews on the client (E2): a message's previews arrive after it,
 * without counting as an edit; the setting follows the server; the sender's
 * removal shows at once and comes back if refused; and a preview's picture
 * is held like a file and let go with its message.
 */
let server: WorkspaceServer;
let base: string;
let dataDir: string;
let aliceToken: string;
let bobToken: string;

const PICTURE = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from("IHDR", "ascii"),
  Buffer.from([0, 0, 4, 0xb0, 0, 0, 2, 0x76]),
  Buffer.alloc(40, 7),
]);

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
  const general = Object.values(client.state.channels).find((c) => c.name === "general")!;
  await client.loadTimeline(general.id);
  return { client, general };
}

const held = (client: WorkspaceClient, channelId: string, id: string): Message | undefined =>
  client.state.timelines[channelId]?.items.find((m) => m.id === id);

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "slackoss-previews-"));
  server = await createWorkspaceServer({
    dataDir,
    port: 0,
    mdns: false,
    rateLimits: false,
    fetchLinkPreview: async (url) => {
      // One page answers late, so what happens before it arrives can be seen.
      if (url.endsWith("/slow")) await new Promise((done) => setTimeout(done, 300));
      return url.startsWith("https://news.example/")
        ? {
            url,
            title: `Story at ${new URL(url).pathname}`,
            description: "",
            siteName: "Example News",
            image: { bytes: PICTURE, type: "image/png", width: 1200, height: 630 },
          }
        : null;
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  const api = new Api(base);
  aliceToken = (
    await api.register({ handle: "alice", displayName: "Alice", password: "password123" })
  ).token;
  bobToken = (await api.register({ handle: "bob", displayName: "Bob", password: "password123" }))
    .token;
});

afterAll(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("link previews on the client", () => {
  it("arrive after the message as no edit, and follow the workspace's setting", async () => {
    const { client, general } = await online();
    expect(client.state.linkPreviews).toBe(true);
    const bob = new Api(base, bobToken);
    const { message } = await bob.sendMessage(general.id, {
      text: "https://news.example/one/slow",
    });
    const before = await until(client, () => !!held(client, general.id, message.id), "the message");
    const changedBefore = before.changedContent[general.id];

    const after = await until(
      client,
      () => (held(client, general.id, message.id)?.previews?.length ?? 0) === 1,
      "its preview",
    );
    expect(held(client, general.id, message.id)!.previews![0]).toMatchObject({
      url: "https://news.example/one/slow",
      title: "Story at /one/slow",
      image: { width: 1200, height: 630 },
    });
    // Not an edit: Activity and the header have nothing new to load.
    expect(after.changedContent[general.id]).toBe(changedBefore);

    // Alice is the workspace's owner: the first to register.
    expect(await client.setLinkPreviews(false)).toBe(false);
    expect(client.state.linkPreviews).toBe(false);
    const other = await online(bobToken);
    await until(other.client, (s) => s.linkPreviews === false, "the setting reaching Bob");
    await client.setLinkPreviews(true);
    await until(other.client, (s) => s.linkPreviews === true, "the setting back on");
  });

  it("leave the replies quoting their message as they were", async () => {
    const { client, general } = await online();
    const bob = new Api(base, bobToken);
    const { message } = await bob.sendMessage(general.id, { text: "Plans for Friday" });
    const { message: reply } = await client.api.sendMessage(general.id, {
      text: "Sounds good",
      replyToId: message.id,
    });
    await bob.editMessage(message.id, "Plans for Friday https://news.example/slow");
    await until(
      client,
      () => !!held(client, general.id, reply.id)?.replyTo?.text.includes("news.example"),
      "the edit quoted",
    );
    const quoting = held(client, general.id, reply.id);
    await until(
      client,
      () => (held(client, general.id, message.id)?.previews?.length ?? 0) === 1,
      "its preview",
    );
    expect(held(client, general.id, reply.id)).toBe(quoting);
  });

  it("go at once when their sender removes one, and come back if the server refuses", async () => {
    const { client, general } = await online();
    const { message } = await client.api.sendMessage(general.id, {
      text: "https://news.example/two",
    });
    const state = await until(
      client,
      () => (held(client, general.id, message.id)?.previews?.length ?? 0) === 1,
      "its preview",
    );
    const shown = state.timelines[general.id]!.items.find((m) => m.id === message.id)!;
    const preview = shown.previews![0]!;

    const refusal = vi
      .spyOn(client.api, "removeLinkPreview")
      .mockRejectedValueOnce(new Error("offline"));
    const refused = client.removeLinkPreview(shown, preview.id);
    expect(held(client, general.id, message.id)!.previews).toEqual([]);
    await expect(refused).rejects.toThrow("offline");
    expect(held(client, general.id, message.id)!.previews).toEqual([preview]);
    refusal.mockRestore();

    await client.removeLinkPreview(held(client, general.id, message.id)!, preview.id);
    // The server's own word, which may already be here, leaves it out.
    expect(held(client, general.id, message.id)!.previews ?? []).toEqual([]);
  });

  it("hold a preview's picture like a file, and let it go with its message", async () => {
    const { client, general } = await online();
    const { message } = await client.api.sendMessage(general.id, {
      text: "https://news.example/three",
    });
    await until(
      client,
      () => (held(client, general.id, message.id)?.previews?.length ?? 0) === 1,
      "its preview",
    );
    const preview = held(client, general.id, message.id)!.previews![0]!;
    const fetchImage = vi.spyOn(client.api, "fetchPreviewImage");
    const key = previewImageKey(preview.id);
    const created = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    onTestFinished(() => {
      created.mockRestore();
      revoked.mockRestore();
    });

    client.files.retain(key);
    expect(await client.files.get(key)).toBe("blob:preview");
    expect(fetchImage).toHaveBeenCalledWith(preview.id, expect.any(AbortSignal));
    const blob = created.mock.calls[0]![0] as Blob;
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(PICTURE);

    // Another message going leaves it be: it is known to be this one's.
    const { message: other } = await client.api.sendMessage(general.id, { text: "Unrelated" });
    await until(client, () => !!held(client, general.id, other.id), "the other message");
    await client.api.deleteMessage(other.id);
    await until(client, () => !held(client, general.id, other.id), "the other deletion");
    expect(client.files.peek(key)).toBe("blob:preview");

    const gone = new Promise<string>((resolve) => client.files.onInvalidate(resolve));
    await client.api.deleteMessage(message.id);
    expect(await gone).toBe(key);
    expect(client.files.peek(key)).toBeUndefined();
    client.files.release(key);
  });
});
