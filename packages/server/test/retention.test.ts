import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

let server: WorkspaceServer | undefined;
let directory: string;
let base: string;
let token: string;
let userId: string;
let channelId: string;

async function start(opts: { retentionDays?: number } = {}) {
  server = await createWorkspaceServer({
    dataDir: directory,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    ...opts,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function api(path: string, method: string, body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}

async function signIn() {
  const registered = await api("/api/auth/register", "POST", {
    handle: "owner",
    displayName: "Owner",
    password: "password123",
  });
  token = registered.body.token;
  userId = registered.body.user.id;
  channelId = server!.store.getChannelByName("general")!.id;
}

async function post(text: string, extra: Record<string, unknown> = {}) {
  const { body } = await api(`/api/channels/${channelId}/messages`, "POST", { text, ...extra });
  return body.message as { id: string; channelId: string };
}

async function attach(name: string) {
  const form = new FormData();
  form.append("file", new Blob(["attachment bytes"]), name);
  const uploaded = await fetch(`${base}/api/channels/${channelId}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  return ((await uploaded.json()) as { file: { id: string } }).file.id;
}

/** Everything the event log holds, as the raw text it is stored as. */
function loggedPayloads(): string {
  return JSON.stringify(server!.store.eventsSince(0, userId, 100_000) ?? []);
}

/**
 * Makes rows old. Only time can otherwise do this, and a test that waited a day
 * would not be a test. A second connection is how it reaches past the store's
 * own API; WAL lets the server's connection see the change.
 */
function backdate(days: number) {
  const db = new DatabaseSync(join(directory, "workspace.db"));
  try {
    db.exec(`UPDATE messages SET created_at = created_at - ${days * 24 * 3600_000}`);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ownbase-retention-"));
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  rmSync(directory, { recursive: true, force: true });
});

describe("what deleting a message actually reaches", () => {
  beforeEach(async () => {
    await start();
    await signIn();
  });

  it("takes the words out of the event log, not just out of the channel", async () => {
    const secret = "the-sentence-i-regret-writing";
    const message = await post(secret);
    expect(loggedPayloads()).toContain(secret);

    expect((await api(`/api/messages/${message.id}`, "DELETE")).status).toBe(200);
    // The channel no longer shows it, which was never the hard part.
    expect(server!.store.getMessage(message.id)).toBeNull();
    // The log is where the copy lived on disk, readable by anyone who can read
    // the file, for as long as the log is kept.
    expect(loggedPayloads()).not.toContain(secret);
  });

  it("takes the attachment's name too, which often says as much", async () => {
    const fileId = await attach("severance-agreement-final.pdf");
    const message = await post("here it is", { fileIds: [fileId] });
    expect(loggedPayloads()).toContain("severance-agreement-final.pdf");

    await api(`/api/messages/${message.id}`, "DELETE");
    expect(loggedPayloads()).not.toContain("severance-agreement-final.pdf");
  });

  it("takes the first draft when someone edits instead of deleting", async () => {
    const wrong = "i think dana is the problem here";
    const message = await post(wrong);
    const edited = await api(`/api/messages/${message.id}`, "PATCH", {
      text: "i think the process is the problem here",
    });
    expect(edited.status).toBe(200);

    const log = loggedPayloads();
    expect(log).not.toContain(wrong);
    // The correction itself is still there; only what it replaced is gone.
    expect(log).toContain("i think the process is the problem here");
  });

  it("leaves the events themselves in place, so nobody is sent back for a snapshot", async () => {
    const before = server!.store.currentSeq();
    const message = await post("something to take back");
    await api(`/api/messages/${message.id}`, "DELETE");

    // A client that was away since `before` replays the posting and then the
    // deletion, and lands where it would have anyway. Removing the events
    // instead would leave a gap it would read as having fallen off the log.
    const replay = server!.store.eventsSince(before, userId) ?? [];
    const types = replay.map((e) => e.event.type);
    expect(types).toContain("message.created");
    expect(types).toContain("message.deleted");
    const created = replay.find((e) => e.event.type === "message.created")!;
    expect((created.event as any).message.id).toBe(message.id);
    expect((created.event as any).message.text).toBe("");
  });

  it("removes a thread's replies with its first message, words and attachments too", async () => {
    const root = await post("the opening message");
    const fileId = await attach("reply-attachment.txt");
    const reply = await api(`/api/channels/${channelId}/messages`, "POST", {
      text: "somebody else's answer",
      threadRootId: root.id,
      fileIds: [fileId],
    });
    expect(reply.status).toBe(201);
    const blob = join(directory, "files", fileId);
    expect(existsSync(blob)).toBe(true);

    await api(`/api/messages/${root.id}`, "DELETE");
    const thread = await api(`/api/channels/${channelId}/threads/${root.id}`, "GET");
    expect(thread.status).toBe(404);
    expect((await api(`/api/threads/followed`, "GET")).body.threads).toEqual([]);

    // Not hidden: gone, the way a deleted message is.
    expect(server!.store.getMessage(reply.body.message.id)).toBeNull();
    const log = loggedPayloads();
    expect(log).not.toContain("somebody else's answer");
    expect(log).not.toContain("reply-attachment.txt");
    await server!.flushFileDeletions();
    expect(existsSync(blob)).toBe(false);
  });

  it("announces each reply's removal before the thread's own, so an open thread empties first", async () => {
    const root = await post("a thread about to go");
    const first = (
      await api(`/api/channels/${channelId}/messages`, "POST", {
        text: "one",
        threadRootId: root.id,
      })
    ).body.message;
    const second = (
      await api(`/api/channels/${channelId}/messages`, "POST", {
        text: "two",
        threadRootId: root.id,
      })
    ).body.message;
    const before = server!.store.currentSeq();

    await api(`/api/messages/${root.id}`, "DELETE");
    const deletions = (server!.store.eventsSince(before, userId) ?? [])
      .map((e) => e.event)
      .filter((e) => e.type === "message.deleted") as {
      messageId: string;
      threadRootId: string | null;
    }[];
    expect(deletions.map((e) => e.messageId)).toEqual([first.id, second.id, root.id]);
    expect(deletions.map((e) => e.threadRootId)).toEqual([root.id, root.id, null]);
  });

  it("leaves the thread alone when only a reply is deleted", async () => {
    const root = await post("still here");
    const keep = (
      await api(`/api/channels/${channelId}/messages`, "POST", {
        text: "keep",
        threadRootId: root.id,
      })
    ).body.message;
    const drop = (
      await api(`/api/channels/${channelId}/messages`, "POST", {
        text: "drop",
        threadRootId: root.id,
      })
    ).body.message;

    await api(`/api/messages/${drop.id}`, "DELETE");
    expect(server!.store.getMessage(root.id)).not.toBeNull();
    expect(server!.store.getMessage(keep.id)?.text).toBe("keep");
    expect(server!.store.getMessage(drop.id)).toBeNull();
  });

  it("takes the pins and saves that pointed at it", async () => {
    const message = await post("pin me");
    expect((await api(`/api/messages/${message.id}/pin`, "PUT")).status).toBe(200);
    expect((await api(`/api/messages/${message.id}/save`, "PUT")).status).toBe(200);
    expect((await api(`/api/channels/${channelId}/pins`, "GET")).body.messages).toHaveLength(1);

    await api(`/api/messages/${message.id}`, "DELETE");
    expect((await api(`/api/channels/${channelId}/pins`, "GET")).body.messages).toEqual([]);
    expect((await api("/api/saved", "GET")).body.messages).toEqual([]);
  });
});

describe("a retention window", () => {
  it("is off unless the host asks for one", async () => {
    await start();
    await signIn();
    const message = await post("from a long time ago");
    backdate(400);

    expect(server!.applyRetention()).toBe(0);
    expect(server!.store.getMessage(message.id)).not.toBeNull();
  });

  it("refuses a window that is not a number of days", async () => {
    await expect(
      createWorkspaceServer({
        dataDir: directory,
        host: "127.0.0.1",
        port: 0,
        mdns: false,
        retentionDays: -1,
      }),
    ).rejects.toThrow(/retentionDays/);
  });

  it("discards what is past the window and keeps what is not", async () => {
    await start({ retentionDays: 30 });
    await signIn();
    const old = await post("said last quarter");
    backdate(60);
    const recent = await post("said this morning");

    expect(server!.applyRetention()).toBe(1);
    expect(server!.store.getMessage(old.id)).toBeNull();
    expect(server!.store.getMessage(recent.id)).not.toBeNull();
  });

  it("leaves nothing of what it discards, in the log or on disk", async () => {
    await start({ retentionDays: 30 });
    await signIn();
    const secret = "a-number-nobody-should-still-have";
    const fileId = await attach("old-invoice.pdf");
    await post(secret, { fileIds: [fileId] });
    const blob = join(directory, "files", fileId);
    expect(existsSync(blob)).toBe(true);
    backdate(60);

    expect(server!.applyRetention()).toBe(1);
    await server!.flushFileDeletions();
    const log = loggedPayloads();
    expect(log).not.toContain(secret);
    expect(log).not.toContain("old-invoice.pdf");
    expect(existsSync(blob)).toBe(false);
  });

  it("keeps a thread whose newest reply is still inside the window", async () => {
    await start({ retentionDays: 30 });
    await signIn();
    const root = await post("started this long ago");
    backdate(60);
    const reply = await api(`/api/channels/${channelId}/messages`, "POST", {
      text: "still talking about it",
      threadRootId: root.id,
    });
    expect(reply.status).toBe(201);

    // A reply hanging under nothing reads as a broken database rather than as
    // a window doing its job, so the root waits for the conversation to end.
    expect(server!.applyRetention()).toBe(0);
    expect(server!.store.getMessage(root.id)).not.toBeNull();
  });

  it("takes a thread's replies with its root once the whole thing is past it", async () => {
    await start({ retentionDays: 30 });
    await signIn();
    const root = await post("a conversation that finished");
    const reply = await api(`/api/channels/${channelId}/messages`, "POST", {
      text: "and here is the last word on it",
      threadRootId: root.id,
    });
    backdate(60);

    expect(server!.applyRetention()).toBe(2);
    expect(server!.store.getMessage(root.id)).toBeNull();
    expect(server!.store.getMessage(reply.body.message.id)).toBeNull();
  });

  it("takes the words out of app events still waiting to be delivered", async () => {
    await start({ retentionDays: 30 });
    await signIn();
    const secret = "an-old-secret-still-queued-for-an-app";
    const message = await post(secret);
    const store = server!.store;
    const app = store.createApp({
      name: "Waiting App",
      botUserId: userId,
      createdBy: userId,
      signingSecret: "test-signing-secret-not-a-credential",
    });
    const subscription = store.createSubscription({
      appId: app.id,
      url: "https://example.invalid/events",
      eventTypes: [],
    });
    // Due in an hour, so the delivery timer leaves it where it is.
    store.enqueueEventDelivery(
      subscription.id,
      channelId,
      1,
      JSON.stringify({
        type: "event_callback",
        event: { type: "message", text: secret, ts: message.id },
        ownbase: { type: "message.created", seq: 1 },
      }),
      Date.now() + 3600_000,
      message.id,
    );
    backdate(60);

    expect(server!.applyRetention()).toBe(1);
    const db = new DatabaseSync(join(directory, "workspace.db"));
    try {
      const bodies = JSON.stringify(db.prepare("SELECT body FROM event_deliveries").all());
      expect(bodies).toContain("message.created");
      expect(bodies).not.toContain(secret);
    } finally {
      db.close();
    }
  });

  it("does not send everyone back for a new snapshot when it runs", async () => {
    await start({ retentionDays: 30 });
    await signIn();
    await post("old one");
    backdate(60);
    const cursor = server!.store.currentSeq();
    await post("new one");

    expect(server!.applyRetention()).toBe(1);
    // Null here would mean the client had fallen off the log, which a tidy-up
    // of year-old messages has no business causing.
    expect(server!.store.eventsSince(cursor, userId)).not.toBeNull();
  });

  it("leaves the workspace usable afterwards", async () => {
    await start({ retentionDays: 30 });
    await signIn();
    await post("ancient history");
    backdate(60);
    server!.applyRetention();

    // The rows it removed were referenced by six other tables; a foreign key it
    // missed would surface here rather than at the delete.
    const posted = await api(`/api/channels/${channelId}/messages`, "POST", {
      text: "carrying on",
    });
    expect(posted.status).toBe(201);
    const listed = await api(`/api/channels/${channelId}/messages`, "GET");
    expect(listed.body.messages.map((m: { text: string }) => m.text)).toContain("carrying on");
  });
});

/**
 * Writes an old thread straight into the database: a root and `replies`
 * replies under it, all created at time 1. Posting tens of thousands of
 * messages through the API would test the rate limits rather than retention.
 */
function seedOldThread(rootId: string, replies: number): void {
  const db = new DatabaseSync(join(directory, "workspace.db"));
  try {
    db.exec("BEGIN");
    const insert = db.prepare(
      `INSERT INTO messages (id, channel_id, user_id, text, thread_root_id, created_at)
       VALUES (?, ?, ?, ?, ?, 1)`,
    );
    insert.run(rootId, channelId, userId, "an old question", null);
    for (let i = 0; i < replies; i++) {
      insert.run(`${rootId}-${String(i).padStart(6, "0")}`, channelId, userId, "a reply", rootId);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

function countMessages(): number {
  const db = new DatabaseSync(join(directory, "workspace.db"));
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

// Seeds and removes 33,001 messages: under a second alone, 3.4 s on CI's
// shared two-worker runner, and 5.1 s on a busier run, past Vitest's 5 s
// default. The size is the point of the test, so it gets the time it needs.
const LARGE_THREAD_MS = 30_000;

describe("a retention window over a large backlog", () => {
  it(
    "takes a thread with more replies than SQLite accepts parameters",
    async () => {
      await start({ retentionDays: 30 });
      await signIn();
      // SQLite refuses a statement with more than 32,766 bound values, which is
      // what one parameter per message used to need here.
      seedOldThread("0000000000ROOT", 33_000);

      expect(server!.applyRetention()).toBe(33_001);
      expect(countMessages()).toBe(0);
    },
    LARGE_THREAD_MS,
  );

  it("budgets each pass by messages, and finishes the backlog over several", async () => {
    await start({ retentionDays: 30 });
    await signIn();
    for (const root of ["0000000001A", "0000000001B", "0000000001C"]) seedOldThread(root, 4);

    // Five messages per pass: each thread is five, so one thread per pass.
    const pass = () =>
      server!.store.transaction(() => server!.store.purgeMessagesBefore(2, { messages: 5 }));
    expect(pass().messages).toBe(5);
    expect(countMessages()).toBe(10);
    // A thread bigger than the budget is still taken whole rather than never.
    expect(
      server!.store.transaction(() => server!.store.purgeMessagesBefore(2, { messages: 1 }))
        .messages,
    ).toBe(5);
    expect(countMessages()).toBe(5);

    // The timer's round keeps going until nothing is left.
    expect(await server!.sweepRetention()).toBe(5);
    expect(countMessages()).toBe(0);
    expect(server!.retentionStatus()).toMatchObject({ lastError: null, failures: 0 });
  });

  it("records a failed sweep instead of throwing, and clears it once one succeeds", async () => {
    await start({ retentionDays: 30 });
    await signIn();
    seedOldThread("0000000002A", 2);
    const store = server!.store;
    const purge = store.purgeMessagesBefore;
    store.purgeMessagesBefore = () => {
      throw new Error("disk I/O error");
    };
    try {
      // From a timer, a throw here would have ended the process.
      await expect(server!.sweepRetention()).resolves.toBe(0);
      expect(server!.retentionStatus()).toMatchObject({
        lastError: "disk I/O error",
        failures: 1,
        lastSuccessAt: null,
      });
      // The failed pass rolled back whole; nothing is half removed.
      expect(countMessages()).toBe(3);
    } finally {
      store.purgeMessagesBefore = purge;
    }

    expect(await server!.sweepRetention()).toBe(3);
    expect(server!.retentionStatus()).toMatchObject({ lastError: null, failures: 0 });
    expect(server!.retentionStatus().lastSuccessAt).not.toBeNull();
  });

  it("still keeps a large thread whose newest reply is inside the window", async () => {
    await start({ retentionDays: 30 });
    await signIn();
    seedOldThread("0000000003A", 40);
    const reply = await api(`/api/channels/${channelId}/messages`, "POST", {
      text: "one more thing",
      threadRootId: "0000000003A",
    });
    expect(reply.status).toBe(201);

    expect(await server!.sweepRetention()).toBe(0);
    expect(countMessages()).toBe(42);
  });
});
