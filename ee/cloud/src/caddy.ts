import type { HostedWorkspace } from "./registry.js";

export interface CaddyOptions {
  /** The domain workspaces live under, as <slug>.<domain>. */
  domain: string;
  /** Where Caddy asks whether a name may have a certificate: the control plane's /caddy/ask. */
  askUrl: string;
  /** Caddy's admin API, where the config is loaded and where it stays. */
  adminListen: string;
  /**
   * "acme" for real certificates (Let's Encrypt or ZeroSSL), "internal" for
   * Caddy's own, which only a machine told to trust them accepts (testing).
   */
  issuer: "acme" | "internal";
  /** Told to the certificate authority, for notices about the certificates. */
  email?: string;
}

/** The page a suspended workspace's address shows. */
export const SUSPENDED_PAGE = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>This workspace is paused</title>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 15vh auto; padding: 0 1rem; line-height: 1.5">
<h1 style="font-size: 1.4rem">This workspace is paused</h1>
<p>Nothing in it has been deleted. Its owner can get in touch with OwnBase to start it again.</p>
</body></html>
`;

/**
 * Caddy's whole configuration for the workspaces hosted now (P7): each
 * active workspace's address goes to its server on loopback, a suspended
 * one's shows a page saying so, and certificates are issued on demand for
 * whichever names the control plane says exist. Loaded in full each time,
 * so Caddy never drifts from the registry.
 */
export function caddyConfig(workspaces: HostedWorkspace[], opts: CaddyOptions): unknown {
  const host = (slug: string) => `${slug}.${opts.domain}`;
  const routes = workspaces.flatMap((workspace): object[] => {
    if (workspace.state === "active")
      return [
        {
          "@id": `workspace-${workspace.slug}`,
          match: [{ host: [host(workspace.slug)] }],
          handle: [
            {
              handler: "reverse_proxy",
              upstreams: [{ dial: `127.0.0.1:${workspace.port}` }],
            },
          ],
          terminal: true,
        },
      ];
    if (workspace.state === "suspended")
      return [
        {
          "@id": `workspace-${workspace.slug}`,
          match: [{ host: [host(workspace.slug)] }],
          handle: [
            {
              handler: "static_response",
              status_code: 503,
              headers: {
                "Content-Type": ["text/html; charset=utf-8"],
                "Cache-Control": ["no-store"],
              },
              body: SUSPENDED_PAGE,
            },
          ],
          terminal: true,
        },
      ];
    return [];
  });
  const issuer =
    opts.issuer === "internal"
      ? { module: "internal" }
      : { module: "acme", ...(opts.email ? { email: opts.email } : {}) };
  return {
    admin: { listen: opts.adminListen },
    apps: {
      http: {
        servers: {
          workspaces: {
            listen: [":443"],
            routes,
            // Plain HTTP only ever redirects to HTTPS, which Caddy adds itself.
          },
        },
      },
      tls: {
        automation: {
          policies: [{ issuers: [issuer], on_demand: true }],
          on_demand: { permission: { module: "http", endpoint: opts.askUrl } },
        },
      },
    },
  };
}

/** Loads a whole config into Caddy through its admin API. */
export async function loadCaddyConfig(adminUrl: string, config: unknown): Promise<void> {
  const response = await fetch(new URL("/load", adminUrl), {
    method: "POST",
    // Node's fetch says Sec-Fetch-Mode, as a browser does, and Caddy then
    // takes only a request from its own address.
    headers: { "content-type": "application/json", origin: new URL(adminUrl).origin },
    body: JSON.stringify(config),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`Caddy refused the config: ${response.status} ${await response.text()}`);
}
