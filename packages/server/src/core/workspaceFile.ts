import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { MetaRows } from "./settings.js";

/**
 * The workspace's database file and its `meta` rows, with nothing but Node
 * behind them: a backup job loads this, and stays clear of the server's graph.
 */

/** The file in a workspace's folder that holds everything but its attachments. */
export const WORKSPACE_DATABASE = "workspace.db";

export function workspaceDatabase(dataDir: string): string {
  return join(dataDir, WORKSPACE_DATABASE);
}

/** The `meta` row the workspace's name is kept in (`SETTINGS.workspaceName`). */
export const WORKSPACE_NAME_ROW = "workspace_name";

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
