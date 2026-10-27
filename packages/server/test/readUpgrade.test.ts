import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, openDbAtVersion } from "../src/db.js";
import { Store } from "../src/store.js";

/**
 * Upgrading to replies read through their threads (v30). Before it, the
 * channel's cursor read every reply it passed, as far as Activity and the
 * mention badges were concerned; nothing read that way may come back unread.
 */
let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ownbase-read-upgrade-"));
  file = join(dir, "workspace.db");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seedAtV29() {
  const older = openDbAtVersion(file, 29);
  older.exec(`
    INSERT INTO users (id, handle, display_name, password_hash, salt, created_at)
      VALUES ('U1', 'owner', 'Owner', '', '', 0), ('U2', 'peer', 'Peer', '', '', 0);
    INSERT INTO channels (id, type, name, creator_id, created_at)
      VALUES ('C1', 'public', 'general', 'U1', 0);
    -- The owner read the channel as far as seq 50.
    INSERT INTO channel_members (channel_id, user_id, last_read_seq, joined_at)
      VALUES ('C1', 'U1', 50, 0), ('C1', 'U2', 0, 0);
  `);
  const insert = older.prepare(
    `INSERT INTO messages (id, channel_id, user_id, text, thread_root_id, seq, created_at)
     VALUES (?, 'C1', ?, ?, ?, ?, 0)`,
  );
  // Someone else's thread, never opened: a mention and a reply the channel
  // cursor passed, and a mention after it.
  insert.run("M10", "U2", "a question", null, 10);
  insert.run("M20", "U2", "for <@U1>", "M10", 20);
  insert.run("M30", "U2", "more detail", "M10", 30);
  insert.run("M40", "U2", "back in the channel", null, 40);
  // The owner's own thread, followed, whose cursor the channel cursor overtook.
  insert.run("M42", "U1", "my thread", null, 42);
  insert.run("M44", "U2", "an answer", "M42", 44);
  insert.run("M60", "U2", "and now <@U1>", "M10", 60);
  older.exec(`
    INSERT INTO thread_follows (user_id, root_id, following, last_read_seq, revision)
      VALUES ('U1', 'M42', 1, 42, 1);
  `);
  older.close();
}

describe("upgrading to replies read through their threads", () => {
  it("keeps every reply the channel cursor had read, and its mentions, read", () => {
    seedAtV29();
    const db = openDb(file, undefined, { backupBeforeUpgrade: false });
    try {
      const store = new Store(db);
      // Only the mention after the old cursor counts, as it did before.
      expect(store.unreadMentionCounts("U1")).toEqual({ C1: 1 });
      expect(store.activityMessages("U1", { mode: "unread", limit: 50 }).map((m) => m.id)).toEqual([
        "M60",
      ]);
      // The thread without a cursor of its own is read where the channel was.
      expect(store.memberships("U1")[0]).toMatchObject({ lastReadSeq: 50, repliesReadSeq: 50 });
      expect(store.threadFollow("U1", "M10")).toMatchObject({ following: false, lastReadSeq: 50 });
      // The followed thread's cursor is raised to the channel's, so Threads
      // now agrees with what Activity already said.
      expect(store.threadFollow("U1", "M42")).toMatchObject({ following: true, lastReadSeq: 50 });
      expect(store.unreadThreadCount("U1")).toBe(0);
      expect(store.followedThreads("U1").threads).toMatchObject([{ unreadCount: 0 }]);
    } finally {
      db.close();
    }
  });
});
