import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ControlPlane } from "./controlPlane.js";

const HELP = `ownbase-cloud: OwnBase's hosting control plane

Usage: ownbase-cloud --data <dir> --domain <domain> [options]

  --data <dir>          Holds control.db, workspaces/<slug>/ and exports/
  --domain <domain>     Workspaces live at https://<slug>.<domain>
  --listen <host:port>  The operator API, and where Caddy asks about a name
                        (default 127.0.0.1:8100). Keep it on loopback: only
                        the operator and Caddy use it
  --server <file>       The OwnBase server bundle (default: ownbase-server.js
                        beside this file)
  --ports <from-to>     Loopback ports for workspace servers (default 20000-29999)
  --caddy-admin <url>   Caddy's admin API (default http://127.0.0.1:2019), or
                        "off" to leave Caddy alone
  --tls <acme|internal> Real certificates, or Caddy's own for a test machine
                        (default acme)
  --email <address>     Given to the certificate authority
  --upgrade-url <url>   Where an owner past the plan's members chooses a bigger one

The operator's token: OWNBASE_CLOUD_TOKEN, or OWNBASE_CLOUD_TOKEN_FILE naming
a file that holds it, at least 32 characters. Workspace servers are given
OWNBASE_ICE_SERVERS and OWNBASE_CLOUDFLARE_TURN_KEY_ID / _API_TOKEN from this
process's environment, for calls between networks.
`;

function fail(message: string): never {
  console.error(`\n  ${message}\n\n  Run ownbase-cloud --help to see the options.\n`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    domain: { type: "string" },
    listen: { type: "string", default: "127.0.0.1:8100" },
    server: { type: "string" },
    ports: { type: "string", default: "20000-29999" },
    "caddy-admin": { type: "string", default: "http://127.0.0.1:2019" },
    tls: { type: "string", default: "acme" },
    email: { type: "string" },
    "upgrade-url": { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(HELP);
  process.exit(0);
}

if (!values.data) fail("--data is needed: where the control plane keeps its workspaces");
const domain = values.domain?.trim().toLowerCase() ?? "";
if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain))
  fail(
    `--domain needs the domain workspaces live under, such as ownbase.chat, not "${values.domain ?? ""}"`,
  );
const listen = /^([^:]+):(\d+)$/.exec(values.listen);
if (!listen) fail(`--listen needs host:port, not "${values.listen}"`);
const ports = /^(\d+)-(\d+)$/.exec(values.ports);
const from = Number(ports?.[1]);
const to = Number(ports?.[2]);
if (!ports || from < 1024 || to > 65535 || from > to)
  fail(`--ports needs a range such as 20000-29999, not "${values.ports}"`);
if (values.tls !== "acme" && values.tls !== "internal")
  fail(`--tls is acme or internal, not "${values.tls}"`);

let token = process.env.OWNBASE_CLOUD_TOKEN;
if (!token && process.env.OWNBASE_CLOUD_TOKEN_FILE) {
  try {
    token = readFileSync(process.env.OWNBASE_CLOUD_TOKEN_FILE, "utf8").trim();
  } catch (error) {
    fail(`OWNBASE_CLOUD_TOKEN_FILE could not be read (${(error as NodeJS.ErrnoException).code})`);
  }
}
if (!token || token.length < 32)
  fail(
    "The operator's token is needed: OWNBASE_CLOUD_TOKEN or OWNBASE_CLOUD_TOKEN_FILE, 32 characters or more",
  );

const bundle = resolve(
  values.server ?? join(dirname(fileURLToPath(import.meta.url)), "ownbase-server.js"),
);
const host = listen[1]!;
const port = Number(listen[2]);
const caddyAdmin = values["caddy-admin"];

const plane = new ControlPlane({
  dataDir: resolve(values.data),
  domain,
  server: { command: process.execPath, args: [bundle] },
  token,
  ports: { from, to },
  listen: { host, port },
  caddy:
    caddyAdmin === "off"
      ? null
      : {
          adminUrl: caddyAdmin,
          adminListen: new URL(caddyAdmin).host,
          issuer: values.tls,
          ...(values.email ? { email: values.email } : {}),
        },
  ...(values["upgrade-url"] ? { upgradeUrl: values["upgrade-url"] } : {}),
  log: (message) => console.log(`  ${message}`),
});

await plane.app.listen({ host, port });
console.log(`\n  OwnBase control plane on http://${host}:${port}, workspaces at *.${domain}`);
await plane.start();
console.log(
  `  ${plane.registry.list().filter((w) => w.state === "active").length} workspaces running\n`,
);

// Caddy started again without its last config (no --resume) would forget
// the workspaces until the next change; told again every few minutes.
const resync = setInterval(() => {
  void plane.tellCaddy();
}, 5 * 60_000);
resync.unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    clearInterval(resync);
    void plane.stop().then(() => process.exit(0));
  });
}
