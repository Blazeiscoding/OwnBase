/** mDNS service type advertised by hosting servers and browsed by clients. */
export const MDNS_SERVICE_TYPE = "ownbase";

export const DEFAULT_PORT = 8543;

/** TXT record payload attached to the mDNS advertisement. */
export interface DiscoveryTxt {
  name: string; // workspace name
  ver: string; // server version
  proto: string; // protocol version
  /**
   * The advertising server's instance id, new on every start and also served
   * by /api/health. What tells "this computer's own workspace" apart from
   * another one on the same port. Absent from servers before it was added.
   */
  inst?: string;
  /**
   * The version of the workspace's icon (`ServerInfo.iconVersion`), so a list
   * of found workspaces can ask for it by the public route. Absent when there
   * is none, and from servers before it was added.
   */
  icon?: string;
}

/**
 * Whether `value` is an icon version as a server makes one: the first 16 hex
 * digits of the picture's SHA-256. What else an announcement calls one is
 * not used.
 */
export function isIconVersion(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
}

/**
 * `host:port` for building an address, with an IPv6 literal in brackets: the
 * only way a URL, or anything that reads one, can tell the port from the
 * address. A host already in brackets is left as it is.
 */
export function hostWithPort(host: string, port: number): string {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return bare.includes(":") ? `[${bare}]:${port}` : `${bare}:${port}`;
}

/**
 * Whether an address can be put in a link. An IPv6 link-local address
 * (fe80::/10) only works together with the network interface it belongs to,
 * and a browser's URL has no way to say which one, so it cannot.
 */
export function isLinkableAddress(host: string): boolean {
  if (!host) return false;
  if (host.includes("%")) return false;
  return !/^\[?fe[89ab][0-9a-f]:/i.test(host);
}

/** Deep-link format: ownbase://join?host=1.2.3.4:8543&code=INVITE */
export const DEEP_LINK_PROTOCOL = "ownbase";
