import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { text as readText } from "node:stream/consumers";
import { bytes, endpoint, json, type User } from "@ownbase/protocol";
import type { EarlierWords, ExtensionContext, Keep, ServerExtension } from "../src/extensions.js";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * What the server gives an extension that keeps records (P12): people and
 * conversations it says to keep, which retention skips and nobody can
 * delete; the words an edit replaces; the administrative record, to add to
 * and to read in order; the record of messages, deleted ones included, and
 * their files; the outbound guard; and one-time download tickets. Nothing
 * here needs ee/.
 */
let server: WorkspaceServer | undefined;
let directory: string;
let base: string;
type Account = { token: string; user: User };

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ownbase-records-"));
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  rmSync(directory, { recursive: true, force: true });
});

const DAY = 24 * 3600_000;

const downloads = {
  probe: endpoint({
    method: "GET",
    path: "/api/records/probe",
    access: "owner",
    ticket: true,
    answer: bytes,
  }),
  ticket: endpoint({
    method: "POST",
    path: "/api/records/probe/ticket",
    access: "owner",
    answer: json<{ token: string }>(),
  }),
};

/** An extension that keeps what `keep` says, hears edits, and lends its context to the test. */
function recorder(keep: Keep = { userIds: [], channelIds: [] }) {
  const held: { context?: ExtensionContext; keep: Keep; edits: EarlierWords[]; refuse: boolean } = {
    keep,
    edits: [],
    refuse: false,
  };
  const extension: ServerExtension = {
    name: "recorder",
    register(context) {
      held.context = context;
      context.route(downloads.probe, async ({ reply }) => reply.send("the download"));
      context.route(downloads.ticket, async ({ req, user }) =>
        context.ticketFor(req, user, downloads.probe, {}),
      );
    },
    keeps: () => held.keep,
    editing(earlier) {
      if (held.refuse) throw new Error("the record could not be kept");
      held.edits.push(earlier);
    },
  };
  return { extension, held };
}

async function start(extensions: ServerExtension[], over: { allowPrivateHooks?: boolean } = {}) {
  server = await createWorkspaceServer({
    dataDir: directory,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    logger: false,
    retentionDays: 30,
    extensions,
    ...over,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function call(path: string, token?: string, body?: unknown, method = "POST") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json().catch(() => null)) as any };
}

async function people() {
  const register = async (handle: string): Promise<Account> =>
    (
      await call("/api/auth/register", undefined, {
        handle,
        displayName: handle,
        password: "password123",
      })
    ).data;
  const owner = await register("owner");
  const member = await register("member");
  const general = server!.store.channels.byName("general")!.id;
  return { owner, member, general };
}

async function post(who: Account, channelId: string, text: string, extra: object = {}) {
  const { data } = await call(`/api/channels/${channelId}/messages`, who.token, {
    text,
    ...extra,
  });
  return data.message as { id: string };
}

const remove = (who: Account, channelId: string, id: string) =>
  call(`/api/messages/${id}`, who.token, undefined, "DELETE");

/** Ages every message, through a second connection, as retention.test.ts does. */
function backdate(days: number) {
  const db = new DatabaseSync(join(directory, "workspace.db"));
  try {
    db.exec(`UPDATE messages SET created_at = created_at - ${days * DAY}`);
  } finally {
    db.close();
  }
}

const stillThere = (id: string) =>
  server!.store.messages
    .recorded({
      from: 0,
      to: Date.now() + DAY,
      userIds: [],
      channelIds: server!.store.channels.all().map((c) => c.id),
      limit: 1000,
    })
    .some((m) => m.id === id);

