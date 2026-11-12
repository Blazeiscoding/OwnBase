import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readZipEntries, readZipEntry } from "../src/backups/zip.js";
import { exportWorkspace } from "../src/import/slackExport.js";
import { importSlack } from "../src/import/slackImport.js";
import { Store } from "../src/store.js";
import { slackExport, writeZip } from "./slackFixture.js";

let root: string;
let first: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ownbase-slack-export-"));
  const zip = join(root, "slack.zip");
  await writeZip(zip, slackExport());
  first = join(root, "first");
  await importSlack({
    from: zip,
    dataDir: first,
    owner: "alice",
    workspaceName: "Acme",
    fetchFiles: true,
    fetchFile: async () => Buffer.from("hello world"),
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A workspace as its members see it, with every id swapped for what it
 * names, so two workspaces made from the same history compare equal.
 */
function contents(dataDir: string) {
  const db = new DatabaseSync(join(dataDir, "workspace.db"));
  try {
    const store = new Store(db);
    const people = store.people.list();
    const handle = new Map(people.map((u) => [u.id, u.handle]));
    const channelIds = (db.prepare("SELECT id FROM channels").all() as { id: string }[]).map(
      (r) => r.id,
    );
    const channels = channelIds.map((id) => store.channels.get(id)!);
    const members = (id: string) =>
      store.channels
        .memberIds(id)
        .map((m) => handle.get(m)!)
        .sort();
    const key = (c: (typeof channels)[number]) =>
      c.type === "dm" || c.type === "group_dm"
        ? `${c.type}:${members(c.id).join(",")}`
        : `${c.type}:${c.name}`;
    const keys = new Map(channels.map((c) => [c.id, key(c)]));
    const words = (text: string) =>
      text
        .replace(/<@([A-Za-z0-9]+)>/g, (_, id: string) => `@${handle.get(id) ?? "?"}`)
        .replace(/<#([A-Za-z0-9]+)>/g, (_, id: string) => `#${keys.get(id) ?? "?"}`);
    const conversations = channels.map((c) => {
      const history = store.messages.list({ channelId: c.id, limit: 1000 }).reverse();
      const replies = history.flatMap((m) =>
        m.replyCount
          ? store.messages.list({ channelId: c.id, threadRootId: m.id, limit: 1000 }).reverse()
          : [],
      );
      const all = [...history, ...replies.filter((r) => !r.broadcast)].sort((a, b) =>
        a.id < b.id ? -1 : 1,
      );
      const texts = new Map(all.map((m) => [m.id, m.text]));
      return {
        key: key(c),
        topic: words(c.topic),
        description: words(c.description),
        archived: c.archived,
        members: members(c.id),
        messages: all.map((m) => ({
          author: handle.get(m.userId),
          text: words(m.text),
          createdAt: m.createdAt,
          editedAt: m.editedAt,
          thread: m.threadRootId ? words(texts.get(m.threadRootId) ?? "?") : null,
          broadcast: m.broadcast,
          replies: m.replyCount,
          pinned: m.pinned,
          reactions: m.reactions.map((r) => ({
            emoji: r.emoji,
            users: r.userIds.map((u) => handle.get(u)),
          })),
          files: m.files.map((f) => ({
            name: f.name,
            mime: f.mime,
            size: f.size,
            bytes: createHash("sha256")
              .update(readFileSync(join(dataDir, "files", f.id)))
              .digest("hex"),
          })),
        })),
      };
    });
    return {
      name: store.settings.get("workspaceName"),
      people: people.map((u) => ({
        handle: u.handle,
        displayName: u.displayName,
        role: u.role,
        deactivated: u.deactivated,
        isBot: u.isBot,
        timeZone: u.timeZone ?? null,
      })),
      conversations: conversations.sort((a, b) => (a.key < b.key ? -1 : 1)),
    };
  } finally {
    db.close();
  }
}

describe("exporting a workspace", () => {
  it("writes what an import brings back the same: people, conversations, history and files", async () => {
    const zip = join(root, "ownbase.zip");
    const written = await exportWorkspace({ dataDir: first, to: zip, everything: true });
    expect(written).toMatchObject({
      people: 5,
      channels: 3,
      directMessages: 2,
      messages: 13,
      files: 1,
    });

    const second = join(root, "second");
    const result = await importSlack({
      from: zip,
      dataDir: second,
      owner: "alice",
      workspaceName: "Acme",
    });
    expect(result.counts).toMatchObject({
      messages: 13,
      replies: 3,
      reactions: 3,
      pins: 2,
      files: 1,
    });
    expect(result.skipped).toEqual([]);

    const before = contents(first);
    const after = contents(second);
    // Not a comparison of two empty things.
    expect(before.conversations.flatMap((c) => c.messages)).toHaveLength(13);
    expect(before.conversations.flatMap((c) => c.messages).filter((m) => m.thread)).toHaveLength(3);
    expect(after).toEqual(before);
  });

  it("holds public channels only, unless asked for everything", async () => {
    const zip = join(root, "public.zip");
    const written = await exportWorkspace({ dataDir: first, to: zip });
    expect(written).toMatchObject({ channels: 2, directMessages: 0 });
    expect(written.skipped).toEqual([
      {
        reason: "private channels and direct messages (export with --everything to include them)",
        count: 3,
      },
    ]);
    const names = (await readZipEntries(zip)).map((e) => e.name);
    expect(names).toContain("users.json");
    expect(names).toContain("channels.json");
    expect(names.filter((n) => /^(groups|dms|mpims)\.json$/.test(n))).toEqual([]);
    expect(
      names
        .filter((n) => n.endsWith(".json"))
        .map((n) => n.split("/")[0])
        .sort(),
    ).toEqual(["channels.json", "general", "general", "random", "users.json"]);
  });

  it("never writes a password, a session or a key", async () => {
    const zip = join(root, "everything.zip");
    await exportWorkspace({ dataDir: first, to: zip, everything: true });
    const db = new DatabaseSync(join(first, "workspace.db"));
    const secrets = (
      db.prepare("SELECT password_hash, salt FROM users").all() as Record<string, string>[]
    ).flatMap((row) => Object.values(row));
    db.close();
    expect(secrets.length).toBeGreaterThan(0);
    const json = await Promise.all(
      (await readZipEntries(zip))
        .filter((e) => e.name.endsWith(".json"))
        .map(async (e) => (await readZipEntry(zip, e)).toString("utf8")),
    );
    for (const secret of secrets) for (const text of json) expect(text).not.toContain(secret);
    const users = JSON.parse(json.find((t) => t.includes('"real_name"'))!) as Record<
      string,
      unknown
    >[];
    // Every field any person has: nothing beyond what a profile shows.
    expect([...new Set(users.flatMap((u) => Object.keys(u)))].sort()).toEqual(
      [
        "deleted",
        "id",
        "is_admin",
        "is_bot",
        "is_owner",
        "is_primary_owner",
        "is_restricted",
        "name",
        "profile",
        "real_name",
        "tz",
      ].sort(),
    );
  });

  it("will not write over a file, and leaves nothing behind when it stops", async () => {
    const zip = join(root, "taken.zip");
    writeFileSync(zip, "mine");
    await expect(exportWorkspace({ dataDir: first, to: zip })).rejects.toThrow(/already exists/);
    expect(readFileSync(zip, "utf8")).toBe("mine");
    await expect(
      exportWorkspace({ dataDir: join(root, "nowhere"), to: join(root, "x.zip") }),
    ).rejects.toThrow(/No workspace found/);
    expect(readdirSync(root).sort()).toEqual(["first", "slack.zip", "taken.zip"]);
  });
});
