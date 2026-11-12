import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_WORKSPACE_NAME,
  MESSAGE_TEXT_MAX,
  type ChannelType,
  type ID,
  type WorkspaceEvent,
} from "@ownbase/protocol";
import { hashPassword } from "../auth.js";
import { holdWorkspace, WORKSPACE_LOCK, WORKSPACE_OWNER } from "../core/ownership.js";
import { WORKSPACE_DATABASE, workspaceDatabase } from "../core/workspaceFile.js";
import { openDb } from "../db.js";
import { eventChannel, eventMessageId, writeEffects } from "../events/registry.js";
import { secretToken, ulid } from "../ids.js";
import { imageSize } from "../imageSize.js";
import { getFromUrl, OutboundError } from "../outbound.js";
import { Store } from "../store.js";
import { emojiForSlackName } from "./slackEmoji.js";
import {
  parseSlackList,
  slackChannel,
  slackDm,
  SlackFormatError,
  slackMessage,
  slackTimeKey,
  slackTimeMs,
  slackUser,
  type SlackChannel,
  type SlackFile,
  type SlackMessage,
  type SlackUser,
} from "./slackFormat.js";
import { fromSlackText } from "./slackText.js";
import { IMPORT_LIMITS, SlackExportZip, type ImportLimits } from "./slackZip.js";

export interface SlackImportOptions {
  /** The export Slack made, as a zip. */
  from: string;
  /** A new folder, or an empty one, to make the workspace in. */
  dataDir: string;
  /** Who becomes the owner: their Slack username, as users.json has it. */
  owner: string;
  workspaceName?: string;
  /** Fetch each file from Slack through the link the export holds. */
  fetchFiles?: boolean;
  limits?: Partial<ImportLimits>;
  /** Fetches one file's bytes. Tests give their own; otherwise the outbound guard's. */
  fetchFile?: (url: string, maxBytes: number) => Promise<Buffer>;
  /** Where progress goes, a line at a time. */
  log?: (line: string) => void;
}

export interface SlackImportResult {
  workspaceName: string;
  owner: { handle: string; displayName: string; temporaryPassword: string };
  counts: {
    people: number;
    bots: number;
    channels: number;
    directMessages: number;
    messages: number;
    replies: number;
    files: number;
    reactions: number;
    pins: number;
  };
  /** What was left out, and why, most first. */
  skipped: { reason: string; count: number }[];
}

/** Messages written in one transaction, between which other work gets a turn. */
const BATCH = 2000;

/** Slack's own bot, which posts with this id and is not in users.json. */
const SLACKBOT = "USLACKBOT";

/** Notices of someone joining or leaving, which this app does not post. */
const JOIN_NOTICES = new Set(["channel_join", "channel_leave", "group_join", "group_leave"]);
/** Notices a conversation changed, which this app keeps as the change itself. */
const CHANNEL_NOTICES = new Set([
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "channel_convert_to_private",
  "channel_convert_to_public",
  "group_topic",
  "group_purpose",
  "group_name",
  "group_archive",
  "group_unarchive",
  "pinned_item",
  "unpinned_item",
  "bot_add",
  "bot_remove",
]);
/** A change to a message recorded beside it: the message itself already holds the result. */
const CHANGE_RECORDS = new Set(["message_changed", "message_deleted", "message_replied"]);

const isTimeZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** A conversation from the export, made here before any message is written. */
interface Conversation {
  slackId: string;
  id: ID;
  type: ChannelType;
  label: string;
  folders: string[];
  members: ID[];
  archived: boolean;
  topic: string;
  purpose: string;
  /** Pins channels.json lists by the message's time, with who pinned it. */
  pins: Map<string, { userId: ID | null; at: number | null }>;
}

/** One file of a message, its bytes already in place under `files/`. */
interface StoredFile {
  id: ID;
  name: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
}

/**
 * Makes a new workspace from a Slack export: its people, channels, private
 * channels and direct messages where the export has them, and their messages
 * with threads, edits, reactions, pins and files.
 *
 * Everything is written through the stores and recorded in the event log as
 * a posted message is, so ids, the order of history, thread counts, unread
 * cursors and search all come out as they would. Rate limits, link previews
 * and app deliveries are a sender's and are left out. Each message keeps the
 * time Slack gave it, and its id is made from that time.
 *
 * People come in deactivated with no password anyone knows, except the
 * owner, who gets a temporary one to sign in with and is asked for a new one
 * straight away. The owner brings the others back from People.
 *
 * Only into a folder that is new or empty. If anything fails, what was made
 * is removed again and the error says what failed.
 */