describe("messages an extension says to keep (P12)", () => {
  it("are skipped by retention, with every thread they are in", async () => {
    const { extension, held } = recorder();
    await start([extension]);
    const { owner, member, general } = await people();
    const room = (await call("/api/channels", owner.token, { name: "legal", type: "public" })).data
      .channel.id as string;
    const byHeld = await post(member, general, "held because of who wrote it");
    const loose = await post(owner, general, "nothing keeps this");
    const root = await post(owner, general, "a thread someone held answered");
    await post(member, general, "a held reply", { threadRootId: root.id });
    const inRoom = await post(owner, room, "held because of where it is");
    held.keep = { userIds: [member.user.id], channelIds: [room] };
    backdate(60);

    expect(server!.applyRetention()).toBe(1);
    expect(stillThere(loose.id)).toBe(false);
    for (const kept of [byHeld, root, inRoom]) expect(stillThere(kept.id)).toBe(true);

    // Let go, they age out as anything else does.
    held.keep = { userIds: [], channelIds: [] };
    expect(server!.applyRetention()).toBe(4);
  });

  it("cannot be deleted by their author, an admin, or with the thread they answer", async () => {
    const { extension, held } = recorder();
    await start([extension]);
    const { owner, member, general } = await people();
    const own = await post(member, general, "mine, and held");
    const root = await post(owner, general, "the owner's thread");
    const reply = await post(member, general, "a held reply", { threadRootId: root.id });
    const loose = await post(owner, general, "nothing keeps this");
    held.keep = { userIds: [member.user.id], channelIds: [] };

    const refused = {
      status: 403,
      data: {
        error: "message_kept",
        message: "This message is kept for the workspace's records, so it cannot be deleted.",
      },
    };
    expect(await remove(member, general, own.id)).toMatchObject(refused);
    expect(await remove(owner, general, own.id)).toMatchObject(refused);
    expect(await remove(member, general, reply.id)).toMatchObject(refused);
    // The root takes its replies with it, a held one among them.
    expect(await remove(owner, general, root.id)).toMatchObject(refused);
    for (const id of [own.id, root.id, reply.id]) expect(stillThere(id)).toBe(true);
    expect((await remove(owner, general, loose.id)).status).toBe(200);

    // Kept by where it is, too.
    held.keep = { userIds: [], channelIds: [general] };
    expect(await remove(owner, general, root.id)).toMatchObject(refused);
    held.keep = { userIds: [], channelIds: [] };
    expect((await remove(owner, general, root.id)).status).toBe(200);
    expect((await remove(member, general, own.id)).status).toBe(200);
  });
});

describe("an edit, as an extension hears it (P12)", () => {
  it("is told the words it replaces, in the same change", async () => {
    const { extension, held } = recorder();
    await start([extension]);
    const { member, general } = await people();
    const sent = await post(member, general, "the first words");
    const edit = (text: string, expectedText: string) =>
      call(`/api/messages/${sent.id}`, member.token, { text, expectedText }, "PATCH");
    expect((await edit("the second words", "the first words")).status).toBe(200);
    expect((await edit("the third words", "the second words")).status).toBe(200);
    expect(held.edits.map((e) => e.text)).toEqual(["the first words", "the second words"]);
    expect(held.edits[0]).toMatchObject({
      messageId: sent.id,
      channelId: general,
      userId: member.user.id,
    });
    // The second version was written when the first edit was made.
    expect(held.edits[1]!.writtenAt).toBeGreaterThanOrEqual(held.edits[0]!.writtenAt);

    // What the extension cannot keep, the edit does not erase.
    held.refuse = true;
    expect((await edit("the fourth words", "the third words")).status).toBe(500);
    const [now] = server!.store.messages.recorded({
      from: 0,
      to: Date.now() + DAY,
      userIds: [member.user.id],
      channelIds: [],
      limit: 10,
    });
    expect(now!.text).toBe("the third words");
  });
});

