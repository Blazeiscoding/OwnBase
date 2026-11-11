import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ICON_META_KEYS, type WorkspaceIcon } from "../admin/workspaceIcon.js";
import { holdWorkspace } from "./ownership.js";
import { Settings, type MetaRows } from "./settings.js";

/** The file in a workspace's folder that holds everything but its attachments. */
export const WORKSPACE_DATABASE = "workspace.db";

export function workspaceDatabase(dataDir: string): string {
  return join(dataDir, WORKSPACE_DATABASE);
}

/** A database's `meta` rows, read and written directly, with no store around them. */
export function metaRows(db: DatabaseSync): MetaRows {
  return {
    getMeta: (key) =>
      (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)
        ?.value ?? null,
    setMeta: (key, value) => {
      db.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(key, value);
    },
    deleteMeta: (key) => {
      db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    },
    listMeta: (prefix) =>
      db
        .prepare("SELECT key, value FROM meta WHERE substr(key, 1, ?) = ? ORDER BY key")
        .all(prefix.length, prefix) as { key: string; value: string }[],
  };
}

/**
 * Reads a workspace's settings from its database without a server, read
 * only: nothing is started, upgraded or changed. Null when there is no
 * database there or it cannot be read.
 */
function readStopped<T>(
  dataDir: string,
  read: (settings: Settings, rows: MetaRows) => T,
): T | null {
  const file = workspaceDatabase(dataDir);
  if (!existsSync(file)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = metaRows(db);
    return read(new Settings(rows), rows);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** The identity and name a stopped workspace's database holds. */
export function readStoppedWorkspace(
  dataDir: string,
): { id: string | null; name: string | null } | null {
  return readStopped(dataDir, (settings) => ({
    id: settings.stored("workspaceId"),
    name: settings.stored("workspaceName"),
  }));
}

/** The icon a stopped workspace's database holds, or null when it has no whole one. */
export function readStoppedIcon(dataDir: string): WorkspaceIcon | null {
  return readStopped(dataDir, (settings) => settings.stored("icon"));
}

/** Its icon's version alone, without reading the picture. */
export function readStoppedIconVersion(dataDir: string): string | null {
  return readStopped(dataDir, (_settings, rows) => rows.getMeta(ICON_META_KEYS.version));
}

/**
 * Writes a new name into a stopped workspace's database, the one place its
 * name is kept. Nothing else in the database changes, and no schema upgrade
 * runs. Throws when there is no database there or it cannot be written.
 */
export function renameStoppedWorkspace(dataDir: string, name: string): void {
  const file = workspaceDatabase(dataDir);
  // Opening a file that is not there would create an empty database.
  if (!existsSync(file)) throw new Error("There is no workspace database in that folder.");
  // A server started by hand on the same folder would go on under the old name
  // and could write it back, so the rename is refused while one has it.
  const hold = holdWorkspace(dataDir, "a rename");
  try {
    const db = new DatabaseSync(file);
    try {
      // A backup reading the file gets a moment to finish rather than failing
      // the rename at once.
      db.exec("PRAGMA busy_timeout = 2000");
      new Settings(metaRows(db)).set("workspaceName", name);
    } finally {
      db.close();
    }
  } finally {
    hold.release();
  }
}
