import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "../src/index.js";
import { isLoopbackOrigin, originFromConnection, resolveClientAddress } from "../src/netTrust.js";

describe("where the server thinks it is", () => {
  it("uses the address the connection arrived on", () => {
    expect(originFromConnection("192.168.1.5", 8543)).toBe("http://192.168.1.5:8543");
    expect(originFromConnection("127.0.0.1", 3000)).toBe("http://127.0.0.1:3000");
  });

  it("unwraps an IPv4 address that arrived mapped into IPv6", () => {
    expect(originFromConnection("::ffff:127.0.0.1", 80)).toBe("http://127.0.0.1:80");
  });

  it("brackets a real IPv6 address, which a URL requires", () => {
    expect(originFromConnection("::1", 8543)).toBe("http://[::1]:8543");
  });
});

describe("recognising this machine's own browser", () => {
  it("accepts the page this server served", () => {
    expect(isLoopbackOrigin("http://localhost:8543", 8543)).toBe(true);
    expect(isLoopbackOrigin("http://127.0.0.1:8543", 8543)).toBe(true);
    expect(isLoopbackOrigin("http://[::1]:8543", 8543)).toBe(true);
  });

  it("rejects a page served from anywhere else", () => {
    expect(isLoopbackOrigin("https://evil.example.com", 8543)).toBe(false);
    expect(isLoopbackOrigin("http://evil.example.com:8543", 8543)).toBe(false);
    // A hostname that merely ends in something loopback-looking is not it.
    expect(isLoopbackOrigin("http://notlocalhost:8543", 8543)).toBe(false);
    expect(isLoopbackOrigin("http://localhost.evil.com:8543", 8543)).toBe(false);
  });

  it("rejects another service on this same machine", () => {
    // Loopback is not one trust boundary: a different port is a different
    // program, which has no business claiming this workspace.
    expect(isLoopbackOrigin("http://localhost:9999", 8543)).toBe(false);
  });

  it("rejects what is not a URL at all", () => {
    expect(isLoopbackOrigin("null", 8543)).toBe(false);
    expect(isLoopbackOrigin("", 8543)).toBe(false);
  });
});

describe("resolving a rate-limit identity", () => {
  it("uses Cloudflare's address only for an explicitly trusted loopback proxy", () => {
    const headers = {
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "198.51.100.4",
    };
    expect(resolveClientAddress("::ffff:127.0.0.1", headers, "loopback")).toBe("203.0.113.7");
    expect(resolveClientAddress("::ffff:127.0.0.1", headers)).toBe("127.0.0.1");
  });

  it("never trusts forwarding headers sent by a direct LAN client", () => {
    expect(
      resolveClientAddress(
        "192.168.1.40",
        { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.4" },
        "loopback",
      ),
    ).toBe("192.168.1.40");
  });

  it("falls back to the proxy-added end of X-Forwarded-For", () => {
    expect(
      resolveClientAddress("127.0.0.2", { "x-forwarded-for": "spoofed, 2001:db8::5" }, "loopback"),
    ).toBe("2001:db8::5");
  });

  it("falls back to the socket peer for malformed forwarded addresses", () => {
    expect(
      resolveClientAddress(
        "::1",
        { "cf-connecting-ip": "not-an-ip", "x-forwarded-for": "also-invalid" },
        "loopback",
      ),
    ).toBe("::1");
  });
});

describe("claiming a workspace that has no owner", () => {
  let server: WorkspaceServer | undefined;
  let dataDir: string | undefined;
  let base = "";

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  async function start() {
    dataDir = mkdtempSync(join(tmpdir(), "ownbase-claim-"));
    server = await createWorkspaceServer({
      dataDir,
      host: "127.0.0.1",
      port: 0,
      mdns: false,
      logger: false,
    });
    base = `http://127.0.0.1:${server.port}`;
    expect(server.claimCode).toBeTruthy();
  }

  function register(headers: Record<string, string>, claimCode?: string) {
    return fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        handle: "owner",
        displayName: "Owner",
        password: "password123",
        ...(claimCode ? { claimCode } : {}),
      }),
    });
  }

  it("refuses a page the owner merely visited, arriving from loopback", async () => {
    await start();
    // The request really is from this machine: it is the browser of whoever is
    // sitting at it. What it is not is something they meant to do.
    const refused = await register({ origin: "https://evil.example.com" });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("claim_required");
  });

  it("still lets the page this server served claim it", async () => {
    await start();
    const accepted = await register({ origin: base });
    expect(accepted.status).toBe(201);
  });

  it("still lets a request with no browser behind it claim it", async () => {
    await start();
    // curl, the CLI, the desktop app: none of them send an Origin.
    const accepted = await register({});
    expect(accepted.status).toBe(201);
  });

  it("requires the claim code when a loopback proxy marks a command-line request as remote", async () => {
    await start();
    const refused = await register({ "cf-connecting-ip": "203.0.113.25" });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("claim_required");
  });

  it("lets a visited page through only with the claim code, as from anywhere else", async () => {
    await start();
    const accepted = await register({ origin: "https://evil.example.com" }, server!.claimCode!);
    expect(accepted.status).toBe(201);
  });
});

