import type { HostingStatus } from "../platform.js";
import { DEEP_LINK_PROTOCOL, isPageId, readPageHash } from "@ownbase/protocol";
import { normalizeServerUrlSafe } from "./deeplinkHelpers.js";

export type DeepLink =
  | { kind: "join"; serverUrl: string; code: string | null }
  /** A workspace nobody owns yet, and the code that claims it (P7). */
  | { kind: "claim"; serverUrl: string; code: string }
  /** Back from a workspace's single sign-on, with the code that signs in (P9). */
  | { kind: "sso"; serverUrl: string; code: string }
  /** A link mailed to set a new password (G10). */
  | { kind: "reset"; serverUrl: string; token: string }
  /** A link mailed to confirm an email address (G10). */
  | { kind: "verifyEmail"; serverUrl: string; token: string }
  | { kind: "message"; serverUrl: string; channelId: string; messageId: string };

/**
 * Parses the links the app hands out, in either form: protocol's
 * `desktopLink` for the desktop app, and its `pageLink` for a browser.
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
  if (url.protocol !== `${DEEP_LINK_PROTOCOL}:`) return null;

  // ownbase://join?… parses "join" as the host, not the pathname.
  const action = (url.hostname || url.pathname.replace(/^\/+/, "")).toLowerCase();
  const host = url.searchParams.get("host");
  if (!host) return null;
  const serverUrl = normalizeServerUrlSafe(host);
  if (!serverUrl) return null;

  if (action === "join") {
    return { kind: "join", serverUrl, code: url.searchParams.get("code") };
  }
  if (action === "sso") {
    const code = url.searchParams.get("code");
    return isPageId(code) ? { kind: "sso", serverUrl, code } : null;
  }
  if (action === "message") {
    const channelId = url.searchParams.get("channel");
    const messageId = url.searchParams.get("id");
    if (!channelId || !messageId) return null;
    return { kind: "message", serverUrl, channelId, messageId };
  }
  return null;
}

/** The browser form is the workspace's own root, with where to go in the fragment. */
function parseBrowserLink(url: URL): DeepLink | null {
  if (url.pathname !== "/" || url.search) return null;
  const serverUrl = normalizeServerUrlSafe(url.origin);
  const link = readPageHash(url.hash);
  return serverUrl && link ? { ...link, serverUrl } : null;
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
