import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  type Message,
  type ReadySnapshot,
  type ServerToClient,
} from "@slackoss/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";
import { toSlackEvent } from "../src/integrations.js";
import type { FetchedPreview } from "../src/linkPreview.js";

/**
 * Link previews on the server (E2): found after a message is committed and
 * told as a `message.updated` that says `previewsOnly`, kept with the message
 * through edits, removed by its sender for good, gone with it, served with
 * their picture only to its readers, and turned off by an owner or admin.
 * The pages are not on the network here: the server is given what each
 * address would show (`fetchLinkPreview`); linkPreview.test.ts covers the
 * real fetch and its guard.
 */
let server: WorkspaceServer;
let base: string;
let root: string;
let owner: { token: string; id: string };
let peer: { token: string; id: string };
let outsider: { token: string; id: string };
let general: string;
let fetched: string[];
const sockets: WebSocket[] = [];

const PICTURE = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from("IHDR", "ascii"),
  Buffer.from([0, 0, 4, 0xb0, 0, 0, 2, 0x76]),
  Buffer.alloc(40, 7),
]);

/** What each address shows; anything else has nothing to preview. */
const PAGES: Record<string, Omit<FetchedPreview, "url">> = {
  "https://news.example/launch": {
    title: "Launch day",
    description: "Everything ships at noon.",
    siteName: "Example News",
    image: { bytes: PICTURE, type: "image/png", width: 1200, height: 630 },
  },
  "https://docs.example/plan": {
    title: "The plan",
    description: "",
    siteName: "Docs",
    image: null,
  },
  "https://blog.example/post": {
    title: "A post",
    description: "Words about things.",
    siteName: "Blog",
    image: null,
  },
};

