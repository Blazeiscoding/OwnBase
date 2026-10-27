import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerInfo, SettingsPanel, User } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { enterprise } from "../src/enterprise.js";
import { LICENSE_PREFIX, type LicenseClaims } from "../src/license.js";
import { handleFor, parseDomains } from "../src/sso.js";

/**
 * Single sign-on with OpenID Connect (P9), against a provider running in
 * this process: the whole way through a browser that keeps cookies and
 * follows no redirect by itself, so each step can be looked at or changed.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 28, 12);
const PUBLIC = "http://ownbase.test";
const CLAIM = "claim-code-for-tests";
const licenseKeys = generateKeyPairSync("ed25519");
let clock = NOW;

function license(over: Partial<LicenseClaims> = {}): string {
  const claims: LicenseClaims = {
    id: "lic-acme",
    licensee: "Acme Ltd",
    plan: "enterprise",
    members: 200,
    features: ["sso"],
    issuedAt: NOW - 30 * DAY,
    expiresAt: NOW + 300 * DAY,
    ...over,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign(null, Buffer.from(`${LICENSE_PREFIX}.${payload}`), licenseKeys.privateKey);
  return `${LICENSE_PREFIX}.${payload}.${signature.toString("base64url")}`;
}

const s256 = (value: string) => createHash("sha256").update(value).digest("base64url");
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

interface Person {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
}

/**
 * An OpenID provider, as small as the flow allows: discovery, an authorize
 * endpoint that signs in `person` at once, a token endpoint that checks the
 * client's secret and the PKCE verifier, and its key set.
 */
class TestProvider {
  issuer = "";
  clientId = "ownbase-client";
  clientSecret = "provider-secret";
  person: Person = {
    sub: "00u-maya",
    email: "maya@acme.com",
    email_verified: true,
    name: "Maya Lin",
    preferred_username: "maya@acme.com",
  };
  /** Changes the next ID tokens' claims. */
  tamper: ((claims: Record<string, unknown>) => Record<string, unknown>) | null = null;
  /** Signs with a key it does not publish, under the published key's id. */
  forge = false;
  tokenRequests = 0;
  private readonly key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  private readonly stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
  private readonly codes = new Map<
    string,
    { challenge: string; nonce: string; redirectUri: string; person: Person }
  >();
  private server!: Server;

