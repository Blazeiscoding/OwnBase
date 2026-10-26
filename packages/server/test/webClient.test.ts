import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { createWorkspaceServer, type WorkspaceServer } from "../src/index.js";
import { CONTENT_SECURITY_POLICY } from "../src/securityHeaders.js";
import {
  HASHED_ASSET_CACHE,
  REVALIDATED_CACHE,
  isMissingAsset,
  webCacheControl,
} from "../src/webClient.js";

/**
 * The browser client as the server sends it (REV-13): each text file in the
 * encoding the browser accepts, from copies the build wrote beside it, the
 * hashed files cached for good and the page asked about every time.
 */
const ENTRY = "assets/index-Abc123.js";
const STYLE = "assets/index-Def456.css";
const entry = `export const greeting = ${JSON.stringify("hello ".repeat(400))};\n`;
const style = `body { color: red; }\n`.repeat(80);
const page = `<!doctype html><html><head><script type="module" src="/${ENTRY}"></script></head><body></body></html>`;

interface Raw {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** A request without fetch's own decoding, so the bytes on the wire can be read. */
function get(url: string, headers: Record<string, string> = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

function decoded(res: Raw): string {
  const encoding = res.headers["content-encoding"];
  if (encoding === "br") return brotliDecompressSync(res.body).toString("utf8");
  if (encoding === "gzip") return gunzipSync(res.body).toString("utf8");
  expect(encoding).toBeUndefined();
  return res.body.toString("utf8");
}

describe("which files are cached for good", () => {
  const root = join(tmpdir(), "web");

  it("keeps the build's hashed files, compressed copies included", () => {
    expect(webCacheControl(root, join(root, ENTRY))).toBe(HASHED_ASSET_CACHE);
    expect(webCacheControl(root, join(root, `${ENTRY}.br`))).toBe(HASHED_ASSET_CACHE);
    expect(webCacheControl(`${root}/`, join(root, STYLE))).toBe(HASHED_ASSET_CACHE);
  });

  it("asks about the page and anything not under assets/ every time", () => {
    expect(webCacheControl(root, join(root, "index.html"))).toBe(REVALIDATED_CACHE);
    expect(webCacheControl(root, join(root, "index.html.br"))).toBe(REVALIDATED_CACHE);
    expect(webCacheControl(root, join(root, "ownbase.svg"))).toBe(REVALIDATED_CACHE);
    expect(webCacheControl(root, join(root, "assets"))).toBe(REVALIDATED_CACHE);
    expect(webCacheControl(root, join(root, "..", "assets", "x.js"))).toBe(REVALIDATED_CACHE);
  });

  it("treats only build paths as missing files, not pages", () => {
    expect(isMissingAsset("/assets/index-Gone99.js")).toBe(true);
    expect(isMissingAsset("/assets/index-Gone99.js?x=1")).toBe(true);
    expect(isMissingAsset("/")).toBe(false);
    expect(isMissingAsset("/join")).toBe(false);
    expect(isMissingAsset("/assetsx/a.js")).toBe(false);
  });
});

describe("the browser client served by the workspace server", () => {
  let server: WorkspaceServer;
  let dataDir: string;
  let webDir: string;
  let base: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "slackoss-web-data-"));
    webDir = mkdtempSync(join(tmpdir(), "slackoss-web-dist-"));
    mkdirSync(join(webDir, "assets"));
    writeFileSync(join(webDir, "index.html"), page);
    writeFileSync(join(webDir, ENTRY), entry);
    writeFileSync(join(webDir, `${ENTRY}.br`), brotliCompressSync(entry));
    writeFileSync(join(webDir, `${ENTRY}.gz`), gzipSync(entry));
    // A file the build left uncompressed is still sent, as it is.
    writeFileSync(join(webDir, STYLE), style);
    server = await createWorkspaceServer({
      dataDir,
      host: "127.0.0.1",
      port: 0,
      mdns: false,
      logger: false,
      webDistPath: webDir,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(webDir, { recursive: true, force: true });
  });

  it("sends Brotli, gzip or the file itself, decoding to the same script", async () => {
    const br = await get(`${base}/${ENTRY}`, { "accept-encoding": "gzip, deflate, br" });
    const gz = await get(`${base}/${ENTRY}`, { "accept-encoding": "gzip" });
    const plain = await get(`${base}/${ENTRY}`, { "accept-encoding": "identity" });
    const none = await get(`${base}/${ENTRY}`);
    expect(br.headers["content-encoding"]).toBe("br");
    expect(gz.headers["content-encoding"]).toBe("gzip");
    for (const res of [br, gz, plain, none]) {
      expect(res.status).toBe(200);
      expect(decoded(res)).toBe(entry);
      expect(res.headers["content-type"]).toMatch(/^text\/javascript|^application\/javascript/);
      expect(String(res.headers.vary).toLowerCase()).toContain("accept-encoding");
      expect(res.headers["cache-control"]).toBe(HASHED_ASSET_CACHE);
      expect(res.headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers.etag).toBeTruthy();
    }
    expect(br.body.length).toBeLessThan(gz.body.length);
    expect(gz.body.length).toBeLessThan(plain.body.length);
  });

  it("sends a file with no compressed copy as it is, still varying by encoding", async () => {
    const res = await get(`${base}/${STYLE}`, { "accept-encoding": "br, gzip" });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(decoded(res)).toBe(style);
    expect(res.headers["content-type"]).toMatch(/^text\/css/);
    expect(String(res.headers.vary).toLowerCase()).toContain("accept-encoding");
    expect(res.headers["cache-control"]).toBe(HASHED_ASSET_CACHE);
  });

  it("has the page asked about every time, and answers 304 while it is unchanged", async () => {
    const first = await get(`${base}/`, { "accept-encoding": "br" });
    expect(first.status).toBe(200);
    expect(first.body.toString("utf8")).toBe(page);
    expect(first.headers["cache-control"]).toBe(REVALIDATED_CACHE);
    const etag = String(first.headers.etag);
    const again = await get(`${base}/`, { "accept-encoding": "br", "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
  });

  it("sends a new build's page, naming its new files, to a browser holding the old one", async () => {
    const first = await get(`${base}/`);
    const rebuilt = page.replace("index-Abc123.js", "index-Xyz789012.js");
    writeFileSync(join(webDir, "index.html"), rebuilt);
    try {
      const again = await get(`${base}/`, { "if-none-match": String(first.headers.etag) });
      expect(again.status).toBe(200);
      expect(again.body.toString("utf8")).toBe(rebuilt);
    } finally {
      writeFileSync(join(webDir, "index.html"), page);
    }
  });

  it("serves the page, uncached, for a link into the app", async () => {
    const res = await get(`${base}/join?code=abc`);
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toBe(page);
    expect(res.headers["cache-control"]).toBe(REVALIDATED_CACHE);
  });

  it("answers a build file that is not there with a 404, not the page", async () => {
    const res = await get(`${base}/assets/index-Gone99.js`, { "accept-encoding": "br" });
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(res.body.toString("utf8"))).toEqual({ error: "not_found" });
  });

  it("leaves the API's own answers alone", async () => {
    const res = await get(`${base}/api/health`, { "accept-encoding": "br" });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.headers["cache-control"]).not.toBe(HASHED_ASSET_CACHE);
  });
});
