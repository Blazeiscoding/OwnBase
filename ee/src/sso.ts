import type { SettingsPanel, SignInMethod } from "@ownbase/protocol";
import type { ExtensionContext } from "@ownbase/server/extensions";
import { HttpError } from "@ownbase/server/httpError";
import { eeEndpoints, TEXT_MAX } from "./endpoints.js";
import {
  authorizationUrl,
  discover,
  exchangeCode,
  KeySet,
  OidcError,
  randomToken,
  verifyIdToken,
  type IdClaims,
  type Provider,
} from "./oidc.js";
import {
  applyLinkSettings,
  linkFields,
  page,
  redirect,
  signInFlow,
  type LinkSettings,
} from "./signInFlow.js";

export { CODE_MS, FLOW_MS, handleFor, handleFrom, parseDomains } from "./signInFlow.js";

/**
 * Single sign-on with OpenID Connect (P9), part of the Enterprise edition.
 * The owner names the provider in Workspace settings; the sign-in screen
 * then has its button. Accounts here have no email address, so nobody is
 * matched by one: a person links the provider's account to theirs while
 * signed in (Account settings, Sign-in), or, where the owner allows it, gets
 * a new account the first time the provider signs them in.
 *
 * The browser that presses the button holds a cookie the way back must
 * bring, so nobody can finish a sign-in someone else began. What comes back
 * to the app is a one-time code, never a session: the app redeems it with a
 * secret only it has (`challenge` at the start, `verifier` at the end), so a
 * code passed to someone else signs nobody in.
 *
 * With a license that has `sso`, the owner can set it up, link accounts,
 * make new ones and require it. When the license ends, accounts already
 * linked still sign in this way, since chat never locks anyone out, and
 * passwords work for everyone again.
 */

/** Who signs people in, as the owner set it up. */
export interface SsoSettings extends LinkSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

const UNSET: SsoSettings = {
  name: "",
  issuer: "",
  clientId: "",
  clientSecret: "",
  newAccounts: false,
  domains: [],
  required: false,
};

/** The provider's description of itself is read again after this long. */
const PROVIDER_MS = 60 * 60 * 1000;

/** What a sign-in to an OpenID provider keeps besides what every one does. */
interface OidcFlow {
  nonce: string;
  verifier: string;
  issuer: string;
}

export interface SingleSignOn {
  register(context: ExtensionContext): void;
  signInMethods(): SignInMethod[];
  requiresSingleSignOn(): boolean;
  settingsPanels(): SettingsPanel[];
}

