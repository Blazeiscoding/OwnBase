import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import type { AuditEntry, SettingsPanel, User } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { enterprise } from "../src/enterprise.js";
import { LICENSE_PREFIX, type LicenseClaims } from "../src/license.js";
import { applyPatch, parseFilter, matches, ScimError } from "../src/scimResource.js";

/**
 * Provisioning with SCIM 2.0 (P10). The sequences below are the requests
 * Okta and Microsoft Entra ID document that they send, in the order they
 * send them, with their bodies as published:
 * - Okta, "SCIM 2.0 protocol reference" (developer.okta.com/docs/api/openapi/okta-scim/guides/scim-20/)
 * - Entra, "Develop a SCIM endpoint" (learn.microsoft.com/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups),
 *   its "SCIM protocol requests and responses" and the SCIM Validator's checks.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 13, 12);
const PUBLIC = "https://chat.acme.test";
const CLAIM = "claim-code-for-tests";
const licenseKeys = generateKeyPairSync("ed25519");
let clock = NOW;

function license(over: Partial<LicenseClaims> = {}): string {
  const claims: LicenseClaims = {
    id: "lic-acme",
    licensee: "Acme Ltd",
    plan: "enterprise",
    members: 200,
    features: ["scim"],
    issuedAt: NOW - 30 * DAY,
    expiresAt: NOW + 300 * DAY,
    ...over,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign(null, Buffer.from(`${LICENSE_PREFIX}.${payload}`), licenseKeys.privateKey);
  return `${LICENSE_PREFIX}.${payload}.${signature.toString("base64url")}`;
}

let server: WorkspaceServer | undefined;
let base: string;
type Account = { token: string; user: User };

afterEach(async () => {
  await server?.stop();
  server = undefined;
  clock = NOW;
});

async function start(text: string | null = license()) {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    logger: false,
    claimCode: CLAIM,
    publicUrl: PUBLIC,
    extensions: [enterprise({ license: text, trusted: [licenseKeys.publicKey], now: () => clock })],
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function call(path: string, token?: string, body?: unknown, method = "POST") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as any };
}

async function people() {
  const register = async (handle: string, extra: object = {}): Promise<Account> =>
    (
      await call("/api/auth/register", undefined, {
        handle,
        displayName: handle,
        password: "password123",
        ...extra,
      })
    ).data;
  const owner = await register("owner", { claimCode: CLAIM });
  const member = await register("member");
  return { owner, member };
}

/** The owner presses Make a token in Workspace settings. */
async function makeToken(owner: Account): Promise<string> {
  const made = await call("/api/scim/token", owner.token);
  expect(made.status).toBe(200);
  expect(made.data.reveal).toMatchObject({ label: "SCIM token" });
  return made.data.reveal.value as string;
}

