import {
  DEEP_LINK_PROTOCOL,
  type SettingsField,
  type SettingsPanel,
  type SignInConnection,
  type SignInMethod,
  type User,
} from "@ownbase/protocol";
import type { ExtensionContext } from "@ownbase/server/extensions";
import {
  authorizationUrl,
  discover,
  exchangeCode,
  KeySet,
  OidcError,
  randomToken,
  s256,
  verifyIdToken,
  type IdClaims,
  type Provider,
} from "./oidc.js";

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
export interface SsoSettings {
  /** As people know the provider, such as "Okta". */
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Someone the provider signs in who has no account here gets one. */
  newAccounts: boolean;
  /** When any, new accounts are for verified addresses at these domains only. */
  domains: string[];
  /** Passwords sign in the owner alone. */
  required: boolean;
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

/** From pressing the button to coming back, at most. */
export const FLOW_MS = 10 * 60 * 1000;
/** The code a sign-in comes back with, and the link to start linking, wait this long for their use. */
export const CODE_MS = 2 * 60 * 1000;
/** The provider's description of itself is read again after this long. */
const PROVIDER_MS = 60 * 60 * 1000;
/** Sign-ins and codes waiting at once, at most: the oldest give way. */
const WAITING_MAX = 500;
const COOKIE = "ownbase_sso";
const TEXT_MAX = 500;

interface Flow {
  nonce: string;
  verifier: string;
  /** The SHA-256 of the cookie the browser that began holds. */
  browser: string;
  issuer: string;
  expiresAt: number;
  /** Signing in: which client began, and the challenge its code is redeemed for. */
  client?: "web" | "desktop";
  challenge?: string;
  /** Linking: whose account. */
  linkUserId?: string;
}

/** A provider's account, linked to one here. */
interface Identity {
  userId: string;
  issuer: string;
  subject: string;
  email?: string;
  linkedAt: number;
}

export interface SingleSignOn {
  register(context: ExtensionContext): void;
  signInMethods(): SignInMethod[];
  requiresSingleSignOn(): boolean;
  settingsPanels(): SettingsPanel[];
}

type Request = Parameters<ExtensionContext["startSession"]>[1];
interface Reply {
  code(status: number): Reply;
  header(name: string, value: string): Reply;
  send(payload?: unknown): Reply;
}
type Query = { Querystring: Record<string, string | undefined> };

/** Answered as the server answers its own refusals: `{ error: code, message }`. */
const refuse = (statusCode: number, code: string, message: string) =>
  Object.assign(new Error(message), { statusCode, code });

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The page a browser is left on when a sign-in ends somewhere other than the
 * app: something went wrong, an account was linked, or the desktop app is
 * being opened.
 */
function page(
  reply: Reply,
  status: number,
  title: string,
  text: string,
  link?: { href: string; label: string },
  open?: string,
): Reply {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${open ? `<meta http-equiv="refresh" content="0;url=${escape(open)}">` : ""}<title>${escape(title)} · OwnBase</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f5f2;color:#22211f;display:grid;place-items:center;min-height:100vh}main{max-width:28rem;padding:2rem}h1{font-size:1.4rem;margin:0 0 .5rem}a{display:inline-block;margin-top:1rem;padding:.55rem 1rem;border-radius:.6rem;background:#22211f;color:#fff;text-decoration:none}@media (prefers-color-scheme:dark){body{background:#1b1a19;color:#ecebe8}a{background:#ecebe8;color:#1b1a19}}</style>
</head><body><main><h1>${escape(title)}</h1><p>${escape(text)}</p>${link ? `<a href="${escape(link.href)}">${escape(link.label)}</a>` : ""}</main></body></html>`;
  return reply
    .code(status)
    .header("content-type", "text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .send(html);
}

const redirect = (reply: Reply, location: string) =>
  reply.code(302).header("location", location).header("cache-control", "no-store").send();

const readCookie = (req: Request): string | undefined =>
  req.headers.cookie
    ?.split(";")
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);

const identityKey = (issuer: string, subject: string) => s256(`${issuer}\n${subject}`);

/** Usernames are 2 to 32 lowercase letters, digits, . _ or -, starting with a letter or digit. */
const HANDLE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

/** A username for someone new, from what the provider calls them, not one taken. */
export function handleFor(claims: IdClaims, taken: (handle: string) => boolean): string {
  const from =
    claims.preferred_username?.split("@")[0] || claims.email?.split("@")[0] || claims.name || "";
  let base = from
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9._-]+/g, "")
    .replace(/^[._-]+/, "")
    .slice(0, 28);
  if (!HANDLE.test(base)) base = `member${base}`.slice(0, 28);
  for (let n = 1; n < 1000; n++) {
    const handle = n === 1 ? base : `${base}-${n}`;
    if (!taken(handle)) return handle;
  }
  return `member-${randomToken()
    .slice(0, 12)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "0")}`;
}

/** "acme.com, @acme.co.uk" as domains, or null for one that is not a domain. */
export function parseDomains(text: string): string[] | null {
  const domains = text
    .split(/[\s,]+/)
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  return domains.every((domain) => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(domain))
    ? [...new Set(domains)]
    : null;
}

export function singleSignOn(opts: {
  /** Whether the license has single sign-on now. */
  licensed: () => boolean;
  now?: () => number;
  fetch?: typeof fetch;
}): SingleSignOn {
  const now = opts.now ?? Date.now;
  const fetchFn = opts.fetch ?? fetch;
  let context: ExtensionContext | null = null;
  /** Sign-ins gone to the provider, by their state. In memory: a restart asks to start again. */
  const flows = new Map<string, Flow>();
  /** Codes the way back brought, by their SHA-256. */
  const codes = new Map<string, { userId: string; challenge: string; expiresAt: number }>();
  /** Links to start linking an account, by their SHA-256. */
  const tickets = new Map<string, { userId: string; expiresAt: number }>();
  let provider: { issuer: string; at: number; value: Promise<Provider> } | null = null;
  const keySets = new Map<string, KeySet>();

  const store = () => context!.storage;
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
  const base = () => context?.publicUrl();
  const callbackUrl = () => `${base()}/api/sso/callback`;
  const providerName = (s: SsoSettings) => s.name || "single sign-on";
  const required = () => {
    const s = settings();
    return configured(s) && s.required && opts.licensed();
  };

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

  /** Drops what has expired, and the oldest while there are too many. */
  const prune = <T extends { expiresAt: number }>(map: Map<string, T>) => {
    const at = now();
    for (const [key, value] of map) if (value.expiresAt <= at) map.delete(key);
    while (map.size >= WAITING_MAX) map.delete(map.keys().next().value!);
  };

  const parse = <T>(raw: string | null): T | null => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };
  const identityOf = (issuer: string, subject: string) =>
    parse<Identity>(store().get(`sso:identity:${identityKey(issuer, subject)}`));
  /** The provider's account linked to `userId`, for the issuer set up now. */
  const linkedTo = (userId: string): Identity | null => {
    const key = store().get(`sso:user:${userId}`);
    const identity = key ? parse<Identity>(store().get(`sso:identity:${key}`)) : null;
    return identity?.userId === userId && identity.issuer === settings().issuer ? identity : null;
  };
  const link = (userId: string, claims: IdClaims) => {
    const key = identityKey(claims.iss, claims.sub);
    const before = store().get(`sso:user:${userId}`);
    if (before && before !== key) store().delete(`sso:identity:${before}`);
    const identity: Identity = {
      userId,
      issuer: claims.iss,
      subject: claims.sub,
      ...(typeof claims.email === "string" ? { email: claims.email.slice(0, 320) } : {}),
      linkedAt: now(),
    };
    store().set(`sso:identity:${key}`, JSON.stringify(identity));
    store().set(`sso:user:${userId}`, key);
  };
  const unlink = (userId: string) => {
    const key = store().get(`sso:user:${userId}`);
    if (!key) return;
    if (parse<Identity>(store().get(`sso:identity:${key}`))?.userId === userId)
      store().delete(`sso:identity:${key}`);
    store().delete(`sso:user:${userId}`);
  };
  /** People who can sign in now with the provider set up now. */
  const linkedCount = () => {
    const issuer = settings().issuer;
    return store()
      .list("sso:identity:")
      .filter(({ value }) => {
        const identity = parse<Identity>(value);
        const user = identity?.issuer === issuer ? context!.users.get(identity.userId) : null;
        return !!user && !user.deactivated;
      }).length;
  };

  /** Whether someone new may have an account: null when they may, or why not. */
  const newAccountRefusal = (s: SsoSettings, claims: IdClaims): string | null => {
    const who = claims.email ?? claims.preferred_username ?? "you";
    if (!opts.licensed() || !s.newAccounts)
      return `No account in this workspace is linked to ${who} yet. Sign in with your password, then link ${providerName(s)} in Account settings, under Sign-in.`;
    if (!s.domains.length) return null;
    if (typeof claims.email !== "string" || claims.email_verified !== true)
      return `${providerName(s)} has not verified ${who}, so no account is made for it here. Ask the workspace's owner.`;
    const domain = claims.email.split("@").pop()!.toLowerCase();
    return s.domains.includes(domain)
      ? null
      : `New accounts here are for ${s.domains.map((d) => `@${d}`).join(", ")} addresses, not ${claims.email}.`;
  };

  const cookie = (value: string, seconds: number) =>
    `${COOKIE}=${value}; Path=/api/sso/; Max-Age=${seconds}; HttpOnly; SameSite=Lax${base()?.startsWith("https:") ? "; Secure" : ""}`;

  function register(given: ExtensionContext) {
    context = given;
    const { app } = given;
    const back = () => ({ href: `${base()}/`, label: "Back to OwnBase" });

    /** The button: off to the provider, with what the way back must bring. */
    app.get<Query>("/api/sso/start", async (req, reply) => {
      const s = settings();
      if (!configured(s) || !base())
        return page(
          reply,
          404,
          "Single sign-on is off",
          "This workspace does not use single sign-on. Sign in with your password.",
        );
      const q = req.query;
      let begun: Pick<Flow, "client" | "challenge" | "linkUserId">;
      if (q.link !== undefined) {
        const key = s256(q.link);
        const ticket = tickets.get(key);
        tickets.delete(key);
        if (!ticket || ticket.expiresAt <= now())
          return page(
            reply,
            400,
            "Start again",
            "This link has expired. Go back to Account settings and press Link again.",
          );
        begun = { linkUserId: ticket.userId };
      } else {
        if (
          (q.client !== "web" && q.client !== "desktop") ||
          !/^[A-Za-z0-9_-]{43}$/.test(q.challenge ?? "")
        )
          return page(
            reply,
            400,
            "Start again",
            "Start signing in from the OwnBase sign-in screen.",
          );
        begun = { client: q.client, challenge: q.challenge };
      }
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
      prune(flows);
      const state = randomToken();
      const flow: Flow = {
        ...begun,
        nonce: randomToken(),
        verifier: randomToken(),
        browser: "",
        issuer: found.issuer,
        expiresAt: now() + FLOW_MS,
      };
      const browser = randomToken();
      flow.browser = s256(browser);
      flows.set(state, flow);
      reply.header("set-cookie", cookie(browser, FLOW_MS / 1000));
      return redirect(
        reply,
        authorizationUrl(found, {
          clientId: s.clientId,
          redirectUri: callbackUrl(),
          state,
          nonce: flow.nonce,
          codeVerifier: flow.verifier,
        }),
      );
    });

    /** The way back from the provider: an account linked, or a code for the app. */
    app.get<Query>("/api/sso/callback", async (req, reply) => {
      const q = req.query;
      const flow = q.state ? flows.get(q.state) : undefined;
      if (q.state) flows.delete(q.state);
      reply.header("set-cookie", cookie("", 0));
      if (!flow || flow.expiresAt <= now())
        return page(
          reply,
          400,
          "Start again",
          "This sign-in has expired, or was used already. Go back to OwnBase and start again.",
        );
      if (s256(readCookie(req) ?? "") !== flow.browser)
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
          `${providerName(s)} said: ${(q.error_description || q.error).slice(0, TEXT_MAX)}.`,
          back(),
        );
      if (!configured(s) || !base())
        return page(reply, 404, "Single sign-on is off", "This workspace stopped using it.");
      let claims: IdClaims;
      try {
        const found = await providerFor(s.issuer);
        if (found.issuer !== flow.issuer)
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
            codeVerifier: flow.verifier,
          },
          fetchFn,
        );
        claims = await verifyIdToken(idToken, {
          issuer: found.issuer,
          clientId: s.clientId,
          nonce: flow.nonce,
          now: now(),
          key: (kid, alg) => keysAt(found.jwksUri).key(kid, alg),
        });
      } catch (error) {
        if (!(error instanceof OidcError)) throw error;
        given.log.warn({ code: error.code }, `single sign-on: ${error.message}`);
        return page(reply, 502, "Not signed in", error.message, back());
      }

      const who = claims.email ?? claims.preferred_username ?? "that account";
      const known = identityOf(claims.iss, claims.sub);
      const holder = known ? given.users.get(known.userId) : null;

      if (flow.linkUserId) {
        const me = given.users.get(flow.linkUserId);
        if (!opts.licensed())
          return page(
            reply,
            403,
            "Not linked",
            "Linking needs an Enterprise license with single sign-on.",
            back(),
          );
        if (!me || me.deactivated)
          return page(reply, 403, "Not linked", "This account can no longer be linked.", back());
        if (holder && holder.id !== me.id)
          return page(
            reply,
            409,
            "Not linked",
            `${who} is linked to @${holder.handle} already. Unlink it there first.`,
            back(),
          );
        link(me.id, claims);
        return page(
          reply,
          200,
          "Linked",
          `@${me.handle} signs in with ${providerName(s)} as ${who} from now on. You can close this tab.`,
          back(),
        );
      }

      if (holder?.deactivated)
        return page(
          reply,
          403,
          "Not signed in",
          "This account has been deactivated. Ask an admin of the workspace.",
          back(),
        );
      let user: User | null = holder;
      if (!user) {
        const refusal = newAccountRefusal(s, claims);
        if (refusal) return page(reply, 403, "No account here yet", refusal, back());
        try {
          const handle = handleFor(claims, (h) => !!given.users.byHandle(h));
          user = await given.users.create({
            handle,
            displayName: claims.name?.trim().slice(0, 80) || handle,
          });
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code !== "handle_taken" && code !== "workspace_unclaimed") throw error;
          return page(
            reply,
            409,
            "Not signed in",
            "Your account could not be made. Start again.",
            back(),
          );
        }
        link(user.id, claims);
      }

      prune(codes);
      const code = randomToken();
      codes.set(s256(code), {
        userId: user.id,
        challenge: flow.challenge!,
        expiresAt: now() + CODE_MS,
      });
      if (flow.client === "desktop") {
        const host = encodeURIComponent(base()!).replaceAll("%3A", ":").replaceAll("%2F", "/");
        const target = `${DEEP_LINK_PROTOCOL}://sso?host=${host}&code=${code}`;
        return page(
          reply,
          200,
          "Signed in",
          "OwnBase is opening. If it does not, press the button. You can close this tab after.",
          { href: target, label: "Open OwnBase" },
          target,
        );
      }
      return redirect(reply, `${base()}/#/sso/${code}`);
    });

    /** The app's code and its secret, for a session. */
    app.post("/api/sso/redeem", async (req) => {
      const body = (req.body ?? {}) as { code?: unknown; verifier?: unknown };
      if (typeof body.code !== "string" || typeof body.verifier !== "string")
        throw refuse(400, "invalid_request", "A code and its verifier are needed.");
      const key = s256(body.code);
      const held = codes.get(key);
      codes.delete(key);
      if (!held || held.expiresAt <= now() || s256(body.verifier) !== held.challenge)
        throw refuse(
          401,
          "sso_code_invalid",
          "That sign-in has expired, or was started somewhere else. Start again.",
        );
      return given.startSession(held.userId, req);
    });

    /** Whether the person signed in here has linked the provider's account. */
    app.get("/api/sso/connect", async (req, reply): Promise<SignInConnection> => {
      const me = given.requireUser(req);
      reply.header("cache-control", "no-store");
      const identity = linkedTo(me.id);
      return identity
        ? { connected: true, ...(identity.email ? { as: identity.email } : {}) }
        : { connected: false };
    });

    /** Where to go to link it: a one-time link, for the browser that opens it. */
    app.post("/api/sso/connect", async (req) => {
      const me = given.requireUser(req);
      if (me.role === "guest")
        throw refuse(403, "guest_not_allowed", "Guests sign in with their name alone.");
      if (!configured(settings()) || !base())
        throw refuse(409, "sso_off", "This workspace does not use single sign-on.");
      if (!opts.licensed())
        throw refuse(
          403,
          "license_required",
          "Linking needs an Enterprise license with single sign-on.",
        );
      prune(tickets);
      const ticket = randomToken();
      tickets.set(s256(ticket), { userId: me.id, expiresAt: now() + CODE_MS });
      return { url: `/api/sso/start?link=${ticket}` };
    });

    app.delete("/api/sso/connect", async (req): Promise<SignInConnection> => {
      const me = given.requireUser(req);
      // Without it they could not sign in again.
      if (me.role !== "owner" && required())
        throw refuse(
          409,
          "sso_required",
          "This workspace requires single sign-on, so your account stays linked.",
        );
      unlink(me.id);
      return { connected: false };
    });

    /** The owner's settings, from the panel: what is sent changes, a secret left empty stays. */
    app.put("/api/sso/settings", async (req) => {
      given.requireOwner(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const next: SsoSettings = { ...settings() };
      for (const key of ["name", "issuer", "clientId", "clientSecret", "domains"] as const) {
        const value = body[key];
        if (value === undefined) continue;
        if (typeof value !== "string" || value.length > TEXT_MAX)
          throw refuse(
            400,
            "invalid_request",
            `${key} must be text of up to ${TEXT_MAX} characters.`,
          );
        if (key === "domains") {
          const domains = parseDomains(value);
          if (!domains)
            throw refuse(
              400,
              "invalid_domains",
              "Write domains such as acme.com, separated by commas.",
            );
          next.domains = domains;
        } else if (key === "clientSecret") {
          if (value) next.clientSecret = value;
        } else next[key] = value.trim();
      }
      for (const key of ["newAccounts", "required"] as const) {
        const value = body[key];
        if (value === undefined) continue;
        if (typeof value !== "boolean")
          throw refuse(400, "invalid_request", `${key} is on or off.`);
        next[key] = value;
      }
      if (!next.issuer) {
        // Off: nothing more is needed, and anyone may turn it off.
        given.storage.set("sso:settings", JSON.stringify({ ...next, required: false }));
        return { ok: true };
      }
      if (!opts.licensed())
        throw refuse(
          403,
          "license_required",
          "Single sign-on needs an Enterprise license with SSO.",
        );
      if (!base())
        throw refuse(
          409,
          "public_url_required",
          "Give the server its public address first (--public-url): the provider sends people back to it.",
        );
      if (!next.clientId || !next.clientSecret)
        throw refuse(400, "sso_incomplete", "Fill in the client ID and the client secret too.");
      try {
        next.issuer = (await discover(next.issuer, fetchFn)).issuer;
      } catch (error) {
        if (!(error instanceof OidcError)) throw error;
        throw refuse(400, "sso_discovery_failed", error.message);
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
    const field = (f: SettingsField) => f;
    const linked = configured(s) ? linkedCount() : 0;
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
              status: `${linked} of ${people(context.memberCount())} can sign in with ${providerName(s)}.`,
            }
          : {}),
        fields: [
          field({
            key: "name",
            label: "Name on the button",
            kind: "text",
            value: s.name,
            placeholder: "Okta",
            help: "The sign-in screen says “Sign in with” and this.",
          }),
          field({
            key: "issuer",
            label: "Issuer",
            kind: "url",
            value: s.issuer,
            placeholder: "https://acme.okta.com",
            help: "The provider's issuer address. Left empty, single sign-on is off.",
          }),
          field({ key: "clientId", label: "Client ID", kind: "text", value: s.clientId }),
          field({
            key: "clientSecret",
            label: "Client secret",
            kind: "secret",
            value: "",
            isSet: !!s.clientSecret,
          }),
          field({
            key: "newAccounts",
            label: "Make accounts for new people",
            kind: "toggle",
            value: s.newAccounts,
            help: "Someone the provider signs in who has no account here gets one, as a member. Off, people link the account they have, in Account settings.",
          }),
          field({
            key: "domains",
            label: "Email domains for new accounts",
            kind: "text",
            value: s.domains.join(", "),
            placeholder: "acme.com",
            help: "Separate them with commas. With any, the provider must have verified the address. Left empty, anyone it signs in gets an account.",
          }),
          field({
            key: "required",
            label: "Require single sign-on",
            kind: "toggle",
            value: s.required,
            help: "Passwords then sign in only you, the owner, so you can always get back in. Anyone who has not linked an account cannot sign in until it is off.",
          }),
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
          name: providerName(s),
          start: "/api/sso/start",
          redeem: "/api/sso/redeem",
          connect: "/api/sso/connect",
        },
      ];
    },
    requiresSingleSignOn: required,
    settingsPanels,
  };
}