async function start(extra: Record<string, unknown> = {}) {
  server = await createWorkspaceServer({
    dataDir: root,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits: false,
    fetchLinkPreview: async (url: string) => {
      fetched.push(url);
      const shown = PAGES[url];
      return shown ? { url, ...shown } : null;
    },
    ...extra,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function request(path: string, auth: string | null, body?: unknown, method = "POST") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    type,
    body: type.startsWith("application/json")
      ? ((await response.json()) as any)
      : Buffer.from(await response.arrayBuffer()),
  };
}

const post = async (auth: string, channel: string, text: string): Promise<Message> => {
  const res = await request(`/api/channels/${channel}/messages`, auth, { text });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.message;
};

const register = async (handle: string) => {
  const res = await request("/api/auth/register", null, {
    handle,
    displayName: handle,
    password: "password123",
  });
  return { token: res.body.token as string, id: res.body.user.id as string };
};

/** One message as a reader of its conversation gets it now. */
const read = async (auth: string, channelId: string, id: string): Promise<Message> =>
  (await request(`/api/channels/${channelId}/messages`, auth, undefined, "GET")).body.messages.find(
    (m: Message) => m.id === id,
  );

/** Waits for a message's previews to be the ones named, by url. */
const previewsOf = async (channelId: string, id: string, urls: string[]) => {
  await expect
    .poll(async () => ((await read(owner.token, channelId, id)).previews ?? []).map((p) => p.url))
    .toEqual(urls);
  return (await read(owner.token, channelId, id)).previews ?? [];
};

/** Everything the event log holds, as the raw text it is stored as. */
const logged = () => JSON.stringify(server.store.eventsSince(0, owner.id, 100_000) ?? []);

async function listen(token: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const frames: ServerToClient[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerToClient));
  ws.on("open", () =>
    ws.send(
      JSON.stringify({ type: "hello", token, lastSeq: null, protocolVersion: PROTOCOL_VERSION }),
    ),
  );
  await expect.poll(() => frames.some((f) => f.type === "ready")).toBe(true);
  return frames;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "slackoss-previews-"));
  fetched = [];
  await start();
  owner = await register("owner");
  peer = await register("peer");
  outsider = await register("outsider");
  general = server.store.getChannelByName("general")!.id;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("link previews", () => {
  it("come a moment after the message, in the order of its links, as no edit to apps", async () => {
    const frames = await listen(owner.token);
    const message = await post(
      peer.token,
      general,
      "Read https://news.example/launch and https://nothing.example/ then <https://docs.example/plan|the plan>",
    );
    expect(message.previews).toBeUndefined();
    const previews = await previewsOf(general, message.id, [
      "https://news.example/launch",
      "https://docs.example/plan",
    ]);
    expect(previews[0]).toMatchObject({
      title: "Launch day",
      description: "Everything ships at noon.",
      siteName: "Example News",
      image: { width: 1200, height: 630 },
    });
    expect(previews[1]!.image).toBeNull();
    expect(fetched.sort()).toEqual([
      "https://docs.example/plan",
      "https://news.example/launch",
      "https://nothing.example/",
    ]);

    // Told as a change to its previews only, which apps are not sent.
    const heard = frames.flatMap((f) =>
      f.type === "event" && f.envelope.event.type === "message.updated" ? [f.envelope.event] : [],
    );
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ previewsOnly: true, message: { id: message.id } });
    expect(toSlackEvent(heard[0]!)).toBeNull();
    expect(
      toSlackEvent({ type: "message.updated", message: { ...message, text: "edited" } }),
    ).toMatchObject({ subtype: "message_changed" });
    expect(ready(frames).linkPreviews).toBe(true);
  });

  it("serve their picture to readers of the message, and to nobody else", async () => {
    const secret = (
      await request("/api/channels", owner.token, {
        type: "private",
        name: "secret",
        memberIds: [peer.id],
      })
    ).body.channel.id as string;
    const message = await post(peer.token, secret, "https://news.example/launch");
    const [preview] = await previewsOf(secret, message.id, ["https://news.example/launch"]);
    const image = await request(
      `/api/link-previews/${preview!.id}/image`,
      peer.token,
      undefined,
      "GET",
    );
    expect(image.status).toBe(200);
    expect(image.type).toBe("image/png");
    expect(Buffer.compare(image.body as Buffer, PICTURE)).toBe(0);
    for (const [who, status] of [
      [outsider.token, 404],
      [null, 401],
    ] as const) {
      expect(
        (await request(`/api/link-previews/${preview!.id}/image`, who, undefined, "GET")).status,
      ).toBe(status);
    }
    // One with no picture has none to serve.
    const plain = await post(peer.token, secret, "https://docs.example/plan");
    const [noImage] = await previewsOf(secret, plain.id, ["https://docs.example/plan"]);
    expect(
      (await request(`/api/link-previews/${noImage!.id}/image`, peer.token, undefined, "GET"))
        .status,
    ).toBe(404);
  });

  it("follow an edit: a link taken out loses its preview at once, a new one gets its own", async () => {
    const message = await post(
      peer.token,
      general,
      "https://news.example/launch https://docs.example/plan",
    );
    await previewsOf(general, message.id, [
      "https://news.example/launch",
      "https://docs.example/plan",
    ]);
    const edited = await request(
      `/api/messages/${message.id}`,
      peer.token,
      { text: "https://docs.example/plan and https://blog.example/post" },
      "PATCH",
    );
    expect(edited.body.message.previews.map((p: { url: string }) => p.url)).toEqual([
      "https://docs.example/plan",
    ]);
    await previewsOf(general, message.id, [
      "https://docs.example/plan",
      "https://blog.example/post",
    ]);
    // What it had already was not fetched again.
    expect(fetched.filter((url) => url === "https://docs.example/plan")).toHaveLength(1);
  });

  it("can be removed by the sender alone, and an edit keeping the link leaves it off", async () => {
    const message = await post(peer.token, general, "https://news.example/launch");
    const [preview] = await previewsOf(general, message.id, ["https://news.example/launch"]);
    expect(
      (await request(`/api/link-previews/${preview!.id}`, owner.token, undefined, "DELETE")).status,
    ).toBe(403);
    expect(
      (await request(`/api/link-previews/${preview!.id}`, peer.token, undefined, "DELETE")).status,
    ).toBe(200);
    await previewsOf(general, message.id, []);
    expect(
      (await request(`/api/link-previews/${preview!.id}/image`, peer.token, undefined, "GET"))
        .status,
    ).toBe(404);
    await request(
      `/api/messages/${message.id}`,
      peer.token,
      { text: "Still https://news.example/launch" },
      "PATCH",
    );
    await new Promise((done) => setTimeout(done, 100));
    expect((await read(owner.token, general, message.id)).previews).toBeUndefined();
    expect(fetched).toEqual(["https://news.example/launch"]);
  });

  it("go with a deleted message, out of the log too", async () => {
    const message = await post(peer.token, general, "https://news.example/launch");
    const [preview] = await previewsOf(general, message.id, ["https://news.example/launch"]);
    expect(logged()).toContain("Launch day");
    await request(`/api/messages/${message.id}`, peer.token, undefined, "DELETE");
    expect(server.store.previewRows(message.id)).toEqual([]);
    expect(logged()).not.toContain("Launch day");
    expect(
      (await request(`/api/link-previews/${preview!.id}/image`, peer.token, undefined, "GET"))
        .status,
    ).toBe(404);
  });

  it("go with older history, and the log's copies with it", async () => {
    const message = await post(peer.token, general, "https://news.example/launch");
    await previewsOf(general, message.id, ["https://news.example/launch"]);
    await new Promise((done) => setTimeout(done, 5));
    server.store.transaction(() => server.store.purgeMessagesBefore(Date.now()));
    expect(server.store.previewRows(message.id)).toEqual([]);
    expect(logged()).not.toContain("Launch day");
  });

  it("are turned off and on by an owner or admin, and told to everyone signed in", async () => {
    const frames = await listen(peer.token);
    expect(
      (await request("/api/admin/workspace/link-previews", peer.token, { enabled: false }, "PUT"))
        .status,
    ).toBe(403);
    const off = await request(
      "/api/admin/workspace/link-previews",
      owner.token,
      { enabled: false },
      "PUT",
    );
    expect(off.body).toEqual({ enabled: false });
    await expect
      .poll(() =>
        frames.some(
          (f) =>
            f.type === "ephemeral" &&
            f.event.type === "workspace.linkPreviews" &&
            f.event.enabled === false,
        ),
      )
      .toBe(true);
    expect(ready(await listen(peer.token)).linkPreviews).toBe(false);

    const quiet = await post(peer.token, general, "https://news.example/launch");
    await new Promise((done) => setTimeout(done, 100));
    expect(fetched).toEqual([]);
    expect((await read(owner.token, general, quiet.id)).previews).toBeUndefined();

    await request("/api/admin/workspace/link-previews", owner.token, { enabled: true }, "PUT");
    const back = await post(peer.token, general, "https://news.example/launch again");
    await previewsOf(general, back.id, ["https://news.example/launch"]);
    expect(
      server.store
        .listAudit({ limit: 10 })
        .filter((e) => e.action === "workspace.link_previews_changed")
        .map((e) => e.details),
    ).toEqual([
      { from: false, to: true },
      { from: true, to: false },
    ]);
  });
});

describe("an isolated copy", () => {
  it("fetches no previews, since it calls nothing outside", async () => {
    await server.stop();
    await start({ isolated: true });
    const message = await post(owner.token, general, "https://news.example/launch");
    await new Promise((done) => setTimeout(done, 100));
    expect(fetched).toEqual([]);
    expect((await read(owner.token, general, message.id)).previews).toBeUndefined();
  });
});

const ready = (frames: ServerToClient[]) =>
  frames.find((f): f is ReadySnapshot => f.type === "ready")!;
