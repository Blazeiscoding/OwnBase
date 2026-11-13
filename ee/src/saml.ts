import { randomBytes, X509Certificate } from "node:crypto";
import {
  generateServiceProviderMetadata,
  SAML,
  SamlStatusError,
  ValidateInResponseTo,
  type CacheItem,
  type CacheProvider,
  type Profile,
} from "@node-saml/node-saml";
import type { SettingsPanel, SignInMethod } from "@ownbase/protocol";
import type { ExtensionContext } from "@ownbase/server/extensions";
import { HttpError } from "@ownbase/server/httpError";
import { eeEndpoints } from "./endpoints.js";
import { CLOCK_SKEW_MS, isLoopback, randomToken } from "./oidc.js";
import {
  applyLinkSettings,
  CODE_MS,
  FLOW_MS,
  linkFields,
  page,
  redirect,
  signInFlow,
  WAITING_MAX,
  type Claims,
  type Flow,
  type LinkSettings,
} from "./signInFlow.js";

/**
 * Single sign-on with SAML 2.0 (P11), beside OpenID Connect (P9) and set up
 * the same way: the owner fills in what the identity provider gives, and the
 * sign-in screen gets its button. People are matched on the provider's NameID,
 * linked as OpenID's subjects are (`signInFlow.ts`).
 *
 * The XML is checked by node-saml, not here: signature wrapping, where a
 * signed assertion is moved so the one read is not the one signed, is where
 * hand-written SAML has failed. node-saml reads only what the signature
 * covers. Settings that matter:
 * - the assertion must be signed with the provider's certificate, by its
 *   own signature or the response's around it;
 * - its issuer must be the provider's entity ID, and its audience this
 *   workspace's;
 * - it must answer a request sent from here in the last 10 minutes, which it
 *   then uses up, so an answer the provider sent unasked is refused;
 * - its ID is remembered until it expires, and a second copy is refused.
 *
 * The answer comes as a form the provider's page posts here, and a POST from
 * another site brings no SameSite=Lax cookie. So it is checked on arrival, then
 * finished by a GET in the browser that began, which does bring it.
 */

/** Who signs people in, as the owner set it up. */
export interface SamlSettings extends LinkSettings {
  /** The provider's single sign-on address, which requests are sent to by redirect. */
  signInUrl: string;
  /** The provider's entity ID: its assertions name it as their issuer. */
  issuer: string;
  /** The provider's signing certificates, as PEM: more than one while it changes them. */
  certificates: string[];
}

const UNSET: SamlSettings = {
  name: "",
  signInUrl: "",
  issuer: "",
  certificates: [],
  newAccounts: false,
  domains: [],
  required: false,
};

/** What a sign-in to a SAML provider keeps besides what every one does. */
interface SamlFlow {
  /** The ID of the request sent: the answer must name it. */
  requestId: string;
  issuer: string;
}

const NAMEID_TRANSIENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient";
const NAMEID_EMAIL = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";

/**
 * Attribute names for an address and a name, as Okta, Microsoft Entra ID,
 * AD FS, Google and Keycloak send them: their own, LDAP's OIDs and the
 * claim URIs Microsoft uses.
 */
const EMAIL = [
  "email",
  "mail",
  "emailAddress",
  "urn:oid:0.9.2342.19200300.100.1.3",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
];
const NAME = [
  "displayName",
  "name",
  "urn:oid:2.16.840.1.113730.3.1.241",
  "http://schemas.microsoft.com/identity/claims/displayname",
];
const GIVEN_NAME = [
  "givenName",
  "firstName",
  "urn:oid:2.5.4.42",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
];
const SURNAME = [
  "sn",
  "surname",
  "lastName",
  "urn:oid:2.5.4.4",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
];
/** A username: Entra's "name" claim is the user principal name, such as maya@acme.com. */
const USERNAME = [
  "username",
  "uid",
  "urn:oid:0.9.2342.19200300.100.1.1",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
];

