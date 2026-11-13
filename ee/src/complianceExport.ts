import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { crc32 } from "node:zlib";
import type { Channel, ID, User } from "@ownbase/protocol";
import type { ExtensionContext, RecordedMessage } from "@ownbase/server/extensions";
import { zipArchive, type ZipSource } from "@ownbase/server/zip";

/**
 * A compliance export (P12): one zip, made as it downloads, of
 *
 * - `messages.jsonl`, a line for each message written in the range by the
 *   people chosen, or in the conversations chosen, oldest first;
 * - `conversations.jsonl` and `people.jsonl`, for the ids those lines name;
 * - `files/<id>/<name>`, each file still attached to one of them;
 * - `manifest.json`, what was asked for, by whom, and what it holds.
 *
 * Choosing a person takes everything they wrote, anywhere, and every message
 * in their direct conversations, whoever wrote it. Choosing a channel takes
 * every message in it.
 */

/** What an export covers. `to` is the first moment after it. */
export interface ExportChoice {
  from: number;
  to: number;
  userIds: ID[];
  channelIds: ID[];
}

/** Words a message had before an edit, kept because it was held then. */
export interface EarlierVersion {
  text: string;
  /** When those words were written. */
  writtenAt: number;
  /** When an edit replaced them. */
  replacedAt: number;
}

/** The export's format, for whoever reads `manifest.json`. */
export const EXPORT_FORMAT = 1;

/** Messages read at once, between which other requests are served. */
const PAGE = 500;

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());

/** A file's name as the zip holds it: one level, under the file's id. */
export const zipName = (fileId: ID, name: string) => {
  const flat = name.replace(/[\\/\u0000-\u001f]/g, "_").trim();
  return `files/${fileId}/${flat === "" || flat === "." || flat === ".." ? "file" : flat}`;
};

/** How conversations are named in the export: a channel by its name, a direct one by who is in it. */
function conversationLine(channel: Channel, users: (id: ID) => User | null) {
  const members = channel.memberIds ?? [];
  return {
    id: channel.id,
    type: channel.type,
    name:
      channel.type === "dm" || channel.type === "group_dm"
        ? members.map((id) => users(id)?.handle ?? id).join(", ")
        : channel.name,
    archived: channel.archived,
    ...(channel.memberIds ? { memberIds: channel.memberIds } : {}),
  };
}

export interface MadeExport {
  length: number;
  open: () => Readable;
  counts: { messages: number; deleted: number; edited: number; files: number };
  /** Removes what was written to disk for it. */
  cleanUp: () => void;
}

/**
 * Writes the messages to a file of its own first, since the zip says its
 * length before its first byte, then zips that and the files, which stream
 * from where the server keeps them.
 */
