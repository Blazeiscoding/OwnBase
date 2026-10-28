import { createHmac } from "node:crypto";
import { z } from "zod";
import { ConfigError } from "./config.js";
import { iceServersSchema } from "./rtc.js";

export type IceServer = z.infer<typeof iceServersSchema>[number];

/**
 * A TURN relay carries a call between people whose networks will not let them
 * reach each other directly. Cloudflare's gives out passwords that expire, so
 * the server asks for one when calls need it; any other relay is used as given.
 */
export type CallRelay =
  | { kind: "cloudflare"; keyId: string; apiToken: string }
  | { kind: "custom"; urls: string[]; username: string; credential: string };

/**
 * A relay of the host's own that shares a secret with this server, as
 * coturn's `use-auth-secret` does. The server signs each member a password
 * that expires, so nobody is handed one that lasts. Only the environment sets
 * it, never the desktop app.
 */
export type SharedSecretRelay = { kind: "shared-secret"; urls: string[]; secret: string };

/** Every relay a server can give calls. */
export type ServerRelay = CallRelay | SharedSecretRelay;

const secret = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\s\p{Cc}]+$/u);

const relayUrls = z
  .array(
    z
      .string()
      .max(500)
      .regex(/^turns?:[^\s]+$/),
  )
  .min(1)
  .max(8);

/** A secret short enough to guess would let anyone make passwords for the relay. */
export const SHARED_SECRET_MIN_LENGTH = 16;

export const callRelaySchema: z.ZodType<CallRelay> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cloudflare"),
    // It becomes part of the request's path, so nothing that could leave it.
    keyId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    apiToken: secret(512),
  }),
  z.object({
    kind: z.literal("custom"),
    urls: relayUrls,
    username: secret(256),
    credential: secret(512),
  }),
]);

export const serverRelaySchema: z.ZodType<ServerRelay> = z.union([
  callRelaySchema,
  z.object({
    kind: z.literal("shared-secret"),
    urls: relayUrls,
    secret: secret(512).min(SHARED_SECRET_MIN_LENGTH),
  }),
]);

/**
 * How long a password signed with a shared secret lasts, as long as a
 * Cloudflare one. coturn checks it when a connection through the relay starts,
 * so a call already running carries on past it.
 */
export const SHARED_SECRET_TTL_SECONDS = 24 * 60 * 60;

/**
 * A member's password for a relay that shares a secret with this server, as
 * coturn checks it: the username is when it expires and who it is for, the
 * password is that username signed with the secret (HMAC-SHA1, base64).
 * coturn counts its quotas on the part after the colon, so per member.
 */
export function sharedSecretCredential(
  relay: SharedSecretRelay,
  userId: string,
  nowMs: number,
): IceServer {
  const username = `${Math.floor(nowMs / 1000) + SHARED_SECRET_TTL_SECONDS}:${userId}`;
  const credential = createHmac("sha1", relay.secret).update(username).digest("base64");
  return { urls: relay.urls, username, credential };
}

const CLOUDFLARE_TURN = "https://rtc.live.cloudflare.com/v1/turn/keys";
/** How long a Cloudflare password lasts: longer than any call should. */
export const CLOUDFLARE_TTL_SECONDS = 24 * 60 * 60;
/** One password serves every call started within this, so each still has most of a day. */
const REUSE_MS = 60 * 60 * 1000;
/** After a refusal, calls go without a relay for this long before asking again. */
const RETRY_MS = 30 * 1000;

/** Why Cloudflare gave no password, in words a host can act on. */
export class RelayError extends Error {}

/**
 * Asks Cloudflare for STUN and TURN servers with a password that lasts `ttl`
 * seconds. Port 53 is left out: browsers block it, and a TURN address on it
 * only times out.
 */