/** One or more certificates, as PEM or as their base64 alone, or null for anything else. */
export function parseCertificates(text: string): string[] | null {
  const isCertificate = (base64: string) => {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return false;
    try {
      new X509Certificate(Buffer.from(base64, "base64"));
      return true;
    } catch {
      return false;
    }
  };
  const pem = [...text.matchAll(/-----BEGIN CERTIFICATE-----([^-]*)-----END CERTIFICATE-----/g)];
  // A PEM file pasted into one line loses its line breaks, which base64 does
  // not need. Without its first and last lines, a certificate is its base64
  // alone, and several are separated by commas.
  const whole = text.replace(/\s+/g, "");
  const bodies = pem.length
    ? pem.map((match) => match[1]!.replace(/\s+/g, ""))
    : isCertificate(whole)
      ? [whole]
      : text.split(/[\s,]+/).filter(Boolean);
  if (!bodies.length || !bodies.every(isCertificate)) return null;
  return [...new Set(bodies)].map(
    (base64) =>
      `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----`,
  );
}

/** A certificate's base64 alone, as the settings panel shows it. */
const base64Of = (pem: string) => pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");

const first = (profile: Profile, names: string[]): string | undefined => {
  for (const name of names) {
    const value = profile[name];
    const text = Array.isArray(value) ? value[0] : value;
    if (typeof text === "string" && text.trim()) return text.trim().slice(0, 320);
  }
  return undefined;
};

/** Something the provider's answer would not do. Its message is for the person signing in. */
class SamlRefusal extends Error {}

/**
 * Who the answer signed in, as the account linking reads it. An address in
 * a signed assertion counts as verified: the provider is the company's
 * directory, and SAML has no flag for it.
 */
export function claimsOf(profile: Profile, issuer: string): Claims {
  if (!profile.nameID) throw new SamlRefusal("The sign-in service did not say who you are.");
  // A transient NameID is new at every sign-in, so nobody could be linked by it.
  if (profile.nameIDFormat === NAMEID_TRANSIENT)
    throw new SamlRefusal(
      "The sign-in service sends a different name for you each time. Ask the workspace's owner to have it send a persistent NameID or your email address.",
    );
  const email =
    first(profile, EMAIL) ??
    (profile.nameIDFormat === NAMEID_EMAIL ? profile.nameID.slice(0, 320) : undefined);
  const given = first(profile, GIVEN_NAME);
  const surname = first(profile, SURNAME);
  const name = first(profile, NAME) ?? ([given, surname].filter(Boolean).join(" ") || undefined);
  const username = first(profile, USERNAME);
  return {
    iss: issuer,
    sub: profile.nameID,
    ...(email && /^[^@\s]+@[^@\s]+$/.test(email) ? { email, email_verified: true } : {}),
    ...(name ? { name } : {}),
    ...(username ? { preferred_username: username } : {}),
  };
}

/** What went wrong, for the person signing in, from node-saml's refusal. */
export function reasonFor(error: unknown): string {
  if (error instanceof SamlRefusal) return error.message;
  if (error instanceof SamlStatusError)
    return "The sign-in service did not sign you in. Try again, or ask the workspace's owner.";
  const message = error instanceof Error ? error.message : "";
  if (/has already been received/.test(message))
    return "This answer from the sign-in service was used already. Start again.";
  if (/InResponseTo/i.test(message))
    return "The sign-in service's answer is not for a sign-in started here. Start again from the OwnBase sign-in screen.";
  if (/audience/i.test(message))
    return "The sign-in service's answer is for another application. Ask the workspace's owner to check its entity ID.";
  if (/not yet valid/.test(message))
    return "The sign-in service's answer is not valid yet. This server's clock may be wrong.";
  if (/expired|too old|subject confirmation/i.test(message))
    return "The sign-in service's answer has expired. Start again.";
  if (/issuer/i.test(message))
    return "The answer comes from another sign-in service than the one set up here.";
  if (/signature|signed data/i.test(message))
    return "The sign-in service's answer is not signed with the certificate set up here. Ask the workspace's owner.";
  return "The sign-in service's answer could not be checked. Ask the workspace's owner.";
}

/**
 * What node-saml remembers between a request and its answer: the IDs of
 * requests sent, kept 10 minutes and used once, and of assertions received,
 * kept until they expire. In memory, as sign-ins in progress are. Its times
 * are the real clock's, as node-saml's own are.
 */
