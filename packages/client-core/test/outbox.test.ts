import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { Api, ApiError, WorkspaceClient } from "../src/index.js";
import type { WorkspaceState } from "../src/index.js";

/**
 * A send that does not go through stays in the outbox with its words and
 * files, says why in words the author can act on, and sends once on retry.
 */
let server: WorkspaceServer;
let base: string;
let dataDir: string;
let token: string;
let general: string;

function until(
  client: WorkspaceClient,
  predicate: (s: WorkspaceState) => boolean,
  label = "condition",
  timeoutMs = 5000,
): Promise<WorkspaceState> {
  return new Promise((resolve, reject) => {
    if (predicate(client.state)) return resolve(client.state);
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);
    const unsubscribe = client.store.subscribe((s) => {
      if (predicate(s)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(s);
      }
    });
  });
}

async function online() {
  const client = new WorkspaceClient(base, token);
  onTestFinished(() => client.destroy());
  client.connect();
  await until(client, (s) => s.status === "online", "connection");
  return client;
}

const failed = (s: WorkspaceState) => s.pending.find((p) => p.failed);

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-outbox-"));
  server = await createWorkspaceServer({
    dataDir,
    port: 0,
    mdns: false,
    rateLimits: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  token = (
    await new Api(base).register({ handle: "sam", displayName: "Sam", password: "password123" })
  ).token;
  general = server.store.channels.byName("general")!.id;
});