export async function cloudflareIceServers(
  relay: Extract<CallRelay, { kind: "cloudflare" }>,
  options: { ttl?: number; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<IceServer[]> {
  const request = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await request(
      `${CLOUDFLARE_TURN}/${encodeURIComponent(relay.keyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${relay.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ttl: options.ttl ?? CLOUDFLARE_TTL_SECONDS }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      },
    );
  } catch {
    throw new RelayError("Could not reach Cloudflare's TURN service.");
  }
  if (response.status === 401 || response.status === 403)
    throw new RelayError("Cloudflare refused the API token for this TURN key.");
  if (response.status === 404) throw new RelayError("Cloudflare has no TURN key with that ID.");
  if (!response.ok) throw new RelayError(`Cloudflare's TURN service answered ${response.status}.`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RelayError("Cloudflare's TURN service sent something unreadable.");
  }
  const offered = (body as { iceServers?: unknown })?.iceServers;
  const servers: unknown[] = Array.isArray(offered) ? offered : [];
  const usable = servers
    .map((server) => {
      if (!server || typeof server !== "object") return null;
      const urls = [(server as { urls?: unknown }).urls]
        .flat()
        .filter((url): url is string => typeof url === "string" && !/:53(?:[/?]|$)/.test(url));
      return urls.length ? { ...(server as object), urls } : null;
    })
    .filter(Boolean);
  const parsed = iceServersSchema.safeParse(usable);
  if (!parsed.success || !parsed.data.some((server) => [server.urls].flat().some(isTurn)))
    throw new RelayError("Cloudflare's TURN service offered no relay.");
  return parsed.data;
}

export const isTurn = (url: string) => /^turns?:/i.test(url);

/**
 * What calls are given for a relay, kept between calls: a Cloudflare password
 * is reused for an hour, and one request serves everyone joining at once. A
 * shared secret signs a password for each member as they ask.
 */
export function createRelaySource(
  relay: ServerRelay | null,
  options: { fetch?: typeof fetch; now?: () => number; onError?: (error: RelayError) => void } = {},
) {
  const now = options.now ?? Date.now;
  let cached: { servers: IceServer[]; until: number } | null = null;
  let pending: Promise<IceServer[]> | null = null;
  let error: RelayError | null = null;
  return {
    /** The relay's servers for the member `userId`, who is named in a shared secret's password. */
    async servers(userId: string): Promise<IceServer[]> {
      if (!relay) return [];
      if (relay.kind === "custom")
        return [{ urls: relay.urls, username: relay.username, credential: relay.credential }];
      if (relay.kind === "shared-secret") return [sharedSecretCredential(relay, userId, now())];
      if (cached && now() < cached.until) return cached.servers;
      pending ??= cloudflareIceServers(relay, { fetch: options.fetch })
        .then((servers) => {
          cached = { servers, until: now() + REUSE_MS };
          error = null;
          return servers;
        })
        .catch((err: unknown) => {
          error = err instanceof RelayError ? err : new RelayError(String(err));
          // Calls on this network work without a relay; only wait a little
          // before asking again, rather than asking for every person.
          cached = { servers: [], until: now() + RETRY_MS };
          options.onError?.(error);
          return [];
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
    /** Why the last request for a password failed, until one succeeds. */
    error: () => error?.message ?? null,
  };
}

/**
 * The servers a call is given: the workspace's own first, then the relay's,
 * leaving out an address already given (Cloudflare's STUN server is also the
 * one Open to all adds).
 */
export function withRelay(base: IceServer[], relay: IceServer[]): IceServer[] {
  const seen = new Set(base.flatMap((server) => [server.urls].flat()));
  const added = relay
    .map((server) => ({ ...server, urls: [server.urls].flat().filter((url) => !seen.has(url)) }))
    .filter((server) => server.urls.length > 0);
  return [...base, ...added];
}

/**
 * The relay the environment sets, if any: a relay of the host's own that shares
 * a secret with this server (OWNBASE_TURN_URLS and OWNBASE_TURN_SECRET), or
 * Cloudflare's (its key ID and API token). Each needs both its halves, and
 * only one may be set. A relay with a fixed password goes in OWNBASE_ICE_SERVERS.
 */
export function relayFromEnvironment(
  setting: (name: string) => string | undefined,
): ServerRelay | null {
  const urls = setting("TURN_URLS")?.trim();
  const sharedSecret = setting("TURN_SECRET")?.trim();
  const keyId = setting("CLOUDFLARE_TURN_KEY_ID")?.trim();
  const apiToken = setting("CLOUDFLARE_TURN_API_TOKEN")?.trim();
  if ((urls || sharedSecret) && (keyId || apiToken))
    throw new ConfigError(
      "Set one call relay: OWNBASE_TURN_URLS and OWNBASE_TURN_SECRET for your own, or OWNBASE_CLOUDFLARE_TURN_KEY_ID and OWNBASE_CLOUDFLARE_TURN_API_TOKEN for Cloudflare's",
    );
  if (urls || sharedSecret) {
    const list = (urls ?? "").split(/[\s,]+/).filter(Boolean);
    if (!sharedSecret)
      throw new ConfigError(
        "OWNBASE_TURN_URLS needs OWNBASE_TURN_SECRET, the secret your TURN server was given",
      );
    if (list.length === 0)
      throw new ConfigError(
        "OWNBASE_TURN_SECRET needs OWNBASE_TURN_URLS, your TURN server's addresses",
      );
    if (!relayUrls.safeParse(list).success)
      throw new ConfigError(
        "OWNBASE_TURN_URLS must be up to eight addresses starting turn: or turns:, separated by commas, like turn:turn.example.org:3478",
      );
    // The addresses are right, so the secret is what is wrong. The message
    // leaves it out, as an error can end up in a log.
    const parsed = serverRelaySchema.safeParse({
      kind: "shared-secret",
      urls: list,
      secret: sharedSecret,
    });
    if (!parsed.success)
      throw new ConfigError(
        `OWNBASE_TURN_SECRET must be at least ${SHARED_SECRET_MIN_LENGTH} characters with no spaces, such as one made by openssl rand -hex 32`,
      );
    return parsed.data;
  }
  if (!keyId && !apiToken) return null;
  const parsed = callRelaySchema.safeParse({ kind: "cloudflare", keyId, apiToken });
  if (!parsed.success)
    throw new ConfigError(
      "OWNBASE_CLOUDFLARE_TURN_KEY_ID and OWNBASE_CLOUDFLARE_TURN_API_TOKEN must both be set, as the TURN key's ID and its API token",
    );
  return parsed.data;
}
