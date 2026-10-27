import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import type { Invite } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

let server: WorkspaceServer;
let base: string;
let owner: { token: string; id: string };
let member: { token: string; id: string };
let logLines: string[];

async function call<T = any>(path: string, token: string | null, method = "GET", body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as T };
}

async function register(handle: string, inviteCode?: string) {
  return call<{ token: string; user: { id: string }; error?: string }>(
    "/api/auth/register",
    null,
    "POST",
    { handle, displayName: handle, password: "password123", ...(inviteCode ? { inviteCode } : {}) },
  );
}

async function invite(token: string, body: Record<string, unknown> = { expiresInHours: 24 }) {
  return (await call<{ invite: Invite }>("/api/invites", token, "POST", body)).data.invite;
}

beforeEach(async () => {
  logLines = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      logLines.push(String(chunk));
      done();
    },
  });
  // Invite-only, so a refused code is what actually keeps someone out.
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    inviteOnly: true,
    rateLimits: false,
    logger: { stream },
  });
  base = `http://127.0.0.1:${server.port}`;
  const first = await register("owner");
  owner = { token: first.data.token, id: first.data.user.id };
  const joined = await register("member", (await invite(owner.token)).code);
  member = { token: joined.data.token, id: joined.data.user.id };
  // Most of this file is about codes a member made, so this member may make them.
  await allowInviting(member.id, true);
});

async function allowInviting(id: string, canInvite: boolean) {
  const res = await call(`/api/admin/users/${id}`, owner.token, "PATCH", { canInvite });
  expect(res.status).toBe(200);
}

afterEach(() => server.stop());

describe("the invites someone can see", () => {
  it("are every invite, for an administrator", async () => {
    const mine = await invite(owner.token);
    const theirs = await invite(member.token);
    const listed = (await call<{ invites: Invite[] }>("/api/invites", owner.token)).data.invites;
    const codes = listed.map((i) => i.code);
    expect(codes).toContain(mine.code);
    expect(codes).toContain(theirs.code);
  });

  it("are only their own, for a member", async () => {
    // A code is what lets a stranger in, so one member is never shown another's.
    const ownersCode = (await invite(owner.token)).code;
    const theirs = await invite(member.token);
    const listed = (await call<{ invites: Invite[] }>("/api/invites", member.token)).data.invites;
    expect(listed.map((i) => i.code)).toEqual([theirs.code]);
    expect(listed.map((i) => i.code)).not.toContain(ownersCode);
  });

  it("say how each one stands, and how much it has been used", async () => {
    const once = await invite(owner.token, { maxUses: 1 });
    expect((await register("first-in", once.code)).status).toBe(201);
    const listed = (await call<{ invites: Invite[] }>("/api/invites", owner.token)).data.invites;
    const found = listed.find((i) => i.code === once.code)!;
    expect(found.uses).toBe(1);
    expect(found.status).toBe("used_up");
  });
});

describe("revoking an invite", () => {
  it("stops it letting anyone in", async () => {
    const leaked = await invite(owner.token);
    const revoked = await call<{ invite: Invite }>(
      `/api/invites/${leaked.code}`,
      owner.token,
      "DELETE",
    );
    expect(revoked.status).toBe(200);
    expect(revoked.data.invite.status).toBe("revoked");
    expect(revoked.data.invite.revokedAt).toBeTypeOf("number");

    const refused = await register("stranger", leaked.code);
    expect(refused.status).toBe(403);
    expect(refused.data.error).toBe("invite_required");
  });

  it("is something its creator can do", async () => {
    const own = await invite(member.token);
    expect((await call(`/api/invites/${own.code}`, member.token, "DELETE")).status).toBe(200);
    expect((await register("stranger", own.code)).status).toBe(403);
  });

  it("is something an administrator can do to anyone's", async () => {
    const theirs = await invite(member.token);
    expect((await call(`/api/invites/${theirs.code}`, owner.token, "DELETE")).status).toBe(200);
    expect((await register("stranger", theirs.code)).status).toBe(403);
  });

  it("is not something one member can do to another's, and does not confirm it exists", async () => {
    const ownersCode = (await invite(owner.token)).code;
    const refused = await call(`/api/invites/${ownersCode}`, member.token, "DELETE");
    // The same answer as for a code that was never issued.
    expect(refused).toEqual(await call("/api/invites/NOSUCHCODE", member.token, "DELETE"));
    expect(refused.status).toBe(404);
    // And the invite still works.
    expect((await register("welcome", ownersCode)).status).toBe(201);
  });

  it("can be asked twice without failing", async () => {
    const leaked = await invite(owner.token);
    await call(`/api/invites/${leaked.code}`, owner.token, "DELETE");
    const again = await call<{ invite: Invite }>(
      `/api/invites/${leaked.code}`,
      owner.token,
      "DELETE",
    );
    expect(again.status).toBe(200);
    expect(again.data.invite.status).toBe("revoked");
  });

  it("does not write the code to the request log", async () => {
    const leaked = await invite(owner.token);
    await call(`/api/invites/${leaked.code}`, owner.token, "DELETE");
    await new Promise((r) => setTimeout(r, 100));
    const log = logLines.join("");
    expect(log).toContain("/api/invites/REDACTED");
    expect(log).not.toContain(leaked.code);
  });
});

