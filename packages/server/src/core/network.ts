import type { FastifyRequest } from "fastify";
import { parsePublicUrl } from "../config.js";
import {
  firstHeaderValue,
  isLoopbackOrigin,
  originFromConnection,
  resolveClientAddress,
} from "../netTrust.js";

/** Headers only something in front of this server writes. */
const FORWARDED = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "cf-connecting-ip",
];

/** Where requests come from and how this server is addressed, as the host has said. */
export class Network {
  private publicUrlNow: string | undefined;
  private trustLoopbackProxy: boolean;
  private readonly trustProxy: boolean;

  constructor(opts: { publicUrl?: string; trustProxy?: boolean; trustedClientProxy?: "loopback" }) {
    this.publicUrlNow =
      opts.publicUrl === undefined ? undefined : parsePublicUrl(opts.publicUrl, "publicUrl");
    this.trustProxy = opts.trustProxy === true;
    this.trustLoopbackProxy = opts.trustedClientProxy === "loopback";
  }

  publicUrl(): string | undefined {
    return this.publicUrlNow;
  }

  /** Checked before anything changes, so a refused address leaves the old one. */
  setPublicUrl(url: string | null): void {
    this.publicUrlNow = url === null ? undefined : parsePublicUrl(url, "publicUrl");
  }

  setTrustLoopbackProxy(enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean");
    this.trustLoopbackProxy = enabled;
  }

  /** The address a request came from, as the limiter keys on it. */
  callerAddress(req: Pick<FastifyRequest, "socket" | "headers">): string {
    return resolveClientAddress(
      req.socket.remoteAddress,
      req.headers,
      this.trustLoopbackProxy ? "loopback" : undefined,
    );
  }

  /** Whatever the client called itself. Shown back to its owner, never trusted. */
  deviceName(req: FastifyRequest): string {
    return String(req.headers["user-agent"] ?? "").slice(0, 200);
  }

  /**
   * Whether this request came from the machine running the server.
   *
   * Behind a reverse proxy every request arrives from loopback, which would
   * hand the local bypass to the whole internet. So a request that shows any
   * sign of having been forwarded is never local, and neither is any request to
   * a server configured with a public URL.
   *
   * Arriving from loopback is not on its own proof that the person running this
   * machine meant it. A web page they merely visited can have their browser
   * post to localhost, and that request arrives from loopback like any other —
   * which, while a workspace still has no owner, would let that page claim it
   * without the claim code. A command line request carries no `Origin`; a
   * browser always sends one on a write, and a page served from anywhere else
   * names that somewhere else. So an `Origin` is required to be this same
   * server, if it is there at all.
   */
  isLocalRequest(req: FastifyRequest): boolean {
    if (this.publicUrlNow) return false;
    if (FORWARDED.some((name) => req.headers[name] !== undefined)) return false;
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin && !isLoopbackOrigin(origin, req.socket.localPort)) {
      return false;
    }
    const ip = (req.ip || "").replace(/^::ffff:/, "");
    return ip === "127.0.0.1" || ip === "::1";
  }

  /**
   * How this server is addressed from outside, for the URLs we hand to apps.
   *
   * These become a `response_url`, which carries a token and which an app posts
   * its reply to. Building one from the `Host` header meant whoever sent the
   * request chose where that reply went: a forged header pointed the app at
   * somewhere else entirely, and sent the token with it. So the configured
   * public URL is used when there is one, forwarded headers only when a proxy
   * has been declared, and otherwise the address the connection actually
   * arrived on, which no header can change.
   */
  requestOrigin(req: FastifyRequest): string {
    if (this.publicUrlNow) return this.publicUrlNow;
    if (this.trustProxy) {
      const proto = firstHeaderValue(req.headers["x-forwarded-proto"]) || "http";
      const host =
        firstHeaderValue(req.headers["x-forwarded-host"]) || firstHeaderValue(req.headers.host);
      if (host) return `${proto}://${host}`;
    }
    return originFromConnection(req.socket.localAddress, req.socket.localPort);
  }
}

/** The session token a request carries, if any. */
export function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  return null;
}
