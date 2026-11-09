import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";
import * as auth from "../src/auth.js";

let server: WorkspaceServer;
let base: string;
let owner: { token: string; user: { id: string } };

async function request(
  path: string,
  token?: string,
  method = "GET",
  body?: unknown,
  extraHeaders: Record<string, string> = {},
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}
const register = (handle: string) =>
  request("/api/auth/register", undefined, "POST", {
    handle,
    displayName: handle,
    password: "password123",
  });
const login = (handle = "owner", password = "password123") =>
  request("/api/auth/login", undefined, "POST", { handle, password });

beforeEach(async () => {
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

describe("workspace claim", () => {
  it.each(["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"])(
    "requires the host's claim code behind %s",
    async (header) => {
      const headers = { [header]: "proxy" };
      expect(
        (await request("/api/server-info", undefined, "GET", undefined, headers)).body
          .requiresClaim,
      ).toBe(true);
      const body = { handle: "owner", displayName: "Owner", password: "password123" };
      expect((await request("/api/auth/register", undefined, "POST", body, headers)).status).toBe(
        403,
      );
      expect(server.store.people.count()).toBe(0);
      const claimed = await request(
        "/api/auth/register",
        undefined,
        "POST",
        { ...body, claimCode: server.claimCode },
        headers,
      );
      expect(claimed.status).toBe(201);
      expect(claimed.body.user.role).toBe("owner");
      expect(server.store.getMeta("claim_code")).toBe("");
    },
  );
});

describe("account controls", () => {
  beforeEach(async () => {
    owner = (await register("owner")).body;
  });

  it("lists session identifiers without bearer secrets and only revokes the caller's devices", async () => {
    const second = (await login()).body;
    const guest = (await register("guest")).body;
    const sessions = (await request("/api/auth/sessions", owner.token)).body.sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s: any) => s.current)).toHaveLength(1);
    expect(JSON.stringify(sessions)).not.toContain(owner.token);
    expect(JSON.stringify(sessions)).not.toContain(auth.hashToken(owner.token));
    const otherId = sessions.find((s: any) => !s.current).id;
    expect((await request(`/api/auth/sessions/${otherId}`, guest.token, "DELETE")).status).toBe(
      404,
    );
    expect((await request(`/api/auth/sessions/${otherId}`, owner.token, "DELETE")).status).toBe(
      200,
    );
    expect((await request("/api/me", second.token)).status).toBe(401);
    expect((await request("/api/me", owner.token)).status).toBe(200);
    expect((await request("/api/me", guest.token)).status).toBe(200);
  });

  it("changes the password, revokes other sessions, and keeps the requesting device", async () => {
    const other = (await login()).body;
    expect(
      (
        await request("/api/auth/password", owner.token, "POST", {
          currentPassword: "wrong",
          newPassword: "new-password123",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/auth/password", owner.token, "POST", {
          currentPassword: "password123",
          newPassword: "new-password123",
        })
      ).status,
    ).toBe(200);
    expect((await request("/api/me", other.token)).status).toBe(401);
    expect((await request("/api/me", owner.token)).status).toBe(200);
    expect((await login()).status).toBe(401);
    expect((await login("owner", "new-password123")).status).toBe(200);
  });

  it("does not authenticate a password replaced while verification was in progress", async () => {
    const verify = auth.verifyPassword;
    const credentials = await auth.hashPassword("replacement123");
    vi.spyOn(auth, "verifyPassword").mockImplementationOnce(async (...args) => {
      const valid = await verify(...args);
      server.store.setPassword(owner.user.id, credentials.hash, credentials.salt);
      return valid;
    });
    expect((await login()).status).toBe(401);
    expect((await login("owner", "replacement123")).status).toBe(200);
  });

  it("cannot change a password after its requesting session is revoked during hashing", async () => {
    const hash = auth.hashPassword;
    vi.spyOn(auth, "hashPassword").mockImplementationOnce(async (password) => {
      const credentials = await hash(password);
      server.store.deleteSession(auth.hashToken(owner.token));
      return credentials;
    });
    expect(
      (
        await request("/api/auth/password", owner.token, "POST", {
          currentPassword: "password123",
          newPassword: "new-password123",
        })
      ).status,
    ).toBe(401);
    expect((await login()).status).toBe(200);
    expect((await login("owner", "new-password123")).status).toBe(401);
  });

  it("resets member credentials while protecting the owner and peer administrators", async () => {
    const admin = (await register("admin")).body;
    const peer = (await register("peer")).body;
    const member = (await register("member")).body;
    server.store.people.update(admin.user.id, { role: "admin" });
    server.store.people.update(peer.user.id, { role: "admin" });
    const reset = (target: string, token = admin.token) =>
      request(`/api/admin/users/${target}/password`, token, "POST");
    expect((await reset(owner.user.id)).status).toBe(403);
    expect((await reset(peer.user.id)).status).toBe(403);
    expect((await reset(admin.user.id)).status).toBe(400);
    expect((await reset(admin.user.id, member.token)).status).toBe(403);
    const result = await reset(member.user.id);
    expect(result.status).toBe(200);
    expect((await request("/api/me", member.token)).status).toBe(401);
    expect((await login("member")).status).toBe(401);
    expect((await login("member", result.body.temporaryPassword)).status).toBe(200);
  });

  it("rechecks administrative permissions after password hashing", async () => {
    const admin = (await register("admin")).body;
    const member = (await register("member")).body;
    server.store.people.update(admin.user.id, { role: "admin" });
    const hash = auth.hashPassword;
    vi.spyOn(auth, "hashPassword").mockImplementationOnce(async (password) => {
      const credentials = await hash(password);
      server.store.people.update(admin.user.id, { role: "member" });
      return credentials;
    });
    expect(
      (await request(`/api/admin/users/${member.user.id}/password`, admin.token, "POST")).status,
    ).toBe(403);
    expect((await login("member")).status).toBe(200);
    expect((await request("/api/me", member.token)).status).toBe(200);
  });

  it("transfers ownership only from the current owner to an active human account", async () => {
    const member = (await register("member")).body;
    const transfer = (token: string, id: string) =>
      request(`/api/admin/users/${id}/owner`, token, "POST");
    expect((await transfer(member.token, member.user.id)).status).toBe(403);
    server.store.people.update(member.user.id, { deactivated: true });
    expect((await transfer(owner.token, member.user.id)).status).toBe(400);
    server.store.people.update(member.user.id, { deactivated: false });
    expect((await transfer(owner.token, member.user.id)).status).toBe(200);
    expect(
      server.store.people
        .list()
        .filter((u) => u.role === "owner")
        .map((u) => u.id),
    ).toEqual([member.user.id]);
    expect(server.store.people.get(owner.user.id)!.role).toBe("admin");
    expect((await transfer(owner.token, owner.user.id)).status).toBe(403);
  });
});