/** A request as an identity provider sends it: SCIM's content type, the bearer token. */
async function scim(token: string | null, method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}/scim/v2${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      accept: "application/scim+json",
      ...(body === undefined ? {} : { "content-type": "application/scim+json; charset=utf-8" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    location: response.headers.get("location"),
    data: text ? (JSON.parse(text) as any) : undefined,
  };
}

const q = (filter: string) => `/Users?filter=${encodeURIComponent(filter)}`;

const panels = async (owner: Account) =>
  (await call("/api/admin/extension-settings", owner.token, undefined, "GET")).data
    .panels as SettingsPanel[];

describe("provisioning as Okta does it", () => {
  // Okta's create, as its guide gives it: a password it sends even with
  // password sync off, and groups it never fills here.
  const created = {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    userName: "test.user@okta.local",
    name: { givenName: "Test", familyName: "User" },
    emails: [{ primary: true, value: "test.user@okta.local", type: "work" }],
    displayName: "Test User",
    locale: "en-US",
    externalId: "00ujl29u0le5T6Aj10h7",
    groups: [],
    password: "password123",
    active: true,
  };

  it("checks, creates, reads, replaces, deactivates and reactivates a person", async () => {
    await start();
    const { owner } = await people();
    const token = await makeToken(owner);

    // 1. Is there one already?
    const none = await scim(
      token,
      "GET",
      `${q('userName eq "test.user@okta.local"')}&startIndex=1&count=100`,
    );
    expect(none.status).toBe(200);
    expect(none.type).toMatch(/^application\/scim\+json/);
    expect(none.data).toEqual({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: 0,
      itemsPerPage: 0,
      startIndex: 1,
      Resources: [],
    });

    // 2. Create.
    const made = await scim(token, "POST", "/Users", created);
    expect(made.status).toBe(201);
    const id = made.data.id as string;
    expect(made.data).toMatchObject({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      id: expect.any(String),
      userName: "test.user@okta.local",
      name: { givenName: "Test", familyName: "User" },
      emails: [{ primary: true, value: "test.user@okta.local", type: "work" }],
      displayName: "Test User",
      externalId: "00ujl29u0le5T6Aj10h7",
      active: true,
      meta: { resourceType: "User", location: `${PUBLIC}/scim/v2/Users/${id}` },
    });
    expect(made.data).not.toHaveProperty("password");
    const person = server!.store.people.get(id)!;
    expect(person).toMatchObject({ handle: "test.user", displayName: "Test User", role: "member" });
    expect(person.deactivated).toBe(false);

    // 3. Read it back, and find it by its name.
    expect((await scim(token, "GET", `/Users/${id}`)).data).toEqual(made.data);
    const found = await scim(token, "GET", q('userName eq "TEST.USER@okta.local"'));
    expect(found.data.totalResults).toBe(1);
    expect(found.data.Resources[0].id).toBe(id);

    // 4. Okta's profile update: GET, then PUT the whole person back, changed.
    const replaced = await scim(token, "PUT", `/Users/${id}`, {
      ...made.data,
      name: { givenName: "Another", familyName: "User" },
      displayName: "Another User",
      password: "password123",
    });
    expect(replaced.status).toBe(200);
    expect(replaced.data).toMatchObject({
      displayName: "Another User",
      name: { givenName: "Another" },
    });
    expect(server!.store.people.get(id)!.displayName).toBe("Another User");

    // 5. Deactivate, as Okta does: replace, with no path.
    const off = await scim(token, "PATCH", `/Users/${id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", value: { active: false } }],
    });
    expect(off.status).toBe(200);
    expect(off.data.active).toBe(false);
    expect(server!.store.people.get(id)!.deactivated).toBe(true);

    // 6. And back.
    const on = await scim(token, "PATCH", `/Users/${id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", value: { active: true } }],
    });
    expect(on.data.active).toBe(true);
    expect(server!.store.people.get(id)).toMatchObject({ deactivated: false, role: "member" });

    // 7. Import: everyone, a hundred at a time, numbers as numbers.
    const page = await scim(token, "GET", "/Users?startIndex=1&count=100");
    expect(page.data).toMatchObject({ totalResults: 3, itemsPerPage: 3, startIndex: 1 });
    expect(page.data.Resources.map((r: { userName: string }) => r.userName)).toEqual([
      "owner",
      "member",
      "test.user@okta.local",
    ]);
    const second = await scim(token, "GET", "/Users?startIndex=2&count=1");
    expect(second.data).toMatchObject({ totalResults: 3, itemsPerPage: 1, startIndex: 2 });
    expect(second.data.Resources[0].userName).toBe("member");

    // The audit log says who deactivated them.
    const audit = (await call("/api/admin/audit", owner.token, undefined, "GET")).data.entries;
    expect(audit.slice(0, 2)).toMatchObject([
      {
        action: "user.reactivated",
        actorId: null,
        targetId: id,
        details: { by: "SCIM provisioning" },
      },
      {
        action: "user.deactivated",
        actorId: null,
        targetId: id,
        details: { by: "SCIM provisioning" },
      },
    ]);
  });

  it("deactivating someone who has the app open ends their session at once", async () => {
    await start();
    const { owner, member } = await people();
    const token = await makeToken(owner);
    // Okta's import matches the account people already had, by its username.
    const matched = await scim(token, "GET", q('userName eq "member"'));
    expect(matched.data.totalResults).toBe(1);
    const id = matched.data.Resources[0].id;
    expect(id).toBe(member.user.id);
    expect((await call("/api/me", member.token, undefined, "GET")).status).toBe(200);
    await scim(token, "PATCH", `/Users/${id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", value: { active: false } }],
    });
    expect((await call("/api/me", member.token, undefined, "GET")).status).toBe(401);
    expect(
      (await call("/api/auth/login", undefined, { handle: "member", password: "password123" }))
        .status,
    ).not.toBe(200);
    // Reactivated, the session they had stays ended, and they sign in again as the member they were.
    await scim(token, "PATCH", `/Users/${id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", value: { active: true } }],
    });
    const back = await call("/api/auth/login", undefined, {
      handle: "member",
      password: "password123",
    });
    expect(back.status).toBe(200);
    expect(back.data.user).toMatchObject({ role: "member", deactivated: false });
    expect((await call("/api/me", member.token, undefined, "GET")).status).toBe(401);
  });
});

describe("provisioning as Microsoft Entra ID does it", () => {
  const userName = "Test_User_00aa00aa-bb11-cc22-dd33-44ee44ee44ee";
  const email = "Test_User_11bb11bb-cc22-dd33-ee44-55ff55ff55ff@testuser.com";
  const created = {
    schemas: [
      "urn:ietf:params:scim:schemas:core:2.0:User",
      "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User",
    ],
    externalId: "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef",
    userName,
    active: true,
    emails: [{ primary: true, type: "work", value: email }],
    meta: { resourceType: "User" },
    name: { formatted: "givenName familyName", familyName: "familyName", givenName: "givenName" },
    roles: [],
  };
  const patch = (...Operations: object[]) => ({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations,
  });

  it("runs the documented requests and the SCIM Validator's checks from start to finish", async () => {
    await start();
    const { owner } = await people();
    const token = await makeToken(owner);

    // Test connection: a random user, and groups, to see the address and token work.
    const random = await scim(
      token,
      "GET",
      q('userName eq "ab6490ee-1e48-479e-a20b-2d77186b5dd1"'),
    );
    expect(random.data).toMatchObject({ totalResults: 0, Resources: [] });
    expect((await scim(token, "GET", "/Groups?excludedAttributes=members")).data).toMatchObject({
      totalResults: 0,
    });

    // Create User.
    const made = await scim(token, "POST", "/Users", created);
    expect(made.status).toBe(201);
    const id = made.data.id as string;
    expect(made.data).toMatchObject({
      id: expect.any(String),
      externalId: created.externalId,
      userName,
      active: true,
      emails: created.emails,
      name: created.name,
      meta: { resourceType: "User", created: expect.any(String), lastModified: expect.any(String) },
    });
    expect(server!.store.people.get(id)!.displayName).toBe("givenName familyName");

    // Create Duplicate User: 201 the first time, 409 the second.
    const again = await scim(token, "POST", "/Users", created);
    expect(again.status).toBe(409);
    expect(again.data).toEqual({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "409",
      scimType: "uniqueness",
      detail: expect.stringContaining(userName),
    });

    // Get User, and one that does not exist.
    const got = await scim(token, "GET", `/Users/${id}`);
    expect(got.data).toMatchObject({ id, userName, externalId: created.externalId });
    const missing = await scim(token, "GET", "/Users/5171a35d82074e068ce2");
    expect(missing.status).toBe(404);
    expect(missing.data).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "404",
    });

    // Get User by query, on either joining attribute, and zero results.
    expect((await scim(token, "GET", q(`userName eq "${userName}"`))).data.Resources).toEqual([
      got.data,
    ]);
    expect(
      (await scim(token, "GET", q(`emails[type eq "work"].value eq "${email}"`))).data.totalResults,
    ).toBe(1);
    expect((await scim(token, "GET", q('userName eq "non-existent user"'))).data).toMatchObject({
      totalResults: 0,
      Resources: [],
    });

    // Update User [Multi-valued properties].
    const multi = await scim(
      token,
      "PATCH",
      `/Users/${id}`,
      patch(
        {
          op: "Replace",
          path: 'emails[type eq "work"].value',
          value: "updatedEmail@microsoft.com",
        },
        { op: "Replace", path: "name.familyName", value: "updatedFamilyName" },
      ),
    );
    expect(multi.status).toBe(200);
    expect(multi.data.emails).toEqual([
      { primary: true, type: "work", value: "updatedEmail@microsoft.com" },
    ]);
    expect(multi.data.name.familyName).toBe("updatedFamilyName");

    // Update User [Single-valued properties]: the joining attribute itself.
    const renamed = "5b50642d-79fc-4410-9e90-4c077cdd1a59@testuser.com";
    await scim(
      token,
      "PATCH",
      `/Users/${id}`,
      patch({ op: "Replace", path: "userName", value: renamed }),
    );
    expect((await scim(token, "GET", q(`userName eq "${renamed}"`))).data.Resources[0].id).toBe(id);
    expect((await scim(token, "GET", q(`userName eq "${userName}"`))).data.totalResults).toBe(0);

    // Add Attributes: kept as sent and given back, the enterprise extension's too.
    await scim(
      token,
      "PATCH",
      `/Users/${id}`,
      patch(
        { op: "Add", path: "title", value: "Product manager" },
        { op: "Add", path: "displayName", value: "Maya Lin" },
        {
          op: "Add",
          path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department",
          value: "Sales",
        },
        { op: "Add", path: 'phoneNumbers[type eq "work"].value', value: "55555555555" },
      ),
    );
    const added = (await scim(token, "GET", q(`userName eq "${renamed}"`))).data.Resources[0];
    expect(added).toMatchObject({
      title: "Product manager",
      displayName: "Maya Lin",
      "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { department: "Sales" },
      phoneNumbers: [{ type: "work", value: "55555555555" }],
    });
    expect(added.schemas).toContain("urn:ietf:params:scim:schemas:extension:enterprise:2.0:User");
    expect(server!.store.people.get(id)!.displayName).toBe("Maya Lin");

    // Disable User; the user is still returned, as inactive.
    const off = await scim(
      token,
      "PATCH",
      `/Users/${id}`,
      patch({ op: "Replace", path: "active", value: false }),
    );
    expect(off.status).toBe(200);
    expect((await scim(token, "GET", q(`userName eq "${renamed}"`))).data.Resources[0].active).toBe(
      false,
    );
    // Entra before its 2020 fixes sent the booleans as text.
    await scim(
      token,
      "PATCH",
      `/Users/${id}`,
      patch({ op: "Replace", path: "active", value: "True" }),
    );
    expect(server!.store.people.get(id)!.deactivated).toBe(false);

    // Delete User: deactivated here, with their messages, and gone to the provider.
    const gone = await scim(token, "DELETE", `/Users/${id}`);
    expect(gone.status).toBe(204);
    expect(gone.data).toBeUndefined();
    expect((await scim(token, "GET", `/Users/${id}`)).status).toBe(404);
    expect((await scim(token, "GET", q(`userName eq "${renamed}"`))).data.totalResults).toBe(0);
    expect(server!.store.people.get(id)).toMatchObject({ deactivated: true });

    // Assigned again later: the same account comes back.
    const back = await scim(token, "POST", "/Users", { ...created, userName: renamed });
    expect(back.status).toBe(201);
    expect(back.data.id).toBe(id);
    expect(server!.store.people.get(id)!.deactivated).toBe(false);
  });
});

