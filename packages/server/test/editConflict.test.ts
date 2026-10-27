import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * An edit says which words it replaces (UX-04). One made from a window that
 * had not yet heard of a newer edit, from another device or an app, is
 * refused rather than saved over it, so neither version is lost without the
 * author choosing.
 */
let server: WorkspaceServer | undefined;
let directory: string;
let base: string;
let author: string;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "ownbase-edit-conflict-"));
  server = await createWorkspaceServer({
    dataDir: directory,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits: false,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  rmSync(directory, { recursive: true, force: true });
});

async function call(token: string, path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function posted(text: string) {
  const response = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "author", displayName: "Author", password: "password123" }),
  });
  const { token, user } = (await response.json()) as { token: string; user: { id: string } };
  const general = server!.store.getChannelByName("general")!.id;
  const { body } = await call(token, `/api/channels/${general}/messages`, "POST", { text });
  author = user.id;
  return { token, id: body.message.id as string };
}

/** How many times the author's log has announced an edit to this message. */
const updates = (id: string) =>
  server!.store
    .eventsSince(0, author)!
    .filter((e) => e.event.type === "message.updated" && e.event.message.id === id).length;

describe("editing a message that may have changed", () => {
  it("saves over the words the edit started from", async () => {
    const { token, id } = await posted("Ship it on Friday");
    const edit = await call(token, `/api/messages/${id}`, "PATCH", {
      text: "Ship it on Monday",
      expectedText: "Ship it on Friday",
    });
    expect(edit.status).toBe(200);
    expect(edit.body.message.text).toBe("Ship it on Monday");
    expect(updates(id)).toBe(1);
  });

  it("refuses an edit made from words that have changed since, and keeps the newer ones", async () => {
    const { token, id } = await posted("Ship it on Friday");
    // Another device's edit, which the first has not heard of.
    await call(token, `/api/messages/${id}`, "PATCH", {
      text: "Ship it on Thursday",
      expectedText: "Ship it on Friday",
    });
    const stale = await call(token, `/api/messages/${id}`, "PATCH", {
      text: "Ship it on Friday (mine)",
      expectedText: "Ship it on Friday",
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("message_changed");
    expect(server!.store.getMessage(id)!.text).toBe("Ship it on Thursday");
    expect(updates(id)).toBe(1);

    // Having seen the newer words, the author can still choose theirs.
    const chosen = await call(token, `/api/messages/${id}`, "PATCH", {
      text: "Ship it on Friday (mine)",
      expectedText: "Ship it on Thursday",
    });
    expect(chosen.status).toBe(200);
    expect(server!.store.getMessage(id)!.text).toBe("Ship it on Friday (mine)");
  });

  it("accepts a retry whose first try was saved, though the words it expected are gone", async () => {
    const { token, id } = await posted("Ship it on Friday");
    const body = { text: "Ship it on Monday", expectedText: "Ship it on Friday" };
    await call(token, `/api/messages/${id}`, "PATCH", body);
    // The answer to the first try was lost, so the client sends it again.
    const retry = await call(token, `/api/messages/${id}`, "PATCH", body);
    expect(retry.status).toBe(200);
    expect(server!.store.getMessage(id)!.text).toBe("Ship it on Monday");
  });

  it("still replaces whatever is there for a client that does not say what it expects", async () => {
    const { token, id } = await posted("Ship it on Friday");
    await call(token, `/api/messages/${id}`, "PATCH", { text: "Ship it on Thursday" });
    const blind = await call(token, `/api/messages/${id}`, "PATCH", { text: "Ship it on Monday" });
    expect(blind.status).toBe(200);
    expect(server!.store.getMessage(id)!.text).toBe("Ship it on Monday");
  });
});