  async start() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url!, this.issuer || "http://127.0.0.1");
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/.well-known/openid-configuration")
        return json(200, {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/keys`,
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        });
      if (url.pathname === "/keys")
        return json(200, {
          keys: [
            {
              ...this.key.publicKey.export({ format: "jwk" }),
              kid: "k1",
              alg: "RS256",
              use: "sig",
            },
          ],
        });
      if (url.pathname === "/authorize") {
        const q = url.searchParams;
        if (
          q.get("response_type") !== "code" ||
          q.get("client_id") !== this.clientId ||
          q.get("code_challenge_method") !== "S256" ||
          !q.get("scope")?.split(" ").includes("openid")
        )
          return json(400, { error: "invalid_request" });
        const code = randomBytes(16).toString("hex");
        this.codes.set(code, {
          challenge: q.get("code_challenge")!,
          nonce: q.get("nonce")!,
          redirectUri: q.get("redirect_uri")!,
          person: { ...this.person },
        });
        const back = new URL(q.get("redirect_uri")!);
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.get("state")!);
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (url.pathname === "/token" && req.method === "POST") {
        let text = "";
        req.on("data", (chunk) => (text += chunk));
        req.on("end", () => {
          this.tokenRequests++;
          const form = new URLSearchParams(text);
          const basic = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
          if (req.headers.authorization !== basic) return json(401, { error: "invalid_client" });
          const held = this.codes.get(form.get("code") ?? "");
          this.codes.delete(form.get("code") ?? "");
          if (
            !held ||
            held.redirectUri !== form.get("redirect_uri") ||
            s256(form.get("code_verifier") ?? "") !== held.challenge
          )
            return json(400, { error: "invalid_grant" });
          let claims: Record<string, unknown> = {
            iss: this.issuer,
            aud: this.clientId,
            iat: Math.floor(clock / 1000),
            exp: Math.floor(clock / 1000) + 300,
            nonce: held.nonce,
            ...held.person,
          };
          if (this.tamper) claims = this.tamper(claims);
          const signed = `${b64({ alg: "RS256", kid: "k1", typ: "JWT" })}.${b64(claims)}`;
          const by: KeyObject = this.forge ? this.stranger.privateKey : this.key.privateKey;
          const signature = sign("sha256", Buffer.from(signed), by).toString("base64url");
          json(200, {
            access_token: "unused",
            token_type: "Bearer",
            id_token: `${signed}.${signature}`,
          });
        });
        return;
      }
      json(404, { error: "not_found" });
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** A browser: it keeps the workspace's cookie and follows no redirect by itself. */
class Browser {
  cookie = "";
  async get(url: string) {
    const response = await fetch(url, {
      redirect: "manual",
      headers: this.cookie ? { cookie: this.cookie } : {},
    });
    const set = response.headers.get("set-cookie");
    if (set) {
      const pair = set.split(";")[0]!;
      this.cookie = pair.endsWith("=") ? "" : pair;
    }
    return {
      status: response.status,
      location: response.headers.get("location"),
      text: await response.text(),
    };
  }
}

const provider = new TestProvider();
let server: WorkspaceServer | undefined;
let base: string;
type Account = { token: string; user: User };

beforeAll(() => provider.start());
afterAll(() => provider.stop());
afterEach(async () => {
  await server?.stop();
  server = undefined;
  provider.tamper = null;
  provider.forge = false;
  provider.person = {
    sub: "00u-maya",
    email: "maya@acme.com",
    email_verified: true,
    name: "Maya Lin",
    preferred_username: "maya@acme.com",
  };
  clock = NOW;
});

async function start(text: string | null = license(), publicUrl: string | null = PUBLIC) {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    logger: false,
    claimCode: CLAIM,
    ...(publicUrl ? { publicUrl } : {}),
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

async function setUp(owner: Account, extra: object = {}) {
  const saved = await call(
    "/api/sso/settings",
    owner.token,
    {
      name: "Okta",
      issuer: provider.issuer,
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      ...extra,
    },
    "PUT",
  );
  expect(saved).toEqual({ status: 200, data: { ok: true } });
}

/** The workspace's own address for one it gave under its public one. */
const here = (url: string) => {
  const at = new URL(url);
  expect(at.origin).toBe(PUBLIC);
  return base + at.pathname + at.search;
};

/**
 * Through the provider and back. `stop` leaves the browser at the callback,
 * not yet asked for, to change or replay it.
 */
async function throughProvider(browser: Browser, start: string) {
  const begun = await browser.get(base + start);
  expect(begun.status).toBe(302);
  expect(browser.cookie).toMatch(/^ownbase_sso=/);
  const atProvider = await browser.get(begun.location!);
  expect(atProvider.status).toBe(302);
  return here(atProvider.location!);
}

/** The sign-in button, the provider, and back: the code the app gets, and its secret. */
async function signInWithSso(browser = new Browser(), client: "web" | "desktop" = "web") {
  const verifier = randomBytes(32).toString("base64url");
  const callback = await throughProvider(
    browser,
    `/api/sso/start?client=${client}&challenge=${s256(verifier)}`,
  );
  const back = await browser.get(callback);
  return { back, verifier, callback };
}

const codeIn = (location: string | null) => {
  const match = /^http:\/\/ownbase\.test\/#\/sso\/([A-Za-z0-9_-]{43})$/.exec(location ?? "");
  expect(match, `not a code: ${location}`).not.toBeNull();
  return match![1]!;
};

/** A signed-in person links the provider's account from Account settings. */
async function linkAccount(account: Account) {
  const asked = await call("/api/sso/connect", account.token);
  expect(asked.status).toBe(200);
  expect(asked.data.url).toMatch(/^\/api\/sso\/start\?link=/);
  const browser = new Browser();
  const back = await browser.get(await throughProvider(browser, asked.data.url));
  return back;
}

describe("single sign-on through an OpenID provider", () => {
  it("links a signed-in person's account, then signs them in with a one-time code", async () => {
    await start();
    const { owner, member } = await people();
    await setUp(owner);

    const info = (await call("/api/server-info", undefined, undefined, "GET")).data as ServerInfo;
    expect(info.signIn).toEqual({
      methods: [
        {
          id: "sso",
          name: "Okta",
          start: "/api/sso/start",
          redeem: "/api/sso/redeem",
          connect: "/api/sso/connect",
        },
      ],
      passwords: "everyone",
    });

    expect((await call("/api/sso/connect", member.token, undefined, "GET")).data).toEqual({
      connected: false,
    });
    const linked = await linkAccount(member);
    expect(linked.status).toBe(200);
    expect(linked.text).toContain("@member signs in with Okta as maya@acme.com");
    expect((await call("/api/sso/connect", member.token, undefined, "GET")).data).toEqual({
      connected: true,
      as: "maya@acme.com",
    });

    const { back, verifier } = await signInWithSso();
    expect(back.status).toBe(302);
    const code = codeIn(back.location);
    // Only with the secret of the client that began.
    expect(
      (await call("/api/sso/redeem", undefined, { code, verifier: "x".repeat(43) })).data,
    ).toMatchObject({ error: "sso_code_invalid" });
    const { back: again, verifier: second } = await signInWithSso();
    const signedIn = await call("/api/sso/redeem", undefined, {
      code: codeIn(again.location),
      verifier: second,
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.data.user).toMatchObject({ id: member.user.id, handle: "member" });
    const me = await call("/api/me", signedIn.data.token, undefined, "GET");
    expect(me.data.user?.id ?? me.data.id).toBe(member.user.id);
    // Each code once.
    expect(
      (await call("/api/sso/redeem", undefined, { code: codeIn(again.location), verifier: second }))
        .status,
    ).toBe(401);
    expect(verifier).not.toBe(second);
  });

  it("sends the desktop app its code through an ownbase:// link", async () => {
    await start();
    const { owner, member } = await people();
    await setUp(owner);
    await linkAccount(member);
    const { back, verifier } = await signInWithSso(new Browser(), "desktop");
    expect(back.status).toBe(200);
    const link = /ownbase:\/\/sso\?host=http:\/\/ownbase\.test&#38;code=([A-Za-z0-9_-]{43})/.exec(
      back.text,
    );
    expect(link).not.toBeNull();
    expect(back.text).toContain('http-equiv="refresh"');
    const signedIn = await call("/api/sso/redeem", undefined, { code: link![1], verifier });
    expect(signedIn.data.user.id).toBe(member.user.id);
  });

  it("refuses an ID token for another application", async () => {
    await start();
    const { owner, member } = await people();
    await setUp(owner);
    await linkAccount(member);
    provider.tamper = (claims) => ({ ...claims, aud: "someone-else" });
    const { back } = await signInWithSso();
    expect(back.status).toBe(502);
    expect(back.text).toContain("it is for another application");
    expect(back.location).toBeNull();
  });

  it("refuses an expired ID token, and one from the future", async () => {
    await start();
    const { owner, member } = await people();
    await setUp(owner);
    await linkAccount(member);
    provider.tamper = (claims) => ({ ...claims, exp: Math.floor(clock / 1000) - 120 });
    expect((await signInWithSso()).back.text).toContain("it has expired");
    provider.tamper = (claims) => ({ ...claims, iat: Math.floor(clock / 1000) + 600 });
    expect((await signInWithSso()).back.text).toContain("issued in the future");
    provider.tamper = (claims) => ({ ...claims, iss: "https://evil.example" });
    expect((await signInWithSso()).back.text).toContain("issued by https://evil.example");
    provider.tamper = (claims) => ({ ...claims, nonce: "another" });
    expect((await signInWithSso()).back.text).toContain("not made for this sign-in");
  });

  it("refuses a token signed with a key the provider does not publish", async () => {
    await start();
    const { owner, member } = await people();
    await setUp(owner);
    await linkAccount(member);
    provider.forge = true;
    const { back } = await signInWithSso();
    expect(back.status).toBe(502);
    expect(back.text).toContain("its signature does not match");
  });

  it("refuses a state used already, and a way back to another browser", async () => {
    await start();
    const { owner, member } = await people();
    await setUp(owner);
    await linkAccount(member);
    const browser = new Browser();
    const verifier = randomBytes(32).toString("base64url");
    const callback = await throughProvider(
      browser,
      `/api/sso/start?client=web&challenge=${s256(verifier)}`,
    );
    const cookie = browser.cookie;
    expect((await browser.get(callback)).status).toBe(302);
    browser.cookie = cookie;
    const replayed = await browser.get(callback);
    expect(replayed.status).toBe(400);
    expect(replayed.text).toContain("used already");

    // Someone sends their way back to another person's browser.
    const theirs = new Browser();
    const sent = await throughProvider(
      theirs,
      `/api/sso/start?client=web&challenge=${s256(verifier)}`,
    );
    const victim = new Browser();
    const landed = await victim.get(sent);
    expect(landed.status).toBe(400);
    expect(landed.text).toContain("started in another browser");
  });

  it("tells someone with no account linked how to link one", async () => {
    await start();
    const { owner } = await people();
    await setUp(owner);
    const { back } = await signInWithSso();
    expect(back.status).toBe(403);
    expect(back.text).toContain("No account in this workspace is linked to maya@acme.com yet");
    expect(back.text).toContain("Account settings");
  });

  it("makes accounts for new people with a verified address at the domains given", async () => {
    await start();
    const { owner } = await people();
    await setUp(owner, { newAccounts: true, domains: "acme.com" });

    provider.person = { sub: "00u-sam", email: "sam@acme.com", email_verified: false };
    let { back } = await signInWithSso();
    expect(back.status).toBe(403);
    expect(back.text).toContain("Okta has not verified sam@acme.com");

    provider.person = { sub: "00u-sam", email: "sam@elsewhere.org", email_verified: true };
    ({ back } = await signInWithSso());
    expect(back.text).toContain("New accounts here are for @acme.com addresses");

    provider.person = {
      sub: "00u-sam",
      email: "sam@acme.com",
      email_verified: true,
      name: "Sam Rivera",
      preferred_username: "Sam.Rivera@acme.com",
    };
    const made = await signInWithSso();
    const signedIn = await call("/api/sso/redeem", undefined, {
      code: codeIn(made.back.location),
      verifier: made.verifier,
    });
    expect(signedIn.data.user).toMatchObject({
      handle: "sam.rivera",
      displayName: "Sam Rivera",
      role: "member",
    });
    // The same person next time is the same account.
    const next = await signInWithSso();
    const twice = await call("/api/sso/redeem", undefined, {
      code: codeIn(next.back.location),
      verifier: next.verifier,
    });
    expect(twice.data.user.id).toBe(signedIn.data.user.id);
  });

  it("with single sign-on required, keeps passwords for the owner alone", async () => {
    await start();
    const { owner, member } = await people();
    await setUp(owner);
    await linkAccount(member);
    await call("/api/sso/settings", owner.token, { required: true }, "PUT");

    const info = (await call("/api/server-info", undefined, undefined, "GET")).data as ServerInfo;
    expect(info.signIn?.passwords).toBe("owner_only");
    const login = (handle: string) =>
      call("/api/auth/login", undefined, { handle, password: "password123" });
    expect(await login("member")).toMatchObject({ status: 403, data: { error: "sso_required" } });
    expect((await login("owner")).status).toBe(200);
    // A wrong password says only that, as it would anywhere.
    expect(
      (await call("/api/auth/login", undefined, { handle: "member", password: "wrong-password" }))
        .data.error,
    ).toBe("invalid_credentials");
    const joining = await call("/api/auth/register", undefined, {
      handle: "newcomer",
      displayName: "Newcomer",
      password: "password123",
    });
    expect(joining).toMatchObject({ status: 403, data: { error: "sso_required" } });
    // Unlinking would leave them no way in.
    expect((await call("/api/sso/connect", member.token, undefined, "DELETE")).data.error).toBe(
      "sso_required",
    );
    // Single sign-on still signs them in.
    const { back, verifier } = await signInWithSso();
    expect(
      (await call("/api/sso/redeem", undefined, { code: codeIn(back.location), verifier })).status,
    ).toBe(200);
  });

  it("after the license ends, still signs linked people in, and gives passwords back", async () => {
    await start(license({ expiresAt: NOW + 5 * DAY }));
    const { owner, member } = await people();
    await setUp(owner, { required: true });
    await linkAccount(member);
    clock = NOW + 30 * DAY; // past the end and its 14 days of grace

    const info = (await call("/api/server-info", undefined, undefined, "GET")).data as ServerInfo;
    expect(info.signIn?.passwords).toBe("everyone");
    expect(
      (await call("/api/auth/login", undefined, { handle: "member", password: "password123" }))
        .status,
    ).toBe(200);
    const { back, verifier } = await signInWithSso();
    expect(
      (await call("/api/sso/redeem", undefined, { code: codeIn(back.location), verifier })).status,
    ).toBe(200);
    expect((await call("/api/sso/connect", member.token)).data.error).toBe("license_required");
    expect(
      (await call("/api/sso/settings", owner.token, { name: "Okta 2" }, "PUT")).data.error,
    ).toBe("license_required");
    // Set up already, it stays in the owner's settings, saying why it cannot change.
    const [panel] = (await call("/api/admin/extension-settings", owner.token, undefined, "GET"))
      .data.panels as SettingsPanel[];
    expect(panel!.problem).toContain("needs an Enterprise license with SSO");
    // Turning it off needs no license.
    expect((await call("/api/sso/settings", owner.token, { issuer: "" }, "PUT")).status).toBe(200);
    expect(
      (await call("/api/admin/extension-settings", owner.token, undefined, "GET")).data.panels,
    ).toEqual([]);
    expect(
      ((await call("/api/server-info", undefined, undefined, "GET")).data as ServerInfo).signIn,
    ).toBeUndefined();
  });

  it("shows the owner its panel, never the secret, and checks the issuer before saving", async () => {
    await start();
    const { owner, member } = await people();
    expect(
      (await call("/api/admin/extension-settings", member.token, undefined, "GET")).status,
    ).toBe(403);
    const refused = await call(
      "/api/sso/settings",
      owner.token,
      { issuer: `${provider.issuer}/nowhere`, clientId: "a", clientSecret: "b" },
      "PUT",
    );
    expect(refused).toMatchObject({ status: 400, data: { error: "sso_discovery_failed" } });
    expect(refused.data.message).toContain("answered 404");
    expect(
      (await call("/api/sso/settings", member.token, { issuer: provider.issuer }, "PUT")).status,
    ).toBe(403);
    await setUp(owner);
    const { panels } = (await call("/api/admin/extension-settings", owner.token, undefined, "GET"))
      .data as { panels: SettingsPanel[] };
    expect(panels).toHaveLength(1);
    const [panel] = panels;
    expect(panel!.description).toContain(`${PUBLIC}/api/sso/callback`);
    expect(panel!.problem).toBeUndefined();
    expect(panel!.status).toBe("0 of 2 people can sign in with Okta.");
    expect(panel!.fields.find((f) => f.key === "clientSecret")).toMatchObject({
      value: "",
      isSet: true,
    });
    expect(JSON.stringify(panels)).not.toContain(provider.clientSecret);
    // A secret left empty is kept.
    await call("/api/sso/settings", owner.token, { clientSecret: "", name: "Acme" }, "PUT");
    await linkAccount(member);
    expect((await signInWithSso()).back.status).toBe(302);
  });

  it("is not offered without SSO in the license, and says when the public address is missing", async () => {
    // The free edition, and a license without the feature: no panel at all.
    await start(null);
    let { owner } = await people();
    const free = await call("/api/admin/extension-settings", owner.token, undefined, "GET");
    expect(free.data.panels).toEqual([]);
    await server!.stop();

    await start(license({ features: [] }));
    ({ owner } = await people());
    expect(
      (await call("/api/admin/extension-settings", owner.token, undefined, "GET")).data.panels,
    ).toEqual([]);
    expect(
      (
        await call(
          "/api/sso/settings",
          owner.token,
          { issuer: provider.issuer, clientId: "a", clientSecret: "b" },
          "PUT",
        )
      ).data.error,
    ).toBe("license_required");
    await server!.stop();

    await start(license(), null);
    ({ owner } = await people());
    const [panel] = (await call("/api/admin/extension-settings", owner.token, undefined, "GET"))
      .data.panels as SettingsPanel[];
    expect(panel!.problem).toContain("--public-url");
  });
});

describe("names and domains for new accounts", () => {
  const claims = (over: object) =>
    ({ iss: "i", sub: "s", aud: "a", exp: 0, iat: 0, ...over }) as Parameters<typeof handleFor>[0];

  it("makes a username from what the provider calls someone, not one taken", () => {
    expect(handleFor(claims({ preferred_username: "Maya.Lin@acme.com" }), () => false)).toBe(
      "maya.lin",
    );
    expect(handleFor(claims({ email: "zoë@acme.com" }), () => false)).toBe("zoe");
    expect(handleFor(claims({ name: "Ana María" }), () => false)).toBe("anamaria");
    expect(handleFor(claims({ email: "_x@acme.com" }), () => false)).toBe("memberx");
    expect(handleFor(claims({}), () => false)).toBe("member");
    const taken = new Set(["maya", "maya-2"]);
    expect(handleFor(claims({ email: "maya@acme.com" }), (h) => taken.has(h))).toBe("maya-3");
  });

  it("reads domains the way people write them, and refuses what is not one", () => {
    expect(parseDomains("acme.com, @Acme.co.uk acme.com")).toEqual(["acme.com", "acme.co.uk"]);
    expect(parseDomains("")).toEqual([]);
    expect(parseDomains("acme")).toBeNull();
    expect(parseDomains("http://acme.com")).toBeNull();
  });
});
