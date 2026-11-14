import { scryptSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";
import * as auth from "../src/auth.js";

/**
 * Stored hashes name the cost that made them (H03): old ones without a name
 * still verify, every hash is made again at today's cost once its owner signs
 * in, and a stored value cannot make the server do more than a bounded amount.
 */
let server: WorkspaceServer;
let base: string;
let owner: { token: string; user: { id: string; handle: string } };

async function request(path: string, token?: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}
const login = (handle = "owner", password = "password123") =>
  request("/api/auth/login", undefined, "POST", { handle, password });
const stored = () => server.store.people.authByHandle("owner")!;
/** What today's cost writes in front of the key. */
const currentPrefix = () => {
  const { ln, r, p } = auth.passwordCost();
  return `$scrypt$ln=${ln},r=${r},p=${p}$`;
};

/** The hash this server wrote before H03: bare hex, at Node's default cost. */
function storeBareHash(password: string) {
  const salt = "a".repeat(32);
  const hash = scryptSync(password, salt, 64).toString("hex");
  server.store.accounts.setPassword(owner.user.id, hash, salt);
  return { hash, salt };
}

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  owner = (
    await request("/api/auth/register", undefined, "POST", {
      handle: "owner",
      displayName: "Owner",
      password: "password123",
    })
  ).body;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await server.stop();
});

describe("the stored hash", () => {
  it("names the cost that made it", async () => {
    expect(stored().passwordHash.startsWith(currentPrefix())).toBe(true);
    expect(stored().passwordHash.slice(currentPrefix().length)).toMatch(/^[0-9a-f]{128}$/);
  });

  it("is made at OWASP's cost unless the environment says otherwise", () => {
    expect(auth.DEFAULT_PASSWORD_COST).toEqual({ ln: 16, r: 8, p: 2 });
  });
});

describe("an old hash, stored without its cost", () => {
  it("signs in, and is stored again at today's cost, which then signs in", async () => {
    const old = storeBareHash("password123");
    expect(auth.needsRehash(old.hash)).toBe(true);

    expect((await login()).status).toBe(200);
    const upgraded = stored();
    expect(upgraded.passwordHash).not.toBe(old.hash);
    expect(upgraded.passwordHash.startsWith(currentPrefix())).toBe(true);
    expect(auth.needsRehash(upgraded.passwordHash)).toBe(false);
    expect(await auth.verifyPassword("password123", upgraded.salt, upgraded.passwordHash)).toBe(
      true,
    );
    expect((await login()).status).toBe(200);
    expect((await login("owner", "password124")).status).toBe(401);
  });

  it("is left alone by a wrong password", async () => {
    const old = storeBareHash("password123");
    expect((await login("owner", "password124")).status).toBe(401);
    expect(stored().passwordHash).toBe(old.hash);
  });

  it("keeps the person signed in when storing it again fails", async () => {
    const old = storeBareHash("password123");
    vi.spyOn(server.store.accounts, "rehashPassword").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect((await login()).status).toBe(200);
    expect(stored().passwordHash).toBe(old.hash);
    expect((await login()).status).toBe(200);
    expect(stored().passwordHash.startsWith(currentPrefix())).toBe(true);
  });

  it("neither undoes nor signs in past a password changed while it was hashed again", async () => {
    storeBareHash("password123");
    const replacement = await auth.hashPassword("replacement123");
    const hash = auth.hashPassword;
    vi.spyOn(auth, "hashPassword").mockImplementationOnce(async (password) => {
      const credentials = await hash(password);
      server.store.accounts.setPassword(owner.user.id, replacement.hash, replacement.salt);
      return credentials;
    });
    expect((await login()).status).toBe(401);
    expect(stored().passwordHash).toBe(replacement.hash);
    expect((await login("owner", "replacement123")).status).toBe(200);
  });

  it("keeps a reset's must-change flag", async () => {
    const salt = "b".repeat(32);
    const hash = scryptSync("password123", salt, 64).toString("hex");
    server.store.accounts.setPassword(owner.user.id, hash, salt, true);
    expect((await login()).body.mustChangePassword).toBe(true);
    expect(stored().passwordHash.startsWith(currentPrefix())).toBe(true);
    expect((await login()).body.mustChangePassword).toBe(true);
  });

  it("is stored again when the password is confirmed for two-step sign-in", async () => {
    storeBareHash("password123");
    const token = owner.token;
    expect(
      (await request("/api/me/two-step", token, "POST", { password: "password123" })).status,
    ).toBe(200);
    expect(stored().passwordHash.startsWith(currentPrefix())).toBe(true);
  });
});

describe("a hash that names its cost", () => {
  it("verifies at that cost, not today's", async () => {
    const cheaper = { ln: 5, r: 4, p: 1 };
    expect(auth.passwordCost()).not.toEqual(cheaper);
    const made = await auth.hashPassword("password123", cheaper);
    expect(made.hash.startsWith("$scrypt$ln=5,r=4,p=1$")).toBe(true);
    expect(await auth.verifyPassword("password123", made.salt, made.hash)).toBe(true);
    expect(await auth.verifyPassword("password124", made.salt, made.hash)).toBe(false);
    expect(auth.needsRehash(made.hash)).toBe(true);

    server.store.accounts.setPassword(owner.user.id, made.hash, made.salt);
    expect((await login()).status).toBe(200);
    expect(stored().passwordHash.startsWith(currentPrefix())).toBe(true);
  });
});

describe("a stored value that makes no sense", () => {
  const key = "c".repeat(128);
  it.each([
    ["N not a power of two", `$scrypt$ln=3.5,r=8,p=1$${key}`],
    ["N far too large", `$scrypt$ln=40,r=8,p=1$${key}`],
    ["more memory than allowed", `$scrypt$ln=20,r=8,p=1$${key}`],
    ["more work than allowed", `$scrypt$ln=18,r=8,p=16$${key}`],
    ["zero block size", `$scrypt$ln=10,r=0,p=1$${key}`],
    ["a missing field", `$scrypt$ln=10,r=8$${key}`],
    ["a missing key", "$scrypt$ln=10,r=8,p=1$"],
    ["a short key", `$scrypt$ln=10,r=8,p=1$${"c".repeat(64)}`],
    ["an extra field", `$scrypt$ln=10,r=8,p=1$${key}$${key}`],
    ["another scheme", `$argon2id$v=19$${key}`],
    ["bare text that is not hex", "x".repeat(128)],
    ["nothing at all", ""],
  ])("is a wrong password, with no derivation started: %s", async (_, value) => {
    server.store.accounts.setPassword(owner.user.id, value, "d".repeat(32));
    // With both derivation slots taken, one started would be refused as busy.
    const running = [auth.hashPassword("first-password"), auth.hashPassword("second-password")];
    expect(await auth.verifyPassword("password123", "d".repeat(32), value)).toBe(false);
    expect(auth.needsRehash(value)).toBe(false);
    await Promise.all(running);
    const refused = await login();
    expect(refused).toMatchObject({ status: 401, body: { error: "invalid_credentials" } });
    expect(stored().passwordHash).toBe(value);
  });
});
