import {
  DEEP_LINK_PROTOCOL,
  handleSchema,
  type Endpoint,
  type EndpointSpec,
  type extensionRoutes,
  type SettingsField,
  type User,
} from "@ownbase/protocol";
import type { ExtensionContext } from "@ownbase/server/extensions";
import { HttpError } from "@ownbase/server/httpError";
import { randomToken, s256 } from "./oidc.js";

/**
 * What single sign-on does the same way whoever the provider is, OpenID
 * Connect (P9) or SAML (P11): a sign-in begun by the app's button or to link
 * an account, bound to the browser that began it by a cookie; the provider's
 * account linked to one here, found, or made; and the one-time code the app
 * redeems with its secret.
 */

/** From pressing the button to coming back, at most. */
export const FLOW_MS = 10 * 60 * 1000;
/** The code a sign-in comes back with, and the link to start linking, wait this long for their use. */
export const CODE_MS = 2 * 60 * 1000;
/** Sign-ins and codes waiting at once, at most: the oldest give way. */
export const WAITING_MAX = 500;

/** Who the provider signed in, in OpenID Connect's names. */
export interface Claims {
  /** The provider: an OpenID issuer, or a SAML identity provider's entity ID. */
  iss: string;
  /** Who they are there, for good. */
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
}

/** What the owner set that decides who gets in, whoever the provider is. */
export interface LinkSettings {
  /** As people know the provider, such as "Okta". */
  name: string;
  /** Links made with another issuer are not used. */
  issuer: string;
  /** Someone the provider signs in who has no account here gets one. */
  newAccounts: boolean;
  /** When any, new accounts are for verified addresses at these domains only. */
  domains: string[];
  /** Passwords sign in the owner alone. */
  required: boolean;
}

/** How a sign-in began: from the app's button, or to link a signed-in person's account. */
export interface Begun {
  /** Signing in: which client began, and the challenge its code is redeemed for. */
  client?: "web" | "desktop";
  challenge?: string;
  /** Linking: whose account. */
  linkUserId?: string;
}

export type Flow<Extra> = Begun &
  Extra & {
    /** The SHA-256 of the cookie the browser that began holds. */
    browser: string;
    expiresAt: number;
  };

/** A provider's account, linked to one here. */
interface Identity {
  userId: string;
  issuer: string;
  subject: string;
  email?: string;
  linkedAt: number;
}

type Request = Parameters<ExtensionContext["startSession"]>[1];
export interface Reply {
  code(status: number): Reply;
  header(name: string, value: string): Reply;
  send(payload?: unknown): Reply;
}
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The page a browser is left on when a sign-in ends somewhere other than the
 * app: something went wrong, an account was linked, or the desktop app is
 * being opened.
 */
