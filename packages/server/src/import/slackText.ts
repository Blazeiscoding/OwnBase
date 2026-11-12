/**
 * Message text between Slack's export and this app. Both write Slack's
 * markup: `<@U123>` for a person, `<#C123>` for a channel, `<!here>`, and
 * `<https://…|label>` for a link. Slack also escapes `&`, `<` and `>` in
 * everything else (its "Formatting text" guide), where this app keeps the
 * characters as typed, so text going either way is escaped or unescaped
 * around the markup.
 */

const MARKUP = /<([^<>\n]*)>/g;

const unescape = (text: string) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface SlackIds {
  /** This workspace's id for a Slack person, or null when the export does not name them. */
  user(slackId: string): string | null;
  channel(slackId: string): string | null;
}

/** What people and channels are called, for text this app shows as plain words. */
export interface SlackNames {
  user(slackId: string): string | null;
  channel(slackId: string): string | null;
}

/**
 * Slack's text as this app keeps it: the people and channels it names, by
 * their ids here. One the export does not name stays as words, `@name` from
 * the label Slack kept beside it, or the bare id when there is none. Markup
 * this app does not have, such as a user group or a date, becomes the words
 * Slack shows for it.
 */
export function fromSlackText(text: string, ids: SlackIds): string {
  return convert(text, ids, null);
}

/**
 * Slack's text as plain words, for what this app shows without markup, such
 * as a channel's topic: `@Bob Brown`, `#random`, a link as its label and
 * address.
 */
export function slackWords(text: string, names: SlackNames): string {
  return convert(text, { user: () => null, channel: () => null }, names);
}

function convert(text: string, ids: SlackIds, names: SlackNames | null): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(MARKUP)) {
    out += unescape(text.slice(last, match.index));
    last = match.index + match[0].length;
    const inner = match[1]!;
    const bar = inner.indexOf("|");
    const target = bar === -1 ? inner : inner.slice(0, bar);
    const label = bar === -1 ? null : unescape(inner.slice(bar + 1));
    if (target.startsWith("@")) {
      const slackId = target.slice(1);
      const id = ids.user(slackId);
      const name = names?.user(slackId) || label?.replace(/^@/, "") || slackId;
      out += id ? `<@${id}>` : `@${name}`;
    } else if (target.startsWith("#")) {
      const slackId = target.slice(1);
      const id = ids.channel(slackId);
      const name = names?.channel(slackId) || label?.replace(/^#/, "") || slackId;
      out += id ? `<#${id}>` : `#${name}`;
    } else if (target === "!here" || target === "!channel" || target === "!everyone") {
      out += names ? `@${target.slice(1)}` : `<${target}>`;
    } else if (/^https?:\/\//i.test(target)) {
      if (!names) out += `<${target}${label === null ? "" : `|${label}`}>`;
      else out += label && label !== target ? `${label} (${target})` : target;
    } else if (target.startsWith("!")) {
      // `<!subteam^S123|@team>`, `<!date^1392734382^{date}|Feb 18>`: what Slack shows instead.
      out += label ?? `@${target.slice(1).split("^")[0]}`;
    } else {
      // `<mailto:…|…>`, `<tel:…>` and the like: the words a reader saw.
      out += label ?? target.replace(/^(mailto|tel):/i, "");
    }
  }
  return out + unescape(text.slice(last));
}

/** This app's markup, which a Slack reader understands as it is. */
const OWN_MARKUP =
  /<(?:[@#][A-Za-z0-9_-]+|!(?:here|channel|everyone)|https?:\/\/[^\s|<>]+(?:\|[^<>\n]+)?)>/g;

/** Text as Slack writes it: the markup as it is, everything else escaped. */
export function toSlackText(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(OWN_MARKUP)) {
    // A link's label is words, escaped as the rest are.
    const bar = match[0].indexOf("|");
    const markup =
      bar === -1 ? match[0] : `${match[0].slice(0, bar)}|${escape(match[0].slice(bar + 1, -1))}>`;
    out += escape(text.slice(last, match.index)) + markup;
    last = match.index + match[0].length;
  }
  return out + escape(text.slice(last));
}