function remembered(): CacheProvider {
  const requests = new Map<string, CacheItem>();
  const assertions = new Map<string, number>();
  const live = (item: CacheItem | undefined) =>
    item && item.createdAt + FLOW_MS > Date.now() ? item : undefined;
  const take = async (key: string | null) => {
    if (key === null) return null;
    const item = live(requests.get(key));
    requests.delete(key);
    return item?.value ?? null;
  };
  return {
    async saveAsync(key, value) {
      for (const [k, item] of requests) if (!live(item)) requests.delete(k);
      while (requests.size >= WAITING_MAX) requests.delete(requests.keys().next().value!);
      const item = { value, createdAt: Date.now() };
      requests.set(key, item);
      return item;
    },
    getAsync: async (key) => live(requests.get(key))?.value ?? null,
    removeAsync: take,
    consumeAsync: take,
    // Only after an assertion's signature is checked, so only the provider fills it.
    async saveIfAbsentAsync(key, _value, expiresAtMs) {
      const at = Date.now();
      for (const [k, until] of assertions) if (until <= at) assertions.delete(k);
      if (assertions.has(key)) return false;
      assertions.set(key, expiresAtMs);
      return true;
    },
  };
}

export interface SamlSignOn {
  register(context: ExtensionContext): void;
  signInMethods(): SignInMethod[];
  requiresSingleSignOn(): boolean;
  settingsPanels(): SettingsPanel[];
}

