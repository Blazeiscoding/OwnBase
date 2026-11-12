import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import { zipArchive } from "../src/backups/zip.js";

/** Writes a zip of `files`, each JSON value or Buffer under its name, as Slack's export would be. */
export async function writeZip(path: string, files: Record<string, unknown>): Promise<void> {
  const archive = zipArchive(
    Object.entries(files).map(([name, value]) => {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
      return { name, size: bytes.length, crc32: crc32(bytes), open: () => Readable.from([bytes]) };
    }),
  );
  await pipeline(archive.open(), createWriteStream(path));
}

/** Slack times, seconds and microseconds, for the fixture's messages. */
export const TS = {
  joined: "1704100000.000100",
  root: "1704100100.000200",
  edited: "1704100200.000000",
  reply: "1704100300.000300",
  broadcast: "1704100400.000400",
  file: "1704100500.000500",
  bot: "1704100600.000600",
  sameMilliA: "1704100700.000700",
  sameMilliB: "1704100700.000900",
  lateReply: "1704186000.000050",
  pinned: "1704186000.000100",
  random: "1704100800.000100",
  secret: "1704100900.000100",
  dm: "1704101000.000100",
  group: "1704101100.000100",
} as const;

/**
 * A small Slack export with one of everything an import maps: three people
 * (one deleted), a bot in users.json and one that posts by name, two public
 * channels, a private one, a direct message and a group message, a thread
 * with a reply on a later day and one also sent to the channel, an edit,
 * reactions (one custom, one with a skin tone), pins both ways Slack records
 * them, a file, a join notice, mentions of a person, of a channel and of
 * someone users.json does not list, and escaped text.
 *
 * The days are listed newest first, as nothing promises their order in a zip.
 */
export function slackExport(): Record<string, unknown> {
  return {
    "users.json": [
      {
        id: "U1",
        name: "alice",
        real_name: "Alice Adams",
        is_admin: true,
        is_owner: true,
        tz: "Europe/London",
        profile: { display_name: "Alice", real_name: "Alice Adams" },
      },
      {
        id: "U2",
        name: "bob",
        real_name: "Bob Brown",
        profile: { display_name: "" },
        tz: "Not/AZone",
      },
      { id: "U3", name: "carol", deleted: true, profile: { real_name: "Carol Clark" } },
      { id: "B1", name: "deploybot", is_bot: true, real_name: "Deploys" },
    ],
    "channels.json": [
      {
        id: "C1",
        name: "general",
        created: 1704000000,
        creator: "U1",
        is_general: true,
        members: ["U1", "U2", "U3"],
        topic: { value: "Say hi to <@U2>", creator: "U1", last_set: 1704000000 },
        purpose: { value: "Everything &amp; anything", creator: "U1", last_set: 1704000000 },
        pins: [{ id: TS.root, type: "C", user: "U2", created: 1704100150 }],
      },
      {
        id: "C2",
        name: "random",
        created: 1704000100,
        creator: "U2",
        is_archived: true,
        members: ["U1", "U2"],
        topic: { value: "" },
        purpose: { value: "" },
      },
    ],
    "groups.json": [
      { id: "G1", name: "secret", created: 1704000200, creator: "U1", members: ["U1", "U2"] },
    ],
    "dms.json": [{ id: "D1", created: 1704000300, members: ["U1", "U2"] }],
    "mpims.json": [
      {
        id: "G2",
        name: "mpdm-alice--bob--carol-1",
        created: 1704000400,
        creator: "U1",
        members: ["U1", "U2", "U3"],
      },
    ],
    "general/2024-01-02.json": [
      { type: "message", user: "U1", text: "Pinned rule", ts: TS.pinned, pinned_to: ["C1"] },
      {
        type: "message",
        user: "U2",
        text: "Late reply",
        ts: TS.lateReply,
        thread_ts: TS.root,
        parent_user_id: "U1",
      },
    ],
    "general/2024-01-01.json": [
      { type: "message", user: "U1", text: "Second in the millisecond", ts: TS.sameMilliB },
      { type: "message", user: "U1", text: "First in the millisecond", ts: TS.sameMilliA },
      {
        type: "message",
        subtype: "channel_join",
        user: "U2",
        text: "<@U2> has joined the channel",
        ts: TS.joined,
      },
      {
        type: "message",
        user: "U1",
        text: "Hello <@U2> and <@U999|ghost>, see <#C2|random> &amp; &lt;b&gt; <https://example.com|a link>",
        ts: TS.root,
        thread_ts: TS.root,
        reply_count: 3,
        edited: { user: "U1", ts: TS.edited },
        reactions: [
          { name: "+1", users: ["U2", "U3"], count: 2 },
          { name: "partyparrot", users: ["U2"], count: 1 },
          { name: "wave::skin-tone-3", users: ["U1"], count: 1 },
        ],
      },
      {
        type: "message",
        user: "U2",
        text: "Reply one",
        ts: TS.reply,
        thread_ts: TS.root,
        parent_user_id: "U1",
      },
      {
        type: "message",
        subtype: "thread_broadcast",
        user: "U3",
        text: "Also to the channel",
        ts: TS.broadcast,
        thread_ts: TS.root,
      },
      {
        type: "message",
        user: "U2",
        text: "",
        ts: TS.file,
        files: [
          {
            id: "F1",
            name: "report.txt",
            title: "Report",
            mimetype: "text/plain",
            size: 11,
            url_private_download:
              "https://files.slack.com/files-pri/T1-F1/download/report.txt?t=xoxe-test",
          },
          { id: "F2", mode: "tombstone" },
        ],
      },
      {
        type: "message",
        subtype: "bot_message",
        bot_id: "BX",
        username: "Deploy Bot",
        text: "Deployed v1",
        ts: TS.bot,
      },
    ],
    "random/2024-01-01.json": [
      { type: "message", user: "B1", bot_id: "BX1", text: "random words", ts: TS.random },
    ],
    "secret/2024-01-01.json": [
      { type: "message", user: "U1", text: "private words", ts: TS.secret },
    ],
    "D1/2024-01-01.json": [{ type: "message", user: "U2", text: "direct words", ts: TS.dm }],
    "mpdm-alice--bob--carol-1/2024-01-01.json": [
      { type: "message", user: "U3", text: "group words", ts: TS.group },
    ],
  };
}