describe("the url handed to an app", () => {
  let server: WorkspaceServer | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  async function responseUrlFor(
    opts: { publicUrl?: string; trustProxy?: boolean },
    headers: Record<string, string>,
  ) {
    dataDir = mkdtempSync(join(tmpdir(), "ownbase-origin-"));
    server = await createWorkspaceServer({
      dataDir,
      host: "127.0.0.1",
      port: 0,
      mdns: false,
      logger: false,
      allowPrivateHooks: true,
      ...opts,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const reg = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // A configured public URL means this is a served workspace, so even the
      // first account needs the claim code its host printed.
      body: JSON.stringify({
        handle: "alice",
        displayName: "Alice",
        password: "password123",
        ...(server.claimCode ? { claimCode: server.claimCode } : {}),
      }),
    });
    const token = ((await reg.json()) as { token: string }).token;

    // A stub that records the response_url it was handed and answers nothing.
    let seen = "";
    const { createServer } = await import("node:http");
    const stub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen =
          new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("response_url") ?? "";
        res.writeHead(200, { "content-type": "application/json" });
        res.end("");
      });
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    const stubPort = (stub.address() as { port: number }).port;

    const app = await (
      await fetch(`${base}/api/apps`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "Origin Bot" }),
      })
    ).json();
    await fetch(`${base}/api/apps/${(app as { app: { id: string } }).app.id}/commands`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ command: "/where", url: `http://127.0.0.1:${stubPort}/cmd` }),
    });
    const channelId = server.store.getChannelByName("general")!.id;
    // Raw http rather than fetch: `Host` is a forbidden header there and is
    // dropped silently, which would make the forged-Host case prove nothing.
    const { request } = await import("node:http");
    const body = JSON.stringify({ text: "/where now" });
    await new Promise<void>((resolve, reject) => {
      const call = request(
        {
          host: "127.0.0.1",
          port: server!.port,
          path: `/api/channels/${channelId}/commands`,
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            ...headers,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        },
      );
      call.on("error", reject);
      call.end(body);
    });
    await new Promise<void>((r) => stub.close(() => r()));
    return seen;
  }

  it("ignores a forged Host, which would send the app's reply elsewhere", async () => {
    // The url carries a token and is where the app posts what it wants to say.
    // Letting the caller choose it means choosing where both of those go.
    const url = await responseUrlFor({}, { host: "evil.example.com" });
    expect(url).not.toContain("evil.example.com");
    expect(url).toContain("127.0.0.1");
  });

  it("ignores forwarded headers from a server that has no proxy", async () => {
    const url = await responseUrlFor(
      {},
      { "x-forwarded-host": "evil.example.com", "x-forwarded-proto": "https" },
    );
    expect(url).not.toContain("evil.example.com");
  });

  it("believes them once a proxy has been declared", async () => {
    const url = await responseUrlFor(
      { trustProxy: true },
      { "x-forwarded-host": "chat.team.dev", "x-forwarded-proto": "https" },
    );
    expect(url.startsWith("https://chat.team.dev/")).toBe(true);
  });

  it("builds on an address published under a path, without doubling the slash", async () => {
    const url = await responseUrlFor({ publicUrl: "https://example.com/chat/" }, {});
    expect(url.startsWith("https://example.com/chat/api/commands/response/")).toBe(true);
  });

  it("prefers the configured address over anything a header claims", async () => {
    const url = await responseUrlFor(
      { publicUrl: "https://chat.team.dev", trustProxy: true },
      { "x-forwarded-host": "evil.example.com" },
    );
    expect(url.startsWith("https://chat.team.dev/")).toBe(true);
  });

  it("tells clients the configured address, so the links people share carry it", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "ownbase-origin-"));
    server = await createWorkspaceServer({
      dataDir,
      host: "127.0.0.1",
      port: 0,
      mdns: false,
      logger: false,
      publicUrl: "https://chat.team.dev/",
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/api/server-info`);
    expect(((await response.json()) as { publicUrl?: string }).publicUrl).toBe(
      "https://chat.team.dev",
    );
  });
});
