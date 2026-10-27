import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspaceServer, type WorkspaceServer } from "../src/index.js";
import { CONTENT_SECURITY_POLICY, CONTENT_SECURITY_POLICY_META } from "../src/securityHeaders.js";

describe("the policy itself", () => {
  function directive(policy: string, name: string): string | undefined {
    return policy
      .split(";")
      .map((d) => d.trim())
      .find((d) => d === name || d.startsWith(`${name} `))
      ?.slice(name.length)
      .trim();
  }

  it("will not let injected markup become running code", () => {
    // The directive that matters for a chat application, whose whole job is
    // displaying text other people wrote.
    // WebAssembly the app ships may be compiled, for the call noise filter;
    // JavaScript eval may not.
    expect(directive(CONTENT_SECURITY_POLICY, "script-src")).toBe("'self' 'wasm-unsafe-eval'");
    expect(CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'");
    expect(directive(CONTENT_SECURITY_POLICY, "object-src")).toBe("'none'");
    expect(directive(CONTENT_SECURITY_POLICY, "base-uri")).toBe("'self'");
  });

  it("does not allow inline script, which the client does not use", () => {
    expect(directive(CONTENT_SECURITY_POLICY, "script-src")).not.toContain("unsafe-inline");
  });

  it("refuses to be framed", () => {
    expect(directive(CONTENT_SECURITY_POLICY, "frame-ancestors")).toBe("'none'");
  });

  it("still lets the client reach a workspace it was not served by", () => {
    // Narrowing this would break signing in to another server, which is a
    // supported thing to do rather than an accident.
    expect(directive(CONTENT_SECURITY_POLICY, "connect-src")).toContain("*");
  });

  it("leaves frame-ancestors out of the meta form, which cannot express it", () => {
    // Writing it there would be ignored rather than enforced, which reads as
    // protection that is not there.
    expect(CONTENT_SECURITY_POLICY_META).not.toContain("frame-ancestors");
    expect(CONTENT_SECURITY_POLICY_META).toContain("script-src 'self' 'wasm-unsafe-eval'");
  });
});

describe("the desktop client's copy of it", () => {
  it("says the same thing as the server sends", () => {
    // Two places, one policy. This is what keeps them from drifting apart.
    const here = dirname(fileURLToPath(import.meta.url));
    const html = readFileSync(
      resolve(here, "../../../apps/desktop/src/renderer/index.html"),
      "utf8",
    );
    // Tolerant of how the formatter chooses to lay the element out: it wraps
    // long attributes across lines, which a regex expecting them adjacent
    // would read as the element being absent.
    const found = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
    expect(
      found,
      "the desktop renderer has no Content-Security-Policy meta element",
    ).not.toBeNull();
    expect(found![1]).toBe(CONTENT_SECURITY_POLICY_META);
  });
});

describe("what the server actually sends", () => {
  let server: WorkspaceServer;
  let dataDir: string;
  let base: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "ownbase-headers-"));
    server = await createWorkspaceServer({
      dataDir,
      host: "127.0.0.1",
      port: 0,
      mdns: false,
      logger: false,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("puts the headers on an ordinary response", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("sends no referrer, so a token in a url cannot travel with a link", async () => {
    // This server puts tokens in urls — a download ticket, a webhook, a
    // response_url — and a referrer would hand one to wherever a link led.
    const res = await fetch(`${base}/api/health`);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("puts them on a refusal too, which is a response like any other", async () => {
    const res = await fetch(`${base}/api/me`);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
  });

  it("leaves a header a route set for itself alone", async () => {
    // The file routes choose their own nosniff and caching; a blanket hook must
    // add what is missing rather than overwrite what was deliberate.
    const res = await fetch(`${base}/api/files/01ABCDEFGHIJKLMNOPQRSTUVWX`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