export async function importSlack(opts: SlackImportOptions): Promise<SlackImportResult> {
  const dataDir = resolve(opts.dataDir);
  const limits: ImportLimits = { ...IMPORT_LIMITS, ...opts.limits };
  const log = opts.log ?? (() => {});

  const existed = existsSync(dataDir);
  if (existed) {
    const there = readdirSync(dataDir).filter(
      (name) => !name.startsWith(WORKSPACE_LOCK) && !name.startsWith(WORKSPACE_OWNER),
    );
    if (there.includes(WORKSPACE_DATABASE))
      throw new SlackFormatError(
        `${dataDir} already holds a workspace. Import into a new folder; nothing there was changed.`,
      );
    if (there.length > 0)
      throw new SlackFormatError(
        `${dataDir} is not empty. Import into a new, empty folder; nothing there was changed.`,
      );
  }

  const zip = await SlackExportZip.open(resolve(opts.from), limits);
  const hold = holdWorkspace(dataDir, "a Slack import");
  let db: DatabaseSync | null = null;
  try {
    db = openDb(workspaceDatabase(dataDir));
    const result = await new SlackImport(new Store(db), zip, dataDir, opts, limits, log).run();
    db.close();
    db = null;
    return result;
  } catch (err) {
    try {
      db?.close();
    } catch {
      // Closing is only to let the folder go.
    }
    hold.release();
    // Nothing half made is left to be mistaken for the workspace.
    if (existed)
      for (const name of readdirSync(dataDir))
        rmSync(join(dataDir, name), { recursive: true, force: true });
    else rmSync(dataDir, { recursive: true, force: true });
    throw err;
  } finally {
    hold.release();
  }
}

class SlackImport {
  private readonly people = new Map<string, ID>();
  private readonly bots = new Map<string, ID>();
  private readonly channels = new Map<string, Conversation>();
  private readonly handles = new Set<string>();
  private readonly skipped = new Map<string, number>();
  private readonly counts: SlackImportResult["counts"] = {
    people: 0,
    bots: 0,
    channels: 0,
    directMessages: 0,
    messages: 0,
    replies: 0,
    files: 0,
    reactions: 0,
    pins: 0,
  };
  /** The one password hash everyone but the owner gets, of a secret thrown away at once. */
  private unknown!: { hash: string; salt: string };
  private readonly filesDir: string;
  private readonly users = new Map<string, SlackUser>();

  constructor(
    private readonly store: Store,
    private readonly zip: SlackExportZip,
    dataDir: string,
    private readonly opts: SlackImportOptions,
    private readonly limits: ImportLimits,
    private readonly log: (line: string) => void,
  ) {
    this.filesDir = join(dataDir, "files");
  }

  private skip(reason: string, count = 1): void {
    this.skipped.set(reason, (this.skipped.get(reason) ?? 0) + count);
  }

