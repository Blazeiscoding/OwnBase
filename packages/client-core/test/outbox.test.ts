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
  general = server.store.getChannelByName("general")!.id;
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
        "Workspace attachment storage is full. Ask the host to free space or raise the limit, then retry.",
      attachments: [{ name: "too-big.bin", size: 200 }],
      uploadProgress: null,
    });
    expect(upload).toHaveBeenCalledOnce();
    expect(server.store.listMessages({ channelId: general, limit: 10 })).toHaveLength(0);

    // The file is still there to try again with.
    upload.mockClear();
    client.retrySend(failed(state)!.nonce);
    await until(client, (s) => !!failed(s), "the second refusal");
    expect(upload.mock.calls[0]![1]).toBe(file);
  });

  it("sends exactly once when retried after what stopped it is cleared", async () => {
    const client = await online();
    server.store.updateChannel(general, { archived: true });
    onTestFinished(() => void server.store.updateChannel(general, { archived: false }));
    client.send(general, "Once the room reopens");

    const state = await until(client, (s) => !!failed(s), "the refusal");
    const entry = failed(state)!;
    expect(entry.failureReason).toBe("This conversation is archived.");
    expect(entry.text).toBe("Once the room reopens");

    server.store.updateChannel(general, { archived: false });
    client.retrySend(entry.nonce);
    await until(client, (s) => s.pending.length === 0, "the retry");
    expect(
      server.store
        .listMessages({ channelId: general, limit: 10 })
        .filter((m) => m.text === "Once the room reopens"),
    ).toHaveLength(1);
    // A second retry of something already sent does nothing.
    client.retrySend(entry.nonce);
    expect(client.state.pending).toHaveLength(0);
  });

  it("says the workspace could not be reached, and that it will send on retry", async () => {
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
      failureReason: "Could not reach the workspace. It will be sent when you try again.",
    });
    expect(client.state.pending).toHaveLength(0);
  });
});