export function singleSignOn(opts: {
  licensed: () => boolean;
  /**
   * The account provisioning (P10) made for a verified address, linked at
   * that person's first sign-in: the provider's own records say who they are.
   */
  provisioned?: (email: string) => string | null;
  now?: () => number;
  fetch?: typeof fetch;
}): SingleSignOn {
  const now = opts.now ?? Date.now;
  const fetchFn = opts.fetch ?? fetch;
  let context: ExtensionContext | null = null;
  let provider: { issuer: string; at: number; value: Promise<Provider> } | null = null;
  const keySets = new Map<string, KeySet>();

  const settings = (): SsoSettings => {
    const raw = context?.storage.get("sso:settings");
    if (!raw) return UNSET;
    try {
      return { ...UNSET, ...(JSON.parse(raw) as Partial<SsoSettings>) };
    } catch {
      return UNSET;
    }
  };
  const configured = (s: SsoSettings) => !!(s.issuer && s.clientId && s.clientSecret);
  const flow = signInFlow<OidcFlow>({
    id: "sso",
    licensed: opts.licensed,
    provisioned: opts.provisioned,
    now,
    settings,
    configured: () => configured(settings()),
  });
  const base = flow.base;
  const callbackUrl = () => `${base()}/api/sso/callback`;

  /** The provider's description, read again after an hour or for another issuer. */
  const providerFor = (issuer: string): Promise<Provider> => {
    if (!provider || provider.issuer !== issuer || now() - provider.at > PROVIDER_MS) {
      const entry = { issuer, at: now(), value: discover(issuer, fetchFn) };
      provider = entry;
      // A failure is asked again next time, not kept for an hour.
      entry.value.catch(() => {
        if (provider === entry) provider = null;
      });
    }
    return provider.value;
  };
  const keysAt = (uri: string) => {
    let keys = keySets.get(uri);
    if (!keys) keySets.set(uri, (keys = new KeySet(uri, fetchFn, now)));
    return keys;
  };

  function register(given: ExtensionContext) {
    context = given;
    const { route } = given;
    flow.register(given, {
      redeem: eeEndpoints.ssoRedeem,
      connection: eeEndpoints.ssoConnection,
      connect: eeEndpoints.ssoConnect,
      disconnect: eeEndpoints.ssoDisconnect,
    });

    route(eeEndpoints.ssoStart, async ({ reply, query: q }) => {
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
      let found: Provider;
      try {
        found = await providerFor(s.issuer);
      } catch (error) {
        if (!(error instanceof OidcError)) throw error;
        return page(
          reply,
          502,
          "Single sign-on is not working",
          `${error.message} Tell the workspace's owner.`,
        );
      }
      const nonce = randomToken();
      const verifier = randomToken();
      const state = flow.open(reply, begun, { nonce, verifier, issuer: found.issuer });
      return redirect(
        reply,
        authorizationUrl(found, {
          clientId: s.clientId,
          redirectUri: callbackUrl(),
          state,
          nonce,
          codeVerifier: verifier,
        }),
      );
    });

    route(eeEndpoints.ssoCallback, async ({ req, reply, query: q }) => {
      const begun = flow.take(q.state);
      flow.endCookie(reply);
      if (!begun)
        return page(
          reply,
          400,
          "Start again",
          "This sign-in has expired, or was used already. Go back to OwnBase and start again.",
        );
      if (!flow.sameBrowser(begun, req))
        return page(
          reply,
          400,
          "Start again",
          "This sign-in was started in another browser. Go back to OwnBase and start again here.",
        );
      const s = settings();
      if (q.error)
        return page(
          reply,
          400,
          "Not signed in",
          `${flow.providerName()} said: ${(q.error_description || q.error).slice(0, TEXT_MAX)}.`,
          flow.back(),
        );
      if (!configured(s) || !base())
        return page(reply, 404, "Single sign-on is off", "This workspace stopped using it.");
      let claims: IdClaims;
      try {
        const found = await providerFor(s.issuer);
        if (found.issuer !== begun.issuer)
          throw new OidcError(
            "issuer_changed",
            "Single sign-on was set up again while you were signing in. Start again.",
          );
        if (!q.code) throw new OidcError("token_invalid", "The sign-in service sent no code.");
        const idToken = await exchangeCode(
          found,
          {
            clientId: s.clientId,
            clientSecret: s.clientSecret,
            code: q.code,
            redirectUri: callbackUrl(),
            codeVerifier: begun.verifier,
          },
          fetchFn,
        );
        claims = await verifyIdToken(idToken, {
          issuer: found.issuer,
          clientId: s.clientId,
          nonce: begun.nonce,
          now: now(),
          key: (kid, alg) => keysAt(found.jwksUri).key(kid, alg),
        });
      } catch (error) {
        if (!(error instanceof OidcError)) throw error;
        given.log.warn({ code: error.code }, `single sign-on: ${error.message}`);
        return page(reply, 502, "Not signed in", error.message, flow.back());
      }
      return flow.finish(reply, begun, claims);
    });

    route(eeEndpoints.ssoSettings, async ({ body }) => {
      const next: SsoSettings = { ...settings() };
      for (const key of ["name", "issuer", "clientId", "clientSecret"] as const) {
        const value = body[key];
        if (value === undefined) continue;
        if (key === "clientSecret") {
          if (value) next.clientSecret = value;
        } else next[key] = value.trim();
      }
      applyLinkSettings(next, body);
      if (!next.issuer) {
        // Off: nothing more is needed, and anyone may turn it off.
        given.storage.set("sso:settings", JSON.stringify({ ...next, required: false }));
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
      if (!next.clientId || !next.clientSecret)
        throw new HttpError(
          400,
          "sso_incomplete",
          "Fill in the client ID and the client secret too.",
        );
      try {
        next.issuer = (await discover(next.issuer, fetchFn)).issuer;
      } catch (error) {
        if (!(error instanceof OidcError)) throw error;
        throw new HttpError(400, "sso_discovery_failed", error.message);
      }
      provider = null;
      given.storage.set("sso:settings", JSON.stringify(next));
      return { ok: true };
    });
  }

  function settingsPanels(): SettingsPanel[] {
    if (!context) return [];
    const s = settings();
    // Without the license feature this build is the free edition, unless single
    // sign-on was set up already: its owner still sees it, and can turn it off.
    if (!opts.licensed() && !configured(s)) return [];
    const linked = configured(s) ? flow.linkedCount() : 0;
    const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
    return [
      {
        id: "sso",
        title: "Single sign-on",
        description: `People sign in with your company's OpenID Connect provider, such as Okta, Microsoft Entra ID, Google Workspace or Keycloak. Register OwnBase there as a web application with the sign-in redirect address ${base() ? callbackUrl() : "<public address>/api/sso/callback"}, then fill in what it gives you.`,
        save: "/api/sso/settings",
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
            key: "issuer",
            label: "Issuer",
            kind: "url",
            value: s.issuer,
            placeholder: "https://acme.okta.com",
            help: "The provider's issuer address. Left empty, single sign-on is off.",
          },
          { key: "clientId", label: "Client ID", kind: "text", value: s.clientId },
          {
            key: "clientSecret",
            label: "Client secret",
            kind: "secret",
            value: "",
            isSet: !!s.clientSecret,
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
          id: "sso",
          name: flow.providerName(),
          start: "/api/sso/start",
          redeem: "/api/sso/redeem",
          connect: "/api/sso/connect",
        },
      ];
    },
    requiresSingleSignOn: flow.required,
    settingsPanels,
  };
}