export async function makeExport(
  context: ExtensionContext,
  choice: ExportChoice,
  about: {
    madeBy: User;
    madeAt: number;
    versions: (messageId: ID) => EarlierVersion[];
  },
): Promise<MadeExport> {
  const conversations = new Map(context.channels.list().map((c) => [c.id, c]));
  const people = new Set(choice.userIds);
  // A person's direct conversations, whoever wrote in them.
  const channelIds = new Set(choice.channelIds);
  for (const channel of conversations.values())
    if (
      (channel.type === "dm" || channel.type === "group_dm") &&
      channel.memberIds?.some((id) => people.has(id))
    )
      channelIds.add(channel.id);

  const folder = mkdtempSync(join(tmpdir(), "ownbase-export-"));
  const cleanUp = () => rmSync(folder, { recursive: true, force: true });
  try {
    const messagesPath = join(folder, "messages.jsonl");
    const out = openSync(messagesPath, "w");
    const counts = { messages: 0, deleted: 0, edited: 0, files: 0 };
    const files: { id: ID; name: string; size: number }[] = [];
    const named = new Set<ID>();
    const seenConversations = new Set<ID>();
    try {
      let afterId: ID | undefined;
      for (;;) {
        const page: RecordedMessage[] = context.messages.recorded({
          from: choice.from,
          to: choice.to,
          userIds: [...people],
          channelIds: [...channelIds],
          ...(afterId ? { afterId } : {}),
          limit: PAGE,
        });
        if (page.length === 0) break;
        let lines = "";
        for (const message of page) {
          const earlier = about.versions(message.id);
          counts.messages++;
          if (message.deletedAt !== null) counts.deleted++;
          if (message.editedAt !== null || earlier.length > 0) counts.edited++;
          named.add(message.userId);
          seenConversations.add(message.channelId);
          const attached = message.files.map((file) => {
            files.push({ id: file.id, name: zipName(file.id, file.name), size: file.size });
            return {
              id: file.id,
              name: file.name,
              type: file.mime,
              size: file.size,
              path: zipName(file.id, file.name),
            };
          });
          lines += `${JSON.stringify({
            id: message.id,
            conversationId: message.channelId,
            authorId: message.userId,
            threadRootId: message.threadRootId,
            sentAt: iso(message.createdAt),
            editedAt: iso(message.editedAt),
            deletedAt: iso(message.deletedAt),
            text: message.text,
            files: attached,
            earlierVersions: earlier.map((v) => ({
              text: v.text,
              writtenAt: iso(v.writtenAt),
              replacedAt: iso(v.replacedAt),
            })),
          })}\n`;
        }
        writeSync(out, lines);
        afterId = page.at(-1)!.id;
        // Reading is synchronous; between pages, the server answers everyone else.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      closeSync(out);
    }
    counts.files = files.length;

    const conversationLines = [...seenConversations]
      .map((id) => conversations.get(id))
      .filter((c): c is Channel => c !== undefined)
      .map((c) => {
        for (const id of c.memberIds ?? []) named.add(id);
        return JSON.stringify(conversationLine(c, context.users.get));
      });
    const peopleLines = [...named].map((id) => {
      const user = context.users.get(id);
      return JSON.stringify({
        id,
        handle: user?.handle ?? null,
        name: user?.displayName ?? null,
        deactivated: user?.deactivated ?? null,
        app: user?.isBot ?? null,
      });
    });
    const manifest = {
      format: EXPORT_FORMAT,
      madeAt: iso(about.madeAt),
      madeBy: { id: about.madeBy.id, handle: about.madeBy.handle },
      from: iso(choice.from),
      until: iso(choice.to),
      people: choice.userIds,
      conversations: [...channelIds],
      counts,
      deletions:
        "A deleted message keeps who wrote it, where, when, and when it was deleted. Its words and files were erased when it was deleted. A message cannot be deleted while it is held.",
      edits:
        "A message has its newest words and when they were last edited. Earlier words are kept only for messages that were held when they were edited.",
    };

    const text = (name: string, body: string): ZipSource => {
      const bytes = Buffer.from(body);
      return {
        name,
        size: bytes.length,
        crc32: crc32(bytes),
        open: () => Readable.from([bytes]),
      };
    };
    const lines = (all: string[]) => (all.length ? `${all.join("\n")}\n` : "");
    const entries: ZipSource[] = [
      text("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`),
      {
        name: "messages.jsonl",
        size: statSync(messagesPath).size,
        open: () => createReadStream(messagesPath),
      },
      text("conversations.jsonl", lines(conversationLines)),
      text("people.jsonl", lines(peopleLines)),
    ];
    const taken = new Set<string>();
    for (const file of files) {
      if (taken.has(file.name)) continue;
      taken.add(file.name);
      entries.push({
        name: file.name,
        size: file.size,
        open: () => {
          const stream = context.files.open(file.id);
          if (!stream) throw new Error("This workspace keeps no files.");
          return stream;
        },
      });
    }
    const zip = zipArchive(entries, about.madeAt);
    return { length: zip.length, open: zip.open, counts, cleanUp };
  } catch (error) {
    cleanUp();
    throw error;
  }
}
