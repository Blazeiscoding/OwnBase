import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * GET /metrics for whoever keeps the server running (G15): there only when
 * the host gives a token, answered only to that token, and only counts.
 */
const TOKEN = "metrics-token-for-the-tests";
let server: WorkspaceServer | undefined;
let directory: string | undefined;
let base: string;
const sockets: WebSocket[] = [];

async function start(metricsToken?: string) {
  directory = mkdtempSync(join(tmpdir(), "ownbase-metrics-"));
  server = await createWorkspaceServer({
    dataDir: directory,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits: false,
    ...(metricsToken === undefined ? {} : { metricsToken }),
  });
  base = `http://127.0.0.1:${server.port}`;
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  await server?.stop();
  server = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

const scrape = (token: string | null = TOKEN) =>
  fetch(`${base}/metrics`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

/** The samples of a scrape, by name and labels as written, such as `a{b="c"}`. */
async function samples() {
  const response = await scrape();
  expect(response.status).toBe(200);
  const text = await response.text();
  const values = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const at = line.lastIndexOf(" ");
    values.set(line.slice(0, at), Number(line.slice(at + 1)));
  }
  return { text, values };
}

async function json<T>(path: string, token: string | null, body?: unknown, method = "POST") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok, `${method} ${path} answered ${response.status}`).toBe(true);
  return (await response.json()) as T;
}

/** Opens a signed-in socket and resolves once it is caught up. */
function connect(token: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
    sockets.push(ws);
    ws.on("open", () =>
      ws.send(
        JSON.stringify({ type: "hello", token, lastSeq: null, protocolVersion: PROTOCOL_VERSION }),
      ),
    );
    ws.on("message", (data) => {
      if ((JSON.parse(String(data)) as { type: string }).type === "synced") resolve(ws);
    });
    ws.on("error", reject);
  });
}

describe("the metrics address", () => {
  it("does not exist unless the host gives a token", async () => {
    await start();
    expect((await scrape()).status).toBe(404);
  });

  it("answers only the host's token", async () => {
    await start(TOKEN);
    const without = await scrape(null);
    expect(without.status).toBe(401);
    expect(without.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect((await scrape("metrics-token-for-the-test")).status).toBe(401);
    expect((await scrape(`${TOKEN}x`)).status).toBe(401);

    const right = await scrape();
    expect(right.status).toBe(200);
    expect(right.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(right.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses a short token at start", async () => {
    await expect(start("too-short")).rejects.toThrow(/at least 16 characters/);
    await expect(start("has a space in the middle")).rejects.toThrow(/without spaces/);
  });
});

describe("what it counts", () => {
  it("has each metric, moving when the thing it counts happens", async () => {
    await start(TOKEN);
    const before = (await samples()).values;
    expect(before.get("ownbase_signed_in_sessions")).toBe(0);
    expect(before.get("ownbase_open_sockets")).toBe(0);
    expect(before.get("ownbase_huddles")).toBe(0);
    expect(before.get("ownbase_files_stored")).toBe(0);
    expect(before.get("ownbase_database_bytes")).toBeGreaterThan(0);
    expect(before.get("ownbase_backups_enabled")).toBe(0);
    expect(before.get('ownbase_app_deliveries{state="waiting"}')).toBe(0);
    expect(before.get('ownbase_scheduled_messages{state="queued"}')).toBe(0);

    const { token } = await json<{ token: string }>("/api/auth/register", null, {
      handle: "alice",
      displayName: "Alice Example",
      password: "password123",
    });
    const { channels } = await json<{ channels: { id: string; name: string }[] }>(
      "/api/channels",
      token,
      undefined,
      "GET",
    );
    const general = channels.find((c) => c.name === "general")!.id;
    await json(`/api/channels/${general}/messages`, token, { text: "a secret plan" });

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(2048)]), "notes.bin");
    const upload = await fetch(`${base}/api/channels/${general}/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    expect(upload.ok).toBe(true);

    const ws = await connect(token);
    const joined = new Promise<void>((resolve) =>
      ws.on("message", (data) => {
        const frame = JSON.parse(String(data)) as { type: string; event?: { type: string } };
        if (frame.type === "ephemeral" && frame.event?.type === "huddle.join.result") resolve();
      }),
    );
    ws.send(JSON.stringify({ type: "huddle.join", channelId: general, requestId: "r1" }));
    await joined;

    const { text, values: after } = await samples();
    expect(after.get("ownbase_signed_in_sessions")).toBe(1);
    expect(after.get("ownbase_open_sockets")).toBe(1);
    expect(after.get("ownbase_connected_people")).toBe(1);
    expect(after.get("ownbase_huddles")).toBe(1);
    expect(after.get("ownbase_huddle_people")).toBe(1);
    expect(after.get("ownbase_files_stored")).toBe(1);
    expect(after.get("ownbase_files_stored_bytes")).toBe(2048);
    expect(after.get("ownbase_events_written_total")).toBeGreaterThan(
      before.get("ownbase_events_written_total")!,
    );

    // Requests by the route's pattern, never the address asked for.
    expect(
      after.get(
        'ownbase_http_requests_total{method="POST",route="/api/channels/:id/messages",code="201"}',
      ),
    ).toBe(1);
    expect(
      after.get(
        'ownbase_http_request_duration_seconds_count{method="POST",route="/api/channels/:id/messages"}',
      ),
    ).toBe(1);
    expect(
      after.get(
        'ownbase_http_request_duration_seconds_bucket{method="POST",route="/api/channels/:id/messages",le="+Inf"}',
      ),
    ).toBe(1);
    expect(after.get('ownbase_http_requests_total{method="GET",route="/metrics",code="200"}')).toBe(
      1,
    );

    // Counts only: nobody's name, handle, id or words.
    for (const secret of ["alice", "Alice Example", "a secret plan", "notes.bin", general, token])
      expect(text).not.toContain(secret);

    ws.close();
  });

  it("counts an address no route has under one name", async () => {
    await start(TOKEN);
    await fetch(`${base}/api/nothing/here/01ARZ3NDEKTSV4RRFFQ69G5FAV`);
    await fetch(`${base}/somewhere-else`);
    const { text, values } = await samples();
    expect(
      values.get('ownbase_http_requests_total{method="GET",route="unmatched",code="404"}'),
    ).toBe(2);
    expect(text).not.toContain("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  it("writes every family with its HELP and TYPE, in the text format", async () => {
    await start(TOKEN);
    const { text } = await samples();
    const lines = text.trimEnd().split("\n");
    const declared = new Set<string>();
    for (const line of lines) {
      const type = /^# TYPE (\S+) (gauge|counter|histogram)$/.exec(line);
      if (type) declared.add(type[1]!);
      else if (!line.startsWith("# HELP "))
        expect(line).toMatch(/^[a-z_]+(\{[a-z_]+="[^"]*"(,[a-z_]+="[^"]*")*\})? [0-9.e+-]+$/);
    }
    for (const line of lines.filter((l) => !l.startsWith("#"))) {
      const name = line.split(/[{ ]/)[0]!.replace(/_(bucket|sum|count)$/, "");
      expect(declared.has(name) || declared.has(line.split(/[{ ]/)[0]!), line).toBe(true);
    }
    expect(text.endsWith("\n")).toBe(true);
  });
});
