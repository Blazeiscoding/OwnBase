import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  openDb,
  openDbAtVersion,
  SCHEMA_VERSION,
  UPGRADE_BACKUP_DIR,
  UPGRADE_BACKUPS_KEPT,
} from "../src/db.js";
import { createWorkspaceServer } from "../src/server.js";

let dir: string;
let file: string;
const copiesDir = () => join(dir, UPGRADE_BACKUP_DIR);
const copies = () => (existsSync(copiesDir()) ? readdirSync(copiesDir()).sort() : []);

const versionOf = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
};

/** A workspace as an older release left it, holding something worth keeping. */
function olderWorkspace(version = SCHEMA_VERSION - 2) {
  const db = openDbAtVersion(file, version);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    "workspace_name",
    "Before the upgrade",
  );
  db.close();
  return version;
}

function setWorkspaceId(path: string, id: string) {
  const db = new DatabaseSync(path);
  try {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('workspace_id', ?)").run(id);
  } finally {
    db.close();
  }
}

/** A real copy an earlier upgrade could have left, from schema `from`, stamped `taken`. */
function earlierCopy(from: number, taken: string, workspaceId?: string): string {
  mkdirSync(copiesDir(), { recursive: true });
  const name = `workspace-v${from}-before-v${from + 1}-${taken}.db`;
  openDbAtVersion(join(copiesDir(), name), from).close();
  if (workspaceId) setWorkspaceId(join(copiesDir(), name), workspaceId);
  return name;
}

/**
 * Zeroes the page holding the messages table's root, as a failing disk might,
 * leaving the header and schema pages whole: the copy still reads as the right
 * schema of the right workspace, but its history is gone.
 */
