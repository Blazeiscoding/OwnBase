import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveObjectURL } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "@slackoss/server";
import { Api, WorkspaceClient } from "../src/index.js";
import { FileCache } from "../src/fileCache.js";

/**
 * Downloaded attachments go when their message is deleted or their
 * conversation becomes unreadable, even after the history that listed them
 * has been let go (F07). Bytes already shown cannot be taken back; what is
 * taken away is the cached copy the client would otherwise go on handing out.
 */
let server: WorkspaceServer;
let client: WorkspaceClient;
let owner: Api;
let ownerToken: string;
let memberId: string;
let general: string;
let dataDir: string;

async function upload(channelId: string, text: string) {
  const form = new FormData();
  form.append("file", new Blob([text], { type: "text/plain" }), "notes.txt");
  // Api.uploadFile uses the browser's XHR; Node posts to the same route.
  const response = await fetch(`${owner.baseUrl}/api/channels/${channelId}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}` },
    body: form,
  });
  expect(response.ok).toBe(true);
  return ((await response.json()) as { file: { id: string } }).file;
}

beforeEach(async () => {
  // Attachments are kept on disk, so this workspace needs a folder.
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-files-"));
  server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    retentionDays: 1,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const api = new Api(base);
  const a = await api.register({ handle: "owner", displayName: "Owner", password: "password123" });
  const b = await api.register({
    handle: "member",
    displayName: "Member",
    password: "password123",
  });
  ownerToken = a.token;
  owner = new Api(base, a.token);
  memberId = b.user.id;
  client = new WorkspaceClient(base, b.token);
  client.connect();
  await expect.poll(() => client.state.status).toBe("online");
  general = Object.values(client.state.channels).find((c) => c.name === "general")!.id;
});