describe("the administrative record, for an extension (P12)", () => {
  it("takes its entries, reads them in order after any one, and says when there are more", async () => {
    const { extension, held } = recorder();
    await start([extension]);
    const { owner } = await people();
    const audit = held.context!.audit;
    let told = 0;
    const stop = audit.onRecord(() => told++);
    audit.record({ actorId: owner.user.id, did: "changed the legal hold", details: { people: 2 } });
    audit.record({ actorId: null, did: "sent the record to a webhook" });
    // Two written together are told once, on a later turn.
    expect(told).toBe(0);
    await expect.poll(() => told).toBe(1);

    const all = audit.after(null, 100);
    expect(all.slice(-2)).toMatchObject([
      {
        actorId: owner.user.id,
        action: "extension.action",
        targetType: "workspace",
        details: { did: "changed the legal hold", people: 2 },
      },
      { actorId: null, details: { did: "sent the record to a webhook" } },
    ]);
    expect(audit.after(all.at(-2)!.id, 100).map((e) => e.id)).toEqual([all.at(-1)!.id]);
    expect(audit.after(all.at(-1)!.id, 100)).toEqual([]);
    // An id it does not have reads from the first again, rather than never.
    expect(audit.after("01NOTANENTRYTHELOGHAS0000", 100)).toEqual(all);
    // Admins read the same entry in the record.
    const listed = (await call("/api/admin/audit", owner.token, undefined, "GET")).data.entries;
    expect(listed[0]).toMatchObject({ action: "extension.action" });

    stop();
    audit.record({ actorId: null, did: "stopped" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(told).toBe(1);
  });
});

describe("the record of messages, for an extension (P12)", () => {
  it("has a time range's messages by people or conversations, deleted ones without their words", async () => {
    const { extension, held } = recorder();
    await start([extension]);
    const { owner, member, general } = await people();
    const dm = (
      await call("/api/channels", owner.token, { type: "dm", memberIds: [member.user.id] })
    ).data.channel.id as string;
    const form = new FormData();
    form.append("file", new Blob(["attachment bytes"]), "notes.txt");
    const uploaded = await fetch(`${base}/api/channels/${general}/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.token}` },
      body: form,
    });
    const fileId = ((await uploaded.json()) as { file: { id: string } }).file.id;
    const withFile = await post(owner, general, "with a file", { fileIds: [fileId] });
    const gone = await post(member, general, "taken back");
    await remove(member, general, gone.id);
    const direct = await post(owner, dm, "just between us");
    const context = held.context!;

    const all = context.messages.recorded({
      from: 0,
      to: Date.now() + DAY,
      userIds: [member.user.id],
      channelIds: [dm],
      limit: 10,
    });
    expect(all.map((m) => m.id)).toEqual([gone.id, direct.id]);
    expect(all[0]).toMatchObject({ userId: member.user.id, text: "", files: [] });
    expect(all[0]!.deletedAt).toEqual(expect.any(Number));
    expect(all[1]).toMatchObject({ channelId: dm, text: "just between us", deletedAt: null });

    const [shared] = context.messages.recorded({
      from: 0,
      to: Date.now() + DAY,
      userIds: [owner.user.id],
      channelIds: [],
      limit: 1,
    });
    expect(shared).toMatchObject({ id: withFile.id, files: [{ id: fileId, name: "notes.txt" }] });
    expect(await readText(context.files.open(fileId)!)).toBe("attachment bytes");
    // A page at a time, after the last one seen.
    const next = context.messages.recorded({
      from: 0,
      to: Date.now() + DAY,
      userIds: [owner.user.id],
      channelIds: [],
      afterId: withFile.id,
      limit: 10,
    });
    expect(next.map((m) => m.id)).toEqual([direct.id]);
    // Nothing before the range starts or from when it ends.
    expect(
      context.messages.recorded({
        from: Date.now() + DAY,
        to: Date.now() + 2 * DAY,
        userIds: [owner.user.id],
        channelIds: [],
        limit: 10,
      }),
    ).toEqual([]);

    const conversations = context.channels.list();
    expect(conversations.find((c) => c.id === dm)).toMatchObject({
      type: "dm",
      memberIds: expect.arrayContaining([owner.user.id, member.user.id]),
    });
    expect(conversations.some((c) => c.name === "general")).toBe(true);
  });
});

describe("what else an extension may use (P12)", () => {
  let hook: Server;
  let seen: { body: string; signature?: string }[];

  beforeEach(async () => {
    seen = [];
    hook = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        seen.push({ body, signature: req.headers["x-test-signature"] as string | undefined });
        res.end("thanks");
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
  });

  afterEach(() => new Promise<void>((resolve) => hook.close(() => resolve())));

  const hookUrl = () => `http://127.0.0.1:${(hook.address() as { port: number }).port}/audit`;

  it("posts through the outbound guard, which refuses private addresses unless allowed", async () => {
    const { extension, held } = recorder();
    await start([extension]);
    await expect(
      held.context!.post(hookUrl(), "{}", { contentType: "application/json" }),
    ).rejects.toMatchObject({ code: "blocked_host" });
    expect(seen).toEqual([]);
    await server!.stop();

    const allowed = recorder();
    await start([allowed.extension], { allowPrivateHooks: true });
    const answer = await allowed.held.context!.post(hookUrl(), '{"entries":[]}', {
      contentType: "application/json",
      headers: { "x-test-signature": "signed" },
    });
    expect(answer).toEqual({ status: 200, body: "thanks" });
    expect(seen).toEqual([{ body: '{"entries":[]}', signature: "signed" }]);
  });

  it("opens one of its downloads once, by a ticket made for the session asking", async () => {
    const { extension } = recorder();
    await start([extension]);
    const { owner } = await people();
    const { token } = (await call("/api/records/probe/ticket", owner.token)).data;
    const first = await fetch(`${base}/api/records/probe?download=${token}`);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("the download");
    expect((await fetch(`${base}/api/records/probe?download=${token}`)).status).toBe(404);
  });
});