afterAll(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("a send that does not go through", () => {
  it("keeps the words and files, and says the workspace is full", async () => {
    const client = await online();
    // Uploads go through XMLHttpRequest for its progress events, which Node
    // lacks, so the upload is refused here as the server refuses one past its cap.
    const upload = vi
      .spyOn(client.api, "uploadFile")
      .mockRejectedValue(new ApiError(507, "storage_quota_exceeded"));
    const file = new File([new Uint8Array(200).fill(1)], "too-big.bin", {
      type: "application/octet-stream",
    });
    client.send(general, "The spreadsheet", { files: [file] });

    const state = await until(client, (s) => !!failed(s), "the refusal");
    expect(failed(state)).toMatchObject({
      text: "The spreadsheet",
      failureReason:
        "The workspace has no room left for files. Ask whoever hosts it to free space or raise the limit, then press Retry.",
      attachments: [{ name: "too-big.bin", size: 200 }],
      uploadProgress: null,
    });
    expect(upload).toHaveBeenCalledOnce();
    expect(server.store.messages.list({ channelId: general, limit: 10 })).toHaveLength(0);

    // The file is still there to try again with.
    upload.mockClear();
    client.retrySend(failed(state)!.nonce);
    await until(client, (s) => !!failed(s), "the second refusal");
    expect(upload.mock.calls[0]![1]).toBe(file);
  });

  it("sends exactly once when retried after what stopped it is cleared", async () => {
    const client = await online();
    server.store.channels.update(general, { archived: true });
    onTestFinished(() => void server.store.channels.update(general, { archived: false }));
    client.send(general, "Once the room reopens");

    const state = await until(client, (s) => !!failed(s), "the refusal");
    const entry = failed(state)!;
    expect(entry.failureReason).toBe("This conversation is archived.");
    expect(entry.text).toBe("Once the room reopens");

    server.store.channels.update(general, { archived: false });
    client.retrySend(entry.nonce);
    await until(client, (s) => s.pending.length === 0, "the retry");
    expect(
      server.store.messages
        .list({ channelId: general, limit: 10 })
        .filter((m) => m.text === "Once the room reopens"),
    ).toHaveLength(1);
    // A second retry of something already sent does nothing.
    client.retrySend(entry.nonce);
    expect(client.state.pending).toHaveLength(0);
  });

  it("says the workspace could not be reached, and that it sends again once back", async () => {
    const client = await online();
    const self = client.state.self!;
    // A client whose server went away: same account, nobody listening.
    const away = new WorkspaceClient("http://127.0.0.1:9", token);
    onTestFinished(() => away.destroy());
    away.store.setState({ self, status: "online" });
    away.send(general, "Written on the train");
    const state = await until(away, (s) => !!failed(s), "the failure");
    expect(failed(state)).toMatchObject({
      text: "Written on the train",
      failureReason: "Could not reach the workspace. It is sent again once you're back online.",
    });
    expect(client.state.pending).toHaveLength(0);
  });

  it("says a file that could not go up was lost on the way, not refused", async () => {
    const client = await online();
    // What the upload's XHR gives on a dropped connection, and on its timeout.
    for (const code of ["network_error", "upload_timeout"] as const) {
      vi.spyOn(client.api, "uploadFile").mockRejectedValueOnce(new ApiError(0, code));
      client.send(general, `With a file (${code})`, {
        files: [new File(["hello"], "notes.txt", { type: "text/plain" })],
      });
      const state = await until(client, (s) => !!failed(s), `the ${code}`);
      expect(failed(state)).toMatchObject({
        refused: false,
        failureReason: "Could not reach the workspace. It is sent again once you're back online.",
      });
      client.discardSend(failed(state)!.nonce);
    }
  });

  it("sends what came too fast again by itself, once the wait is over", async () => {
    const client = await online();
    vi.spyOn(client.api, "sendMessage").mockRejectedValueOnce(
      new ApiError(429, "too_many_requests", undefined, 300),
    );
    client.send(general, "One of many");
    const state = await until(client, (s) => !!failed(s), "the rate limit");
    expect(failed(state)).toMatchObject({
      refused: false,
      failureReason: "Too much sent at once. It is sent again in a moment.",
    });
    await until(client, (s) => s.pending.length === 0, "the send going again");
    expect(
      server.store.messages
        .list({ channelId: general, limit: 10 })
        .filter((m) => m.text === "One of many"),
    ).toHaveLength(1);
  });

  it("waits as long as a rate-limited server says, then sends each once", async () => {
    // Two at once, then two a second: the burst of five a person can paste.
    const limitedDir = mkdtempSync(join(tmpdir(), "ownbase-outbox-limited-"));
    const limited = await createWorkspaceServer({
      dataDir: limitedDir,
      port: 0,
      mdns: false,
      rateLimits: { post: { burst: 2, perMinute: 120 } },
    });
    onTestFinished(async () => {
      await limited.stop();
      rmSync(limitedDir, { recursive: true, force: true });
    });
    const limitedBase = `http://127.0.0.1:${limited.port}`;
    const { token: limitedToken } = await new Api(limitedBase).register({
      handle: "kit",
      displayName: "Kit",
      password: "password123",
    });
    const channel = limited.store.channels.byName("general")!.id;
    const client = new WorkspaceClient(limitedBase, limitedToken);
    onTestFinished(() => client.destroy());
    client.connect();
    await until(client, (s) => s.status === "online", "connection");

    const words = ["one", "two", "three", "four", "five"];
    for (const text of words) client.send(channel, text);
    await until(client, (s) => s.pending.some((p) => p.failed), "the limit");
    await until(client, (s) => s.pending.length === 0, "every send going again", 10_000);
    const posted = limited.store.messages
      .list({ channelId: channel, limit: 10 })
      .map((m) => m.text)
      .filter((text) => words.includes(text));
    expect(posted.sort()).toEqual([...words].sort());
  });

  it("says when the workspace was reached but did not answer, or answered unreadably", async () => {
    const client = await online();
    const send = vi.spyOn(client.api, "sendMessage");
    send.mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));
    client.send(general, "Into the void");
    let state = await until(client, (s) => !!failed(s), "the timeout");
    expect(failed(state)).toMatchObject({
      refused: false,
      failureReason: "The workspace did not answer in time. Press Retry to send it again.",
    });
    client.discardSend(failed(state)!.nonce);

    send.mockRejectedValueOnce(new SyntaxError("Unexpected end of JSON input"));
    client.send(general, "Through a captive portal");
    state = await until(client, (s) => !!failed(s), "the unreadable answer");
    expect(failed(state)!.failureReason).toBe(
      "The workspace's answer could not be read. Press Retry to send it again.",
    );
  });

  it("sends what was lost on the way once the connection is back, but not what was refused", async () => {
    const client = await online();
    const send = vi.spyOn(client.api, "sendMessage");
    // The first try never reaches the server; later ones do.
    send.mockRejectedValueOnce(new TypeError("fetch failed"));
    client.send(general, "Sent from a tunnel");
    await until(client, (s) => !!failed(s), "the lost send");

    // The socket drops and comes back, as on leaving the tunnel.
    (client as unknown as { ws: WebSocket }).ws.close();
    await until(client, (s) => s.status === "reconnecting", "the drop");
    await until(client, (s) => s.pending.length === 0, "the send going again", 10_000);
    expect(
      server.store.messages
        .list({ channelId: general, limit: 10 })
        .filter((m) => m.text === "Sent from a tunnel"),
    ).toHaveLength(1);
  });
});