afterEach(async () => {
  client?.destroy();
  await server?.stop();
  const owned = resolve(dataDir);
  if (dirname(owned) !== resolve(tmpdir()) || !basename(owned).startsWith("ownbase-files-"))
    throw new Error("Refused cleanup outside the owned attachment fixture");
  rmSync(owned, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("cached attachments (F07)", () => {
  it("lets a deleted message's file go, and tells an open preview", async () => {
    const file = await upload(general, "words that were deleted");
    const message = (await owner.sendMessage(general, { text: "see attached", fileIds: [file.id] }))
      .message;
    await client.loadTimeline(general);
    const cached = await client.files.get(file.id);
    expect(await resolveObjectURL(cached)!.text()).toBe("words that were deleted");
    const told = vi.fn();
    client.files.onInvalidate(told);

    await owner.deleteMessage(message.id);
    await expect.poll(() => client.files.peek(file.id)).toBeUndefined();
    expect(told).toHaveBeenCalledWith(file.id);
    expect(resolveObjectURL(cached)).toBeUndefined();
    await expect(client.files.get(file.id)).rejects.toBeTruthy();
  });

  it("lets a private conversation's file go on removal after its history was evicted", async () => {
    const { channel } = await owner.createChannel({ type: "private", name: "private-room" });
    await owner.inviteMember(channel.id, memberId);
    await expect.poll(() => client.state.channels[channel.id]).toBeTruthy();
    const file = await upload(channel.id, "formerly private");
    await owner.sendMessage(channel.id, { text: "private attachment", fileIds: [file.id] });
    await client.loadTimeline(channel.id);
    await client.files.get(file.id);
    const kept = await upload(general, "still readable");
    await owner.sendMessage(general, { text: "public attachment", fileIds: [kept.id] });
    await client.loadTimeline(general);
    const keptUrl = await client.files.get(kept.id);

    // Reading twenty other conversations evicts this one's history, as browsing would.
    for (let i = 0; i < 20; i++) {
      const other = (await owner.createChannel({ type: "public", name: `room-${i}` })).channel;
      await expect.poll(() => client.state.channels[other.id]).toBeTruthy();
      await client.loadTimeline(other.id);
    }
    expect(client.state.timelines[channel.id]).toBeUndefined();
    expect(client.files.peek(file.id)).toBeTruthy();

    await owner.removeChannelMember(channel.id, memberId);
    await expect.poll(() => client.state.channels[channel.id]).toBeUndefined();
    expect(client.files.peek(file.id)).toBeUndefined();
    // A file from a conversation still readable stays.
    expect(client.files.peek(kept.id)).toBe(keptUrl);
  });

  it("lets everything go when the session ends", async () => {
    const file = await upload(general, "signed out");
    await owner.sendMessage(general, { text: "attachment", fileIds: [file.id] });
    await client.loadTimeline(general);
    await client.files.get(file.id);
    client.store.setState({ status: "auth_failed" });
    expect(client.files.peek(file.id)).toBeUndefined();
  });

  it("revokes retained root and reply files after actual history eviction and retention", async () => {
    const rootFile = await upload(general, "expired root bytes");
    const replyFile = await upload(general, "expired reply bytes");
    const root = (await owner.sendMessage(general, { text: "old root", fileIds: [rootFile.id] }))
      .message;
    const reply = (
      await owner.sendMessage(general, {
        text: "old reply",
        threadRootId: root.id,
        fileIds: [replyFile.id],
      })
    ).message;
    await client.loadTimeline(general);
    await client.loadThread(root.id, general);
    const rootUrl = await client.files.get(rootFile.id);
    const replyUrl = await client.files.get(replyFile.id);
    const db = (server.store as unknown as { db: { exec(sql: string): void } }).db;
    db.exec("UPDATE messages SET created_at = created_at - 172800000");
    const recentFile = await upload(general, "recent authorized bytes");
    const recent = (
      await owner.sendMessage(general, { text: "recent message", fileIds: [recentFile.id] })
    ).message;
    await expect
      .poll(() =>
        client.state.timelines[general]!.items.some((message) => message.id === recent.id),
      )
      .toBe(true);
    const recentUrl = await client.files.get(recentFile.id);
    // Evict both the timeline and the loaded thread through normal navigation.
    for (let i = 0; i < 20; i++) {
      const channel = (await owner.createChannel({ type: "public", name: `retention-room-${i}` }))
        .channel;
      await expect.poll(() => client.state.channels[channel.id]).toBeTruthy();
      await client.loadTimeline(channel.id);
      const newRoot = (await owner.sendMessage(channel.id, { text: "a recent root" })).message;
      await client.loadThread(newRoot.id, channel.id);
    }
    expect(client.state.timelines[general]).toBeUndefined();
    expect(client.state.threadPages[root.id]).toBeUndefined();
    const told = vi.fn();
    client.files.onInvalidate(told);
    expect(server.applyRetention()).toBe(2);
    await expect.poll(() => client.state.removedHistory[general]).toBeGreaterThan(0);
    expect(client.files.peek(rootFile.id)).toBeUndefined();
    expect(client.files.peek(replyFile.id)).toBeUndefined();
    expect(resolveObjectURL(rootUrl)).toBeUndefined();
    expect(resolveObjectURL(replyUrl)).toBeUndefined();
    expect(told).toHaveBeenCalledWith(rootFile.id);
    expect(told).toHaveBeenCalledWith(replyFile.id);
    expect(client.files.peek(recentFile.id)).toBe(recentUrl);
    await expect(client.api.fetchFile(rootFile.id)).rejects.toMatchObject({ status: 404 });
    await expect(client.api.fetchFile(replyFile.id)).rejects.toMatchObject({ status: 404 });
    expect(server.store.getMessage(reply.id)).toBeNull();
  });

  it("cannot reinstall a held reply transfer after its thread is retained away", async () => {
    const file = await upload(general, "expired late bytes");
    const root = (await owner.sendMessage(general, { text: "old root" })).message;
    await owner.sendMessage(general, {
      text: "old reply",
      threadRootId: root.id,
      fileIds: [file.id],
    });
    await client.loadThread(root.id, general);
    const original = client.api.fetchFile.bind(client.api);
    let acquired!: () => void;
    const received = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let callerSignal: AbortSignal | undefined;
    vi.spyOn(client.api, "fetchFile").mockImplementation(async (id, signal) => {
      callerSignal = signal;
      const blob = await original(id, signal);
      acquired();
      await held;
      return blob;
    });
    const loading = client.files.get(file.id);
    await received;
    const db = (server.store as unknown as { db: { exec(sql: string): void } }).db;
    db.exec("UPDATE messages SET created_at = created_at - 172800000");
    expect(server.applyRetention()).toBe(2);
    await expect.poll(() => client.state.removedHistory[general]).toBeGreaterThan(0);
    expect(callerSignal?.aborted).toBe(true);
    release();
    await expect(loading).rejects.toMatchObject({ message: "File access was invalidated" });
    expect(client.files.peek(file.id)).toBeUndefined();
  });

  it("revalidates a deleted file obtained without loaded message history", async () => {
    const file = await upload(general, "unknown owner bytes");
    const message = (
      await owner.sendMessage(general, { text: "searchable attachment", fileIds: [file.id] })
    ).message;
    expect((await client.api.search("searchable")).messages[0]!.files[0]!.id).toBe(file.id);
    const url = await client.files.get(file.id);
    await owner.deleteMessage(message.id);
    await expect.poll(() => client.files.peek(file.id)).toBeUndefined();
    expect(resolveObjectURL(url)).toBeUndefined();
  });
});

describe("the attachment cache's owners (F07)", () => {
  const owners: Record<string, { channelId: string; messageId: string } | null> = {
    a: { channelId: "C1", messageId: "M1" },
    b: { channelId: "C2", messageId: "M2" },
    c: null,
  };
  const cache = (fetchFile: (id: string) => Promise<Blob>) =>
    new FileCache({ fetchFile } as never, undefined, (id) => owners[id] ?? null);

  it("lets go by message or conversation, keeping other conversations' files", async () => {
    const files = cache(async () => new Blob(["x"]));
    for (const id of ["a", "b", "c"]) await files.get(id);
    files.invalidateMessage("M1");
    expect(files.peek("a")).toBeUndefined();
    expect(files.peek("b")).toBeTruthy();
    // A file whose conversation was never known goes with any lost access.
    files.invalidateChannel("C9");
    expect(files.peek("c")).toBeUndefined();
    expect(files.peek("b")).toBeTruthy();
    files.invalidateChannel("C2");
    expect(files.peek("b")).toBeUndefined();
  });

  it("never reinstalls a transfer that was under way when its message went", async () => {
    let finish!: (blob: Blob) => void;
    const files = cache(() => new Promise<Blob>((done) => (finish = done)));
    const loading = files.get("a");
    await Promise.resolve();
    files.invalidateMessage("M1");
    finish(new Blob(["late"]));
    await expect(loading).rejects.toBeTruthy();
    expect(files.peek("a")).toBeUndefined();
  });

  it("forgets a cancelled transfer's message, and asks again for the next one", async () => {
    const known = new Map<string, { channelId: string; messageId: string } | null>([["d", null]]);
    let finish!: (blob: Blob) => void;
    const files = new FileCache(
      {
        // As the real one: an aborted transfer rejects.
        fetchFile: (_id: string, signal: AbortSignal) =>
          new Promise<Blob>((done, fail) => {
            finish = done;
            signal.addEventListener("abort", () => fail(signal.reason), { once: true });
          }),
      } as never,
      undefined,
      (id) => known.get(id) ?? null,
    );
    files.retain("d");
    const first = files.get("d");
    // Scrolled away: the last view goes and the transfer is cancelled.
    files.release("d");
    await expect(first).rejects.toBeTruthy();
    expect((files as unknown as { owners: Map<string, unknown> }).owners.size).toBe(0);
    // Its message has loaded since, so the next transfer knows it.
    known.set("d", { channelId: "C1", messageId: "M4" });
    const second = files.get("d");
    finish(new Blob(["x"]));
    await second;
    files.invalidateMessage("M4");
    expect(files.peek("d")).toBeUndefined();
  });
});