describe("an invite whose creator has been deactivated", () => {
  async function setDeactivated(id: string, deactivated: boolean) {
    const res = await call(`/api/admin/users/${id}`, owner.token, "PATCH", { deactivated });
    expect(res.status).toBe(200);
  }

  it("stops working, since nobody still here vouches for it", async () => {
    const left = await invite(member.token);
    await setDeactivated(member.id, true);
    expect((await register("stranger", left.code)).status).toBe(403);
    const listed = (await call<{ invites: Invite[] }>("/api/invites", owner.token)).data.invites;
    expect(listed.find((i) => i.code === left.code)!.status).toBe("creator_deactivated");
  });

  it("works again if they are brought back, unlike one that was revoked", async () => {
    const paused = await invite(member.token);
    await setDeactivated(member.id, true);
    await setDeactivated(member.id, false);
    expect((await register("welcome-back", paused.code)).status).toBe(201);
  });
});

describe("permission to create invite codes", () => {
  it("is something a new member does not have until an administrator gives it", async () => {
    const joined = await register("newcomer", (await invite(owner.token)).code);
    const newcomer = joined.data.token;
    const me = await call<{ user: { canInvite: boolean } }>("/api/me", newcomer);
    expect(me.data.user.canInvite).toBe(false);

    const refused = await call<{ error: string }>("/api/invites", newcomer, "POST", {
      expiresInHours: 24,
    });
    expect(refused.status).toBe(403);
    expect(refused.data.error).toBe("invite_permission_required");
  });

  it("is always there for an owner, without being given", async () => {
    const me = await call<{ user: { canInvite: boolean } }>("/api/me", owner.token);
    expect(me.data.user.canInvite).toBe(true);
    expect((await call("/api/invites", owner.token, "POST", { expiresInHours: 1 })).status).toBe(
      201,
    );
  });

  it("stops a member's codes working when it is taken away, and starts them again when it is back", async () => {
    const theirs = await invite(member.token);
    await allowInviting(member.id, false);

    expect((await register("too-late", theirs.code)).status).toBe(403);
    const listed = (await call<{ invites: Invite[] }>("/api/invites", owner.token)).data.invites;
    expect(listed.find((i) => i.code === theirs.code)!.status).toBe("creator_not_permitted");
    // And no new ones.
    expect((await call("/api/invites", member.token, "POST", { expiresInHours: 1 })).status).toBe(
      403,
    );

    await allowInviting(member.id, true);
    expect((await register("on-time", theirs.code)).status).toBe(201);
  });

  it("does not stop a member withdrawing the codes they already made", async () => {
    const theirs = await invite(member.token);
    await allowInviting(member.id, false);
    const revoked = await call<{ invite: Invite }>(
      `/api/invites/${theirs.code}`,
      member.token,
      "DELETE",
    );
    expect(revoked.status).toBe(200);
    expect(revoked.data.invite.status).toBe("revoked");
  });

  it("is given by administrators only", async () => {
    const joined = await register("peer", (await invite(owner.token)).code);
    const res = await call(`/api/admin/users/${joined.data.user.id}`, member.token, "PATCH", {
      canInvite: true,
    });
    expect(res.status).toBe(403);
  });

  it("is not a setting for an admin, who can always invite, or for an app", async () => {
    const joined = await register("deputy", (await invite(owner.token)).code);
    const deputy = joined.data.user.id;
    await call(`/api/admin/users/${deputy}`, owner.token, "PATCH", { role: "admin" });
    const forAdmin = await call<{ error: string }>(
      `/api/admin/users/${deputy}`,
      owner.token,
      "PATCH",
      {
        canInvite: false,
      },
    );
    expect(forAdmin.status).toBe(400);
    expect(forAdmin.data.error).toBe("admins_can_always_invite");

    const app = await call<{ botUser: { id: string } }>("/api/apps", owner.token, "POST", {
      name: "Inviting Bot",
    });
    const forApp = await call<{ error: string }>(
      `/api/admin/users/${app.data.botUser.id}`,
      owner.token,
      "PATCH",
      { canInvite: true },
    );
    expect(forApp.status).toBe(400);
    expect(forApp.data.error).toBe("bots_cannot_invite");
  });

  it("goes with the admin role when someone is made a member again", async () => {
    const joined = await register("former-admin", (await invite(owner.token)).code);
    const id = joined.data.user.id;
    await call(`/api/admin/users/${id}`, owner.token, "PATCH", { role: "admin" });
    const made = await invite(joined.data.token);
    await call(`/api/admin/users/${id}`, owner.token, "PATCH", { role: "member" });
    // Being an admin was the permission, so their codes stop with it.
    expect((await register("after-demotion", made.code)).status).toBe(403);
  });

  it("is recorded when it changes, and not when it does not", async () => {
    await allowInviting(member.id, true); // already allowed in beforeEach
    await allowInviting(member.id, false);
    const { entries } = (
      await call<{ entries: { action: string; targetId: string }[] }>(
        "/api/admin/audit?limit=20",
        owner.token,
      )
    ).data;
    const about = entries.filter((e) => e.targetId === member.id).map((e) => e.action);
    expect(about).toEqual(["user.invite_permission_removed", "user.invite_permission_granted"]);
  });
});
