import { z } from "zod";

/**
 * Slack's export, as far as an import reads it. Slack's help article "How to
 * read Slack data exports" names the files: users.json, channels.json, and in
 * an export of every conversation groups.json (private channels), dms.json
 * and mpims.json (group direct messages); then a folder for each conversation
 * that has messages, named after the channel, or after its id for a direct
 * message, holding one file of messages for each day (`2024-01-31.json`),
 * oldest first. Everything not read here is left alone, so a field Slack adds
 * later costs nothing, and one an import relies on is checked, so a file in
 * another shape is refused by name rather than read as nothing.
 */

/** A Slack time: seconds since 1970 and up to six digits more, as text. */
const SLACK_TIME = /^\d{1,12}(\.\d{1,6})?$/;

const slackTime = z.union([z.string(), z.number()]).transform((value, ctx) => {
  const text = typeof value === "number" ? value.toFixed(6) : value;
  if (!SLACK_TIME.test(text)) {
    ctx.addIssue({ code: "custom", message: `"${String(value)}" is not a Slack time` });
    return z.NEVER;
  }
  return text;
});

const words = z.string().nullish();
const flag = z.boolean().nullish();
const textField = z.object({ value: words }).nullish();

export const slackUser = z.object({
  id: z.string().min(1),
  name: z.string(),
  deleted: flag,
  real_name: words,
  is_bot: flag,
  is_app_user: flag,
  is_admin: flag,
  is_owner: flag,
  is_primary_owner: flag,
  is_restricted: flag,
  is_ultra_restricted: flag,
  tz: words,
  profile: z.object({ display_name: words, real_name: words }).nullish(),
});
export type SlackUser = z.infer<typeof slackUser>;

const slackPin = z.object({ id: slackTime, user: words, created: z.number().nullish() });

/** An entry of channels.json, groups.json or mpims.json. */
export const slackChannel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  created: z.number().nullish(),
  creator: words,
  is_archived: flag,
  members: z.array(z.string()).nullish(),
  topic: textField,
  purpose: textField,
  pins: z.array(slackPin).nullish(),
});
export type SlackChannel = z.infer<typeof slackChannel>;

/** An entry of dms.json, whose folder is named after its id. */
export const slackDm = z.object({
  id: z.string().min(1),
  created: z.number().nullish(),
  members: z.array(z.string()),
});
export type SlackDm = z.infer<typeof slackDm>;

export const slackFile = z.object({
  id: words,
  name: words,
  title: words,
  mimetype: words,
  size: z.number().nullish(),
  created: z.number().nullish(),
  /** "tombstone" for a deleted file, "hidden_by_limit" for one past a free plan's limit. */
  mode: words,
  is_external: flag,
  url_private: words,
  url_private_download: words,
  /**
   * Not Slack's: where an export written by this app keeps the file's bytes,
   * inside the same zip. Slack's own export holds links instead.
   */
  export_path: words,
});
export type SlackFile = z.infer<typeof slackFile>;

export const slackMessage = z.object({
  type: words,
  subtype: words,
  ts: slackTime,
  user: words,
  text: words,
  thread_ts: slackTime.nullish(),
  bot_id: words,
  username: words,
  bot_profile: z.object({ name: words }).nullish(),
  user_profile: z.object({ name: words, real_name: words, display_name: words }).nullish(),
  edited: z.object({ user: words, ts: slackTime.nullish() }).nullish(),
  reactions: z
    .array(z.object({ name: z.string(), users: z.array(z.string()).nullish() }))
    .nullish(),
  files: z.array(slackFile).nullish(),
  pinned_to: z.array(z.string()).nullish(),
  /** What older bots post instead of text: each attachment's own words. */
  attachments: z
    .array(z.object({ fallback: words, pretext: words, text: words }).loose())
    .nullish(),
});
export type SlackMessage = z.infer<typeof slackMessage>;

/** Something in the export that is not what Slack writes, named by file and field. */
export class SlackFormatError extends Error {}

/**
 * Reads `value` from `file` as `schema`, or says which field of which entry
 * is wrong: "general/2024-01-31.json, entry 4, ts: "noon" is not a Slack time".
 */
export function parseSlack<T extends z.ZodType>(
  schema: T,
  value: unknown,
  file: string,
): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  const [first, ...rest] = issue.path;
  const where =
    typeof first === "number"
      ? [`entry ${first + 1}`, ...(rest.length ? [rest.join(".")] : [])]
      : issue.path.length
        ? [issue.path.join(".")]
        : [];
  throw new SlackFormatError(`${[file, ...where].join(", ")}: ${issue.message}`);
}

/** A file that holds a list of entries, each read as `schema`. */
export function parseSlackList<T extends z.ZodType>(
  schema: T,
  value: unknown,
  file: string,
): z.output<T>[] {
  return parseSlack(z.array(schema), value, file);
}

/** Milliseconds since 1970 for a Slack time, to the millisecond. */
export function slackTimeMs(ts: string): number {
  const [seconds, fraction = ""] = ts.split(".");
  return Number(seconds) * 1000 + Math.floor(Number(fraction.padEnd(6, "0")) / 1000);
}

/** A key that sorts Slack times in the order they happened. */
export function slackTimeKey(ts: string): string {
  const [seconds, fraction = ""] = ts.split(".");
  return seconds!.padStart(12, "0") + fraction.padEnd(6, "0");
}

/**
 * A Slack time for a moment in milliseconds, and the how-manyth message
 * within that millisecond it is, so two in one millisecond keep their order.
 */
export function slackTimeOf(ms: number, within = 0): string {
  const micros = (ms % 1000) * 1000 + Math.min(within, 999);
  return `${Math.floor(ms / 1000)}.${String(micros).padStart(6, "0")}`;
}