function corruptHistory(path: string) {
  const db = new DatabaseSync(path);
  const { rootpage } = db
    .prepare("SELECT rootpage FROM sqlite_schema WHERE type = 'table' AND name = 'messages'")
    .get() as { rootpage: number };
  const { page_size } = db.prepare("PRAGMA page_size").get() as { page_size: number };
  db.close();
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, Buffer.alloc(page_size), 0, page_size, (rootpage - 1) * page_size);
  } finally {
    closeSync(fd);
  }
  const check = new DatabaseSync(path, { readOnly: true });
  try {
    expect(versionOf(path)).toBeGreaterThan(0);
    expect(() => check.prepare("SELECT * FROM messages NOT INDEXED").all()).toThrow(/malformed/);
  } finally {
    check.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ownbase-upgrade-"));
  file = join(dir, "workspace.db");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("upgrading a workspace", () => {
  it("copies it first, as it was, and then upgrades it", async () => {
    const from = olderWorkspace();
    let reported = "";
    const db = openDb(file, undefined, { onUpgradeBackup: (path) => (reported = path) });
    db.close();

    expect(versionOf(file)).toBe(SCHEMA_VERSION);
    expect(copies()).toHaveLength(1);
    expect(reported).toBe(join(copiesDir(), copies()[0]!));
    // What rolling back needs: the old schema, and the data that was in it.
    expect(versionOf(reported)).toBe(from);
    const copy = new DatabaseSync(reported, { readOnly: true });
    try {
      expect(
        copy.prepare("SELECT value FROM meta WHERE key = 'workspace_name'").get(),
      ).toMatchObject({ value: "Before the upgrade" });
    } finally {
      copy.close();
    }
  });

  it("takes no copy of a workspace that is new, or already current", () => {
    openDb(file).close();
    expect(copies()).toEqual([]);
    openDb(file).close();
    expect(copies()).toEqual([]);
  });

  it("keeps only the most recent copies", () => {
    for (let day = 1; day <= UPGRADE_BACKUPS_KEPT + 1; day++) {
      earlierCopy(day, `2020-01-0${day}T00-00-00-000Z`);
    }
    // Something else a person put in there is theirs, not ours to delete.
    writeFileSync(join(copiesDir(), "my-own-backup.db"), "");
    olderWorkspace();
    openDb(file).close();

    const kept = copies().filter((name) => name.startsWith("workspace-"));
    expect(kept).toHaveLength(UPGRADE_BACKUPS_KEPT);
    // The one just taken survives; the oldest ones are what go.
    expect(kept.some((name) => name.includes(`before-v${SCHEMA_VERSION}-`))).toBe(true);
    expect(kept.some((name) => name.includes("2020-01-01"))).toBe(false);
    expect(kept.some((name) => name.includes("2020-01-02"))).toBe(false);
    expect(copies()).toContain("my-own-backup.db");
  });

  it("keeps the copy it has just taken when the clock was set back", () => {
    const from = olderWorkspace();
    // Taken from the same schema, by a clock that said 2040. By the time in
    // their names each is newer than the copy about to be taken.
    for (const month of ["01", "02", "03"]) {
      earlierCopy(from, `2040-${month}-01T00-00-00-000Z`);
    }
    let reported = "";
    openDb(file, undefined, { onUpgradeBackup: (path) => (reported = path) }).close();

    expect(existsSync(reported)).toBe(true);
    expect(versionOf(reported)).toBe(from);
    const kept = copies().filter((name) => name.startsWith("workspace-"));
    expect(kept).toHaveLength(UPGRADE_BACKUPS_KEPT);
    expect(kept).toContain(basename(reported));
    // Among the rest, the time in the name decides, since the schema cannot.
    expect(kept.some((name) => name.includes("2040-01-01"))).toBe(false);
  });

  it("orders copies by the schema they hold before the time in their names", () => {
    const from = olderWorkspace();
    // The oldest schema carries the latest time: a clock that ran ahead.
    earlierCopy(from - 3, "2040-01-01T00-00-00-000Z");
    earlierCopy(from - 2, "2020-01-01T00-00-00-000Z");
    earlierCopy(from - 1, "2020-01-02T00-00-00-000Z");
    openDb(file).close();

    const kept = copies();
    expect(kept).toHaveLength(UPGRADE_BACKUPS_KEPT);
    expect(kept.some((name) => name.startsWith(`workspace-v${from - 3}-`))).toBe(false);
    expect(kept.some((name) => name.startsWith(`workspace-v${from - 1}-`))).toBe(true);
    expect(kept.some((name) => name.startsWith(`workspace-v${from - 2}-`))).toBe(true);
  });

  it("does not let a copy that cannot be restored push out one that can", () => {
    const from = olderWorkspace();
    earlierCopy(from - 2, "2020-01-01T00-00-00-000Z");
    earlierCopy(from - 1, "2020-01-02T00-00-00-000Z");
    // Named as ours, but empty, and a copy whose schema is not the one its
    // name says. Neither is a way back; both are left for a person to see.
    const empty = `workspace-v${from}-before-v${from + 1}-2030-01-01T00-00-00-000Z.db`;
    writeFileSync(join(copiesDir(), empty), "");
    const mislabelled = `workspace-v${from}-before-v${from + 1}-2030-01-02T00-00-00-000Z.db`;
    openDbAtVersion(join(copiesDir(), mislabelled), from - 3).close();
    openDb(file).close();

    const kept = copies();
    expect(kept).toContain(empty);
    expect(kept).toContain(mislabelled);
    expect(kept.some((name) => name.startsWith(`workspace-v${from - 1}-`))).toBe(true);
    expect(kept.some((name) => name.startsWith(`workspace-v${from - 2}-`))).toBe(true);
  });

  it("does not let copies whose history is corrupt push out one that is whole", () => {
    const from = olderWorkspace();
    setWorkspaceId(file, "this-workspace");
    const whole = earlierCopy(from - 1, "2020-01-01T00-00-00-000Z", "this-workspace");
    // Newer by schema, and this workspace by their metadata, so they would
    // have been the ones kept.
    const brokenA = earlierCopy(from, "2020-01-02T00-00-00-000Z", "this-workspace");
    const brokenB = earlierCopy(from, "2020-01-03T00-00-00-000Z", "this-workspace");
    corruptHistory(join(copiesDir(), brokenA));
    corruptHistory(join(copiesDir(), brokenB));
    openDb(file).close();

    const kept = copies();
    expect(kept).toContain(whole);
    // Left where they are for a person to look at, not counted.
    expect(kept).toContain(brokenA);
    expect(kept).toContain(brokenB);
    // And the copy this upgrade took.
    expect(
      kept.filter((name) => !name.startsWith("workspace-v") || !name.includes("2020-")),
    ).toHaveLength(1);
  });

  it("leaves another workspace's copies alone and does not count them", () => {
    const from = olderWorkspace();
    setWorkspaceId(file, "this-workspace");
    earlierCopy(from - 1, "2020-01-01T00-00-00-000Z", "this-workspace");
    earlierCopy(from - 1, "2020-01-02T00-00-00-000Z", "this-workspace");
    const foreign = earlierCopy(from, "2020-01-03T00-00-00-000Z", "another-workspace");
    openDb(file).close();

    const kept = copies();
    expect(kept).toContain(foreign);
    expect(kept.filter((name) => name.includes("2020-01-0"))).toHaveLength(3);
  });

  it("refuses to upgrade when the copy cannot be made, and changes nothing", () => {
    const from = olderWorkspace();
    // A file where the directory should go: the copy has nowhere to be written.
    writeFileSync(copiesDir(), "in the way");

    expect(() => openDb(file)).toThrow(/has not been upgraded and nothing has changed/);
    expect(versionOf(file)).toBe(from);
    // And nothing is left holding the file, which on Windows would stop the
    // host from moving the workspace aside to deal with it.
    renameSync(file, `${file}.moved`);
    expect(existsSync(`${file}.moved`)).toBe(true);
  });

  it("keeps no step of an upgrade that fails partway, so the release it came from still opens it", () => {
    // From v30, four steps: v31 adds message_mentions, v32
    // purged_message_requests, v33 thread_follows.unread_hold, and v34 an index
    // named idx_channel_managers, which something already called that stops.
    const from = olderWorkspace(30);
    const db = new DatabaseSync(file);
    db.exec("CREATE INDEX idx_channel_managers ON users(handle)");
    db.close();

    expect(() => openDb(file)).toThrow(/idx_channel_managers already exists/);
    expect(versionOf(file)).toBe(from);
    const left = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = (
        left.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((t) => t.name);
      expect(tables).not.toContain("message_mentions");
      expect(tables).not.toContain("purged_message_requests");
      const follows = (
        left.prepare("PRAGMA table_info(thread_follows)").all() as { name: string }[]
      ).map((c) => c.name);
      expect(follows).not.toContain("unread_hold");
      expect(left.prepare("SELECT value FROM meta WHERE key = 'workspace_name'").get()).toEqual({
        value: "Before the upgrade",
      });
    } finally {
      left.close();
    }
    // Nothing holds the file for whoever moves it aside.
    renameSync(file, `${file}.moved`);
    renameSync(`${file}.moved`, file);

    // With what stopped it gone, the next start upgrades it whole.
    const fix = new DatabaseSync(file);
    fix.exec("DROP INDEX idx_channel_managers");
    fix.close();
    openDb(file).close();
    expect(versionOf(file)).toBe(SCHEMA_VERSION);
  });

  it("can be told not to, by someone who has just taken their own backup", () => {
    olderWorkspace();
    openDb(file, undefined, { backupBeforeUpgrade: false }).close();
    expect(versionOf(file)).toBe(SCHEMA_VERSION);
    expect(copies()).toEqual([]);
  });

  it("says where the copy went when a server upgrades on start", async () => {
    olderWorkspace();
    const server = await createWorkspaceServer({
      dataDir: dir,
      host: "127.0.0.1",
      port: 0,
      mdns: false,
      logger: false,
    });
    try {
      expect(server.upgradeBackup).not.toBeNull();
      expect(existsSync(server.upgradeBackup!)).toBe(true);
    } finally {
      await server.stop();
    }
    const again = await createWorkspaceServer({
      dataDir: dir,
      host: "127.0.0.1",
      port: 0,
      mdns: false,
      logger: false,
    });
    try {
      expect(again.upgradeBackup).toBeNull();
    } finally {
      await again.stop();
    }
  });
});
