import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { holdWorkspace } from "../src/core/ownership.js";
import { importSlack, type SlackImportOptions } from "../src/import/slackImport.js";
import { OutboundError } from "../src/outbound.js";
import { createWorkspaceServer } from "../src/server.js";
import { Store } from "../src/store.js";
import { slackExport, TS, writeZip } from "./slackFixture.js";

let root: string;
let zip: string;
let dataDir: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ownbase-slack-import-"));
  zip = join(root, "export.zip");
  dataDir = join(root, "workspace");
  await writeZip(zip, slackExport());
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const run = (extra: Partial<SlackImportOptions> = {}) =>
  importSlack({ from: zip, dataDir, owner: "alice", workspaceName: "Acme", ...extra });

/** The imported workspace, read as the server reads it. */
function open() {
  const db = new DatabaseSync(join(dataDir, "workspace.db"));
  return { db, store: new Store(db) };
}

const ms = (ts: string) => {
  const [s, f] = ts.split(".");
  return Number(s) * 1000 + Math.floor(Number(f) / 1000);
};

describe("importing a Slack export", () => {
  it("brings people in deactivated, with the owner able to sign in", async () => {
    const result = await run();
    expect(result.workspaceName).toBe("Acme");
    expect(result.owner.handle).toBe("alice");
    expect(result.counts.people).toBe(3);
    const { db, store } = open();
    try {
      const byHandle = Object.fromEntries(store.people.list().map((u) => [u.handle, u]));
      expect(byHandle.alice).toMatchObject({
        role: "owner",
        deactivated: false,
        displayName: "Alice",
        timeZone: "Europe/London",
      });
      expect(store.accounts.mustChangePassword(byHandle.alice!.id)).toBe(true);
      // An empty display name falls back to the real one; a zone that is not one is left out.
      expect(byHandle.bob).toMatchObject({
        role: "member",
        deactivated: true,
        displayName: "Bob Brown",
      });
      expect(byHandle.bob!.timeZone).toBeUndefined();
      expect(byHandle.carol).toMatchObject({ deactivated: true, displayName: "Carol Clark" });
      expect(byHandle.deploybot).toMatchObject({ isBot: true, displayName: "Deploys" });
      // Bots post under one account per name.
      expect(
        store.people
          .list()
          .filter((u) => u.isBot)
          .map((u) => u.displayName)
          .sort(),
      ).toEqual(["Deploy Bot", "Deploys"]);
      expect(store.settings.get("workspaceName")).toBe("Acme");
    } finally {
      db.close();
    }

    const server = await createWorkspaceServer({
      dataDir,
      host: "127.0.0.1",
      port: 0,
      mdns: false,
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const login = async (handle: string, password: string) =>
        fetch(`${base}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ handle, password }),
        });
      const owner = await login("alice", result.owner.temporaryPassword);
      expect(owner.status).toBe(200);
      expect(((await owner.json()) as { mustChangePassword: boolean }).mustChangePassword).toBe(
        true,
      );
      // Nobody else has a password anyone knows, and each is deactivated besides.
      expect((await login("bob", result.owner.temporaryPassword)).status).not.toBe(200);
      // An owner exists, so the workspace asks for no claim code.
      expect(server.claimCode).toBeFalsy();
    } finally {
      await server.stop();
    }
  });

  it("makes each conversation the export lists, with its members, topic and state", async () => {
    const result = await run();
    expect(result.counts).toMatchObject({ channels: 3, directMessages: 2 });
    const { db, store } = open();
    try {
      const people = Object.fromEntries(store.people.list().map((u) => [u.handle, u.id]));
      const all = db.prepare("SELECT id FROM channels").all() as { id: string }[];
      const channels = all.map(({ id }) => store.channels.get(id)!);
      const byName = (name: string) => channels.find((c) => c.name === name)!;
      expect(byName("general")).toMatchObject({
        type: "public",
        topic: `Say hi to <@${people.bob}>`,
        description: "Everything & anything",
        archived: false,
      });
      expect(byName("random")).toMatchObject({ type: "public", archived: true });
      expect(byName("secret").type).toBe("private");
      expect(store.channels.memberIds(byName("secret").id).sort()).toEqual(
        [people.alice, people.bob].sort(),
      );
      const dm = channels.find((c) => c.type === "dm")!;
      expect(store.channels.memberIds(dm.id).sort()).toEqual([people.alice, people.bob].sort());
      // As the app makes them, so opening a conversation with Bob finds this one.
      expect(store.channels.findDmByKey([people.alice, people.bob].sort().join(":"))?.id).toBe(
        dm.id,
      );
      const group = channels.find((c) => c.type === "group_dm")!;
      expect(store.channels.memberIds(group.id)).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it("writes history with its times, threads, edits, reactions, pins and mentions", async () => {
    const result = await run();
    const { db, store } = open();
    try {
      const people = Object.fromEntries(store.people.list().map((u) => [u.handle, u.id]));
      const general = store.channels.byName("general")!;
      const random = store.channels.byName("random")!;
      const timeline = store.messages.list({ channelId: general.id, limit: 50 }).reverse();
      expect(timeline.map((m) => m.text)).toEqual([
        `Hello <@${people.bob}> and @ghost, see <#${random.id}> & <b> <https://example.com|a link>`,
        "Also to the channel",
        "File: report.txt",
        "Deployed v1",
        "First in the millisecond",
        "Second in the millisecond",
        "Pinned rule",
      ]);
      const [root, broadcast, file, bot, first, second, pinned] = timeline;
      expect(root).toMatchObject({
        userId: people.alice,
        createdAt: ms(TS.root),
        editedAt: ms(TS.edited),
        replyCount: 3,
        pinned: true,
      });
      // Ids are made from the time, so history pages in the order it happened.
      expect(timeline.map((m) => m.id)).toEqual(timeline.map((m) => m.id).sort());
      expect(first!.createdAt).toBe(second!.createdAt);
      expect(first!.id < second!.id).toBe(true);
      expect(root!.reactions).toEqual([
        { emoji: "👍", userIds: [people.bob, people.carol] },
        { emoji: "👋🏼", userIds: [people.alice] },
      ]);
      expect(broadcast).toMatchObject({
        threadRootId: root!.id,
        broadcast: true,
        userId: people.carol,
      });
      expect(file!.userId).toBe(people.bob);
      expect(store.people.get(bot!.userId)).toMatchObject({
        isBot: true,
        displayName: "Deploy Bot",
      });
      expect(pinned!.pinned).toBe(true);

      const replies = store.messages
        .list({ channelId: general.id, threadRootId: root!.id, limit: 10 })
        .map((m) => m.text)
        .reverse();
      expect(replies).toEqual(["Reply one", "Also to the channel", "Late reply"]);

      // Every message has a seq from the event log, and the channel's newest is its badge's.
      const seqs = db.prepare("SELECT seq FROM messages").all() as { seq: number }[];
      expect(seqs.every((r) => r.seq > 0)).toBe(true);
      expect(store.channels.lastMessageSeq(general.id)).toBe(
        Math.max(...timeline.map((m) => m.seq)),
      );

      // Search finds imported words, through the index posted messages fill.
      const hits = db
        .prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'private'")
        .get() as { n: number };
      expect(hits.n).toBe(1);

      expect(result.counts).toMatchObject({ messages: 13, replies: 3, reactions: 3, pins: 2 });
      const skipped = Object.fromEntries(result.skipped.map((s) => [s.reason, s.count]));
      expect(skipped["join and leave notices"]).toBe(1);
      expect(skipped["reactions with a custom emoji"]).toBe(1);
      expect(skipped["files Slack had deleted or hidden"]).toBe(1);
      expect(
        skipped["files left as their names (run again with --fetch-files to bring them)"],
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it("leaves imported history read, for everyone in it", async () => {
    await run();
    const { db, store } = open();
    try {
      for (const user of store.people.list().filter((u) => !u.isBot)) {
        expect(store.channels.unreadSummary(user.id), user.handle).toEqual({
          mentions: 0,
          unread: false,
        });
        expect(store.threads.unreadCount(user.id), user.handle).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  it("fetches files with --fetch-files, and keeps the name of one Slack will not give", async () => {
    const asked: string[] = [];
    const result = await run({
      fetchFiles: true,
      fetchFile: async (url) => {
        asked.push(url);
        return Buffer.from("hello world");
      },
    });
    expect(asked).toEqual([
      "https://files.slack.com/files-pri/T1-F1/download/report.txt?t=xoxe-test",
    ]);
    expect(result.counts.files).toBe(1);
    const { db, store } = open();
    try {
      const general = store.channels.byName("general")!;
      const message = store.messages
        .list({ channelId: general.id, limit: 50 })
        .find((m) => m.files.length)!;
      expect(message.text).toBe("");
      expect(message.files[0]).toMatchObject({ name: "report.txt", mime: "text/plain", size: 11 });
      expect(readFileSync(join(dataDir, "files", message.files[0]!.id), "utf8")).toBe(
        "hello world",
      );
    } finally {
      db.close();
    }

    rmSync(dataDir, { recursive: true });
    const late = await run({
      fetchFiles: true,
      fetchFile: async () => {
        throw new OutboundError("timeout", "the endpoint did not answer in time");
      },
    });
    expect(late.counts.files).toBe(0);
    expect(late.skipped).toContainEqual({
      reason: "files Slack would not hand over (the endpoint did not answer in time)",
      count: 1,
    });
    const again = open();
    try {
      const general = again.store.channels.byName("general")!;
      const texts = again.store.messages
        .list({ channelId: general.id, limit: 50 })
        .map((m) => m.text);
      expect(texts).toContain("File: report.txt");
    } finally {
      again.db.close();
    }
  });
});

describe("an import refuses", () => {
  const refusal = async (extra: Partial<SlackImportOptions> = {}) => {
    const err = await run(extra).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err, "the import went through").not.toBeNull();
    return err!.message;
  };

  it("a folder that is not empty, and changes nothing there", async () => {
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, "notes.txt"), "mine");
    expect(await refusal()).toMatch(/is not empty/);
    expect(readdirSync(dataDir)).toEqual(["notes.txt"]);
  });

  it("a folder that holds a workspace", async () => {
    await run();
    expect(await refusal()).toMatch(/already holds a workspace/);
  });

  it("a folder something else has open", async () => {
    mkdirSync(dataDir);
    const hold = holdWorkspace(dataDir, "a server");
    try {
      expect(await refusal()).toMatch(/already open in another process/);
    } finally {
      hold.release();
    }
  });

  it("a zip past the size it reads, and leaves no folder behind", async () => {
    expect(await refusal({ limits: { zipBytes: 1000 } })).toMatch(
      /more than the 0 MB an import reads/,
    );
    expect(existsSync(dataDir)).toBe(false);
  });

  it("a zip with more files than it reads", async () => {
    expect(await refusal({ limits: { entries: 3 } })).toMatch(/holds 11 files, more than the 3/);
  });

  it("a file past the size it reads in one", async () => {
    expect(await refusal({ limits: { jsonBytes: 200 } })).toMatch(/^users\.json is .* unpacked/);
  });

  it("JSON in another shape, naming the file and the field", async () => {
    const files = slackExport();
    (files["users.json"] as { id?: string }[])[1]!.id = undefined;
    await writeZip(zip, files);
    expect(await refusal()).toMatch(/^users\.json, entry 2, id: /);
    expect(existsSync(dataDir)).toBe(false);
  });

  it("a time that is not a number, after starting, and removes what it made", async () => {
    const files = slackExport();
    (files["random/2024-01-01.json"] as { ts: string }[])[0]!.ts = "noon";
    await writeZip(zip, files);
    expect(await refusal()).toBe('random/2024-01-01.json, entry 1, ts: "noon" is not a Slack time');
    expect(existsSync(dataDir)).toBe(false);
  });

  it("a file that is not JSON", async () => {
    await writeZip(zip, { ...slackExport(), "channels.json": Buffer.from("{ nope") });
    expect(await refusal()).toBe("channels.json is not JSON.");
  });

  it("a zip that is not a Slack export", async () => {
    await writeZip(zip, { "readme.txt": Buffer.from("hi") });
    expect(await refusal()).toMatch(/no users\.json, so it is not a Slack export/);
  });

  it("an owner the export does not list", async () => {
    expect(await refusal({ owner: "zed" })).toMatch(/Nobody in users\.json has the username "zed"/);
  });
});
