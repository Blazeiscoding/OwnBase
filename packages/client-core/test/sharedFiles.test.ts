import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { Api, WorkspaceClient } from "../src/index.js";

/** The file browser's client side (E7): the server says it lists files, and a page is asked for. */
let server: WorkspaceServer;
let base: string;
let dataDir: string;
let token: string;
let userId: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-client-files-"));
  server = await createWorkspaceServer({ dataDir, port: 0, mdns: false, rateLimits: false });
  base = `http://127.0.0.1:${server.port}`;
  const made = await new Api(base).register({
    handle: "alice",
    displayName: "Alice",
    password: "password123",
  });
  token = made.token;
  userId = made.user.id;
});

afterAll(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("shared files on the client", () => {
  it("are offered where the server lists them, and read a page at a time by filter", async () => {
    const client = new WorkspaceClient(base, token);
    onTestFinished(() => client.destroy());
    expect(client.state.sharedFiles).toBe(false);
    client.connect();
    await new Promise<void>((resolve) => {
      const stop = client.store.subscribe((s) => {
        if (s.status === "online") {
          stop();
          resolve();
        }
      });
    });
    expect(client.state.sharedFiles).toBe(true);

    const general = Object.values(client.state.channels).find((c) => c.name === "general")!;
    const api = new Api(base, token);
    const fileIds: string[] = [];
    for (const name of ["Q3 plan.pdf", "team.png", "notes.txt"]) {
      const type = name.endsWith(".png")
        ? "image/png"
        : name.endsWith(".pdf")
          ? "application/pdf"
          : "text/plain";
      // uploadFile reports progress through XMLHttpRequest, which Node lacks.
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array([1, 2])], { type }), name);
      const uploaded = await fetch(`${base}/api/channels/${general.id}/files`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: form,
      });
      const { file } = (await uploaded.json()) as { file: { id: string } };
      fileIds.push(file.id);
      await api.sendMessage(general.id, { text: "", fileIds: [file.id] });
    }

    const all = await client.api.listSharedFiles({});
    expect(all.files.map((f) => f.file.name)).toEqual(["notes.txt", "team.png", "Q3 plan.pdf"]);
    expect(all.files[0]).toMatchObject({ channelId: general.id, userId, threadRootId: null });

    const narrowed = await client.api.listSharedFiles({
      kind: "document",
      userId,
      channelId: general.id,
      q: "  plan ",
    });
    expect(narrowed.files.map((f) => f.file.name)).toEqual(["Q3 plan.pdf"]);

    const first = await client.api.listSharedFiles({});
    expect(first.nextCursor).toBeNull();
  });
});
