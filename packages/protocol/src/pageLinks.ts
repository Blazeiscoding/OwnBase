import { DEEP_LINK_PROTOCOL } from "./discovery.js";

/**
 * Channel and message ids, invite codes and mailed tokens never contain
 * anything else, so a link carrying one needs no decoding to be read back.
 */
export const PAGE_ID_CHARS = "[A-Za-z0-9_-]{1,64}";
export const PAGE_ID = new RegExp(`^${PAGE_ID_CHARS}$`);

export function isPageId(value: unknown): value is string {
  return typeof value === "string" && PAGE_ID.test(value);
}

/**
 * A place in the web client a link can lead to. The browser keeps it in the
 * fragment, which it never sends to the server: an invite code or a mailed
 * token stays out of the server's logs and out of any Referer.
 */
export type PageLink =
  | { kind: "join"; code: string }
  /** A workspace nobody owns yet, and the code that claims it. */
  | { kind: "claim"; code: string }
  /** Back from a workspace's single sign-on, with the code that signs in. */
  | { kind: "sso"; code: string }
  /** Mailed, to set a new password. */
  | { kind: "reset"; token: string }
  /** Mailed, to confirm an email address. */
  | { kind: "verifyEmail"; token: string }
  | { kind: "message"; channelId: string; messageId: string };

const e = encodeURIComponent;

/** The start of every address inside one conversation, `#/c/<channel>`. */
export function conversationHash(channelId: string): string {
  return `#/c/${e(channelId)}`;
}

/** The word each link but a message's has in its address. */
const WORDS = {
  join: "join",
  claim: "claim",
  sso: "sso",
  reset: "reset",
  verifyEmail: "verify-email",
} as const;

export function pageHash(link: PageLink): string {
  if (link.kind === "message") return `${conversationHash(link.channelId)}/m/${e(link.messageId)}`;
  return `#/${WORDS[link.kind]}/${e("code" in link ? link.code : link.token)}`;
}

/** The link that opens `link` at the web client the workspace at `serverUrl` serves. */
export function pageLink(serverUrl: string, link: PageLink): string {
  return `${serverUrl}/${pageHash(link)}`;
}

const hashParts = (hash: string) => hash.replace(/^#\/?/, "").split("/");

/**
 * Reads `#/c/<channel>` and whatever follows it, for the web client's own
 * addresses inside a conversation.
 */
export function readConversationHash(hash: string): { channelId: string; rest: string[] } | null {
  const [first, channelId, ...rest] = hashParts(hash);
  return first === "c" && isPageId(channelId) ? { channelId, rest } : null;
}

/** Reads back what `pageHash` wrote, or null for anything else. */
export function readPageHash(hash: string): PageLink | null {
  const parts = hashParts(hash);
  const [first, id] = parts;
  const kind = (Object.keys(WORDS) as (keyof typeof WORDS)[]).find((k) => WORDS[k] === first);
  if (kind && parts.length === 2 && isPageId(id))
    return kind === "reset" || kind === "verifyEmail" ? { kind, token: id } : { kind, code: id };
  const conversation = readConversationHash(hash);
  const [m, messageId] = conversation?.rest ?? [];
  return conversation && conversation.rest.length === 2 && m === "m" && isPageId(messageId)
    ? { kind: "message", channelId: conversation.channelId, messageId }
    : null;
}

/**
 * The desktop app's form of a link, `ownbase://<action>?host=<server>&…`.
 * ":" and "/" are allowed in a query, and leaving them makes the link
 * readable.
 */
export function desktopLink(
  host: string,
  link: Extract<PageLink, { kind: "join" | "sso" | "message" }>,
): string {
  const at = `host=${e(host).replaceAll("%3A", ":").replaceAll("%2F", "/")}`;
  const base = `${DEEP_LINK_PROTOCOL}://${link.kind}?${at}`;
  return link.kind === "message"
    ? `${base}&channel=${e(link.channelId)}&id=${e(link.messageId)}`
    : `${base}&code=${e(link.code)}`;
}
