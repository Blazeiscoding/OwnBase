import type { HostingStatus } from "../platform.js";
import {
  DEEP_LINK_PROTOCOLS,
  OWNBASE_DEEP_LINK_PROTOCOL,
  normalizeServerUrlSafe,
} from "./deeplinkHelpers.js";

/** What a link asks the app to do. */
export type DeepLink =
  | { kind: "join"; serverUrl: string; code: string | null }
  | { kind: "message"; serverUrl: string; channelId: string; messageId: string };

/** Where a link leads, before the server it belongs to is attached. */
export type LinkTarget =
  { kind: "join"; code: string } | { kind: "message"; channelId: string; messageId: string };

/** Channel and message ids, and invite codes, never contain anything else. */
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Parses the links the app hands out, in either form:
 * ownbase://join?host=…&code=… and ownbase://message?host=…&channel=…&id=…
 * for the desktop app (the previous gatherline:// and slackoss:// forms still read), and
 * <server>/#/join/<code> and <server>/#/c/<channel>/m/<message> for a browser.
 * Returns null for anything malformed rather than throwing.
 */
export function parseDeepLink(raw: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === "http:" || url.protocol === "https:") return parseBrowserLink(url);
  if (!(DEEP_LINK_PROTOCOLS as readonly string[]).includes(url.protocol.replace(/:$/, "")))
    return null;

  // ownbase://join?… parses "join" as the host, not the pathname.
  const action = (url.hostname || url.pathname.replace(/^\/+/, "")).toLowerCase();
  const host = url.searchParams.get("host");
  if (!host) return null;
  const serverUrl = normalizeServerUrlSafe(host);
  if (!serverUrl) return null;

  if (action === "join") {
    return { kind: "join", serverUrl, code: url.searchParams.get("code") };
  }
  if (action === "message") {
    const channelId = url.searchParams.get("channel");
    const messageId = url.searchParams.get("id");
    if (!channelId || !messageId) return null;
    return { kind: "message", serverUrl, channelId, messageId };
  }
  return null;
}

/**
 * The browser form keeps where to go in the fragment, which a browser never
 * sends to the server: an invite code stays out of its logs and out of any
 * Referer. The page itself is the workspace's own root.
 */
function parseBrowserLink(url: URL): DeepLink | null {
  if (url.pathname !== "/" || url.search) return null;
  const serverUrl = normalizeServerUrlSafe(url.origin);
  if (!serverUrl) return null;
  const parts = url.hash.replace(/^#\/?/, "").split("/");
  if (parts.length === 2 && parts[0] === "join" && TOKEN.test(parts[1]!)) {
    return { kind: "join", serverUrl, code: parts[1]! };
  }
  if (
    parts.length === 4 &&
    parts[0] === "c" &&
    parts[2] === "m" &&
    TOKEN.test(parts[1]!) &&
    TOKEN.test(parts[3]!)
  ) {
    return { kind: "message", serverUrl, channelId: parts[1]!, messageId: parts[3]! };
  }
  return null;
}

/**
 * The shortest way to write a server's address that still reads back as that
 * server: "192.168.1.5:8543" for a plain address on a port, but the whole
 * "https://chat.team.dev" where dropping the scheme would change where it
 * leads.
 */
export function serverAddress(serverUrl: string): string {
  const short = serverUrl.replace(/^http:\/\//, "");
  return normalizeServerUrlSafe(short) === serverUrl ? short : serverUrl;
}

/** A link that opens in any browser, at the web client the workspace serves. */
export function browserLink(serverUrl: string, target: LinkTarget): string {
  const e = encodeURIComponent;
  return target.kind === "join"
    ? `${serverUrl}/#/join/${e(target.code)}`
    : `${serverUrl}/#/c/${e(target.channelId)}/m/${e(target.messageId)}`;
}

/** A link that opens the desktop app. Written in the OwnBase form. */
export function desktopLink(serverUrl: string, target: LinkTarget): string {
  const e = encodeURIComponent;
  // ":" and "/" are allowed in a query, and leaving them makes the link readable.
  const host = e(serverAddress(serverUrl)).replaceAll("%3A", ":").replaceAll("%2F", "/");
  return target.kind === "join"
    ? `${OWNBASE_DEEP_LINK_PROTOCOL}://join?host=${host}&code=${e(target.code)}`
    : `${OWNBASE_DEEP_LINK_PROTOCOL}://message?host=${host}&channel=${e(target.channelId)}&id=${e(target.messageId)}`;
}

export interface ShareableServer {
  /** The address to build links on. */
  serverUrl: string;
  /** Other addresses the same workspace answers on, when there is a choice. */
  alternatives: string[];
  /** Set when the only address known reaches just this computer. */
  localOnly: boolean;
}

/**
 * Which address to put in a link someone else will open. A live temporary
 * address owned by this desktop is authoritative, followed by the address the
 * server publishes. Otherwise the address this app is connected to is right,
 * unless it reaches only this computer.
 */
export function shareableServer(input: {
  baseUrl: string;
  /** From the server, when its host configured how others reach it. */
  publicUrl?: string | null;
  /** From this app, when it may be the one hosting the workspace. */
  hosting?: HostingStatus | null;
}): ShareableServer {
  const loopback = isLoopbackUrl(input.baseUrl);
  const { hosting } = input;
  const hostedHere =
    loopback && hosting?.running && String(hosting.port) === new URL(input.baseUrl).port;
  if (hostedHere) {
    // The desktop controller owns this temporary address. Its live status is
    // authoritative over /api/server-info, which may have been fetched before
    // the tunnel opened or may still contain an address that just closed.
    if (hosting.openToAll?.phase === "open") {
      const publicAddress = rootOrigin(hosting.openToAll.url);
      if (publicAddress) return { serverUrl: publicAddress, alternatives: [], localOnly: false };
    }
    const [first, ...rest] = [...(hosting.lanUrls ?? [])]
      .sort((a, b) => lanRank(a) - lanRank(b))
      .flatMap((address) => normalizeServerUrlSafe(address) ?? []);
    if (first) return { serverUrl: first, alternatives: rest, localOnly: false };
    return { serverUrl: input.baseUrl, alternatives: [], localOnly: true };
  }
  const published = input.publicUrl ? rootOrigin(input.publicUrl) : null;
  if (published) return { serverUrl: published, alternatives: [], localOnly: false };
  if (!loopback) {
    return { serverUrl: input.baseUrl, alternatives: [], localOnly: false };
  }
  return { serverUrl: input.baseUrl, alternatives: [], localOnly: true };
}

/**
 * Clients talk to a server at its root, so a public address published under a
 * path is not one a link can be built on.
 */
function rootOrigin(publicUrl: string): string | null {
  try {
    const url = new URL(publicUrl);
    return url.pathname === "/" ? normalizeServerUrlSafe(url.origin) : null;
  } catch {
    return null;
  }
}

/**
 * Home and office networks first. 172.16.0.0/12 is where Docker, WSL and
 * Hyper-V put their virtual adapters, which nobody else can reach.
 */
function lanRank(address: string): number {
  if (/^(192\.168|10)\./.test(address)) return 0;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return 1;
}

/** Addresses that reach only the computer they are typed on. */
export function isLoopbackUrl(serverUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(serverUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    hostname === "0.0.0.0" ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname)
  );
}
