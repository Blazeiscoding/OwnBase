import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { Api, WorkspaceClient } from "../src/index.js";

let server: WorkspaceServer;
let base: string;
let memberId: string;
let memberToken: string;
let owner: WorkspaceClient;
let member: WorkspaceClient;

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  const api = new Api(base);
  const a = await api.register({ handle: "owner", displayName: "Owner", password: "password123" });
  const b = await api.register({
    handle: "member",
    displayName: "Member",
    password: "password123",
  });
  memberId = b.user.id;
  memberToken = b.token;
  owner = new WorkspaceClient(base, a.token);
  member = new WorkspaceClient(base, b.token);
  owner.connect();
  member.connect();
  await expect.poll(() => owner.state.status).toBe("online");
  await expect.poll(() => member.state.status).toBe("online");
});

afterEach(async () => {
  owner?.destroy();
  member?.destroy();
  await server?.stop();
});

/**
 * User groups (J13): the list comes with the snapshot and follows every
 * change an admin makes, here at once and on everyone else's devices live.
 */
describe("user groups", () => {
  it("follow what an admin makes, changes and deletes", async () => {
    const made = await owner.createUserGroup({ handle: "design", name: "Design" });
    if (made instanceof Error) throw made;
    expect(owner.state.userGroups[made.id]).toEqual(made);
    await expect.poll(() => member.state.userGroups[made.id]).toEqual(made);

    const changed = await owner.updateUserGroup(made.id, { memberIds: [memberId] });
    if (changed instanceof Error) throw changed;
    expect(changed.memberIds).toEqual([memberId]);
    await expect.poll(() => member.state.userGroups[made.id]?.memberIds).toEqual([memberId]);

    expect(await owner.deleteUserGroup(made.id)).toBeNull();
    expect(owner.state.userGroups).toEqual({});
    await expect.poll(() => member.state.userGroups).toEqual({});
  });

  it("come with the snapshot", async () => {
    const made = await owner.createUserGroup({ handle: "design", name: "Design" });
    if (made instanceof Error) throw made;
    const later = new WorkspaceClient(base, memberToken);
    later.connect();
    try {
      await expect.poll(() => later.state.status).toBe("online");
      expect(later.state.userGroups).toEqual({ [made.id]: made });
    } finally {
      later.destroy();
    }
  });

  it("give the server's refusal, such as a handle someone has", async () => {
    expect(await owner.createUserGroup({ handle: "member", name: "Taken" })).toMatchObject({
      code: "handle_taken",
    });
  });
});
