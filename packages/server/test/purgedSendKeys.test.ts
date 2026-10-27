import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SEND_RETRY_WINDOW_MS } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * A send's key outlives the message retention removes (RECHECK-08). An app
 * that never heard its send was accepted keeps it in its outbox and sends it
 * again, with the same key. Until the key is remembered past retention, a
 * retry after the message was removed posts it a second time, as new, with
 * the words retention was meant to have discarded.
 */
const DAY = 24 * 3600_000;

let server: WorkspaceServer | undefined;
let directory: string;
let base: string;
let channelId = "";

async function start() {
  server = await createWorkspaceServer({
    dataDir: directory,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    retentionDays: 1,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function call(token: string, path: string, method: string, body?: unknown) {
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

async function register(handle: string) {
  const response = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
  });
  const { token } = (await response.json()) as { token: string };
  // The first account brings #general into being.
  channelId = server!.store.getChannelByName("general")!.id;
  return token;
}

const send = (token: string, text: string, nonce: string) =>
  call(token, `/api/channels/${channelId}/messages`, "POST", { text, nonce });

/** Through a second connection, as time would; WAL lets the server see it. */
function sql(statement: string) {
  const db = new DatabaseSync(join(directory, "workspace.db"));
  try {
    db.exec(statement);
  } finally {
    db.close();
  }
}

/** Every value in every table, as text, to show what the workspace still holds. */
function everythingStored(): string {
  const db = new DatabaseSync(join(directory, "workspace.db"));
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    return JSON.stringify(tables.map(({ name }) => db.prepare(`SELECT * FROM "${name}"`).all()));
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "ownbase-purged-keys-"));
  await start();
});

afterEach(async () => {
  vi.useRealTimers();
  await server?.stop();
  server = undefined;
  rmSync(directory, { recursive: true, force: true });
});

describe("a send retried after retention removed its message", () => {
  it("is refused as already sent, not posted again", async () => {
    const token = await register("owner");
    const words = "numbers for the board, do not forward";
    const first = await send(token, words, "outbox-1");
    expect(first.status).toBe(201);
    // Its answer lost: the app would send the same thing again, and does,
    // while the message is still there. That settles on the same message.
    const again = await send(token, words, "outbox-1");
    expect(again.body.message.id).toBe(first.body.message.id);

    sql(`UPDATE messages SET created_at = created_at - ${2 * DAY}`);
    expect(server!.applyRetention()).toBe(1);
    // Nothing of the words is left, anywhere in the workspace.
    expect(everythingStored()).not.toContain(words);

    const late = await send(token, words, "outbox-1");
    expect(late.status).toBe(409);
    expect(late.body.error).toBe("message_deleted");
    const { body } = await call(token, `/api/channels/${channelId}/messages?limit=50`, "GET");
    expect(body.messages.some((m: { text: string }) => m.text === words)).toBe(false);
  });

  it("is refused the same way a deleted message's retry is", async () => {
    const token = await register("owner");
    const deleted = await send(token, "taken back", "outbox-deleted");
    await call(token, `/api/messages/${deleted.body.message.id}`, "DELETE");
    const removed = await send(token, "removed with age", "outbox-aged");
    sql(`UPDATE messages SET created_at = created_at - ${2 * DAY}`);
    server!.applyRetention();

    const afterDelete = await send(token, "taken back", "outbox-deleted");
    const afterRetention = await send(token, "removed with age", "outbox-aged");
    expect([afterDelete.status, afterDelete.body.error]).toEqual([409, "message_deleted"]);
    expect([afterRetention.status, afterRetention.body.error]).toEqual([409, "message_deleted"]);
    expect(removed.status).toBe(201);
  });

  it("is still refused after the server restarts", async () => {
    const token = await register("owner");
    await send(token, "before the restart", "outbox-restart");
    sql(`UPDATE messages SET created_at = created_at - ${2 * DAY}`);
    server!.applyRetention();
    await server!.stop();
    await start();

    const late = await send(token, "before the restart", "outbox-restart");
    expect([late.status, late.body.error]).toEqual([409, "message_deleted"]);
  });

  it("keeps each account's keys its own", async () => {
    const owner = await register("owner");
    const other = await register("other");
    await send(owner, "the owner's", "same-key");
    sql(`UPDATE messages SET created_at = created_at - ${2 * DAY}`);
    server!.applyRetention();

    // Someone else's app that happened on the same key sends as usual.
    expect((await send(other, "someone else's", "same-key")).status).toBe(201);
    expect((await send(owner, "the owner's", "same-key")).status).toBe(409);
  });
});

describe("how long a removed message's key is kept", () => {
  it("through an app's whole retry window, and a week past it, then no longer", async () => {
    // The hourly maintenance, run by hand; everything else keeps real time.
    vi.useFakeTimers({ toFake: ["setInterval"] });
    await server!.stop();
    await start();
    const token = await register("owner");
    await send(token, "posted a while ago", "outbox-old");
    // Posted just inside the retry window: an app could still be sending it.
    sql(`UPDATE messages SET created_at = created_at - ${SEND_RETRY_WINDOW_MS - DAY}`);
    server!.applyRetention();
    vi.advanceTimersByTime(3600_000);
    expect((await send(token, "posted a while ago", "outbox-old")).status).toBe(409);

    // A week past the window it is still kept, for a clock that runs behind.
    sql(`UPDATE purged_message_requests SET sent_at = sent_at - ${7 * DAY}`);
    vi.advanceTimersByTime(3600_000);
    expect((await send(token, "posted a while ago", "outbox-old")).status).toBe(409);

    // Beyond that, it is forgotten.
    sql(`UPDATE purged_message_requests SET sent_at = sent_at - ${2 * DAY}`);
    vi.advanceTimersByTime(3600_000);
    let kept = "";
    const db = new DatabaseSync(join(directory, "workspace.db"));
    try {
      kept = JSON.stringify(db.prepare("SELECT * FROM purged_message_requests").all());
    } finally {
      db.close();
    }
    expect(kept).toBe("[]");
  });
});
