import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

let server: WorkspaceServer;
let base: string;
let token: string;

async function request(path: string, body?: unknown, method = "POST", auth = token) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}
const register = (handle: string, inviteCode?: string) =>
  request("/api/auth/register", {
    handle,
    displayName: handle,
    password: "password123",
    inviteCode,
  });
async function owner() {
  const result = await register("owner");
  token = result.body.token;
  return result.body.user as { id: string };
}
function failEvent(number = 1) {
  const append = server.store.appendEvent.bind(server.store);
  let calls = 0;
  return vi.spyOn(server.store, "appendEvent").mockImplementation((...args) => {
    if (++calls === number) throw new Error("injected event write failure");
    return append(...args);
  });
}
beforeEach(async () => {
  token = "";
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await server.stop();
});

describe("atomic registration", () => {
  it("restores the claim, owner, default channel and events when session creation fails", async () => {
    const claim = server.store.getMeta("claim_code");
    const publish = vi.spyOn(server.gateway, "publish");
    vi.spyOn(server.store.accounts, "createSession").mockImplementationOnce(() => {
      throw new Error("session write failed");
    });
    expect((await register("owner")).status).toBe(500);
    expect(server.store.people.count()).toBe(0);
    expect(server.store.channels.byName("general")).toBeNull();
    expect(server.store.getMeta("claim_code")).toBe(claim);
    expect(server.store.currentSeq()).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    expect((await register("owner")).body.user.role).toBe("owner");
  });

  it("returns a consumed invitation when a later registration write fails", async () => {
    await owner();
    server.setInviteOnly(true);
    const code = (await request("/api/invites", { maxUses: 1 })).body.invite.code;
    const seq = server.store.currentSeq();
    const publish = vi.spyOn(server.gateway, "publish");
    vi.spyOn(server.store.accounts, "createSession").mockImplementationOnce(() => {
      throw new Error("session write failed");
    });
    expect((await register("guest", code)).status).toBe(500);
    expect(server.store.accounts.getInvite(code)!.uses).toBe(0);
    expect(server.store.people.authByHandle("guest")).toBeNull();
    expect(server.store.currentSeq()).toBe(seq);
    expect(publish).not.toHaveBeenCalled();
    expect((await register("guest", code)).status).toBe(201);
    expect(server.store.accounts.getInvite(code)!.uses).toBe(1);
  });

  it("allows exactly one concurrent registration to consume the final invite use", async () => {
    await owner();
    server.setInviteOnly(true);
    const code = (await request("/api/invites", { maxUses: 1 })).body.invite.code;
    const results = await Promise.all([register("one", code), register("two", code)]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 403]);
    expect(server.store.accounts.getInvite(code)!.uses).toBe(1);
    expect(server.store.people.count()).toBe(2);
  });
});

