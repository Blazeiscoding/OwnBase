import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createWorkspaceServer, type WorkspaceServer } from "../src/index.js";
import { redactUrl } from "../src/redact.js";

describe("redacting a url", () => {
  it("masks an incoming webhook's token, which is its whole authority", () => {
    expect(redactUrl("/hooks/wh_s3cret_value")).toBe("/hooks/REDACTED");
  });

  it("masks a response_url's token", () => {
    expect(redactUrl("/api/commands/response/rt_s3cret")).toBe("/api/commands/response/REDACTED");
  });

  it("masks a download ticket in the query without losing the rest", () => {
    expect(redactUrl("/api/files/01ABC?download=tk_s3cret")).toBe(
      "/api/files/01ABC?download=REDACTED",
    );
    expect(redactUrl("/api/files/01ABC?download=tk_s3cret&inline=1")).toBe(
      "/api/files/01ABC?download=REDACTED&inline=1",
    );
  });

  it("keeps the shape, which is the part worth logging", () => {
    // Which route, which file, which parameters were present all survive; only
    // what would still work if copied is replaced.
    expect(redactUrl("/api/channels/01CHAN/messages?limit=50&before=01MSG")).toBe(
      "/api/channels/01CHAN/messages?limit=50&before=01MSG",
    );
    expect(redactUrl("/api/files/01ABC")).toBe("/api/files/01ABC");
    expect(redactUrl("/")).toBe("/");
    expect(redactUrl("")).toBe("");
  });

  it("does not mangle a search that merely mentions a token", () => {
    // `q` is somebody's search text, not a credential.
    expect(redactUrl("/api/search?q=token")).toBe("/api/search?q=token");
  });

  it("masks only the secret segment, not what follows it", () => {
    expect(redactUrl("/hooks/wh_s3cret/extra")).toBe("/hooks/REDACTED/extra");
  });

  it("matches a parameter name whatever its case", () => {
    expect(redactUrl("/api/files/01ABC?Download=tk_s3cret")).toBe(
      "/api/files/01ABC?Download=REDACTED",
    );
  });

  it("masks undecodable names and values, including pairs without an equals sign", () => {
    expect(redactUrl("/api/health?%=private&%E0%A4=private&%bad&limit=5")).toBe(
      "/api/health?REDACTED=REDACTED&REDACTED=REDACTED&REDACTED&limit=5",
    );
    expect(redactUrl("/api/health?%74oken=private&DOWNLOAD&empty=&q=notes")).toBe(
      "/api/health?%74oken=REDACTED&DOWNLOAD=REDACTED&empty=&q=notes",
    );
  });

  it("keeps a logged real process serving after malformed query encodings", async () => {
    const serverModule = new URL("../src/server.ts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
        import { createWorkspaceServer } from ${JSON.stringify(serverModule)};
        import { Writable } from "node:stream";
        const lines = [];
        const stream = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
        const server = await createWorkspaceServer({ dataDir: ":memory:", host: "127.0.0.1", port: 0, mdns: false, logger: { stream } });
        try {
          const base = "http://127.0.0.1:" + server.port;
          const statuses = [];
          for (const query of ["?%=fixture-value", "?%E0%A4=fixture-value", "?%bad", "?%74oken=fixture-value", ""]) {
            const response = await fetch(base + "/api/health" + query, { signal: AbortSignal.timeout(3000) });
            statuses.push(response.status);
            await response.text();
          }
          console.log(JSON.stringify({ statuses, leaked: lines.join("").includes("fixture-value") }));
        } finally { await server.stop(); }
      `,
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      errors = "";
    child.stdout!.on("data", (chunk) => (output += String(chunk)));
    child.stderr!.on("data", (chunk) => (errors += String(chunk)));
    const timer = setTimeout(() => child.kill(), 12_000);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    }).finally(() => clearTimeout(timer));
    expect({ code, errors }).toEqual({ code: 0, errors: "" });
    expect(JSON.parse(output)).toEqual({ statuses: [200, 200, 200, 200, 200], leaked: false });
  }, 15_000);
});

describe("what actually reaches the log", () => {
  let server: WorkspaceServer | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it("writes no working credential, in a path, a query or a header", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });

    dataDir = mkdtempSync(join(tmpdir(), "ownbase-redact-"));
    server = await createWorkspaceServer({
      dataDir,
      host: "127.0.0.1",
      port: 0,
      mdns: false,
      logger: { stream },
    });
    const base = `http://127.0.0.1:${server.port}`;

    const registered = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "owner", displayName: "Owner", password: "password123" }),
    });
    const token = ((await registered.json()) as { token: string }).token;

    // One request of each shape that carries a secret. None has to succeed:
    // what is being checked is what the logger wrote on the way past.
    const webhookSecret = "wh-secret-should-not-appear";
    const responseSecret = "rt-secret-should-not-appear";
    const downloadSecret = "dl-secret-should-not-appear";
    await fetch(`${base}/hooks/${webhookSecret}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    await fetch(`${base}/api/commands/response/${responseSecret}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await fetch(`${base}/api/files/01ABCDEFGHIJKLMNOPQRSTUVWX?download=${downloadSecret}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });

    await new Promise((r) => setTimeout(r, 100));
    const log = lines.join("");
    expect(log.length).toBeGreaterThan(0);

    for (const secret of [webhookSecret, responseSecret, downloadSecret, token]) {
      expect(log).not.toContain(secret);
    }
    // Still a useful log: the routes that were called are all there. The file
    // route in particular is logged rather than silenced, which is what makes
    // redaction worth more than suppression.
    expect(log).toContain("/hooks/REDACTED");
    expect(log).toContain("/api/commands/response/REDACTED");
    expect(log).toContain("download=REDACTED");
    expect(log).toContain("/api/me");
  });
});
