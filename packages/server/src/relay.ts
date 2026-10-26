import { z } from "zod";
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

const secret = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\s\p{Cc}]+$/u);

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
    urls: z
      .array(
        z
          .string()
          .max(500)
          .regex(/^turns?:[^\s]+$/),
      )
      .min(1)
      .max(8),
    username: secret(256),
    credential: secret(512),
  }),
]);

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
 * is reused for an hour, and one request serves everyone joining at once.
 */
export function createRelaySource(
  relay: CallRelay | null,
  options: { fetch?: typeof fetch; now?: () => number; onError?: (error: RelayError) => void } = {},
) {
  const now = options.now ?? Date.now;
  let cached: { servers: IceServer[]; until: number } | null = null;
  let pending: Promise<IceServer[]> | null = null;
  let error: RelayError | null = null;
  return {
    async servers(): Promise<IceServer[]> {
      if (!relay) return [];
      if (relay.kind === "custom")
        return [{ urls: relay.urls, username: relay.username, credential: relay.credential }];
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
 * A Cloudflare relay from the environment: both its key ID and API token, or
 * neither. Any other relay goes in OWNBASE_ICE_SERVERS.
 */
export function relayFromEnvironment(
  setting: (name: string) => string | undefined,
): CallRelay | null {
  const keyId = setting("CLOUDFLARE_TURN_KEY_ID")?.trim();
  const apiToken = setting("CLOUDFLARE_TURN_API_TOKEN")?.trim();
  if (!keyId && !apiToken) return null;
  const parsed = callRelaySchema.safeParse({ kind: "cloudflare", keyId, apiToken });
  if (!parsed.success)
    throw new Error(
      "OWNBASE_CLOUDFLARE_TURN_KEY_ID and OWNBASE_CLOUDFLARE_TURN_API_TOKEN must both be set, as the TURN key's ID and its API token",
    );
  return parsed.data;
}