describe("atomic channel and account changes", () => {
  it("rejects an unknown private-channel member without leaving a channel behind", async () => {
    await owner();
    expect(
      (
        await request("/api/channels", {
          type: "private",
          name: "private-room",
          memberIds: ["missing"],
        })
      ).status,
    ).toBe(400);
    expect(server.store.channels.byName("private-room")).toBeNull();
    expect((await request("/api/channels", { type: "private", name: "private-room" })).status).toBe(
      201,
    );
  });

  it.each([1, 2])(
    "rolls back founding channel members and events when event %i fails",
    async (number) => {
      await owner();
      const seq = server.store.currentSeq();
      const publish = vi.spyOn(server.gateway, "publish");
      const failure = failEvent(number);
      expect(
        (await request("/api/channels", { type: "private", name: "private-room" })).status,
      ).toBe(500);
      expect(server.store.channels.byName("private-room")).toBeNull();
      expect(server.store.currentSeq()).toBe(seq);
      expect(publish).not.toHaveBeenCalled();
      failure.mockRestore();
      expect(
        (await request("/api/channels", { type: "private", name: "private-room" })).status,
      ).toBe(201);
    },
  );

  it("keeps old channel metadata when its event cannot be written", async () => {
    await owner();
    const channel = server.store.channels.byName("general")!;
    failEvent();
    expect(
      (await request(`/api/channels/${channel.id}`, { topic: "uncommitted" }, "PATCH")).status,
    ).toBe(500);
    expect(server.store.channels.get(channel.id)!.topic).toBe(channel.topic);
  });

  it("does not grant private access or announce an invitation that rolled back", async () => {
    await owner();
    const guest = (await register("guest")).body.user;
    const channel = (await request("/api/channels", { type: "private", name: "private-room" })).body
      .channel;
    const notify = vi.spyOn(server.gateway, "updateChannelAccess");
    failEvent();
    expect(
      (await request(`/api/channels/${channel.id}/invite-member`, { userId: guest.id })).status,
    ).toBe(500);
    expect(server.store.channels.isMember(channel.id, guest.id)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("retains membership and live access when a departure cannot be recorded", async () => {
    const me = await owner();
    const channel = (await request("/api/channels", { type: "private", name: "private-room" })).body
      .channel;
    const notify = vi.spyOn(server.gateway, "updateChannelAccess");
    failEvent();
    expect((await request(`/api/channels/${channel.id}/leave`)).status).toBe(500);
    expect(server.store.channels.isMember(channel.id, me.id)).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps both ownership roles and the event log unchanged on a second-event failure", async () => {
    const me = await owner();
    const guest = (await register("guest")).body.user;
    const seq = server.store.currentSeq();
    const publish = vi.spyOn(server.gateway, "publish");
    failEvent(2);
    expect((await request(`/api/admin/users/${guest.id}/owner`)).status).toBe(500);
    expect(server.store.people.get(me.id)!.role).toBe("owner");
    expect(server.store.people.get(guest.id)!.role).toBe("member");
    expect(server.store.currentSeq()).toBe(seq);
    expect(publish).not.toHaveBeenCalled();
  });

  it("restores revoked sessions and never disconnects a rolled-back deactivation", async () => {
    await owner();
    const guest = (await register("guest")).body;
    const disconnect = vi.spyOn(server.gateway, "disconnectUser");
    failEvent();
    expect(
      (await request(`/api/admin/users/${guest.user.id}`, { deactivated: true }, "PATCH")).status,
    ).toBe(500);
    expect(server.store.people.get(guest.user.id)!.deactivated).toBe(false);
    expect((await request("/api/me", undefined, "GET", guest.token)).status).toBe(200);
    expect(disconnect).not.toHaveBeenCalled();
  });
});

describe("atomic messages and integrations", () => {
  it.each(["edit", "delete", "add reaction", "remove reaction", "pin", "unpin"])(
    "rolls back %s when its event fails",
    async (action) => {
      await owner();
      const channelId = server.store.channels.byName("general")!.id;
      const message = (await request(`/api/channels/${channelId}/messages`, { text: "original" }))
        .body.message;
      if (action === "remove reaction")
        await request(`/api/messages/${message.id}/reactions/yes`, undefined, "PUT");
      if (action === "unpin") await request(`/api/messages/${message.id}/pin`, undefined, "PUT");
      const before = server.store.messages.get(message.id);
      const seq = server.store.currentSeq();
      const publish = vi.spyOn(server.gateway, "publish");
      failEvent();
      const path =
        `/api/messages/${message.id}` +
        (action.includes("reaction") ? "/reactions/yes" : action.includes("pin") ? "/pin" : "");
      const method =
        action === "edit"
          ? "PATCH"
          : ["delete", "remove reaction", "unpin"].includes(action)
            ? "DELETE"
            : "PUT";
      expect(
        (await request(path, action === "edit" ? { text: "changed" } : undefined, method)).status,
      ).toBe(500);
      expect(server.store.messages.get(message.id)).toEqual(before);
      expect(server.store.currentSeq()).toBe(seq);
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("does not leave a bot account behind when app-token creation fails", async () => {
    await owner();
    const count = server.store.people.list().length;
    const seq = server.store.currentSeq();
    vi.spyOn(server.store.apps, "addToken").mockImplementationOnce(() => {
      throw new Error("token write failed");
    });
    expect((await request("/api/apps", { name: "Test App" })).status).toBe(500);
    expect(server.store.people.list()).toHaveLength(count);
    expect(server.store.apps.list()).toHaveLength(0);
    expect(server.store.currentSeq()).toBe(seq);
    expect((await request("/api/apps", { name: "Test App" })).status).toBe(201);
  });

  it("rolls back a webhook and bot membership together", async () => {
    await owner();
    const app = (await request("/api/apps", { name: "Test App" })).body.app;
    const channelId = server.store.channels.byName("general")!.id;
    failEvent();
    expect((await request(`/api/apps/${app.id}/webhooks`, { channelId })).status).toBe(500);
    expect(server.store.apps.listWebhooks(app.id)).toHaveLength(0);
    expect(server.store.channels.isMember(channelId, app.botUserId)).toBe(false);
  });

  it("restores all app resources if deletion fails after removing them", async () => {
    await owner();
    const app = (await request("/api/apps", { name: "Test App" })).body.app;
    const channelId = server.store.channels.byName("general")!.id;
    const hook = (await request(`/api/apps/${app.id}/webhooks`, { channelId })).body.webhook;
    const remove = server.store.apps.delete.bind(server.store);
    vi.spyOn(server.store.apps, "delete").mockImplementationOnce((id) => {
      remove(id);
      throw new Error("final write failed");
    });
    expect((await request(`/api/apps/${app.id}`, undefined, "DELETE")).status).toBe(500);
    expect(server.store.apps.get(app.id)).toEqual(app);
    expect(server.store.apps.listWebhooks(app.id)).toEqual([hook]);
  });
});
