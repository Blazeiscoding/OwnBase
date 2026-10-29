import type { ID } from "@ownbase/protocol";
import { parseDeepLink } from "./deeplink.js";

/** A message a link points to, in a conversation of this workspace. */
export interface LinkedMessage {
  channelId: ID;
  messageId: ID;
}

/** As many cards as a message gets link previews. */
export const MAX_LINKED_MESSAGES = 3;

// The links `Mrkdwn` draws: Slack's <url|label> and <url>, and bare addresses.
const LINK = /<(https?:\/\/[^\s|<>]+)(?:\|[^<>\n]+)?>|(https?:\/\/[^\s<>]+)/g;

/**
 * The messages a message's words link to, in the order they are named, each
 * once and at most `MAX_LINKED_MESSAGES`. Only links to an address this
 * workspace is known by (`ours`), the ones that open here; links in code are
 * left as written, as they are for link previews.
 */
export function linkedMessages(
  text: string,
  ours: (serverUrl: string) => boolean,
): LinkedMessage[] {
  const prose = text
    .split("```")
    .filter((_, i) => i % 2 === 0)
    .join(" ")
    .replace(/`[^`\n]+`/g, " ");
  const found: LinkedMessage[] = [];
  for (const m of prose.matchAll(LINK)) {
    const link = parseDeepLink(m[1] ?? m[2]!);
    if (link?.kind !== "message" || !ours(link.serverUrl)) continue;
    if (found.some((target) => target.messageId === link.messageId)) continue;
    found.push({ channelId: link.channelId, messageId: link.messageId });
    if (found.length === MAX_LINKED_MESSAGES) break;
  }
  return found;
}