export function samlSignOn(opts: {
  licensed: () => boolean;
  /** The account provisioning (P10) made for an address, linked at that person's first sign-in. */
  provisioned?: (email: string) => string | null;
  now?: () => number;
}): SamlSignOn {
  const now = opts.now ?? Date.now;
  let context: ExtensionContext | null = null;
  const cacheProvider = remembered();
  /** Answers checked, waiting for the GET from the browser that began, by a one-time key. */
  const checked = new Map<string, { flow: Flow<SamlFlow>; claims: Claims; expiresAt: number }>();

  const settings = (): SamlSettings => {
    const raw = context?.storage.get("saml:settings");
    if (!raw) return UNSET;
    try {
      return { ...UNSET, ...(JSON.parse(raw) as Partial<SamlSettings>) };
    } catch {
      return UNSET;
    }
  };
  const configured = (s: SamlSettings) => !!(s.issuer && s.signInUrl && s.certificates.length);
  const flow = signInFlow<SamlFlow>({
    id: "saml",
    licensed: opts.licensed,
    provisioned: opts.provisioned,
    now,
    settings,
    configured: () => configured(settings()),
  });
  const base = flow.base;
  /** This workspace's entity ID: where its metadata is, as is usual. */
  const entityId = () => `${base()}/api/saml/metadata`;
  const acsUrl = () => `${base()}/api/saml/acs`;

  const samlFor = (s: SamlSettings, requestId?: string) =>
    new SAML({
      entryPoint: s.signInUrl,
      issuer: entityId(),
      callbackUrl: acsUrl(),
      audience: entityId(),
      idpIssuer: s.issuer,
      idpCert: s.certificates,
      // A signature over the assertion, its own or the response's around it:
      // Entra and Google sign the assertion, Keycloak the response, Okta both.
      // node-saml then reads the assertion from what the signature covers.
      wantAssertionsSigned: false,
      wantAuthnResponseSigned: false,
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: FLOW_MS,
      rejectReplayedAssertions: true,
      acceptedClockSkewMs: CLOCK_SKEW_MS,
      cacheProvider,
      // The provider's own NameID, whatever it is set to send: asking for one
      // it is not set up for fails the sign-in at Entra.
      identifierFormat: null,
      // Asking for a password sign-in fails at Entra for people who use passkeys.
      disableRequestedAuthnContext: true,
      ...(requestId ? { generateUniqueId: () => requestId } : {}),
    });

  function register(given: ExtensionContext) {
    context = given;
    const { route } = given;
    flow.register(given, {
      redeem: eeEndpoints.samlRedeem,
      connection: eeEndpoints.samlConnection,
      connect: eeEndpoints.samlConnect,
      disconnect: eeEndpoints.samlDisconnect,
    });

    route(eeEndpoints.samlMetadata, async ({ reply }) => {
      // The free edition shows no trace of it.
      if (!base() || (!opts.licensed() && !configured(settings())))
        return reply.code(404).header("content-type", "text/plain").send("Not found");
      const xml = generateServiceProviderMetadata({
        issuer: entityId(),
        callbackUrl: acsUrl(),
        wantAssertionsSigned: true,
        identifierFormat: null,
      });
      return reply
        .header("content-type", "application/samlmetadata+xml; charset=utf-8")
        .header("cache-control", "no-store")
        .send(xml);
    });

    route(eeEndpoints.samlStart, async ({ reply, query: q }) => {
      const s = settings();
      if (!configured(s) || !base())
        return page(
          reply,
          404,
          "Single sign-on is off",
          "This workspace does not use single sign-on. Sign in with your password.",
        );
      const begun = flow.begin(q);
      if ("refused" in begun) return page(reply, 400, "Start again", begun.refused);
      // An xs:ID, which must not start with a digit.
      const requestId = `_${randomBytes(20).toString("hex")}`;
      const state = flow.open(reply, begun, { requestId, issuer: s.issuer });
      return redirect(reply, await samlFor(s, requestId).getAuthorizeUrlAsync(state, {}));
    });

    route(eeEndpoints.samlAcs, async ({ reply, body }) => {
      const begun = flow.take(body.RelayState);
      if (!begun)
        return page(
          reply,
          400,
          "Start again",
          "This sign-in has expired, or was used already, or was not started from OwnBase. Start from the OwnBase sign-in screen.",
          flow.back(),
        );
      const s = settings();
      if (!configured(s) || !base())
        return page(reply, 404, "Single sign-on is off", "This workspace stopped using it.");
      let claims: Claims;
      try {
        if (s.issuer !== begun.issuer)
          throw new SamlRefusal(
            "Single sign-on was set up again while you were signing in. Start again.",
          );
        const { profile } = await samlFor(s).validatePostResponseAsync({
          SAMLResponse: body.SAMLResponse,
        });
        if (!profile) throw new SamlRefusal("The sign-in service did not sign you in.");
        // Any request sent from here would pass node-saml; this one must be this sign-in's.
        if (profile.inResponseTo !== begun.requestId)
          throw new SamlRefusal(
            "The sign-in service's answer is not for a sign-in started here. Start again from the OwnBase sign-in screen.",
          );
        claims = claimsOf(profile, s.issuer);
      } catch (error) {
        const reason = reasonFor(error);
        given.log.warn(
          { why: error instanceof Error ? error.message.slice(0, 300) : "unknown" },
          `SAML sign-in refused: ${reason}`,
        );
        return page(reply, 502, "Not signed in", reason, flow.back());
      }
      const at = now();
      for (const [key, value] of checked) if (value.expiresAt <= at) checked.delete(key);
      while (checked.size >= WAITING_MAX) checked.delete(checked.keys().next().value!);
      const key = randomToken();
      checked.set(key, { flow: begun, claims, expiresAt: at + CODE_MS });
      return redirect(reply, `${base()}/api/saml/finish?state=${key}`, 303);
    });

    route(eeEndpoints.samlFinish, async ({ req, reply, query: q }) => {
      const held = q.state ? checked.get(q.state) : undefined;
      if (q.state) checked.delete(q.state);
      flow.endCookie(reply);
      if (!held || held.expiresAt <= now())
        return page(
          reply,
          400,
          "Start again",
          "This sign-in has expired, or was used already. Go back to OwnBase and start again.",
        );
      if (!flow.sameBrowser(held.flow, req))
        return page(
          reply,
          400,
          "Start again",
          "This sign-in was started in another browser. Go back to OwnBase and start again here.",
        );
      return flow.finish(reply, held.flow, held.claims);
    });

    route(eeEndpoints.samlSettings, async ({ body }) => {
      const next: SamlSettings = { ...settings() };
      for (const key of ["name", "signInUrl", "issuer"] as const) {
        const value = body[key];
        if (value !== undefined) next[key] = value.trim();
      }
      if (body.certificate !== undefined) {
        const text = body.certificate.trim();
        const certificates = text ? parseCertificates(text) : [];
        if (!certificates)
          throw new HttpError(
            400,
            "invalid_certificate",
            "That is not a certificate. Paste the provider's signing certificate, from -----BEGIN CERTIFICATE----- to -----END CERTIFICATE-----.",
          );
        next.certificates = certificates;
      }
      applyLinkSettings(next, body);
      if (!next.issuer) {
        // Off: nothing more is needed, and anyone may turn it off.
        given.storage.set("saml:settings", JSON.stringify({ ...next, required: false }));
        return { ok: true };
      }
      if (!opts.licensed())
        throw new HttpError(
          403,
          "license_required",
          "Single sign-on needs an Enterprise license with SSO.",
        );
      if (!base())
        throw new HttpError(
          409,
          "public_url_required",
          "Give the server its public address first (--public-url): the provider sends people back to it.",
        );
      if (!next.signInUrl || !next.certificates.length)
        throw new HttpError(
          400,
          "saml_incomplete",
          "Fill in the sign-in address and the certificate too.",
        );
      let url: URL | null = null;
      try {
        url = new URL(next.signInUrl);
      } catch {
        url = null;
      }
      if (
        !url ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))
      )
        throw new HttpError(
          400,
          "invalid_sign_in_url",
          "The sign-in address must start with https://.",
        );
      given.storage.set("saml:settings", JSON.stringify(next));
      return { ok: true };
    });
  }

  function settingsPanels(): SettingsPanel[] {
    if (!context) return [];
    const s = settings();
    // As with OpenID Connect: nothing in the free edition unless it was set up already.
    if (!opts.licensed() && !configured(s)) return [];
    const linked = configured(s) ? flow.linkedCount() : 0;
    const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
    return [
      {
        id: "saml",
        title: "Single sign-on with SAML",
        description: base()
          ? `People sign in with your company's SAML identity provider, such as Okta, Microsoft Entra ID or AD FS. Add OwnBase there as a SAML application, with the entity ID ${entityId()} (also the address of this workspace's metadata) and the sign-in address (ACS) ${acsUrl()}. Then fill in what it gives you.`
          : "People sign in with your company's SAML identity provider, such as Okta, Microsoft Entra ID or AD FS.",
        save: "/api/saml/settings",
        ...(!opts.licensed()
          ? {
              problem:
                "Single sign-on needs an Enterprise license with SSO. People already linked can still sign in with it.",
            }
          : !base()
            ? {
                problem:
                  "Give the server its public address first (--public-url): the provider sends people back to it.",
              }
            : {}),
        ...(configured(s)
          ? {
              status: `${linked} of ${people(context.memberCount())} can sign in with ${flow.providerName()}.`,
            }
          : {}),
        fields: [
          {
            key: "name",
            label: "Name on the button",
            kind: "text",
            value: s.name,
            placeholder: "Okta",
            help: "The sign-in screen says “Sign in with” and this.",
          },
          {
            key: "signInUrl",
            label: "Sign-in address",
            kind: "url",
            value: s.signInUrl,
            placeholder: "https://acme.okta.com/app/…/sso/saml",
            help: "Where the provider takes sign-in requests. Okta calls it the single sign-on URL, Entra the login URL.",
          },
          {
            key: "issuer",
            label: "Identity provider's entity ID",
            kind: "text",
            value: s.issuer,
            placeholder: "http://www.okta.com/exk…",
            help: "Okta calls it the issuer, Entra the Microsoft Entra identifier. Left empty, SAML sign-in is off.",
          },
          {
            key: "certificate",
            label: "Signing certificate",
            kind: "text",
            value: s.certificates.map(base64Of).join(", "),
            placeholder: "-----BEGIN CERTIFICATE-----…",
            help: "Paste the whole certificate. For a second one while the provider changes it, add it after a comma.",
          },
          ...linkFields(s),
        ],
      },
    ];
  }

  return {
    register,
    signInMethods() {
      const s = settings();
      if (!configured(s) || !base()) return [];
      return [
        {
          id: "saml",
          name: flow.providerName(),
          start: "/api/saml/start",
          redeem: "/api/saml/redeem",
          connect: "/api/saml/connect",
        },
      ];
    },
    requiresSingleSignOn: flow.required,
    settingsPanels,
  };
}
