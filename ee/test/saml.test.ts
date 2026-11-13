import { afterEach, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { ServerInfo, SettingsPanel, User } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { enterprise } from "../src/enterprise.js";
import { LICENSE_PREFIX, type LicenseClaims } from "../src/license.js";
import { claimsOf, parseCertificates } from "../src/saml.js";
import { base64, TestSamlProvider, type Answer } from "./samlProvider.js";

/**
 * Single sign-on with SAML (P11), against an identity provider made in this
 * test: through a browser that keeps cookies, follows no redirect by itself,
 * and, as browsers do with SameSite=Lax, sends no cookie with the provider's
 * cross-site POST.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 28, 12);
const PUBLIC = "http://ownbase.test";
const ACS = `${PUBLIC}/api/saml/acs`;
const ENTITY = `${PUBLIC}/api/saml/metadata`;
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

class Browser {
  cookie = "";
  private keep(response: Response) {
    const set = response.headers.get("set-cookie");
    if (set) {
      const pair = set.split(";")[0]!;
      this.cookie = pair.endsWith("=") ? "" : pair;
    }
  }
  async get(url: string) {
    const response = await fetch(url, {
      redirect: "manual",
      headers: this.cookie ? { cookie: this.cookie } : {},
    });
    this.keep(response);
    return {
      status: response.status,
      location: response.headers.get("location"),
      text: await response.text(),
    };
  }
  /** The provider's page posting its form here: from another site, so with no Lax cookie. */
  async post(url: string, form: Record<string, string | undefined>) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) if (value !== undefined) body.set(key, value);
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    this.keep(response);
    return {
      status: response.status,
      location: response.headers.get("location"),
      text: await response.text(),
    };
  }
}

const idp = new TestSamlProvider();
let server: WorkspaceServer | undefined;
let base: string;
type Account = { token: string; user: User };

afterEach(async () => {
  await server?.stop();
  server = undefined;
  idp.person = {
    nameId: "00u-maya",
    attributes: { email: "maya@acme.com", displayName: "Maya Lin" },
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
  const text = await response.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    // A page or XML.
  }
  return { status: response.status, data, type: response.headers.get("content-type") };
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
    "/api/saml/settings",
    owner.token,
    {
      name: "Okta",
      signInUrl: idp.signInUrl,
      issuer: idp.entityId,
      certificate: idp.certificate,
      ...extra,
    },
    "PUT",
  );
  expect(saved).toMatchObject({ status: 200, data: { ok: true } });
}

/** The workspace's own address for one it gave under its public one. */
const here = (url: string) => {
  const at = new URL(url);
  expect(at.origin).toBe(PUBLIC);
  return base + at.pathname + at.search;
};

type Request = ReturnType<TestSamlProvider["request"]>;

/** The answer the provider gives the person it signs in now, for `request`. */
const goodAnswer = (request: Request, over: Partial<Answer> = {}): string =>
  idp.response({
    inResponseTo: request.id,
    acs: request.acs,
    audience: request.issuer,
    nameId: idp.person.nameId,
    attributes: idp.person.attributes,
    ...over,
  });

/** Off to the provider: the request it is sent, read out of the redirect. */
async function toProvider(browser: Browser, start: string) {
  const begun = await browser.get(base + start);
  expect(begun.status).toBe(302);
  expect(browser.cookie).toMatch(/^ownbase_saml=/);
  const request = idp.request(begun.location!);
  expect(request.target).toBe(idp.signInUrl);
  return request;
}

/** The provider's form posted to the ACS, and, when it was taken, the GET that finishes. */
async function answer(browser: Browser, request: Request, xml: string) {
  const posted = await browser.post(`${base}/api/saml/acs`, {
    SAMLResponse: base64(xml),
    RelayState: request.relayState,
  });
  if (posted.status !== 303) return { posted, back: posted };
  return { posted, back: await browser.get(here(posted.location!)) };
}

/** The sign-in button, the provider, and back: the code the app gets, and its secret. */
async function signInWithSaml(
  make: (request: Request) => string = (request) => goodAnswer(request),
  browser = new Browser(),
) {
  const verifier = randomBytes(32).toString("base64url");
  const request = await toProvider(
    browser,
    `/api/saml/start?client=web&challenge=${s256(verifier)}`,
  );
  const xml = make(request);
  return { ...(await answer(browser, request, xml)), verifier, request, xml, browser };
}

