import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEntry } from "@ownbase/protocol";
import { hashToken } from "../src/auth.js";
import { recoverAccount } from "../src/recover.js";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/** An app endpoint that accepts every url_verification challenge. */
let endpoint: Server;
let endpointPort: number;

let server: WorkspaceServer | undefined;
let directory: string;
let base: string;
let owner: { token: string; id: string };
let member: { token: string; id: string };

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

async function start() {
  server = await createWorkspaceServer({
    dataDir: directory,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    allowPrivateHooks: true,
    rateLimits: false,
    logger: false,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function register(handle: string) {
  const res = await call<{ token: string; user: { id: string } }>(
    "/api/auth/register",
    null,
    "POST",
    { handle, displayName: handle, password: "password123" },
  );
  return { token: res.data.token, id: res.data.user.id };
}

/** The record, newest first, as an administrator reads it. */
async function audit(): Promise<AuditEntry[]> {
  const res = await call<{ entries: AuditEntry[] }>("/api/admin/audit?limit=200", owner.token);
  expect(res.status).toBe(200);
  return res.data.entries;
}

beforeAll(async () => {
  endpoint = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const challenge = /"challenge":"([^"]+)"/.exec(Buffer.concat(chunks).toString())?.[1];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(challenge ? JSON.stringify({ challenge }) : "");
    });
  });
  await new Promise<void>((r) => endpoint.listen(0, "127.0.0.1", r));
  endpointPort = (endpoint.address() as { port: number }).port;
});

afterAll(() => new Promise<void>((r) => endpoint.close(() => r())));

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "ownbase-audit-"));
  await start();
  owner = await register("owner");
  member = await register("member");
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  rmSync(directory, { recursive: true, force: true });
});

