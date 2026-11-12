import {
  createWriteStream,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { fileCrc32, zipArchive, type ZipSource } from "../backups/zip.js";
import { shape } from "../core/rows.js";
import { WORKSPACE_DATABASE } from "../core/workspaceFile.js";
import { SCHEMA_VERSION } from "../db.js";
import { slackNameForEmoji } from "./slackEmoji.js";
import { slackTimeOf } from "./slackFormat.js";
import { toSlackText } from "./slackText.js";

export interface WorkspaceExportOptions {
  dataDir: string;
  /** The zip to write. It must not exist yet. */
  to: string;
  /**
   * Private channels and direct messages too. Only from the command line:
   * whoever is at the server's keyboard can read the database anyway.
   */
  everything?: boolean;
  log?: (line: string) => void;
}

export interface WorkspaceExportResult {
  people: number;
  channels: number;
  directMessages: number;
  messages: number;
  files: number;
  bytes: number;
  skipped: { reason: string; count: number }[];
}

const userRow = shape({
  id: "text",
  handle: "text",
  display_name: "text",
  role: "text",
  is_bot: "number",
  deactivated: "number",
  time_zone: "text?",
});
const channelRow = shape({
  id: "text",
  type: "text",
  name: "text",
  topic: "text",
  description: "text",
  creator_id: "text",
  archived: "number",
  created_at: "number",
});
const messageRow = shape({
  id: "text",
  user_id: "text",
  text: "text",
  thread_root_id: "text?",
  broadcast: "number",
  created_at: "number",
  edited_at: "number?",
});
const reactionRow = shape({ message_id: "text", emoji: "text", user_id: "text" });
const fileRow = shape({
  id: "text",
  message_id: "text",
  name: "text",
  mime: "text",
  size: "number",
});
const pinRow = shape({ message_id: "text", user_id: "text", created_at: "number" });
const countRow = shape({ id: "text", n: "number" });
const memberRow = shape({ user_id: "text" });

/** Messages read at a time. */
const PAGE = 2000;

/** A name a zip entry, and the folder it unpacks to on any system, can have as it is. */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

const seconds = (ms: number) => Math.floor(ms / 1000);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Writes a workspace out as Slack writes its export, so the tools that read
 * Slack's read this, and an import here reads it back: users.json,
 * channels.json, groups.json, dms.json and mpims.json, and a folder of day
 * files for each conversation. Unlike Slack's, the zip holds the files
 * themselves, under `files/`, each message naming its own (`export_path`).
 *
 * No password, session, token or app secret is written, ever: users.json has
 * what a member's profile shows. Deleted messages are left out.
 *
 * Reads the database in one read transaction, so a server can go on running
 * while it is taken and the export is one moment of it. Day files are written
 * to a folder beside the zip first, then streamed into it with the files, so
 * a large workspace does not sit in memory.
 */
export async function exportWorkspace(
  opts: WorkspaceExportOptions,
): Promise<WorkspaceExportResult> {
  const dataDir = resolve(opts.dataDir);
  const to = resolve(opts.to);
  const log = opts.log ?? (() => {});
  const database = join(dataDir, WORKSPACE_DATABASE);
  if (!existsSync(database))
    throw new Error(
      `No workspace found at ${dataDir}. Check that --data points at the data directory.`,
    );
  if (existsSync(to)) throw new Error(`${to} already exists. Choose a new name for the export.`);

  const db = new DatabaseSync(database, { readOnly: true });
  const staging = mkdtempSync(join(dirname(to), `.${basename(to)}-`));
  const partial = `${to}.partial`;
  try {
    const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (user_version < SCHEMA_VERSION)
      throw new Error(
        "This workspace was last opened by an older version of OwnBase. Start it with this version once, then export.",
      );
    if (user_version > SCHEMA_VERSION)
      throw new Error(
        "A newer version of OwnBase made this workspace. Update OwnBase, then export.",
      );
    db.exec("BEGIN");
    const written = await new Exporter(db, dataDir, staging, opts.everything === true, log).run();
    db.exec("COMMIT");

    const entries: ZipSource[] = [];
    for (const name of written.json) {
      const path = join(staging, name);
      entries.push({ name, ...(await fileCrc32(path)), open: () => createReadStream(path) });
    }
    for (const file of written.files) {
      const path = join(dataDir, "files", file.id);
      const checked = await fileCrc32(path);
      entries.push({ name: file.path, ...checked, open: () => createReadStream(path) });
    }
    const archive = zipArchive(entries, Date.now());
    await pipeline(archive.open(), createWriteStream(partial, { flags: "wx" }));
    renameSync(partial, to);
    return { ...written.result, bytes: statSync(to).size };
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
    rmSync(staging, { recursive: true, force: true });
  }
}

class Exporter {
  private readonly json: string[] = [];
  private readonly files: { id: string; path: string }[] = [];
  private readonly skipped = new Map<string, number>();
  private readonly result: Omit<WorkspaceExportResult, "bytes" | "skipped"> = {
    people: 0,
    channels: 0,
    directMessages: 0,
    messages: 0,
    files: 0,
  };
  private handles = new Map<string, string>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly dataDir: string,
    private readonly staging: string,
    private readonly everything: boolean,
    private readonly log: (line: string) => void,
  ) {}

  private skip(reason: string, count = 1): void {
    if (count > 0) this.skipped.set(reason, (this.skipped.get(reason) ?? 0) + count);
  }

  private async write(name: string, value: unknown): Promise<void> {
    const path = join(this.staging, name);
    mkdirSync(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 1));
    this.json.push(name);
  }

  async run() {
    const users = userRow.all(
      this.db.prepare(
        "SELECT id, handle, display_name, role, is_bot, deactivated, time_zone FROM users ORDER BY created_at, id",
      ),
    );
    for (const user of users) this.handles.set(user.id, user.handle);
    await this.write(
      "users.json",
      users.map((u) => ({
        id: u.id,
        name: u.handle,
        deleted: u.deactivated === 1,
        real_name: u.display_name,
        is_bot: u.is_bot === 1,
        is_admin: u.role === "owner" || u.role === "admin",
        is_owner: u.role === "owner",
        is_primary_owner: u.role === "owner",
        // A guest here reads public channels only, as Slack's single-channel guests read theirs.
        is_restricted: u.role === "guest",
        ...(u.time_zone ? { tz: u.time_zone } : {}),
        profile: { display_name: u.display_name, real_name: u.display_name },
      })),
    );
    this.result.people = users.length;

    const channels = channelRow.all(
      this.db.prepare(
        `SELECT id, type, name, topic, description, creator_id, archived, created_at FROM channels
         ${this.everything ? "" : "WHERE type = 'public'"} ORDER BY created_at, id`,
      ),
    );
    if (!this.everything) {
      const left = this.db
        .prepare("SELECT COUNT(*) AS n FROM channels WHERE type != 'public'")
        .get() as { n: number };
      this.skip(
        "private channels and direct messages (export with --everything to include them)",
        left.n,
      );
    }
    const lists: Record<"channels" | "groups" | "dms" | "mpims", unknown[]> = {
      channels: [],
      groups: [],
      dms: [],
      mpims: [],
    };
    const folders = new Set<string>();
    for (const channel of channels) {
      const members = memberRow
        .all(
          this.db.prepare(
            "SELECT user_id FROM channel_members WHERE channel_id = ? ORDER BY joined_at",
          ),
          channel.id,
        )
        .map((m) => m.user_id);
      const direct = channel.type === "dm" || channel.type === "group_dm";
      // Slack names a direct message's folder after its id, a group's after
      // its name, and a channel's after its name. A name that could not be a
      // folder everywhere gives way to the id, which an import also looks for.
      const name =
        channel.type === "group_dm"
          ? `mpdm-${members.map((id) => this.handles.get(id) ?? id).join("--")}-1`
          : channel.name;
      const folder =
        channel.type !== "dm" && PLAIN_NAME.test(name) && !folders.has(name.toLowerCase())
          ? name
          : channel.id;
      folders.add(folder.toLowerCase());
      const pins = await this.writeMessages(channel.id, folder);
      const created = seconds(channel.created_at);
      if (channel.type === "dm") lists.dms.push({ id: channel.id, created, members });
      else
        (channel.type === "public"
          ? lists.channels
          : channel.type === "private"
            ? lists.groups
            : lists.mpims
        ).push({
          id: channel.id,
          name,
          created,
          creator: channel.creator_id,
          is_archived: channel.archived === 1,
          ...(channel.type === "public" ? { is_general: channel.name === "general" } : {}),
          members,
          topic: { value: toSlackText(channel.topic), creator: "", last_set: 0 },
          purpose: { value: toSlackText(channel.description), creator: "", last_set: 0 },
          ...(pins.length ? { pins } : {}),
        });
      if (direct) this.result.directMessages++;
      else this.result.channels++;
    }
    await this.write("channels.json", lists.channels);
    if (this.everything) {
      await this.write("groups.json", lists.groups);
      await this.write("dms.json", lists.dms);
      await this.write("mpims.json", lists.mpims);
    }
    return {
      json: this.json,
      files: this.files,
      result: {
        ...this.result,
        skipped: [...this.skipped]
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count),
      },
    };
  }

  /** Writes one conversation's day files; gives its pins, as channels.json lists them. */
  private async writeMessages(channelId: string, folder: string) {
    /** Each message's Slack time, for its replies and pins to name. */
    const times = new Map<string, string>();
    const authors = new Map<string, string>();
    const pins: { id: string; type: "C"; user: string; created: number }[] = [];
    let current: { day: string; messages: unknown[] } | null = null;
    let last = { ms: -1, within: 0 };
    let after = "";
    let count = 0;
    const flush = async () => {
      if (current?.messages.length)
        await this.write(`${folder}/${current.day}.json`, current.messages);
      current = null;
    };
    for (;;) {
      const rows = messageRow.all(
        this.db.prepare(
          `SELECT id, user_id, text, thread_root_id, broadcast, created_at, edited_at FROM messages
           WHERE channel_id = ? AND deleted_at IS NULL AND id > ? ORDER BY id LIMIT ?`,
        ),
        channelId,
        after,
        PAGE,
      );
      if (rows.length === 0) break;
      after = rows.at(-1)!.id;
      const ids = rows.map((r) => r.id);
      const marks = ids.map(() => "?").join(",");
      const reactions = group(
        reactionRow.all(
          this.db.prepare(
            `SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${marks}) ORDER BY created_at`,
          ),
          ...ids,
        ),
      );
      const files = group(
        fileRow.all(
          this.db.prepare(
            `SELECT id, message_id, name, mime, size FROM files WHERE message_id IN (${marks}) ORDER BY created_at, id`,
          ),
          ...ids,
        ),
      );
      const pinned = new Map(
        pinRow
          .all(
            this.db.prepare(
              `SELECT message_id, user_id, created_at FROM pins WHERE message_id IN (${marks})`,
            ),
            ...ids,
          )
          .map((p) => [p.message_id, p]),
      );
      const replies = new Map(
        countRow
          .all(
            this.db.prepare(
              `SELECT thread_root_id AS id, COUNT(*) AS n FROM messages
               WHERE thread_root_id IN (${marks}) AND deleted_at IS NULL GROUP BY thread_root_id`,
            ),
            ...ids,
          )
          .map((r) => [r.id, r.n]),
      );

      for (const row of rows) {
        const own = files.get(row.id) ?? [];
        if (!row.text.trim() && own.length === 0) {
          this.skip("messages with no words or files, such as call notices and bare forwards");
          continue;
        }
        // Never earlier than the one before, so an import puts them back in this order.
        const ms = Math.max(row.created_at, last.ms);
        last = ms === last.ms ? { ms, within: last.within + 1 } : { ms, within: 0 };
        const ts = slackTimeOf(ms, last.within);
        times.set(row.id, ts);
        authors.set(row.id, row.user_id);
        const rootTs = row.thread_root_id ? times.get(row.thread_root_id) : undefined;
        if (row.thread_root_id && !rootTs)
          this.skip("replies to a deleted message, written as messages in the channel");
        const exported: {
          type: string;
          name: string;
          mimetype: string;
          size: number;
          export_path: string;
          id: string;
          title: string;
        }[] = [];
        for (const file of own) {
          if (!existsSync(join(this.dataDir, "files", file.id))) {
            this.skip("files whose bytes are missing from the files folder");
            continue;
          }
          const path = `files/${file.id}/${plainFileName(file.name)}`;
          this.files.push({ id: file.id, path });
          exported.push({
            type: "file",
            id: file.id,
            name: file.name,
            title: file.name,
            mimetype: file.mime,
            size: file.size,
            export_path: path,
          });
          this.result.files++;
        }
        const pin = pinned.get(row.id);
        if (pin)
          pins.push({ id: ts, type: "C", user: pin.user_id, created: seconds(pin.created_at) });
        const message = {
          type: "message",
          ...(rootTs && row.broadcast === 1 ? { subtype: "thread_broadcast" } : {}),
          user: row.user_id,
          text: toSlackText(row.text),
          ts,
          ...(rootTs
            ? { thread_ts: rootTs, parent_user_id: authors.get(row.thread_root_id!) }
            : replies.has(row.id)
              ? { thread_ts: ts, reply_count: replies.get(row.id) }
              : {}),
          ...(row.edited_at !== null
            ? { edited: { user: row.user_id, ts: slackTimeOf(row.edited_at) } }
            : {}),
          ...(reactions.has(row.id) ? { reactions: reactionList(reactions.get(row.id)!) } : {}),
          ...(exported.length ? { files: exported } : {}),
          ...(pin ? { pinned_to: [channelId] } : {}),
        };
        const today = day(ms);
        if (current && (current as { day: string }).day !== today) await flush();
        current ??= { day: today, messages: [] };
        current.messages.push(message);
        count++;
      }
    }
    await flush();
    this.result.messages += count;
    this.log(
      `  ${folder}: ${count.toLocaleString("en-US")} ${count === 1 ? "message" : "messages"}`,
    );
    return pins;
  }
}

function group<T extends { message_id: string }>(rows: T[]): Map<string, T[]> {
  const by = new Map<string, T[]>();
  for (const row of rows) {
    const list = by.get(row.message_id);
    if (list) list.push(row);
    else by.set(row.message_id, [row]);
  }
  return by;
}

/** Reactions as Slack lists them: one entry for each emoji, in the order each was first added. */
function reactionList(rows: { emoji: string; user_id: string }[]) {
  const by = new Map<string, string[]>();
  for (const row of rows) {
    const users = by.get(row.emoji);
    if (users) users.push(row.user_id);
    else by.set(row.emoji, [row.user_id]);
  }
  return [...by].map(([emoji, users]) => ({
    name: slackNameForEmoji(emoji),
    users,
    count: users.length,
  }));
}

/** A file's name as a zip entry can have it: what could not be part of a path becomes `_`. */
function plainFileName(name: string): string {
  const plain = name
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 120);
  return plain || "file";
}
