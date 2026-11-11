import { isIP } from "node:net";

/**
 * What the server may believe about where a request came from.
 *
 * A `Host` header is written by whoever made the request, and so are all the
 * `X-Forwarded-*` headers. They are useful when a reverse proxy in front of
 * this server sets them and nothing else can, and worthless otherwise, because
 * anyone can send them. The functions here are the parts of that judgement that
 * do not need a live request, so they can be tested on their own.
 */

/**
 * Where this server is, according to the connection the request arrived on.
 *
 * This is the socket's own local address and port, which the client cannot
 * change by sending a different header. On a machine serving a LAN it is the
 * interface the client actually reached, which is the useful answer as well as
 * the safe one.
 */
export function originFromConnection(
  address: string | undefined,
  port: number | undefined,
): string {
  const host = (address ?? "127.0.0.1").replace(/^::ffff:/, "");
  // A bare IPv6 address has to be bracketed before it can sit in a URL.
  const authority = host.includes(":") ? `[${host}]` : host;
  return port ? `http://${authority}:${port}` : `http://${authority}`;
}

/**
 * Whether an `Origin` header names this same server on the loopback interface.
 *
 * This is what separates a person's own machine from a web page that person is
 * merely visiting. A command line request carries no `Origin` at all; a browser
 * always sends one on a write, and a page served from anywhere else names that
 * somewhere else. Both the host and the port have to match, so another service
 * on the same machine does not count as this one.
 */
export function isLoopbackOrigin(origin: string, port: number | undefined): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.hostname
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/^::ffff:/, "");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return false;
  const originPort = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return originPort === port;
}

/** The first value of a header a proxy may have appended to. */
export function firstHeaderValue(raw: string | string[] | undefined): string {
  return (
    String(raw ?? "")
      .split(",")[0]
      ?.trim() ?? ""
  );
}

export interface ClientAddressHeaders {
  readonly [name: string]: string | string[] | undefined;
  readonly "cf-connecting-ip"?: string | string[];
  readonly "x-forwarded-for"?: string | string[];
}

/** A valid IP in one stable form, or null rather than an attacker-chosen key. */
function normalizedIp(raw: string | undefined): string | null {
  const value = (raw ?? "").trim().replace(/^::ffff:/i, "");
  return isIP(value) ? value.toLowerCase() : null;
}

function isLoopbackAddress(address: string): boolean {
  if (address === "::1") return true;
  if (isIP(address) !== 4) return false;
  return address.split(".")[0] === "127";
}

/**
 * The address used for unauthenticated rate limits.
 *
 * Normally only the socket peer is believed. The desktop's cloudflared
 * connector is the one exception: it reaches the embedded server over
 * loopback, so every visitor would otherwise share 127.0.0.1's allowance.
 * Even in that mode, forwarded headers from a LAN peer remain untrusted.
 */
export function resolveClientAddress(
  remoteAddress: string | undefined,
  headers: ClientAddressHeaders,
  trustLoopbackProxy = false,
): string {
  const peer = normalizedIp(remoteAddress) ?? "unknown";
  if (!trustLoopbackProxy || !isLoopbackAddress(peer)) return peer;

  // Cloudflare owns this header at its edge, so prefer it to the conventional
  // forwarding chain. Duplicate/comma-separated values are ambiguous and are
  // deliberately rejected rather than becoming attacker-selected bucket keys.
  const cloudflareRaw = headers["cf-connecting-ip"];
  const cloudflare =
    typeof cloudflareRaw === "string" && !cloudflareRaw.includes(",")
      ? normalizedIp(cloudflareRaw)
      : null;
  if (cloudflare) return cloudflare;

  // The trusted proxy is the rightmost hop in X-Forwarded-For. Choosing that
  // value keeps an earlier, client-supplied entry from deciding the identity.
  const forwardedRaw = headers["x-forwarded-for"];
  const forwarded = Array.isArray(forwardedRaw) ? forwardedRaw.join(",") : forwardedRaw;
  const lastHop = forwarded?.split(",").at(-1);
  return normalizedIp(lastHop) ?? peer;
}