describe("the administrative record", () => {
  it("says who changed an account, and what changed", async () => {
    await call(`/api/admin/users/${member.id}`, owner.token, "PATCH", { role: "admin" });
    await call(`/api/admin/users/${member.id}`, owner.token, "PATCH", { deactivated: true });
    await call(`/api/admin/users/${member.id}`, owner.token, "PATCH", { deactivated: false });
    await call(`/api/admin/users/${member.id}/password`, owner.token, "POST");

    const entries = await audit();
    expect(entries.map((e) => e.action)).toEqual([
      "user.password_reset",
      "user.reactivated",
      "user.deactivated",
      "user.role_changed",
    ]);
    for (const entry of entries) {
      expect(entry.actorId).toBe(owner.id);
      expect(entry.targetType).toBe("user");
      expect(entry.targetId).toBe(member.id);
    }
    expect(entries.find((e) => e.action === "user.role_changed")!.details).toEqual({
      from: "member",
      to: "admin",
    });
  });

  it("records nothing for a change that changed nothing, or was refused", async () => {
    await call(`/api/admin/users/${member.id}`, owner.token, "PATCH", { role: "member" });
    // Refused: nobody can act on the owner.
    const refused = await call(`/api/admin/users/${owner.id}`, member.token, "PATCH", {
      deactivated: true,
    });
    expect(refused.status).toBe(403);
    expect(await audit()).toEqual([]);
  });

  it("records a handover of the workspace", async () => {
    await call(`/api/admin/users/${member.id}/owner`, owner.token, "POST");
    const [entry] = await audit();
    expect(entry).toMatchObject({
      action: "workspace.ownership_transferred",
      actorId: owner.id,
      targetId: member.id,
      details: { previousOwner: owner.id },
    });
  });

  it("follows an app through its life without writing down a credential", async () => {
    const made = await call<{ app: { id: string }; token: string; signingSecret: string }>(
      "/api/apps",
      owner.token,
      "POST",
      { name: "Audited Bot" },
    );
    const appId = made.data.app.id;
    const newToken = (await call(`/api/apps/${appId}/token`, owner.token, "POST")).data.token;
    const newSecret = (await call(`/api/apps/${appId}/signing-secret`, owner.token, "POST")).data
      .signingSecret;
    const channelId = server!.store.getChannelByName("general")!.id;
    const hook = await call<{ webhook: { id: string }; url: string }>(
      `/api/apps/${appId}/webhooks`,
      owner.token,
      "POST",
      { channelId },
    );
    const replacedHook = await call<{ url: string }>(
      `/api/webhooks/${hook.data.webhook.id}/url`,
      owner.token,
      "POST",
    );
    await call(`/api/webhooks/${hook.data.webhook.id}`, owner.token, "DELETE");
    // A URL whose path is itself a secret, as many hook URLs are.
    const secretPath = "/incoming/very-private-path-segment";
    const command = await call<{ command: { id: string } }>(
      `/api/apps/${appId}/commands`,
      owner.token,
      "POST",
      { command: "/audited", url: `http://127.0.0.1:${endpointPort}${secretPath}` },
    );
    await call(`/api/commands/${command.data.command.id}`, owner.token, "DELETE");
    await call(`/api/apps/${appId}/interactivity`, owner.token, "PUT", {
      url: `http://127.0.0.1:${endpointPort}${secretPath}`,
    });
    await call(`/api/apps/${appId}/scopes`, owner.token, "PUT", { scopes: ["chat:write"] });
    // The same list again changes nothing, and is not logged.
    await call(`/api/apps/${appId}/scopes`, owner.token, "PUT", { scopes: ["chat:write"] });
    const sub = await call<{ subscription: { id: string } }>(
      `/api/apps/${appId}/subscriptions`,
      owner.token,
      "POST",
      { url: `http://127.0.0.1:${endpointPort}${secretPath}` },
    );
    await call(`/api/subscriptions/${sub.data.subscription.id}/retry`, owner.token, "POST");
    await call(`/api/subscriptions/${sub.data.subscription.id}`, owner.token, "DELETE");
    await call(`/api/apps/${appId}`, owner.token, "DELETE");

    const entries = await audit();
    expect(entries.map((e) => e.action).reverse()).toEqual([
      "app.created",
      "app.token_replaced",
      "app.signing_secret_replaced",
      "webhook.created",
      "webhook.url_replaced",
      "webhook.deleted",
      "command.created",
      "command.deleted",
      "app.interactivity_url_changed",
      "app.scopes_changed",
      "subscription.created",
      "subscription.retried",
      "subscription.deleted",
      "app.deleted",
    ]);
    expect(entries.find((e) => e.action === "command.created")!.details).toMatchObject({
      command: "/audited",
      host: `127.0.0.1:${endpointPort}`,
    });

    // None of the things that would still work if copied out of the record.
    const recorded = JSON.stringify(entries);
    for (const secret of [
      made.data.token,
      made.data.signingSecret,
      newToken,
      newSecret,
      hook.data.url,
      replacedHook.data.url,
      secretPath,
    ]) {
      expect(recorded).not.toContain(secret);
    }
  });

  it("identifies an invite by a fingerprint, never by its code", async () => {
    await call(`/api/admin/users/${member.id}`, owner.token, "PATCH", { canInvite: true });
    const created = await call<{ invite: { code: string } }>("/api/invites", member.token, "POST", {
      expiresInHours: 24,
    });
    const code = created.data.invite.code;
    await call(`/api/invites/${code}`, owner.token, "DELETE");

    const [revoked, issued] = await audit();
    expect(issued).toMatchObject({ action: "invite.created", actorId: member.id });
    expect(revoked).toMatchObject({ action: "invite.revoked", actorId: owner.id });
    // The same fingerprint both times, so the two can be matched up.
    expect(revoked!.targetId).toBe(issued!.targetId);
    expect(issued!.targetId).toBe(hashToken(code).slice(0, 12));
    expect(JSON.stringify([revoked, issued])).not.toContain(code);
  });

  it("records a recovery the host made from the command line", async () => {
    await server!.stop();
    server = undefined;
    await recoverAccount({ dataDir: directory, handle: "member", makeOwner: true });
    await start();

    // Read from the store: the recovered account must choose a new password
    // before the API will answer it, and the old owner is no longer the owner.
    const [entry] = server!.store.listAudit({ limit: 10 });
    expect(entry).toMatchObject({
      action: "account.recovered",
      // Nobody signed in did this; the host did, with the workspace file.
      actorId: null,
      targetId: member.id,
      details: { madeOwner: true, reactivated: false },
    });
  });

  it("keeps changes made in the same millisecond in the order they happened", () => {
    // Ten, numbered: ids made in one millisecond are random among themselves,
    // so ordering by id would get this exactly right about once in 3.6 million.
    const at = Date.now();
    for (let n = 0; n < 10; n++) {
      server!.store.recordAudit(
        {
          actorId: owner.id,
          action: "user.deactivated",
          targetType: "user",
          targetId: member.id,
          details: { n },
        },
        at,
      );
    }
    const newestFirst = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
    const listed = server!.store.listAudit({ limit: 10 });
    expect(listed.map((e) => e.details.n)).toEqual(newestFirst);
    // And paging from any entry continues from the right place.
    const rest = server!.store.listAudit({ before: listed[3]!.id, limit: 10 });
    expect(rest.map((e) => e.details.n)).toEqual(newestFirst.slice(4));
  });

  it("is for administrators only", async () => {
    const res = await call("/api/admin/audit", member.token);
    expect(res.status).toBe(403);
  });

  it("pages from the newest entry back", async () => {
    for (let i = 0; i < 3; i++) {
      await call("/api/invites", owner.token, "POST", { expiresInHours: 24 });
    }
    const first = await call<{ entries: AuditEntry[]; nextCursor: string | null }>(
      "/api/admin/audit?limit=2",
      owner.token,
    );
    expect(first.data.entries).toHaveLength(2);
    expect(first.data.nextCursor).toBe(first.data.entries[1]!.id);
    const second = await call<{ entries: AuditEntry[]; nextCursor: string | null }>(
      `/api/admin/audit?limit=2&before=${first.data.nextCursor}`,
      owner.token,
    );
    expect(second.data.entries).toHaveLength(1);
    expect(second.data.nextCursor).toBeNull();
    const all = [...first.data.entries, ...second.data.entries];
    expect(new Set(all.map((e) => e.id)).size).toBe(3);
    expect(all.map((e) => e.at)).toEqual([...all.map((e) => e.at)].sort((a, b) => b - a));
  });
});
