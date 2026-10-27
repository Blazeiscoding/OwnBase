/**
 * Paths whose last segment is a working credential rather than an identifier.
 *
 * A request log is read by whoever can read the log file, and on a hosted
 * deployment it is often shipped somewhere else entirely. A URL that carries a
 * secret therefore turns every log line into a copy of that secret, valid for
 * as long as the secret is.
 *
 * **A new route whose path or query carries a token has to be added here.**
 * Nothing detects that automatically, so it is part of writing such a route.
 */
const SECRET_PATH_PREFIXES = [
  // An invite code is what lets a stranger into an invite-only workspace, and
  // revoking one puts it in the path.
  "/api/invites/",
  // An incoming webhook's whole authority is its token, and it never expires.
  "/hooks/",
  // A response_url: thirty minutes and five uses of the right to post as a bot.
  "/api/commands/response/",
];

/**
 * Query parameters that carry a credential. Matched case-insensitively, and by
 * whole name, so an ordinary `q=token` search is not mangled.
 */
const SECRET_QUERY_PARAMS = new Set(["download", "token", "ticket", "code", "secret"]);

const MASK = "REDACTED";

/**
 * Rewrites a request URL so it can be logged without handing over what it
 * carries. The shape is kept — which route, which file, which parameters were
 * present — because that is what makes a log worth having; only the values that
 * would still work if copied are replaced.
 */
export function redactUrl(url: string): string {
  if (!url) return url;
  const queryAt = url.indexOf("?");
  let path = queryAt === -1 ? url : url.slice(0, queryAt);
  const query = queryAt === -1 ? "" : url.slice(queryAt + 1);

  for (const prefix of SECRET_PATH_PREFIXES) {
    if (path.startsWith(prefix)) {
      const rest = path.slice(prefix.length);
      // Only the segment that is the secret; anything beyond it is structure.
      const slash = rest.indexOf("/");
      path = prefix + MASK + (slash === -1 ? "" : rest.slice(slash));
      break;
    }
  }

  if (!query) return path;
  const parts = query.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    const name = eq === -1 ? pair : pair.slice(0, eq);
    let decoded: string;
    try {
      decoded = decodeURIComponent(name).toLowerCase();
    } catch {
      // Request logging runs before the handler's error boundary. A name
      // that cannot be decoded must neither throw nor expose its value in
      // a fallback log; even the malformed name may contain private data.
      return eq === -1 ? MASK : `${MASK}=${MASK}`;
    }
    return SECRET_QUERY_PARAMS.has(decoded) ? `${name}=${MASK}` : pair;
  });
  return `${path}?${parts.join("&")}`;
}

/**
 * Logger settings that keep credentials out of the log.
 *
 * Two separate leaks are covered. Pino's `redact` handles headers, which carry
 * the bearer token of every signed-in request; Fastify does not serialise
 * headers by default, but that is a default somebody can change, and a
 * redaction that is already there when they do is worth more than one added
 * afterwards. The request serialiser handles the URL, which Fastify does log,
 * and which is where this project's tokens actually are.
 */
export const LOGGER_OPTIONS = {
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      'req.headers["x-ownbase-signature"]',
      "res.headers[set-cookie]",
    ],
    remove: true,
  },
  serializers: {
    req(request: {
      method: string;
      url: string;
      routeOptions?: { url?: string };
      ip?: string;
      socket?: { remotePort?: number };
    }) {
      return {
        method: request.method,
        url: redactUrl(request.url),
        remoteAddress: request.ip,
        remotePort: request.socket?.remotePort,
      };
    },
  },
};