  async run(): Promise<SlackImportResult> {
    const users = parseSlackList(slackUser, await this.need("users.json"), "users.json");
    for (const user of users) this.users.set(user.id, user);
    const ownerName = this.opts.owner.trim().toLowerCase().replace(/^@/, "");
    const owner = users.find((u) => u.name.toLowerCase() === ownerName);
    if (!owner) {
      const some = users
        .filter((u) => !u.is_bot && !u.deleted)
        .slice(0, 8)
        .map((u) => u.name);
      throw new SlackFormatError(
        `Nobody in users.json has the username "${this.opts.owner}". ` +
          (some.length ? `Some that are there: ${some.join(", ")}.` : "It lists nobody."),
      );
    }
    if (owner.is_bot)
      throw new SlackFormatError(`"${owner.name}" is a bot, which cannot own a workspace.`);

    const conversations = await this.readConversations();
    mkdirSync(this.filesDir, { recursive: true });
    this.unknown = await hashPassword(secretToken());
    const temporaryPassword = secretToken().slice(0, 16);
    const ownerCredentials = await hashPassword(temporaryPassword);

    const workspaceName = this.opts.workspaceName?.trim() || DEFAULT_WORKSPACE_NAME;
    const ownerId = this.store.transaction(() => {
      this.store.settings.set("workspaceName", workspaceName);
      for (const user of users) this.addPerson(user, user === owner);
      const ownerId = this.people.get(owner.id)!;
      this.store.accounts.setPassword(ownerId, ownerCredentials.hash, ownerCredentials.salt, true);
      for (const conversation of conversations) this.addConversation(conversation, ownerId);
      // Their words may name each other, so they are read once all are made.
      for (const conversation of this.channels.values()) {
        const ids = this.ids();
        this.store.channels.update(conversation.id, {
          topic: fromSlackText(conversation.topic, ids).slice(0, 250),
          description: fromSlackText(conversation.purpose, ids).slice(0, 500),
        });
      }
      return ownerId;
    });

    const named = new Set([...this.channels.values()].flatMap((c) => c.folders));
    const folders = this.zip.dayFolders();
    for (const folder of folders.keys())
      if (!named.has(folder))
        this.skip("folders of messages no list of conversations names, left out");

    for (const conversation of this.channels.values()) {
      const folder = conversation.folders.find((name) => folders.has(name));
      const written = folder
        ? await this.writeHistory(conversation, folder, folders.get(folder)!)
        : 0;
      this.store.transaction(() => {
        if (conversation.archived) this.store.channels.update(conversation.id, { archived: true });
        // A member added now starts with everything before read: what was
        // said in Slack was read there, and is history here, not news.
        for (const userId of conversation.members)
          this.store.channels.addMember(conversation.id, userId);
      });
      this.log(
        `  ${conversation.label}: ${written.toLocaleString("en-US")} ${written === 1 ? "message" : "messages"}`,
      );
    }

    this.store.transaction(() => {
      this.store.threads.readAll(this.store.currentSeq());
      // As the running server keeps it: the newest events, for devices to catch up from.
      this.store.pruneEvents();
    });

    const ownerUser = this.store.people.get(ownerId)!;
    return {
      workspaceName,
      owner: { handle: ownerUser.handle, displayName: ownerUser.displayName, temporaryPassword },
      counts: this.counts,
      skipped: [...this.skipped]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
    };
  }

  private async need(name: string): Promise<unknown> {
    const value = await this.zip.json(name);
    if (value === null) throw new SlackFormatError(`The export has no ${name}.`);
    return value;
  }

  /** Every conversation the export lists, public first, each with where its days are. */
  private async readConversations() {
    const list: {
      type: ChannelType;
      entry: SlackChannel | null;
      dm: { id: string; created?: number | null; members: string[] } | null;
    }[] = [];
    const read = async (name: string, type: ChannelType) => {
      const value = await this.zip.json(name);
      if (value === null) return;
      for (const entry of parseSlackList(slackChannel, value, name))
        list.push({ type, entry, dm: null });
    };
    if (!this.zip.has("channels.json"))
      throw new SlackFormatError("The export has no channels.json.");
    await read("channels.json", "public");
    await read("groups.json", "private");
    const dms = await this.zip.json("dms.json");
    if (dms !== null)
      for (const dm of parseSlackList(slackDm, dms, "dms.json"))
        list.push({ type: "dm", entry: null, dm });
    await read("mpims.json", "group_dm");
    return list;
  }

  /** The handle a Slack username becomes: lowercase letters, digits, `.`, `_` and `-`, unique. */
  private handleFor(name: string): string {
    let base = name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .slice(0, 32);
    if (base.length < 2) base = `${base || "member"}-slack`.slice(0, 32);
    let handle = base;
    for (let n = 2; this.handles.has(handle); n++)
      handle = `${base.slice(0, 32 - String(n).length - 1)}-${n}`;
    this.handles.add(handle);
    return handle;
  }

  private addPerson(user: SlackUser, isOwner: boolean): void {
    const displayName = (
      user.profile?.display_name?.trim() ||
      user.profile?.real_name?.trim() ||
      user.real_name?.trim() ||
      user.name
    ).slice(0, 80);
    if (user.is_bot || user.id === SLACKBOT) {
      this.people.set(user.id, this.bot(displayName, user.name));
      return;
    }
    // The owner's own password is set once everyone is in.
    const person = this.store.people.create({
      handle: this.handleFor(user.name),
      displayName: displayName || user.name,
      passwordHash: this.unknown.hash,
      salt: this.unknown.salt,
      role: isOwner ? "owner" : user.is_admin || user.is_owner ? "admin" : "member",
    });
    this.store.people.update(person.id, {
      // Everyone but the owner waits to be brought back, from People.
      deactivated: !isOwner,
      ...(user.tz && isTimeZone(user.tz) ? { timeZone: user.tz } : {}),
    });
    this.people.set(user.id, person.id);
    this.counts.people++;
  }