describe("the SCIM address", () => {
  it("answers only the token made in Workspace settings, and the newest", async () => {
    await start();
    const { owner, member } = await people();
    const nobody = await scim(null, "GET", "/Users");
    expect(nobody.status).toBe(401);
    expect(nobody.data).toMatchObject({ status: "401", detail: expect.stringContaining("token") });
    // No token made yet: nothing works, a session's token included.
    expect((await scim(owner.token, "GET", "/Users")).status).toBe(401);
    // Only the owner makes one.
    expect((await call("/api/scim/token", member.token)).status).toBe(403);
    const first = await makeToken(owner);
    expect(first).toMatch(/^ownbase-scim-[A-Za-z0-9_-]{43}$/);
    expect((await scim(first, "GET", "/Users")).status).toBe(200);
    expect((await scim(`${first}x`, "GET", "/Users")).status).toBe(401);
    const second = await makeToken(owner);
    expect((await scim(first, "GET", "/Users")).status).toBe(401);
    expect((await scim(second, "GET", "/Users")).status).toBe(200);
    expect((await call("/api/scim/off", owner.token)).status).toBe(200);
    expect((await scim(second, "GET", "/Users")).status).toBe(401);
  });

  it("describes itself, and answers in SCIM's shape where it offers nothing", async () => {
    await start();
    const { owner } = await people();
    const token = await makeToken(owner);
    const config = await scim(token, "GET", "/ServiceProviderConfig");
    expect(config.data).toMatchObject({
      patch: { supported: true },
      bulk: { supported: false },
      filter: { supported: true, maxResults: 200 },
      authenticationSchemes: [expect.objectContaining({ type: "oauthbearertoken" })],
    });
    expect((await scim(token, "GET", "/ResourceTypes")).data.Resources).toEqual([
      expect.objectContaining({ id: "User", endpoint: "/Users" }),
    ]);
    const schemas = (await scim(token, "GET", "/Schemas")).data;
    expect(schemas.Resources.map((s: { id: string }) => s.id)).toEqual([
      "urn:ietf:params:scim:schemas:core:2.0:User",
      "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User",
    ]);
    // Not the web app, which this server serves at any other path.
    const bulk = await scim(token, "POST", "/Bulk", { Operations: [] });
    expect(bulk.status).toBe(404);
    expect(bulk.data).toMatchObject({ status: "404" });
    const group = await scim(token, "POST", "/Groups", { displayName: "Sales" });
    expect(group.status).toBe(404);
  });

  it("refuses what it cannot do, in SCIM's shape", async () => {
    await start();
    const { owner } = await people();
    const token = await makeToken(owner);
    const bad = await scim(token, "GET", q('userName co "maya"'));
    expect(bad.status).toBe(400);
    expect(bad.data).toMatchObject({ scimType: "invalidFilter" });
    expect((await scim(token, "POST", "/Users", { displayName: "No name" })).data).toMatchObject({
      status: "400",
      scimType: "invalidValue",
    });
    // The owner is the way back in, so never deactivated from here.
    const ownerOff = await scim(token, "PATCH", `/Users/${owner.user.id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(ownerOff.status).toBe(403);
    expect(ownerOff.data.detail).toContain("owner");
    expect(server!.store.people.get(owner.user.id)!.deactivated).toBe(false);
    expect((await scim(token, "DELETE", `/Users/${owner.user.id}`)).status).toBe(403);
    // Taking another person's userName.
    const one = await scim(token, "POST", "/Users", { userName: "one@acme.com" });
    const two = await scim(token, "POST", "/Users", { userName: "two@acme.com" });
    const clash = await scim(token, "PUT", `/Users/${two.data.id}`, { userName: "ONE@acme.com" });
    expect(clash).toMatchObject({ status: 409, data: { scimType: "uniqueness" } });
    expect(one.data.id).not.toBe(two.data.id);
    expect(
      (await scim(token, "PATCH", `/Users/${one.data.id}`, { Operations: [{ op: "move" }] }))
        .status,
    ).toBe(400);
  });

  it("leaves apps and guests out", async () => {
    await start();
    const { owner } = await people();
    server!.setAccessPolicy("guest_allowed");
    const guest = (await call("/api/auth/guest", undefined, { displayName: "Visitor" })).data;
    const token = await makeToken(owner);
    const everyone = (await scim(token, "GET", "/Users")).data;
    expect(everyone.Resources.map((r: { userName: string }) => r.userName)).toEqual([
      "owner",
      "member",
    ]);
    expect((await scim(token, "GET", `/Users/${guest.user.id}`)).status).toBe(404);
  });
});

describe("provisioning and the license", () => {
  it("shows no panel and makes no token without SCIM in the license", async () => {
    await start(license({ features: ["sso"] }));
    const { owner } = await people();
    expect((await panels(owner)).map((p) => p.id)).not.toContain("scim");
    expect((await call("/api/scim/token", owner.token)).status).toBe(403);
    await server!.stop();
    await start(null);
    const second = await people();
    expect(await panels(second.owner)).toEqual([]);
  });

  it("gives the owner a panel to make the token, and says how it is used", async () => {
    await start();
    const { owner } = await people();
    const before = (await panels(owner)).find((p) => p.id === "scim")!;
    expect(before).toMatchObject({
      title: "Provisioning with SCIM",
      fields: [],
      actions: [{ id: "token", label: "Make a token", path: "/api/scim/token" }],
    });
    expect(before.description).toContain(`${PUBLIC}/scim/v2`);
    expect(before.status).toBeUndefined();
    const token = await makeToken(owner);
    await scim(token, "POST", "/Users", { userName: "maya@acme.com" });
    const after = (await panels(owner)).find((p) => p.id === "scim")!;
    expect(after.status).toBe(
      "Token made on 13 November 2026, last used on 13 November 2026. 1 person added by your identity provider.",
    );
    expect(after.actions!.map((a) => [a.label, !!a.confirm])).toEqual([
      ["Make a new token", true],
      ["Turn off", true],
    ]);
  });

  it("after the license ends, keeps everyone it added and still deactivates, but adds nobody", async () => {
    await start();
    const { owner } = await people();
    const token = await makeToken(owner);
    const maya = await scim(token, "POST", "/Users", { userName: "maya@acme.com" });
    clock = NOW + 400 * DAY;
    const refused = await scim(token, "POST", "/Users", { userName: "sam@acme.com" });
    expect(refused.status).toBe(403);
    expect(refused.data.detail).toContain("license");
    expect(server!.store.people.get(maya.data.id)!.deactivated).toBe(false);
    const off = await scim(token, "PATCH", `/Users/${maya.data.id}`, {
      Operations: [{ op: "replace", value: { active: false } }],
    });
    expect(off.data.active).toBe(false);
    const panel = (await panels(owner)).find((p) => p.id === "scim")!;
    expect(panel.problem).toContain("adds nobody new");
    expect(panel.actions!.map((a) => a.id)).toEqual(["off"]);
    expect((await call("/api/scim/token", owner.token)).status).toBe(403);
  });

  it("puts turning it on, a new token and turning it off in the audit log, never the token", async () => {
    await start();
    const { owner } = await people();
    const first = await makeToken(owner);
    const second = await makeToken(owner);
    expect((await call("/api/scim/off", owner.token)).status).toBe(200);
    // Turning off what is off already changes nothing.
    expect((await call("/api/scim/off", owner.token)).status).toBe(200);
    const entries = (await call("/api/admin/audit", owner.token, undefined, "GET")).data
      .entries as AuditEntry[];
    expect(entries.map((e) => [e.action, e.actorId, e.details.did])).toEqual([
      ["extension.action", owner.user.id, "turned off provisioning with SCIM"],
      [
        "extension.action",
        owner.user.id,
        "made a new SCIM token, and the one before stopped working",
      ],
      ["extension.action", owner.user.id, "turned on provisioning with SCIM and made its token"],
    ]);
    // What the compliance stream sends is the same record.
    const recorded = JSON.stringify(server!.store.audit.after(null, 100));
    for (const token of [first, second]) {
      expect(recorded).not.toContain(token);
      expect(recorded).not.toContain(token.slice("ownbase-scim-".length));
    }
  });
});

describe("SCIM filters and patches", () => {
  const maya = {
    userName: "maya@acme.com",
    name: { givenName: "Maya", familyName: "Lin" },
    emails: [
      { type: "work", value: "maya@acme.com", primary: true },
      { type: "home", value: "maya@home.test" },
    ],
    externalId: "00u-Maya",
  };

  it("picks by the attributes Okta and Entra filter on, joined by and", () => {
    expect(matches(maya, parseFilter('userName eq "MAYA@acme.com"'))).toBe(true);
    expect(matches(maya, parseFilter('emails[type eq "home"].value eq "maya@home.test"'))).toBe(
      true,
    );
    expect(matches(maya, parseFilter('emails[type eq "work"].value eq "maya@home.test"'))).toBe(
      false,
    );
    expect(matches(maya, parseFilter('externalId eq "00u-maya"'))).toBe(false);
    expect(
      matches(maya, parseFilter('externalId eq "00u-Maya" and name.givenName eq "maya"')),
    ).toBe(true);
    expect(
      matches(
        maya,
        parseFilter('urn:ietf:params:scim:schemas:core:2.0:User:userName eq "maya@acme.com"'),
      ),
    ).toBe(true);
    expect(matches(maya, parseFilter("title pr"))).toBe(false);
    expect(() => parseFilter('userName eq "a" or userName eq "b"')).toThrow(ScimError);
    expect(() => parseFilter("userName eq")).toThrow(ScimError);
  });

  it("removes, replaces and adds where a path points", () => {
    const next = applyPatch(maya, {
      Operations: [
        { op: "remove", path: 'emails[type eq "home"]' },
        { op: "replace", path: "name", value: { givenName: "May" } },
        { op: "add", path: "emails", value: [{ type: "other", value: "m@x.test" }] },
        { op: "Add", path: "nickName", value: [{ value: "Mo" }] },
      ],
    });
    expect(next.emails).toEqual([
      { type: "work", value: "maya@acme.com", primary: true },
      { type: "other", value: "m@x.test" },
    ]);
    expect(next.name).toEqual({ givenName: "May" });
    expect(next.nickName).toBe("Mo");
    // The resource given is left as it was.
    expect(maya.emails).toHaveLength(2);
    expect(() => applyPatch(maya, { Operations: [{ op: "remove" }] })).toThrow(ScimError);
    expect(() =>
      applyPatch(maya, { Operations: [{ op: "replace", path: "a b", value: 1 }] }),
    ).toThrow(ScimError);
  });
});
