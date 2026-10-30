import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";
import { parseIceServers } from "../src/rtc.js";
import { openDbAtVersion } from "../src/db.js";

let server: WorkspaceServer | undefined;
let directory: string | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

async function start(maxFileSize?: number) {
  directory = mkdtempSync(join(tmpdir(), "ownbase-product-"));
  server = await createWorkspaceServer({
    dataDir: directory,
    port: 0,
    host: "127.0.0.1",
    mdns: false,
    inviteOnly: true,
    maxFileSize,
    iceServers: [{ urls: "turn:relay.example.org:3478", username: "team", credential: "secret" }],
  });
  return `http://127.0.0.1:${server.port}`;
}
async function request(base: string, path: string, token?: string, method = "GET", body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as any };
}
const register = (base: string, handle: string, inviteCode?: string) =>
  request(base, "/api/auth/register", undefined, "POST", {
    handle,
    displayName: handle,
    password: "password123",
    inviteCode,
  });

/** Every table, index and trigger definition, in a stable order. */
function schemaOf(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY sql")
      .all() as unknown as { sql: string }[]
  ).map((r) => r.sql.replace(/\s+/g, " ").trim());
}

describe("self-hosted product", () => {
  it("streams uploads and downloads and removes partial oversized files", async () => {
    const base = await start(2 * 1024 * 1024);
    const owner = (await register(base, "owner")).data;
    const channel = server!.store.getChannelByName("general")!;
    const body = new Uint8Array(1024 * 1024).fill(42);
    const form = new FormData();
    form.append("file", new Blob([body]), "payload.bin");
    const res = await fetch(`${base}/api/channels/${channel.id}/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.token}` },
      body: form,
    });
    expect(res.status).toBe(201);
    const { file } = (await res.json()) as { file: { id: string; size: number } };
    expect(file.size).toBe(body.length);
    const downloaded = await fetch(`${base}/api/files/${file.id}`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(body);
    const oversized = new FormData();
    oversized.append("file", new Blob([new Uint8Array(3 * 1024 * 1024)]), "large.bin");
    const rejected = await fetch(`${base}/api/channels/${channel.id}/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.token}` },
      body: oversized,
    });
    expect(rejected.status).toBe(413);
    expect(readdirSync(join(directory!, "files"))).toEqual([file.id]);
    // Four megabytes over real HTTP plus a password hash: the default five
    // seconds is a coin toss on a machine that is also typechecking.
  }, 30_000);

  it("does not let bot tokens join private channels by posting", async () => {
    const base = await start();
    const owner = (await register(base, "owner")).data;
    const created = (await request(base, "/api/apps", owner.token, "POST", { name: "Build Bot" }))
      .data;
    const channel = (
      await request(base, "/api/channels", owner.token, "POST", {
        type: "private",
        name: "leadership",
      })
    ).data.channel;
    const result = await request(base, "/api/chat.postMessage", created.token, "POST", {
      channel: channel.id,
      text: "unauthorized",
    });
    // Slack answers a failed method with 200 and ok:false; see slackError.
    expect(result.status).toBe(200);
    expect((result.data as { error?: string }).error).toBe("not_in_channel");
    expect(server!.store.isMember(channel.id, created.app.botUserId)).toBe(false);
    server!.store.addMember(channel.id, created.app.botUserId);
    expect(
      (
        await request(base, "/api/chat.postMessage", created.token, "POST", {
          channel: channel.id,
          text: "authorized",
        })
      ).status,
    ).toBe(200);
  });
  it("keeps relay credentials authenticated and exposes a lightweight health check", async () => {
    const base = await start();
    // The identifier lets a public address be confirmed to reach this run,
    // so it is the same for every check while the server stays up.
    const health = (await request(base, "/api/health")).data;
    expect(health).toEqual({ status: "ok", instanceId: expect.any(String) });
    expect((await request(base, "/api/health")).data.instanceId).toBe(health.instanceId);
    expect((await request(base, "/api/rtc-config")).status).toBe(401);
    const owner = await register(base, "owner");
    expect(
      (await request(base, "/api/rtc-config", owner.data.token)).data.iceServers[0].credential,
    ).toBe("secret");
  });

  it("gives each server start a fresh health-check identity", async () => {
    let base = await start();
    const first = (await request(base, "/api/health")).data.instanceId;
    await server!.stop();
    server = await createWorkspaceServer({
      dataDir: directory!,
      port: 0,
      host: "127.0.0.1",
      mdns: false,
    });
    base = `http://127.0.0.1:${server.port}`;
    const second = (await request(base, "/api/health")).data.instanceId;
    expect(first).toEqual(expect.any(String));
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
  });

  it("keeps friends private, requires recipient acceptance, and persists across restart", async () => {
    let base = await start();
    const owner = (await register(base, "owner")).data;
    const invite = (await request(base, "/api/invites", owner.token, "POST", { maxUses: 3 })).data
      .invite.code;
    const bob = (await register(base, "bobby", invite)).data;
    const eve = (await register(base, "evelyn", invite)).data;
    expect((await request(base, `/api/friends/${bob.user.id}`, undefined, "POST")).status).toBe(
      401,
    );
    expect((await request(base, `/api/friends/${owner.user.id}`, owner.token, "POST")).status).toBe(
      400,
    );
    await request(base, `/api/friends/${bob.user.id}`, owner.token, "POST");
    await request(base, `/api/friends/${bob.user.id}`, owner.token, "POST");
    expect((await request(base, "/api/friends", bob.token)).data.friends).toEqual([
      expect.objectContaining({ userId: owner.user.id, status: "incoming" }),
    ]);
    expect((await request(base, "/api/friends", eve.token)).data.friends).toEqual([]);
    expect((await request(base, `/api/friends/${bob.user.id}`, owner.token, "PUT")).status).toBe(
      404,
    );
    expect((await request(base, `/api/friends/${owner.user.id}`, bob.token, "PUT")).status).toBe(
      200,
    );
    await server!.stop();
    server = await createWorkspaceServer({
      dataDir: directory!,
      port: 0,
      host: "127.0.0.1",
      mdns: false,
    });
    base = `http://127.0.0.1:${server.port}`;
    expect((await request(base, "/api/friends", owner.token)).data.friends[0].status).toBe(
      "accepted",
    );
    await request(base, `/api/friends/${owner.user.id}`, bob.token, "DELETE");
    expect((await request(base, "/api/friends", owner.token)).data.friends).toEqual([]);
  });

  it("does not spend an invitation on a duplicate handle", async () => {
    const base = await start();
    const owner = (await register(base, "owner")).data;
    const invite = (await request(base, "/api/invites", owner.token, "POST", { maxUses: 1 })).data
      .invite.code;
    expect((await register(base, "owner", invite)).status).toBe(409);
    expect((await register(base, "bobby", invite)).status).toBe(201);
    expect((await register(base, "evelyn", invite)).status).toBe(403);
  });

  it("creates just one owner under concurrent first registrations", async () => {
    const base = await start();
    const results = await Promise.all([register(base, "alpha"), register(base, "bravo")]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(server!.store.listUsers().filter((u) => u.role === "owner")).toHaveLength(1);
  });

  it.each([null, { type: "hello", token: {}, protocolVersion: 1, lastSeq: null }])(
    "rejects malformed socket messages without crashing: %j",
    async (payload) => {
      const base = await start();
      const ws = new WebSocket(base.replace("http", "ws") + "/ws");
      const closed = new Promise<number>((resolve) => ws.on("close", resolve));
      ws.on("open", () => ws.send(JSON.stringify(payload)));
      expect(await closed).toBe(4000);
      expect((await request(base, "/api/health")).status).toBe(200);
    },
  );

  it("closes unauthenticated sockets during shutdown", async () => {
    const base = await start();
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    await new Promise<void>((resolve) => ws.on("open", resolve));
    const closed = new Promise<void>((resolve) => ws.on("close", () => resolve()));
    await server!.stop();
    server = undefined;
    await closed;
  });

  it("validates ICE configuration without reflecting secrets in errors", () => {
    expect(parseIceServers(undefined)).toEqual([]);
    expect(
      parseIceServers(
        '[{"urls":["stun:example.org","turn:example.org"],"username":"u","credential":"p"}]',
      ),
    ).toHaveLength(1);
    expect(() => parseIceServers('[{"urls":"https://invalid","credential":"secret"}]')).toThrow(
      "OWNBASE_ICE_SERVERS",
    );
  });
  it("upgrades a workspace that predates message buttons", async () => {
    const base = await start();
    const owner = await request(base, "/api/auth/register", undefined, "POST", {
      handle: "owner",
      displayName: "Owner",
      password: "password123",
    });
    const channel = server!.store.getChannelByName("general")!;
    const posted = await request(
      base,
      `/api/channels/${channel.id}/messages`,
      owner.data.token,
      "POST",
      {
        text: "written before buttons existed",
        nonce: "old-1",
      },
    );
    expect(posted.status).toBe(201);
    const dir = directory!;
    await server!.stop();
    server = undefined;

    // Wind the schema back to what v8 shipped, data and all.
    //
    // Every migration added since has to be undone here. Rather than trust that
    // to memory, the result is compared against a v8 database built from the
    // migration list itself, so forgetting one fails with the difference named.
    const db = new DatabaseSync(join(dir, "workspace.db"));
    const historical = openDbAtVersion(":memory:", 8);
    try {
      db.exec("ALTER TABLE apps DROP COLUMN scopes");
      db.exec("DROP TABLE message_reports");
      db.exec("DROP TABLE user_blocks");
      db.exec("DROP TABLE two_step_codes");
      db.exec("ALTER TABLE users DROP COLUMN two_step_step");
      db.exec("ALTER TABLE users DROP COLUMN two_step_secret");
      db.exec("ALTER TABLE messages DROP COLUMN call_kind");
      db.exec("DROP TABLE user_avatars");
      db.exec("ALTER TABLE users DROP COLUMN avatar_version");
      db.exec("ALTER TABLE users DROP COLUMN away");
      db.exec("ALTER TABLE users DROP COLUMN time_zone");
      db.exec("ALTER TABLE channel_members DROP COLUMN section_id");
      db.exec("DROP TABLE sidebar_sections");
      db.exec("DROP TABLE poll_votes");
      db.exec("DROP TABLE polls");
      db.exec("DROP TABLE reminders");
      db.exec("ALTER TABLE thread_follows DROP COLUMN muted");
      db.exec("DROP TABLE link_previews");
      db.exec("DROP INDEX idx_messages_forwarded_from");
      db.exec("ALTER TABLE messages DROP COLUMN forwarded_from_id");
      db.exec("ALTER TABLE channel_members DROP COLUMN starred");
      db.exec("ALTER TABLE users DROP COLUMN status_expires_at");
      db.exec("DROP INDEX idx_messages_reply_to");
      db.exec("ALTER TABLE messages DROP COLUMN reply_ping");
      db.exec("ALTER TABLE messages DROP COLUMN reply_to_id");
      db.exec("DROP INDEX idx_channel_managers");
      db.exec("ALTER TABLE thread_follows DROP COLUMN unread_hold");
      db.exec("DROP TABLE purged_message_requests");
      db.exec("DROP TABLE message_mentions");
      db.exec("ALTER TABLE channel_members DROP COLUMN replies_read_seq");
      db.exec("CREATE INDEX idx_messages_thread ON messages(thread_root_id)");
      db.exec("DROP INDEX idx_messages_thread_page");
      db.exec("DROP INDEX idx_scheduled_held");
      db.exec("ALTER TABLE scheduled_messages DROP COLUMN next_attempt_at");
      db.exec("DROP TABLE scheduled_files");
      db.exec("ALTER TABLE scheduled_messages DROP COLUMN broadcast");
      db.exec("ALTER TABLE users DROP COLUMN can_invite");
      db.exec("DROP TABLE audit_log");
      db.exec("DROP INDEX idx_invites_created");
      db.exec("ALTER TABLE invites DROP COLUMN revoked_by");
      db.exec("ALTER TABLE invites DROP COLUMN revoked_at");
      db.exec("DROP INDEX idx_events_message");
      db.exec("ALTER TABLE events DROP COLUMN message_id");
      db.exec("ALTER TABLE event_subscriptions DROP COLUMN dropped_count");
      db.exec("ALTER TABLE users DROP COLUMN must_change_password");
      db.exec("DROP TRIGGER discard_revoked_event_deliveries");
      db.exec("DROP TABLE event_deliveries");
      db.exec("DROP TABLE download_tokens");
      db.exec("ALTER TABLE channel_members DROP COLUMN is_manager");
      db.exec("ALTER TABLE messages DROP COLUMN broadcast");
      db.exec("DROP TABLE thread_follows");
      db.exec("DROP TABLE scheduled_requests");
      db.exec("DROP TABLE pending_file_deletions");
      db.exec("DROP INDEX idx_sessions_id");
      for (const column of ["id", "user_agent", "expires_at"]) {
        db.exec(`ALTER TABLE sessions DROP COLUMN ${column}`);
      }
      db.exec("DROP INDEX idx_scheduled_due");
      for (const column of ["status", "failure_reason", "attempts", "message_id"]) {
        db.exec(`ALTER TABLE scheduled_messages DROP COLUMN ${column}`);
      }
      db.exec("CREATE INDEX idx_scheduled_due ON scheduled_messages(send_at)");
      db.exec("DROP TABLE message_requests");
      db.exec("ALTER TABLE messages DROP COLUMN actions");
      db.exec("ALTER TABLE apps DROP COLUMN interactivity_url");
      db.exec("PRAGMA user_version = 8");
      expect(schemaOf(db)).toEqual(schemaOf(historical));
    } finally {
      historical.close();
      db.close();
    }

    // Reopening migrates it forward without losing what was there.
    server = await createWorkspaceServer({ dataDir: dir, port: 0, host: "127.0.0.1", mdns: false });
    const reopened = `http://127.0.0.1:${server.port}`;
    const login = await request(reopened, "/api/auth/login", undefined, "POST", {
      handle: "owner",
      password: "password123",
    });
    const messages = await request(
      reopened,
      `/api/channels/${channel.id}/messages`,
      login.data.token,
    );
    const old = messages.data.messages.find((m: { nonce: string }) => m.nonce === "old-1");
    expect(old.text).toBe("written before buttons existed");
    expect(old.actions).toEqual([]);

    // And the new column is really there: writing one would fail without it.
    const after = await request(
      reopened,
      `/api/channels/${channel.id}/messages`,
      login.data.token,
      "POST",
      {
        text: "written after",
        nonce: "new-1",
      },
    );
    expect(after.status).toBe(201);
    expect(after.data.message.actions).toEqual([]);
  });
  it("takes access away from someone who has left, everywhere at once", async () => {
    const base = await start();
    const owner = await register(base, "owner");
    const invite = (await request(base, "/api/invites", owner.data.token, "POST", { maxUses: 5 }))
      .data.invite.code;
    const leaver = await register(base, "leaver", invite);
    const leaverToken = leaver.data.token;

    // They are here, and their socket is live.
    expect((await request(base, "/api/channels", leaverToken)).status).toBe(200);
    const socket = new WebSocket(`ws://127.0.0.1:${server!.port}/ws`);
    const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => {
      socket.on("open", () => {
        socket.send(
          JSON.stringify({ type: "hello", token: leaverToken, lastSeq: null, protocolVersion: 1 }),
        );
      });
      socket.on("message", (data) => {
        if (JSON.parse(String(data)).type === "ready") resolve();
      });
      socket.on("error", reject);
    });

    const patched = await request(
      base,
      `/api/admin/users/${leaver.data.user.id}`,
      owner.data.token,
      "PATCH",
      { deactivated: true },
    );
    expect(patched.data.user.deactivated).toBe(true);

    // The token in their hands stops working, the socket they already had is
    // cut, and they cannot sign back in to get a new one.
    expect((await request(base, "/api/channels", leaverToken)).status).toBe(401);
    expect(await closed).toBe(4003);
    const retry = await request(base, "/api/auth/login", undefined, "POST", {
      handle: "leaver",
      password: "password123",
    });
    expect(retry.status).toBe(401);

    // Reactivating lets them back in with a fresh sign-in.
    await request(base, `/api/admin/users/${leaver.data.user.id}`, owner.data.token, "PATCH", {
      deactivated: false,
    });
    const back = await request(base, "/api/auth/login", undefined, "POST", {
      handle: "leaver",
      password: "password123",
    });
    expect(back.status).toBe(200);
    expect((await request(base, "/api/channels", back.data.token)).status).toBe(200);
  });

  it("does not send a message queued by someone who has since been deactivated", async () => {
    const base = await start();
    const owner = await register(base, "owner");
    const invite = (await request(base, "/api/invites", owner.data.token, "POST", { maxUses: 5 }))
      .data.invite.code;
    const leaver = await register(base, "leaver", invite);
    const channel = server!.store.getChannelByName("general")!;

    // Queued through the store so it is already due; the API rightly refuses a
    // time in the past, and what is under test is what the sender picks up.
    const queued = server!.store.scheduleMessage({
      channelId: channel.id,
      userId: leaver.data.user.id,
      text: "posted by a ghost",
      threadRootId: null,
      fileIds: [],
      sendAt: Date.now() - 1000,
    });
    const ghosted = () =>
      server!.store
        .listMessages({ channelId: channel.id, limit: 50 })
        .some((m) => m.text === "posted by a ghost");

    await request(base, `/api/admin/users/${leaver.data.user.id}`, owner.data.token, "PATCH", {
      deactivated: true,
    });
    server!.flushScheduled();
    expect(ghosted()).toBe(false);

    // It is held with a reason, not thrown away: reactivating lets it go out.
    const held = server!.store.getScheduled(queued.id)!;
    expect(held.status).toBe("held");
    expect(held.failureReason).toMatch(/deactivated/);

    await request(base, `/api/admin/users/${leaver.data.user.id}`, owner.data.token, "PATCH", {
      deactivated: false,
    });
    server!.flushScheduled();
    expect(ghosted()).toBe(true);
    expect(server!.store.getScheduled(queued.id)!.status).toBe("sent");
  });

  it("keeps the workspace from being taken away from its owner", async () => {
    const base = await start();
    const owner = await register(base, "owner");
    const invite = (await request(base, "/api/invites", owner.data.token, "POST", { maxUses: 5 }))
      .data.invite.code;
    const one = await register(base, "adminone", invite);
    const two = await register(base, "admintwo", invite);
    for (const who of [one, two]) {
      const made = await request(
        base,
        `/api/admin/users/${who.data.user.id}`,
        owner.data.token,
        "PATCH",
        { role: "admin" },
      );
      expect(made.data.user.role).toBe("admin");
    }

    // An admin cannot turn on another admin, so the workspace cannot be lost
    // to an argument between two of them.
    const coup = await request(
      base,
      `/api/admin/users/${two.data.user.id}`,
      one.data.token,
      "PATCH",
      { deactivated: true },
    );
    expect(coup.status).toBe(403);
    expect(coup.data.error).toBe("admins_are_equals");

    // Nor on the owner.
    const regicide = await request(
      base,
      `/api/admin/users/${owner.data.user.id}`,
      one.data.token,
      "PATCH",
      { deactivated: true },
    );
    expect(regicide.status).toBe(403);

    // Nor on themselves, in either direction.
    const selfHarm = await request(
      base,
      `/api/admin/users/${one.data.user.id}`,
      one.data.token,
      "PATCH",
      { deactivated: true },
    );
    expect(selfHarm.status).toBe(400);

    // A plain member cannot use any of this.
    const member = await register(base, "member", invite);
    expect((await request(base, "/api/admin/users", member.data.token)).status).toBe(403);
    const sneaky = await request(
      base,
      `/api/admin/users/${member.data.user.id}`,
      member.data.token,
      "PATCH",
      { role: "admin" },
    );
    expect(sneaky.status).toBe(403);

    // The owner can still demote an admin.
    const demoted = await request(
      base,
      `/api/admin/users/${one.data.user.id}`,
      owner.data.token,
      "PATCH",
      { role: "member" },
    );
    expect(demoted.data.user.role).toBe("member");
  });
});