  /** The bot account that posts under `name`, made the first time it is needed. */
  private bot(name: string, handle = name): ID {
    const key = name.toLowerCase();
    let id = this.bots.get(key);
    if (!id) {
      id = this.store.apps.createBotUser(
        this.handleFor(handle),
        name.slice(0, 80),
        this.unknown.hash,
        this.unknown.salt,
      ).id;
      this.bots.set(key, id);
      this.counts.bots++;
    }
    return id;
  }

  /**
   * Someone who wrote in the export but is not in users.json, as happens with
   * people from another workspace in a shared channel: made deactivated, from
   * what their message says of them.
   */
  private stranger(slackId: string, message: SlackMessage): ID {
    const profile = message.user_profile;
    const displayName =
      profile?.display_name?.trim() ||
      profile?.real_name?.trim() ||
      profile?.name?.trim() ||
      slackId;
    const person = this.store.people.create({
      handle: this.handleFor(profile?.name || `slack-${slackId}`),
      displayName: displayName.slice(0, 80),
      passwordHash: this.unknown.hash,
      salt: this.unknown.salt,
      role: "member",
    });
    this.store.people.update(person.id, { deactivated: true });
    this.people.set(slackId, person.id);
    this.counts.people++;
    this.skip("people users.json does not list, added deactivated from their messages");
    return person.id;
  }

  private ids() {
    return {
      user: (slackId: string) => this.people.get(slackId) ?? null,
      channel: (slackId: string) => this.channels.get(slackId)?.id ?? null,
    };
  }

  private addConversation(
    item: Awaited<ReturnType<SlackImport["readConversations"]>>[number],
    ownerId: ID,
  ): void {
    const slackId = item.entry?.id ?? item.dm!.id;
    const slackMembers = item.entry?.members ?? item.dm?.members ?? [];
    const unknownMembers = slackMembers.filter((m) => !this.people.has(m)).length;
    if (unknownMembers > 0)
      this.skip("members users.json does not list, left out of conversations", unknownMembers);
    const members = [...new Set(slackMembers.flatMap((m) => this.people.get(m) ?? []))];
    const created = item.entry?.created ?? item.dm?.created;
    const createdAt = typeof created === "number" ? created * 1000 : undefined;
    const creatorId = (item.entry?.creator && this.people.get(item.entry.creator)) || ownerId;
    let type = item.type;
    let dmKey: string | undefined;
    if (type === "dm" || type === "group_dm") {
      // As the app makes them: two people are a direct message, any other
      // number a group, and one conversation for each set of people.
      type = members.length === 2 ? "dm" : "group_dm";
      const key = [...members].sort().join(":");
      if (!this.store.channels.findDmByKey(key)) dmKey = key;
    }
    const isDirect = type === "dm" || type === "group_dm";
    const name = isDirect ? "" : item.entry!.name.trim().slice(0, 80);
    const channel = this.store.channels.create({
      type,
      ...(isDirect ? {} : { name }),
      creatorId,
      memberIds: [],
      ...(dmKey ? { dmKey } : {}),
      ...(createdAt ? { createdAt } : {}),
    });
    const pins = new Map<string, { userId: ID | null; at: number | null }>();
    for (const pin of item.entry?.pins ?? [])
      pins.set(pin.id, {
        userId: (pin.user && this.people.get(pin.user)) || null,
        at: typeof pin.created === "number" ? pin.created * 1000 : null,
      });
    const who = slackMembers.map((m) => this.users.get(m)?.name ?? m).join(", ");
    const label = isDirect
      ? `${type === "dm" ? "direct message" : "group message"} with ${who}`
      : type === "private"
        ? `private channel ${name}`
        : `#${name}`;
    this.channels.set(slackId, {
      slackId,
      id: channel.id,
      type,
      label,
      // Slack names a channel's folder after it, and a direct message's after its id.
      folders: isDirect && item.dm ? [slackId] : [item.entry!.name, slackId],
      members,
      archived: item.entry?.is_archived === true,
      topic: item.entry?.topic?.value ?? "",
      purpose: item.entry?.purpose?.value ?? "",
      pins,
    });
    if (isDirect) this.counts.directMessages++;
    else this.counts.channels++;
  }

