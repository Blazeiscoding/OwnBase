import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@slackoss/server";
import { Api, WorkspaceClient } from "../src/index.js";

let server: WorkspaceServer;
let owner: Api;
let member: WorkspaceClient;
/** The owner's own client, on another device than `owner`. */
let ownerElsewhere: WorkspaceClient;

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    workspaceName: "Rocket Team",
  });
  const base = `http://127.0.0.1:${server.port}`;
  const api = new Api(base);
  const a = await api.register({ handle: "owner", displayName: "Owner", password: "password123" });
  const b = await api.register({
    handle: "member",
    displayName: "Member",
    password: "password123",
  });
  owner = new Api(base, a.token);
  member = new WorkspaceClient(base, b.token);
  ownerElsewhere = new WorkspaceClient(base, a.token);
  member.connect();
  ownerElsewhere.connect();
  await expect.poll(() => member.state.status).toBe("online");
  await expect.poll(() => ownerElsewhere.state.status).toBe("online");
});

afterEach(async () => {
  member?.destroy();
  ownerElsewhere?.destroy();
  await server?.stop();
});

describe("the workspace's name and who may join", () => {
  it("come with the snapshot, with the server saying it takes changes", () => {
    for (const client of [member, ownerElsewhere])
      expect(client.state).toMatchObject({
        workspaceSettings: true,
        accessPolicy: "account_required",
        workspaceName: "Rocket Team",
      });
  });

  it("follow a change an admin makes, on every device and for everyone", async () => {
    expect(await owner.renameWorkspace("  Blue Team ")).toEqual({ workspaceName: "Blue Team" });
    expect(await owner.setAccessPolicy("guest_allowed")).toEqual({
      accessPolicy: "guest_allowed",
    });
    for (const client of [member, ownerElsewhere]) {
      await expect.poll(() => client.state.workspaceName).toBe("Blue Team");
      await expect.poll(() => client.state.accessPolicy).toBe("guest_allowed");
    }
    // As the host's change does: the same events, from the same rule.
    server.setAccessPolicy("invite_only");
    await expect.poll(() => member.state.accessPolicy).toBe("invite_only");
  });

  it("show what the server kept as soon as it answers, for the admin who changed them", async () => {
    expect(await ownerElsewhere.renameWorkspace(" Green Team ")).toBe("Green Team");
    expect(ownerElsewhere.state.workspaceName).toBe("Green Team");
    expect(await ownerElsewhere.setAccessPolicy("invite_only")).toBe("invite_only");
    expect(ownerElsewhere.state.accessPolicy).toBe("invite_only");
    await expect.poll(() => member.state.accessPolicy).toBe("invite_only");
  });

  it("are refused to a member, who sees nothing change", async () => {
    await expect(member.api.renameWorkspace("Taken Over")).rejects.toMatchObject({
      code: "admin_only",
    });
    await expect(member.api.setAccessPolicy("guest_allowed")).rejects.toMatchObject({
      code: "admin_only",
    });
    expect(member.state.workspaceName).toBe("Rocket Team");
    expect(member.state.accessPolicy).toBe("account_required");
  });

  it("are not offered by a server that does not take them", () => {
    // A server before workspace settings sends neither the flag nor the rule.
    const older = new WorkspaceClient("http://127.0.0.1:9", "token");
    try {
      const self = member.state.self!;
      const connection = older as unknown as { handleServerMessage(message: unknown): void };
      connection.handleServerMessage({
        type: "ready",
        seq: 0,
        self,
        users: [self],
        channels: [],
        memberships: [],
        channelLastSeq: {},
        presence: {},
        savedMessageIds: [],
        huddles: {},
        workspaceName: "W",
      });
      expect(older.state.workspaceSettings).toBe(false);
      expect(older.state.accessPolicy).toBeNull();
    } finally {
      older.destroy();
    }
  });
});