const codeIn = (location: string | null) => {
  const match = /^http:\/\/ownbase\.test\/#\/sso\/([A-Za-z0-9_-]{43})$/.exec(location ?? "");
  expect(match, `not a code: ${location}`).not.toBeNull();
  return match![1]!;
};

/** Signed in as whom, with the code and secret a sign-in ended with; null when it did not end with one. */
async function whoSignedIn(
  result: { back: { status: number; location: string | null } },
  verifier: string,
) {
  if (result.back.status !== 302) return null;
  const redeemed = await call("/api/saml/redeem", undefined, {
    code: codeIn(result.back.location),
    verifier,
  });
  return redeemed.status === 200 ? (redeemed.data.user.handle as string) : null;
}

/** A signed-in person links the provider's account, signed in there as `nameId`. */
async function linkAccount(account: Account, nameId = idp.person.nameId) {
  const asked = await call("/api/saml/connect", account.token);
  expect(asked.status).toBe(200);
  expect(asked.data.url).toMatch(/^\/api\/saml\/start\?link=/);
  const browser = new Browser();
  const request = await toProvider(browser, asked.data.url);
  return (await answer(browser, request, goodAnswer(request, { nameId }))).back;
}

/** Maya linked to @member, and the boss's provider account to @owner: a forgery's target. */
async function twoLinked() {
  await start();
  const { owner, member } = await people();
  await setUp(owner);
  expect((await linkAccount(member)).status).toBe(200);
  expect((await linkAccount(owner, "00u-boss")).status).toBe(200);
  return { owner, member };
}

/** Maya's signed assertion with her NameID changed to the boss's, after signing. */
const asBoss = (xml: string) => {
  expect(xml).toContain(">00u-maya<");
  return xml.replace(">00u-maya<", ">00u-boss<");
};