  /** Writes one conversation's days, oldest first; gives how many messages it kept. */
  private async writeHistory(
    conversation: Conversation,
    folder: string,
    days: string[],
  ): Promise<number> {
    /** Each message kept in the channel's own timeline, by its Slack time, for its replies to find. */
    const roots = new Map<string, ID>();
    let written = 0;
    for (const day of days) {
      const file = `${folder}/${day}`;
      const messages = parseSlackList(slackMessage, await this.need(file), file).sort((a, b) =>
        slackTimeKey(a.ts) < slackTimeKey(b.ts)
          ? -1
          : slackTimeKey(a.ts) > slackTimeKey(b.ts)
            ? 1
            : 0,
      );
      for (let start = 0; start < messages.length; start += BATCH) {
        const batch = messages.slice(start, start + BATCH).filter((m) => this.kept(m));
        // Files are fetched or unpacked first: that waits on the network or
        // the disk, which a transaction must not.
        const files = new Map<SlackMessage, { stored: StoredFile[]; lines: string[] }>();
        for (const message of batch)
          if (message.files?.length) files.set(message, await this.prepareFiles(message.files));
        written += this.store.transaction(() => {
          let n = 0;
          for (const message of batch)
            if (this.writeMessage(conversation, message, roots, files.get(message))) n++;
          return n;
        });
        // Chat on this machine, and Ctrl+C, get their turn between batches.
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    return written;
  }

  /** Whether a message is one to bring over, or a notice this app does not post. */
  private kept(message: SlackMessage): boolean {
    const subtype = message.subtype ?? "";
    if (JOIN_NOTICES.has(subtype)) this.skip("join and leave notices");
    else if (CHANNEL_NOTICES.has(subtype))
      this.skip("notices of topic, name, archive and pin changes");
    else if (CHANGE_RECORDS.has(subtype))
      this.skip("records of edits and deletions (the messages keep the result)");
    else if (subtype === "tombstone") this.skip("deleted messages Slack kept a placeholder for");
    else return true;
    return false;
  }

  private author(message: SlackMessage): ID | null {
    const userId = message.user ?? null;
    if (userId && this.people.has(userId)) return this.people.get(userId)!;
    if (message.subtype === "bot_message" || message.bot_id || userId === SLACKBOT) {
      const name =
        message.username?.trim() ||
        message.bot_profile?.name?.trim() ||
        (userId === SLACKBOT ? "Slackbot" : "") ||
        message.bot_id ||
        "Bot";
      return this.bot(name);
    }
    return userId ? this.stranger(userId, message) : null;
  }

  private async prepareFiles(
    files: SlackFile[],
  ): Promise<{ stored: StoredFile[]; lines: string[] }> {
    const stored: StoredFile[] = [];
    const lines: string[] = [];
    for (const file of files) {
      const name = (file.name || file.title || "file").slice(0, 255);
      if (file.mode === "tombstone" || file.mode === "hidden_by_limit") {
        this.skip("files Slack had deleted or hidden");
        continue;
      }
      const id = ulid(typeof file.created === "number" ? file.created * 1000 : Date.now());
      const blob = join(this.filesDir, id);
      try {
        if (file.export_path && this.zip.has(file.export_path)) {
          await this.zip.extract(file.export_path, blob);
          stored.push(
            this.describe(id, name, file, this.zip.size(file.export_path)!, await head(blob)),
          );
          continue;
        }
        const url = file.url_private_download || file.url_private;
        if (this.opts.fetchFiles && url && !file.is_external) {
          const bytes = await (this.opts.fetchFile ?? fetchFromSlack)(url, this.limits.fileBytes);
          await writeFile(blob, bytes, { flag: "wx" });
          stored.push(this.describe(id, name, file, bytes.length, bytes));
          continue;
        }
      } catch (err) {
        rmSync(blob, { force: true });
        if (!(err instanceof FileUnavailable || err instanceof OutboundError)) throw err;
        this.skip(`files Slack would not hand over (${err.message})`);
      }
      if (!this.opts.fetchFiles && !file.is_external && !file.export_path)
        this.skip("files left as their names (run again with --fetch-files to bring them)");
      else if (file.is_external) this.skip("files kept elsewhere, left as links");
      const link = file.is_external && file.url_private ? `<${file.url_private}|${name}>` : name;
      lines.push(`File: ${link}`);
    }
    return { stored, lines };
  }

  private describe(
    id: ID,
    name: string,
    file: SlackFile,
    size: number,
    bytes: Buffer | null,
  ): StoredFile {
    const mime = file.mimetype || "application/octet-stream";
    const dims = bytes && mime.startsWith("image/") ? imageSize(bytes) : null;
    return { id, name, mime, size, width: dims?.width ?? null, height: dims?.height ?? null };
  }

  /** Writes one message and what hangs on it; false when there was nothing to write. */
  private writeMessage(
    conversation: Conversation,
    message: SlackMessage,
    roots: Map<string, ID>,
    files: { stored: StoredFile[]; lines: string[] } | undefined,
  ): boolean {
    const userId = this.author(message);
    if (!userId) {
      this.skip("messages with nobody named as their author");
      return false;
    }
    let text = fromSlackText(message.text ?? "", this.ids());
    if (!text.trim() && message.attachments?.length)
      // What older bots and integrations posted: the words of each attachment.
      text = message.attachments
        .map((a) => fromSlackText(a.pretext || a.text || a.fallback || "", this.ids()))
        .filter(Boolean)
        .join("\n");
    if (files?.lines.length) text = [text, ...files.lines].filter(Boolean).join("\n");
    if (text.length > MESSAGE_TEXT_MAX) {
      text = text.slice(0, MESSAGE_TEXT_MAX);
      this.skip(
        `message text past ${MESSAGE_TEXT_MAX.toLocaleString("en-US")} characters (the rest was cut)`,
      );
    }
    const stored = files?.stored ?? [];
    if (!text.trim() && stored.length === 0) {
      this.skip("messages with nothing left to show");
      return false;
    }

    const reply = !!message.thread_ts && message.thread_ts !== message.ts;
    const rootId = reply ? (roots.get(message.thread_ts!) ?? null) : null;
    if (reply && !rootId)
      this.skip("replies whose thread's first message is missing, kept in the channel");
    const createdAt = slackTimeMs(message.ts);
    const created = this.store.messages.create({
      channelId: conversation.id,
      userId,
      text,
      threadRootId: rootId,
      nonce: null,
      broadcast: rootId !== null && message.subtype === "thread_broadcast",
      imported: {
        createdAt,
        editedAt: message.edited?.ts ? slackTimeMs(message.edited.ts) : null,
      },
    });
    if (!rootId) roots.set(message.ts, created.id);

    // Reactions show in the order they were first added. Slack keeps that
    // order in its list and no times, so each is a millisecond after the last.
    let reacted = createdAt;
    for (const reaction of message.reactions ?? []) {
      const emoji = emojiForSlackName(reaction.name);
      if (!emoji) {
        this.skip("reactions with a custom emoji");
        continue;
      }
      for (const slackId of reaction.users ?? []) {
        const reactor = this.people.get(slackId);
        if (reactor && this.store.messages.addReaction(created.id, reactor, emoji, ++reacted))
          this.counts.reactions++;
      }
    }

    const listed = conversation.pins.get(message.ts);
    if (listed || message.pinned_to?.includes(conversation.slackId)) {
      this.store.saved.pin(
        conversation.id,
        created.id,
        listed?.userId ?? userId,
        listed?.at ?? createdAt,
      );
      this.counts.pins++;
    }

    for (const file of stored) {
      this.store.files.create({ ...file, channelId: conversation.id, userId, createdAt });
      this.counts.files++;
    }
    if (
      stored.length &&
      !this.store.files.attach(
        stored.map((f) => f.id),
        created.id,
        conversation.id,
        userId,
      )
    )
      throw new Error(`The files of a message in ${conversation.label} could not be attached.`);

    const event: WorkspaceEvent = {
      type: "message.created",
      message: this.store.messages.get(created.id)!,
    };
    const envelope = this.store.appendEvent(event, eventChannel(event), eventMessageId(event));
    writeEffects(event, envelope.seq, this.store);
    this.counts.messages++;
    if (rootId) this.counts.replies++;
    return true;
  }
}

/** The start of a file, where a picture says its size. */
async function head(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** A file Slack would not give: an expired link, or one past the size an attachment can be. */
class FileUnavailable extends Error {}

/**
 * Fetches a file through the link the export holds. Slack puts a token on
 * the link (`?t=xoxe-…`), so it needs no other sign-in; the link stops
 * working when the file, its channel or the workspace is deleted. Through the
 * outbound guard, so an export cannot point the server at its own network.
 */
async function fetchFromSlack(url: string, maxBytes: number): Promise<Buffer> {
  const page = await getFromUrl(url, {
    accept: "*/*",
    maxBytes,
    timeoutMs: 120_000,
    maxRedirects: 5,
  });
  if (page.status !== 200) throw new FileUnavailable(`Slack answered ${page.status}`);
  return page.body;
}
