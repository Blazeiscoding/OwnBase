import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * Download tickets: the one-shot, short-lived stand-in for the Authorization
 * header a browser cannot send on the navigation that saves a file. Whoever
 * spends one must still pass every check its issuer passed.
 */
let server: WorkspaceServer;
let directory: string;
let base: string;
let owner: { token: string; id: string };
let member: { token: string; id: string };

async function request(path: string, token?: string, method = "GET", body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as any };
}

async function register(handle: string) {
  const { data } = await request("/api/auth/register", undefined, "POST", {
    handle,
    displayName: handle,
    password: "password123",
  });
  return { token: data.token as string, id: data.user.id as string };
}

async function upload(channelId: string, token: string, text = "the quarterly numbers") {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(text)], { type: "text/plain" }), "numbers.txt");
  const res = await fetch(`${base}/api/channels/${channelId}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { file: { id: string } }).file.id;
}

const issue = (fileId: string, token: string) =>
  request(`/api/files/${fileId}/download-token`, token, "POST");

/**
 * Spends a ticket the way a browser does: a plain GET with no header. The
 * body is always read, or the open response would hold the server's stop.
 */
async function spend(fileId: string, ticket: string, method = "GET") {
  const res = await fetch(`${base}/api/files/${fileId}?download=${ticket}`, { method });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "ownbase-tickets-"));
  server = await createWorkspaceServer({
    dataDir: directory,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    // The cap test issues more tickets in a row than rationing lets through.
    rateLimits: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  owner = await register("owner");
  member = await register("member");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.stop();
  rmSync(directory, { recursive: true, force: true });
});

describe("download tickets", () => {
  it("downloads once as an attachment, then never again", async () => {
    const general = server.store.getChannelByName("general")!.id;
    const fileId = await upload(general, owner.token);
    const issued = await issue(fileId, member.token);
    expect(issued.status).toBe(200);
    expect(issued.data.token).toMatch(/^[a-f0-9]{64}$/);
    expect(issued.data.expiresAt - Date.now()).toBeGreaterThan(55_000);
    expect(issued.data.expiresAt - Date.now()).toBeLessThanOrEqual(60_000);

    const first = await spend(fileId, issued.data.token);
    expect(first.status).toBe(200);
    expect(first.text).toBe("the quarterly numbers");
    expect(first.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''numbers.txt",
    );
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("referrer-policy")).toBe("no-referrer");

    expect((await spend(fileId, issued.data.token)).status).toBe(404);
  });

  it("is spent by two requests at once only once", async () => {
    const general = server.store.getChannelByName("general")!.id;
    const fileId = await upload(general, owner.token);
    const { data } = await issue(fileId, member.token);
    const results = await Promise.all([spend(fileId, data.token), spend(fileId, data.token)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
  });

  it("opens only the file it was issued for, and only when well formed", async () => {
    const general = server.store.getChannelByName("general")!.id;
    const fileId = await upload(general, owner.token);
    const otherId = await upload(general, owner.token, "something else");
    const { data } = await issue(fileId, member.token);
    // Tried on the wrong file, the ticket is used up rather than left to retry.
    expect((await spend(otherId, data.token)).status).toBe(404);
    expect((await spend(fileId, data.token)).status).toBe(404);

    for (const malformed of ["", "abc", "z".repeat(64), data.token.toUpperCase()]) {
      expect((await spend(fileId, malformed)).status).toBe(404);
    }
    // A HEAD cannot spend one, so a link checker never uses it up.
    const fresh = (await issue(fileId, member.token)).data.token;
    expect((await spend(fileId, fresh, "HEAD")).status).toBe(404);
    expect((await spend(fileId, fresh)).status).toBe(200);
  });

  it("expires sixty seconds after it was issued", async () => {
    const general = server.store.getChannelByName("general")!.id;
    const fileId = await upload(general, owner.token);
    const early = (await issue(fileId, member.token)).data.token;
    const late = (await issue(fileId, member.token)).data.token;

    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 59_000);
    expect((await spend(fileId, early)).status).toBe(200);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 60_001);
    expect((await spend(fileId, late)).status).toBe(404);
  });

  it("dies with the session that asked for it, but not with the account's others", async () => {
    const general = server.store.getChannelByName("general")!.id;
    const fileId = await upload(general, owner.token);
    const laptop = member.token;
    const phone = (
      await request("/api/auth/login", undefined, "POST", {
        handle: "member",
        password: "password123",
      })
    ).data.token as string;
    const fromLaptop = (await issue(fileId, laptop)).data.token;
    const fromPhone = (await issue(fileId, phone)).data.token;

    // Signing out deletes the session's tickets with it, and redeeming checks
    // the session again before and after reading the disk; this holds all three.
    expect((await request("/api/auth/logout", laptop, "POST")).status).toBe(200);
    expect((await spend(fileId, fromLaptop)).status).toBe(404);
    expect((await spend(fileId, fromPhone)).status).toBe(200);
  });

  it("is refused once the account has to change its password", async () => {
    const general = server.store.getChannelByName("general")!.id;
    const fileId = await upload(general, owner.token);
    const ticket = (await issue(fileId, member.token)).data.token;
    // A forced change keeps the session only so the password can be changed.
    const auth = server.store.getUserAuthByHandle("member")!;
    server.store.setPassword(member.id, auth.passwordHash, auth.salt, true);
    expect((await spend(fileId, ticket)).status).toBe(404);
    expect((await issue(fileId, member.token)).status).toBe(403);
  });

  it("is refused after its holder leaves or is removed from a private room", async () => {
    const room = await request("/api/channels", owner.token, "POST", {
      type: "private",
      name: "leads",
      memberIds: [member.id],
    });
    expect(room.status).toBe(201);
    const roomId = room.data.channel.id as string;
    const fileId = await upload(roomId, owner.token);

    const beforeRemoval = (await issue(fileId, member.token)).data.token;
    expect(
      (await request(`/api/channels/${roomId}/members/${member.id}`, owner.token, "DELETE")).status,
    ).toBe(200);
    expect((await spend(fileId, beforeRemoval)).status).toBe(404);
    // And none is issued to someone outside the room.
    expect((await issue(fileId, member.token)).status).toBe(404);

    // Leaving has the same effect as being removed.
    const outsider = await register("outsider");
    await request(`/api/channels/${roomId}/invite-member`, owner.token, "POST", {
      userId: outsider.id,
    });
    const beforeLeaving = (await issue(fileId, outsider.token)).data.token;
    expect((await request(`/api/channels/${roomId}/leave`, outsider.token, "POST")).status).toBe(
      200,
    );
    expect((await spend(fileId, beforeLeaving)).status).toBe(404);
  });

  it("is refused once the file is deleted", async () => {
    const general = server.store.getChannelByName("general")!.id;
    const fileId = await upload(general, owner.token);
    const sent = await request(`/api/channels/${general}/messages`, owner.token, "POST", {
      text: "",
      fileIds: [fileId],
    });
    const ticket = (await issue(fileId, member.token)).data.token;
    expect(
      (await request(`/api/messages/${sent.data.message.id}`, owner.token, "DELETE")).status,
    ).toBe(200);
    expect((await spend(fileId, ticket)).status).toBe(404);
  });

  it("keeps an account's 64 newest tickets, and drops the oldest past that", async () => {
    const general = server.store.getChannelByName("general")!.id;
    const fileId = await upload(general, owner.token);
    const realNow = Date.now.bind(Date);
    let step = 0;
    // A millisecond apart, so which is oldest never depends on the clock.
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + step);
    const tickets: string[] = [];
    for (let i = 0; i < 65; i++) {
      step = i;
      tickets.push((await issue(fileId, member.token)).data.token);
    }
    // Someone else's tickets are counted apart.
    step = 65;
    const owners = (await issue(fileId, owner.token)).data.token;

    expect((await spend(fileId, tickets[0]!)).status).toBe(404);
    expect((await spend(fileId, tickets[1]!)).status).toBe(200);
    expect((await spend(fileId, tickets[64]!)).status).toBe(200);
    expect((await spend(fileId, owners)).status).toBe(200);
  });
});