describe("single sign-on through a SAML identity provider", () => {
  it("describes this workspace as a service provider", async () => {
    await start();
    const metadata = await call("/api/saml/metadata", undefined, undefined, "GET");
    expect(metadata.status).toBe(200);
    expect(metadata.type).toContain("application/samlmetadata+xml");
    expect(metadata.data).toContain(`entityID="${ENTITY}"`);
    expect(metadata.data).toContain(`Location="${ACS}"`);
    expect(metadata.data).toContain("urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST");
    expect(metadata.data).toContain('WantAssertionsSigned="true"');
    await server!.stop();
    // The free edition shows no trace of it.
    await start(null);
    expect((await call("/api/saml/metadata", undefined, undefined, "GET")).status).toBe(404);
  });

  it("links a signed-in person's account, then signs them in with a one-time code", async () => {
    await start();
    const { owner, member } = await people();
    await setUp(owner);

    const info = (await call("/api/server-info", undefined, undefined, "GET")).data as ServerInfo;
    expect(info.signIn).toEqual({
      methods: [
        {
          id: "saml",
          name: "Okta",
          start: "/api/saml/start",
          redeem: "/api/saml/redeem",
          connect: "/api/saml/connect",
        },
      ],
      passwords: "everyone",
    });

    // The request names this workspace and where to answer.
    const verifier = randomBytes(32).toString("base64url");
    const request = await toProvider(
      new Browser(),
      `/api/saml/start?client=web&challenge=${s256(verifier)}`,
    );
    expect(request.acs).toBe(ACS);
    expect(request.issuer).toBe(ENTITY);
    expect(request.xml).not.toContain("RequestedAuthnContext");

    expect((await call("/api/saml/connect", member.token, undefined, "GET")).data).toEqual({
      connected: false,
    });
    const linked = await linkAccount(member);
    expect(linked.status).toBe(200);
    expect(linked.text).toContain("@member signs in with Okta as maya@acme.com");
    expect((await call("/api/saml/connect", member.token, undefined, "GET")).data).toEqual({
      connected: true,
      as: "maya@acme.com",
    });

    // Signed as Entra signs (the assertion), as Okta does (both), or the response alone.
    for (const how of ["assertion", "both", "response"] as const) {
      const result = await signInWithSaml((r) => goodAnswer(r, { sign: how }));
      expect(result.posted.status, how).toBe(303);
      expect(result.back.status, how).toBe(302);
      const code = codeIn(result.back.location);
      // Only with the secret of the client that began.
      expect(
        (await call("/api/saml/redeem", undefined, { code, verifier: "x".repeat(43) })).data,
      ).toMatchObject({ error: "sso_code_invalid" });
    }
    const result = await signInWithSaml();
    const signedIn = await call("/api/saml/redeem", undefined, {
      code: codeIn(result.back.location),
      verifier: result.verifier,
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.data.user).toMatchObject({ id: member.user.id, handle: "member" });
  });

  it("refuses an assertion changed after it was signed", async () => {
    await twoLinked();
    for (const how of ["assertion", "both", "response"] as const) {
      const result = await signInWithSaml((r) => asBoss(goodAnswer(r, { sign: how })));
      expect(result.back.status, how).toBe(502);
      expect(result.back.text).toContain("not signed with the certificate set up here");
      expect(await whoSignedIn(result, result.verifier)).toBeNull();
    }
    // The same answer unchanged signs Maya in, so it was the change that was refused.
    const fine = await signInWithSaml();
    expect(await whoSignedIn(fine, fine.verifier)).toBe("member");
  });

  it("refuses an unsigned answer, and one signed with a key it does not know", async () => {
    await twoLinked();
    const unsigned = await signInWithSaml((r) =>
      goodAnswer(r, { sign: "none", nameId: "00u-boss" }),
    );
    expect(unsigned.back.status).toBe(502);
    expect(unsigned.back.text).toContain("not signed with the certificate set up here");
    expect(await whoSignedIn(unsigned, unsigned.verifier)).toBeNull();

    const forged = await signInWithSaml((r) =>
      goodAnswer(r, { sign: "both", forged: true, nameId: "00u-boss" }),
    );
    expect(forged.back.status).toBe(502);
    expect(forged.back.text).toContain("not signed with the certificate set up here");
    expect(await whoSignedIn(forged, forged.verifier)).toBeNull();
  });

  it("refuses a signature wrapped around another assertion", async () => {
    await twoLinked();
    // Maya's signed assertion kept where a careless check still finds it,
    // and the boss's unsigned copy, with the same ID and signature, where it reads.
    const sameId = await signInWithSaml((r) => {
      const signed = idp.signed(
        idp.assertion({ inResponseTo: r.id, acs: r.acs, audience: r.issuer, nameId: "00u-maya" }),
        "Assertion",
      );
      return idp
        .wrap({ inResponseTo: r.id, acs: r.acs }, asBoss(signed))
        .replace("<samlp:Status>", `<samlp:Extensions>${signed}</samlp:Extensions><samlp:Status>`);
    });
    expect(sameId.back.status).toBe(502);
    expect(sameId.back.text).toContain("not signed with the certificate set up here");
    expect(await whoSignedIn(sameId, sameId.verifier)).toBeNull();

    // The boss's unsigned assertion read first, Maya's signed one inside it.
    const nested = await signInWithSaml((r) => {
      const signed = idp.signed(
        idp.assertion({ inResponseTo: r.id, acs: r.acs, audience: r.issuer, nameId: "00u-maya" }),
        "Assertion",
      );
      const evil = idp
        .assertion({
          inResponseTo: r.id,
          acs: r.acs,
          audience: r.issuer,
          nameId: "00u-boss",
          assertionId: "_evil",
        })
        .replace("<saml:Conditions", `<saml:Advice>${signed}</saml:Advice><saml:Conditions`);
      // Advice belongs after Conditions; where it is makes no difference to the check.
      return idp.wrap({ inResponseTo: r.id, acs: r.acs }, evil);
    });
    expect(nested.back.status).toBe(502);
    expect(await whoSignedIn(nested, nested.verifier)).toBeNull();
  });

  it("refuses an answer used once already", async () => {
    await twoLinked();
    const first = await signInWithSaml();
    expect(await whoSignedIn(first, first.verifier)).toBe("member");
    // The same form posted again, in the same browser.
    const again = await answer(first.browser, first.request, first.xml);
    expect(again.back.status).not.toBe(302);
    expect(await whoSignedIn(again, first.verifier)).toBeNull();
    // Posted into a sign-in of someone else's own, which the provider never answered.
    const replayed = await signInWithSaml(() => first.xml);
    expect(replayed.back.status).toBe(502);
    expect(await whoSignedIn(replayed, replayed.verifier)).toBeNull();
  });

  it("refuses an assertion for another application", async () => {
    await twoLinked();
    const result = await signInWithSaml((r) =>
      goodAnswer(r, { audience: "https://another.example/saml" }),
    );
    expect(result.back.status).toBe(502);
    expect(result.back.text).toContain("is for another application");
    expect(await whoSignedIn(result, result.verifier)).toBeNull();
  });

  it("refuses an expired assertion, and one not valid yet", async () => {
    await twoLinked();
    const now = Date.now();
    const expired = await signInWithSaml((r) =>
      goodAnswer(r, { notBefore: now - 20 * 60_000, notOnOrAfter: now - 10 * 60_000 }),
    );
    expect(expired.back.status).toBe(502);
    expect(expired.back.text).toContain("has expired");
    expect(await whoSignedIn(expired, expired.verifier)).toBeNull();

    const early = await signInWithSaml((r) =>
      goodAnswer(r, { notBefore: now + 10 * 60_000, notOnOrAfter: now + 20 * 60_000 }),
    );
    expect(early.back.status).toBe(502);
    expect(await whoSignedIn(early, early.verifier)).toBeNull();
  });

  it("refuses another provider's assertion, and one nobody here asked for", async () => {
    await twoLinked();
    const other = await signInWithSaml((r) =>
      goodAnswer(r, { issuer: "https://evil.example/saml" }),
    );
    expect(other.back.status).toBe(502);
    expect(other.back.text).toContain("another sign-in service");

    // Sent by the provider unasked (from its dashboard): no request, no state.
    const unasked = await new Browser().post(`${base}/api/saml/acs`, {
      SAMLResponse: base64(
        idp.response({ acs: ACS, audience: ENTITY, nameId: "00u-maya", sign: "both" }),
      ),
    });
    expect(unasked.status).toBe(400);
    expect(unasked.text).toContain("not started from OwnBase");

    // An answer to a request this sign-in did not send.
    const elsewhere = await signInWithSaml((r) => goodAnswer(r, { inResponseTo: "_other" }));
    expect(elsewhere.back.status).toBe(502);
    expect(elsewhere.back.text).toContain("not for a sign-in started here");
  });

  it("finishes only in the browser that began", async () => {
    await twoLinked();
    const verifier = randomBytes(32).toString("base64url");
    const browser = new Browser();
    const request = await toProvider(
      browser,
      `/api/saml/start?client=web&challenge=${s256(verifier)}`,
    );
    const posted = await browser.post(`${base}/api/saml/acs`, {
      SAMLResponse: base64(goodAnswer(request)),
      RelayState: request.relayState,
    });
    expect(posted.status).toBe(303);
    const elsewhere = await new Browser().get(here(posted.location!));
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.text).toContain("started in another browser");
    // And once.
    expect((await browser.get(here(posted.location!))).status).toBe(400);
  });

  it("makes accounts for new people at the domains allowed", async () => {
    await start();
    const { owner } = await people();
    await setUp(owner, { newAccounts: true, domains: "acme.com" });
    const made = await signInWithSaml();
    expect(await whoSignedIn(made, made.verifier)).toBe("maya");

    idp.person = { nameId: "00u-eve", attributes: { email: "eve@elsewhere.com" } };
    const refused = await signInWithSaml();
    expect(refused.back.status).toBe(403);
    expect(refused.back.text).toContain("for @acme.com addresses, not eve@elsewhere.com");

    // A NameID new at every sign-in could never be linked.
    const transient = await signInWithSaml((r) =>
      goodAnswer(r, { nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient" }),
    );
    expect(transient.back.status).toBe(502);
    expect(transient.back.text).toContain("persistent NameID");
  });

  it("turns passwords off for everyone but the owner when required", async () => {
    await start();
    const { owner, member } = await people();
    await setUp(owner, { required: true });
    const info = (await call("/api/server-info", undefined, undefined, "GET")).data as ServerInfo;
    expect(info.signIn?.passwords).toBe("owner_only");
    const login = await call("/api/auth/login", undefined, {
      handle: "member",
      password: "password123",
    });
    expect(login.data.error).toBe("sso_required");
    expect((await linkAccount(member)).status).toBe(200);
    expect((await call("/api/saml/connect", member.token, undefined, "DELETE")).data.error).toBe(
      "sso_required",
    );
  });

  it("shows the owner its panel and checks what is saved", async () => {
    await start();
    const { owner, member } = await people();
    expect(
      (await call("/api/saml/settings", member.token, { issuer: idp.entityId }, "PUT")).status,
    ).toBe(403);
    const saving = (body: object) => call("/api/saml/settings", owner.token, body, "PUT");
    const fields = { signInUrl: idp.signInUrl, issuer: idp.entityId };
    expect((await saving({ ...fields, certificate: "not a certificate" })).data.error).toBe(
      "invalid_certificate",
    );
    expect((await saving(fields)).data.error).toBe("saml_incomplete");
    expect(
      (
        await saving({
          ...fields,
          signInUrl: "http://idp.example.test/sso",
          certificate: idp.certificate,
        })
      ).data.error,
    ).toBe("invalid_sign_in_url");
    // A PEM pasted into one line loses its breaks.
    await setUp(owner, { certificate: idp.certificate.replace(/\n/g, "") });

    const { panels } = (await call("/api/admin/extension-settings", owner.token, undefined, "GET"))
      .data as { panels: SettingsPanel[] };
    const panel = panels.find((p) => p.id === "saml")!;
    expect(panel.description).toContain(ACS);
    expect(panel.description).toContain(ENTITY);
    expect(panel.status).toBe("0 of 2 people can sign in with Okta.");
    // What it shows saves again as it is.
    const shown = Object.fromEntries(panel.fields.map((f) => [f.key, f.value]));
    expect((await saving(shown)).status).toBe(200);
    await linkAccount(member);
    const result = await signInWithSaml();
    expect(await whoSignedIn(result, result.verifier)).toBe("member");

    // Off, with nothing more.
    expect((await saving({ issuer: "" })).status).toBe(200);
    expect(
      ((await call("/api/server-info", undefined, undefined, "GET")).data as ServerInfo).signIn,
    ).toBeUndefined();
  });

  it("is not offered without SSO in the license", async () => {
    await start(null);
    const { owner } = await people();
    expect(
      (await call("/api/admin/extension-settings", owner.token, undefined, "GET")).data.panels,
    ).toEqual([]);
    expect(
      (
        await call(
          "/api/saml/settings",
          owner.token,
          { signInUrl: idp.signInUrl, issuer: idp.entityId, certificate: idp.certificate },
          "PUT",
        )
      ).data.error,
    ).toBe("license_required");
  });
});

describe("what an assertion says", () => {
  const profile = (over: object) =>
    ({ issuer: "i", nameID: "n", nameIDFormat: "f", ...over }) as Parameters<typeof claimsOf>[0];

  it("reads Microsoft Entra's claim names", () => {
    expect(
      claimsOf(
        profile({
          nameID: "abc",
          "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress": "maya@acme.com",
          "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname": "Maya",
          "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname": "Lin",
          "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name": "maya@acme.com",
        }),
        "https://sts.windows.net/t/",
      ),
    ).toEqual({
      iss: "https://sts.windows.net/t/",
      sub: "abc",
      email: "maya@acme.com",
      email_verified: true,
      name: "Maya Lin",
      preferred_username: "maya@acme.com",
    });
  });

  it("takes an email NameID as the address, and nothing that is not one", () => {
    expect(
      claimsOf(
        profile({
          nameID: "maya@acme.com",
          nameIDFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        }),
        "i",
      ).email,
    ).toBe("maya@acme.com");
    expect(claimsOf(profile({ email: "not an address" }), "i").email).toBeUndefined();
  });

  it("reads certificates however they are pasted", () => {
    const pem = idp.certificate;
    const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    expect(parseCertificates(pem)).toEqual([pem]);
    expect(parseCertificates(pem.replace(/\n/g, ""))).toEqual([pem]);
    expect(parseCertificates(body)).toEqual([pem]);
    const other = idp.strangerCertificate.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    expect(parseCertificates(`${body}, ${other}`)).toHaveLength(2);
    expect(parseCertificates(`${pem}\n${idp.strangerCertificate}`)).toHaveLength(2);
    expect(parseCertificates("MIIB")).toBeNull();
    expect(parseCertificates(`${body}, nonsense`)).toBeNull();
  });
});