export function page<R extends Reply>(
  reply: R,
  status: number,
  title: string,
  text: string,
  link?: { href: string; label: string },
  open?: string,
): R {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${open ? `<meta http-equiv="refresh" content="0;url=${escape(open)}">` : ""}<title>${escape(title)} · OwnBase</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f5f2;color:#22211f;display:grid;place-items:center;min-height:100vh}main{max-width:28rem;padding:2rem}h1{font-size:1.4rem;margin:0 0 .5rem}a{display:inline-block;margin-top:1rem;padding:.55rem 1rem;border-radius:.6rem;background:#22211f;color:#fff;text-decoration:none}@media (prefers-color-scheme:dark){body{background:#1b1a19;color:#ecebe8}a{background:#ecebe8;color:#1b1a19}}</style>
</head><body><main><h1>${escape(title)}</h1><p>${escape(text)}</p>${link ? `<a href="${escape(link.href)}">${escape(link.label)}</a>` : ""}</main></body></html>`;
  return reply
    .code(status)
    .header("content-type", "text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .send(html) as R;
}

/** `status` 303 after a POST, so the browser follows with a GET. */
export const redirect = <R extends Reply>(reply: R, location: string, status = 302) =>
  reply.code(status).header("location", location).header("cache-control", "no-store").send() as R;

/** A username for someone new, from what the provider calls them, not one taken. */
export function handleFor(claims: Claims, taken: (handle: string) => boolean): string {
  return handleFrom(
    claims.preferred_username?.split("@")[0] || claims.email?.split("@")[0] || claims.name || "",
    taken,
  );
}

/** A username made from `from`, such as an address's first part, not one taken. */
export function handleFrom(from: string, taken: (handle: string) => boolean): string {
  let base = from
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9._-]+/g, "")
    .replace(/^[._-]+/, "")
    .slice(0, 28);
  if (!handleSchema.safeParse(base).success) base = `member${base}`.slice(0, 28);
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

/** Who gets in, from a settings panel's values: new accounts, their domains, and requiring it. */
export function applyLinkSettings<S extends LinkSettings>(
  next: S,
  body: { domains?: string; newAccounts?: boolean; required?: boolean },
): S {
  if (body.domains !== undefined) {
    const domains = parseDomains(body.domains);
    if (!domains)
      throw new HttpError(
        400,
        "invalid_domains",
        "Write domains such as acme.com, separated by commas.",
      );
    next.domains = domains;
  }
  for (const key of ["newAccounts", "required"] as const) {
    const value = body[key];
    if (value !== undefined) next[key] = value;
  }
  return next;
}

/** The settings panel's fields for who gets in. */
export function linkFields(s: LinkSettings): SettingsField[] {
  return [
    {
      key: "newAccounts",
      label: "Make accounts for new people",
      kind: "toggle",
      value: s.newAccounts,
      help: "Someone the provider signs in who has no account here gets one, as a member. Off, people link the account they have, in Account settings.",
    },
    {
      key: "domains",
      label: "Email domains for new accounts",
      kind: "text",
      value: s.domains.join(", "),
      placeholder: "acme.com",
      help: "Separate them with commas. With any, the provider must have verified the address. Left empty, anyone it signs in gets an account.",
    },
    {
      key: "required",
      label: "Require single sign-on",
      kind: "toggle",
      value: s.required,
      help: "Passwords then sign in only you, the owner, so you can always get back in. Anyone who has not linked an account cannot sign in until it is off.",
    },
  ];
}

/**
 * What saving a way of signing in changed, as the audit log says it: turned
 * on or off, the settings changed by their names, and who it lets in. Never a
 * value, since some are secrets or certificates. Null when nothing changed.
 * While it is off, whether it makes accounts or is required decides nothing,
 * so only the named settings are told then.
 */
export function settingsChange<S extends LinkSettings>(
  method: string,
  before: S,
  after: S,
  opts: { on: (s: S) => boolean; named: Record<string, (s: S) => unknown> },
): string | null {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const wasOn = opts.on(before);
  const isOn = opts.on(after);
  const changed = Object.entries({ ...opts.named, "email domains for new accounts": domainsOf })
    .filter(([, of]) => !same(of(before), of(after)))
    .map(([name]) => `the ${name}`);
  const clauses: string[] = [];
  if (wasOn !== isOn) clauses.push(`turned ${isOn ? "on" : "off"} ${method}`);
  else if (changed.length)
    clauses.push(`changed ${inWords(changed)} in the settings for ${method}`);
  if (isOn) {
    const from = wasOn ? before : { required: false, newAccounts: false };
    const it = () => (clauses.length ? "it" : method);
    if (after.required !== from.required)
      clauses.push(
        after.required
          ? `required ${it()} for everyone but the owner`
          : `stopped requiring ${it()}`,
      );
    if (after.newAccounts !== from.newAccounts)
      clauses.push(
        after.newAccounts
          ? `let ${it()} make accounts for new people`
          : `stopped ${it()} from making accounts for new people`,
      );
  }
  if (!clauses.length) return null;
  const last = clauses.pop()!;
  return clauses.length ? `${clauses.join(", ")}, and ${last}` : last;
}

const domainsOf = (s: LinkSettings) => s.domains;

/** "a, b and c". */
function inWords(items: string[]): string {
  return items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** One of the routes every way of signing in has, at its own path. */
export type AccountRoute<S extends Omit<EndpointSpec, "path">> = Endpoint<S & { path: string }>;

export interface SignInFlow<Extra> {
  /** The extension's context, once registered. */
  context(): ExtensionContext | null;
  base(): string | undefined;
  providerName(): string;
  /** Whether it is set up, licensed and required now. */
  required(): boolean;
  /** People who can sign in now with the provider set up now. */
  linkedCount(): number;
  /**
   * Registers the routes every way of signing in has: the code redeemed, and
   * a signed-in person's link to the provider looked at, begun and ended.
   */
  register(
    context: ExtensionContext,
    routes: {
      redeem: AccountRoute<typeof extensionRoutes.redeemSignIn>;
      connection: AccountRoute<typeof extensionRoutes.signInConnection>;
      connect: AccountRoute<typeof extensionRoutes.connectSignIn>;
      disconnect: AccountRoute<typeof extensionRoutes.disconnectSignIn>;
    },
  ): void;
  /** What the start was asked for: a link ticket, or the client and its challenge. */
  begin(query: {
    link?: string | undefined;
    client?: string | undefined;
    challenge?: string | undefined;
  }): Begun | { refused: string };
  /** Keeps a sign-in going to the provider, bound to this browser by a cookie. Returns its state. */
  open(reply: Reply, begun: Begun, extra: Extra): string;
  /** The sign-in `state` names, once. */
  take(state: string | undefined): Flow<Extra> | undefined;
  /** Whether this request comes from the browser that began `flow`. */
  sameBrowser(flow: Flow<Extra>, req: Request): boolean;
  /** Ends the cookie a start set: the sign-in it was for is over, one way or another. */
  endCookie(reply: Reply): void;
  /**
   * Once the provider has said who this is: links the account, or finds the
   * one linked, or makes one, and sends the app its code.
   */
  finish<R extends Reply>(reply: R, flow: Flow<Extra>, claims: Claims): Promise<R>;
  /** The way back to the app, on a page that ends a sign-in. */
  back(): { href: string; label: string };
}

/**
 * The part of single sign-on every provider shares, for the way of signing in
 * `id` names: its routes are under /api/<id>/, its cookie is ownbase_<id>,
 * and its links are kept under <id>: keys.
 */
export function signInFlow<Extra extends object>(opts: {
  id: string;
  licensed: () => boolean;
  /**
   * The account provisioning (P10) made for a verified address, linked at
   * that person's first sign-in: the provider's own records say who they are.
   */
  provisioned?: ((email: string) => string | null) | undefined;
  now: () => number;
  settings: () => LinkSettings;
  configured: () => boolean;
}): SignInFlow<Extra> {
  const { id, now } = opts;
  const COOKIE = `ownbase_${id}`;
  let context: ExtensionContext | null = null;
  /** Sign-ins gone to the provider, by their state. In memory: a restart asks to start again. */
  const flows = new Map<string, Flow<Extra>>();
  /** Codes the way back brought, by their SHA-256. */
  const codes = new Map<string, { userId: string; challenge: string; expiresAt: number }>();
  /** Links to start linking an account, by their SHA-256. */
  const tickets = new Map<string, { userId: string; expiresAt: number }>();

  const store = () => context!.storage;
  const base = () => context?.publicUrl();
  const providerName = () => opts.settings().name || "single sign-on";
  const required = () => opts.configured() && opts.settings().required && opts.licensed();
  const back = () => ({ href: `${base()}/`, label: "Back to OwnBase" });

  const prune = <T extends { expiresAt: number }>(map: Map<string, T>) => {
    const at = now();
    for (const [key, value] of map) if (value.expiresAt <= at) map.delete(key);
    while (map.size >= WAITING_MAX) map.delete(map.keys().next().value!);
  };

  const cookie = (value: string, seconds: number) =>
    `${COOKIE}=${value}; Path=/api/${id}/; Max-Age=${seconds}; HttpOnly; SameSite=Lax${base()?.startsWith("https:") ? "; Secure" : ""}`;
  const readCookie = (req: Request): string | undefined =>
    req.headers.cookie
      ?.split(";")
      .map((pair) => pair.trim())
      .find((pair) => pair.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);

  const parse = <T>(raw: string | null): T | null => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };
  const identityKey = (issuer: string, subject: string) => s256(`${issuer}\n${subject}`);
  const identityOf = (issuer: string, subject: string) =>
    parse<Identity>(store().get(`${id}:identity:${identityKey(issuer, subject)}`));
  /** The provider's account linked to `userId`, for the issuer set up now. */
  const linkedTo = (userId: string): Identity | null => {
    const key = store().get(`${id}:user:${userId}`);
    const identity = key ? parse<Identity>(store().get(`${id}:identity:${key}`)) : null;
    return identity?.userId === userId && identity.issuer === opts.settings().issuer
      ? identity
      : null;
  };
  const link = (userId: string, claims: Claims) => {
    const key = identityKey(claims.iss, claims.sub);
    const before = store().get(`${id}:user:${userId}`);
    if (before && before !== key) store().delete(`${id}:identity:${before}`);
    const identity: Identity = {
      userId,
      issuer: claims.iss,
      subject: claims.sub,
      ...(typeof claims.email === "string" ? { email: claims.email.slice(0, 320) } : {}),
      linkedAt: now(),
    };
    store().set(`${id}:identity:${key}`, JSON.stringify(identity));
    store().set(`${id}:user:${userId}`, key);
  };
  const unlink = (userId: string) => {
    const key = store().get(`${id}:user:${userId}`);
    if (!key) return;
    if (parse<Identity>(store().get(`${id}:identity:${key}`))?.userId === userId)
      store().delete(`${id}:identity:${key}`);
    store().delete(`${id}:user:${userId}`);
  };
  const linkedCount = () => {
    const issuer = opts.settings().issuer;
    return store()
      .list(`${id}:identity:`)
      .filter(({ value }) => {
        const identity = parse<Identity>(value);
        const user = identity?.issuer === issuer ? context!.users.get(identity.userId) : null;
        return !!user && !user.deactivated;
      }).length;
  };

  const newAccountRefusal = (s: LinkSettings, claims: Claims): string | null => {
    const who = claims.email ?? claims.preferred_username ?? "you";
    if (!opts.licensed() || !s.newAccounts)
      return `No account in this workspace is linked to ${who} yet. Sign in with your password, then link ${providerName()} in Account settings, under Security.`;
    if (!s.domains.length) return null;
    if (typeof claims.email !== "string" || claims.email_verified !== true)
      return `${providerName()} has not verified ${who}, so no account is made for it here. Ask the workspace's owner.`;
    const domain = claims.email.split("@").pop()!.toLowerCase();
    return s.domains.includes(domain)
      ? null
      : `New accounts here are for ${s.domains.map((d) => `@${d}`).join(", ")} addresses, not ${claims.email}.`;
  };

  async function finish<R extends Reply>(reply: R, flow: Flow<Extra>, claims: Claims): Promise<R> {
    const given = context!;
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
        `@${me.handle} signs in with ${providerName()} as ${who} from now on. You can close this tab.`,
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
    if (
      !user &&
      opts.licensed() &&
      claims.email_verified === true &&
      typeof claims.email === "string"
    ) {
      const madeId = opts.provisioned?.(claims.email);
      const made = madeId ? given.users.get(madeId) : null;
      // Linked once: another account of the provider's cannot take it over.
      if (made && !store().get(`${id}:user:${made.id}`)) {
        if (made.deactivated)
          return page(
            reply,
            403,
            "Not signed in",
            "This account has been deactivated. Ask an admin of the workspace.",
            back(),
          );
        link(made.id, claims);
        user = made;
      }
    }
    if (!user) {
      const refusal = newAccountRefusal(opts.settings(), claims);
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
  }

  return {
    context: () => context,
    base,
    providerName,
    required,
    linkedCount,
    back,
    finish,

    begin(q) {
      if (q.link !== undefined) {
        const key = s256(q.link);
        const ticket = tickets.get(key);
        tickets.delete(key);
        if (!ticket || ticket.expiresAt <= now())
          return {
            refused: "This link has expired. Go back to Account settings and press Link again.",
          };
        return { linkUserId: ticket.userId };
      }
      if (
        (q.client !== "web" && q.client !== "desktop") ||
        !/^[A-Za-z0-9_-]{43}$/.test(q.challenge ?? "")
      )
        return { refused: "Start signing in from the OwnBase sign-in screen." };
      return { client: q.client, challenge: q.challenge! };
    },

    open(reply, begun, extra) {
      prune(flows);
      const state = randomToken();
      const browser = randomToken();
      flows.set(state, { ...begun, ...extra, browser: s256(browser), expiresAt: now() + FLOW_MS });
      reply.header("set-cookie", cookie(browser, FLOW_MS / 1000));
      return state;
    },

    take(state) {
      const flow = state ? flows.get(state) : undefined;
      if (state) flows.delete(state);
      return flow && flow.expiresAt > now() ? flow : undefined;
    },

    sameBrowser: (flow, req) => s256(readCookie(req) ?? "") === flow.browser,

    endCookie(reply) {
      reply.header("set-cookie", cookie("", 0));
    },

    register(given, routes) {
      context = given;
      const { route } = given;

      route(routes.redeem, async ({ req, body }) => {
        const key = s256(body.code);
        const held = codes.get(key);
        codes.delete(key);
        if (!held || held.expiresAt <= now() || s256(body.verifier) !== held.challenge)
          throw new HttpError(
            401,
            "sso_code_invalid",
            "That sign-in has expired, or was started somewhere else. Start again.",
          );
        return given.startSession(held.userId, req);
      });

      route(routes.connection, async ({ reply, user: me }) => {
        reply.header("cache-control", "no-store");
        const identity = linkedTo(me.id);
        return identity
          ? { connected: true, ...(identity.email ? { as: identity.email } : {}) }
          : { connected: false };
      });

      route(routes.connect, async ({ user: me }) => {
        if (me.role === "guest")
          throw new HttpError(403, "guest_not_allowed", "Guests sign in with their name alone.");
        if (!opts.configured() || !base())
          throw new HttpError(409, "sso_off", "This workspace does not use single sign-on.");
        if (!opts.licensed())
          throw new HttpError(
            403,
            "license_required",
            "Linking needs an Enterprise license with single sign-on.",
          );
        prune(tickets);
        const ticket = randomToken();
        tickets.set(s256(ticket), { userId: me.id, expiresAt: now() + CODE_MS });
        return { url: `/api/${id}/start?link=${ticket}` };
      });

      route(routes.disconnect, async ({ user: me }) => {
        // Without it they could not sign in again.
        if (me.role !== "owner" && required())
          throw new HttpError(
            409,
            "sso_required",
            "This workspace requires single sign-on, so your account stays linked.",
          );
        unlink(me.id);
        return { connected: false };
      });
    },
  };
}
