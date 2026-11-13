import { timingSafeEqual } from "node:crypto";
import type { SettingsAction, SettingsPanel, User } from "@ownbase/protocol";
import type { ExtensionContext } from "@ownbase/server/extensions";
import { HttpError } from "@ownbase/server/httpError";
import { eeEndpoints } from "./endpoints.js";
import { randomToken, s256 } from "./oidc.js";
import {
  applyPatch,
  attribute,
  CORE_USER,
  ENTERPRISE_USER,
  LIST_SCHEMA,
  matches,
  parseFilter,
  ScimError,
  type Attributes,
} from "./scimResource.js";
import { handleFrom } from "./sso.js";

/**
 * Provisioning with SCIM 2.0 (P10), part of the Enterprise edition. The
 * company's identity provider, such as Okta or Microsoft Entra ID, adds
 * people here, keeps their names current and deactivates them when they
 * leave, at `/scim/v2/Users`, with a token the owner makes in Workspace
 * settings.
 *
 * What the provider sends about a person is kept as it sent it, since it
 * reads it back to compare; the account here takes its name and whether it
 * is active from it. Nobody is ever deleted: a DELETE deactivates, and the
 * person's messages stay. Apps and guests are not people a provider manages,
 * and the owner is never deactivated, being the way back in.
 *
 * Groups are not offered. Mapping them to channels needs the core to make
 * channels and change their members for an extension, and Okta and Entra
 * both work with users alone.
 *
 * With a license that has `scim`, the owner can make a token and the
 * provider can add people. When the license ends, people it added stay, and
 * it can still change and deactivate them; it adds nobody new.
 */

/** As the audit log names the changes provisioning makes. */
export const PROVISIONING = "SCIM provisioning";
/** The most people one page of a list holds. */
export const PAGE_MAX = 200;
/** How often "last used" is written down, at most. */
const USED_EVERY_MS = 60 * 60 * 1000;
const SCIM_JSON = "application/scim+json; charset=utf-8";
const TOKEN_PREFIX = "ownbase-scim-";

/** What the provider said about a person, and when. */
interface Stored {
  attributes: Attributes;
  created: number;
  lastModified: number;
  /** DELETEd: deactivated, and gone as far as the provider can see, until it adds them again. */
  deleted?: true;
}

export interface Provisioning {
  register(context: ExtensionContext): void;
  settingsPanels(): SettingsPanel[];
  /**
   * The person the provider added with this address, as their userName or
   * one of their emails, for single sign-on to link at their first sign-in.
   */
  accountFor(email: string): string | null;
}

type Request = Parameters<ExtensionContext["startSession"]>[1];
interface Reply {
  code(status: number): Reply;
  header(name: string, value: string): Reply;
  send(payload?: unknown): Reply;
}

/** What the provider sends that is not the person's: kept apart from what is stored. */
const NOT_STORED = new Set(["schemas", "id", "meta", "password", "active", "groups"]);

const isObject = (value: unknown): value is Attributes =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const iso = (at: number) => new Date(at).toISOString();

/** "13 November 2026", the same wherever the server runs. */
const day = (at: number) =>
  new Date(at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** The text of a string attribute, or "" for anything else. */
const textOf = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** The name a person goes by here, from what the provider says. */
export function displayNameFrom(attributes: Attributes): string {
  const name = attribute(attributes, "name");
  const parts = isObject(name)
    ? [textOf(attribute(name, "givenName")), textOf(attribute(name, "familyName"))]
    : [];
  const candidates = [
    textOf(attribute(attributes, "displayName")),
    isObject(name) ? textOf(attribute(name, "formatted")) : "",
    parts.filter(Boolean).join(" "),
    textOf(attribute(attributes, "userName")).split("@")[0]!,
  ];
  return (candidates.find(Boolean) ?? "").slice(0, 80).trim();
}

/** Every address the provider gave a person: their userName when it is one, and their emails. */
function addresses(attributes: Attributes): string[] {
  const emails = attribute(attributes, "emails");
  const found = [
    textOf(attribute(attributes, "userName")),
    ...(Array.isArray(emails)
      ? emails.map((e) => (isObject(e) ? textOf(attribute(e, "value")) : ""))
      : []),
  ];
  return found.filter((a) => a.includes("@")).map((a) => a.toLowerCase());
}

export function provisioning(opts: { licensed: () => boolean; now?: () => number }): Provisioning {
  const now = opts.now ?? Date.now;
  let context: ExtensionContext | null = null;
  let usedAt: number | null = null;

  const store = () => context!.storage;
  const parse = <T>(raw: string | null): T | null => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };
  const token = () => parse<{ hash: string; madeAt: number }>(store().get("scim:token"));
  const lastUsed = () => usedAt ?? parse<number>(store().get("scim:used"));
  const storedOf = (userId: string) => parse<Stored>(store().get(`scim:user:${userId}`));
  const nameKey = (userName: string) => `scim:name:${userName.toLowerCase()}`;
  const base = () => `${context?.publicUrl() ?? ""}/scim/v2`;

  /** A person the provider may see: not an app, not a guest, not one it deleted. */
  const visible = (user: User | null, stored = user ? storedOf(user.id) : null): user is User =>
    !!user && !user.isBot && user.role !== "guest" && !stored?.deleted;

  /** The person as SCIM shows them. */
  const resource = (user: User, stored = storedOf(user.id)): Attributes => {
    const attributes = stored?.attributes ?? {
      userName: user.handle,
      displayName: user.displayName,
    };
    return {
      schemas: [CORE_USER, ...(attribute(attributes, ENTERPRISE_USER) ? [ENTERPRISE_USER] : [])],
      id: user.id,
      ...attributes,
      active: !user.deactivated,
      meta: {
        resourceType: "User",
        created: iso(stored?.created ?? user.createdAt),
        lastModified: iso(stored?.lastModified ?? user.createdAt),
        location: `${base()}/Users/${user.id}`,
      },
    };
  };

  /** Who has `userName` now: someone the provider named so, or, never named by it, the username. */
  const holderOf = (userName: string): User | null => {
    const id = store().get(nameKey(userName));
    const named = id ? context!.users.get(id) : null;
    if (named && visible(named)) return named;
    const byHandle = context!.users.byHandle(userName);
    return byHandle && visible(byHandle) && !storedOf(byHandle.id) ? byHandle : null;
  };

  const userOrMissing = (id: string): User => {
    const user = context!.users.get(id);
    if (!visible(user)) throw new ScimError(404, `No person here has the id ${id}.`);
    return user;
  };

  /**
   * Keeps what the provider says about `user`, and changes their name and
   * whether they are active to match.
   */
  const keep = (user: User, given: Attributes, before: Stored | null): User => {
    const userName = textOf(attribute(given, "userName"));
    if (!userName) throw new ScimError(400, "Every person needs a userName.", "invalidValue");
    const active = attribute(given, "active");
    if (active !== undefined && typeof active !== "boolean")
      throw new ScimError(400, "active is true or false.", "invalidValue");
    const holder = holderOf(userName);
    if (holder && holder.id !== user.id)
      throw new ScimError(409, `Someone here has the userName ${userName} already.`, "uniqueness");

    const attributes = Object.fromEntries(
      Object.entries(given).filter(([key]) => !NOT_STORED.has(key.toLowerCase())),
    );
    const displayName = displayNameFrom(attributes) || user.handle;
    const patch: { displayName?: string; deactivated?: boolean } = {};
    if (displayName !== user.displayName) patch.displayName = displayName;
    if (typeof active === "boolean" && active === user.deactivated) patch.deactivated = !active;
    let updated = user;
    if (Object.keys(patch).length) {
      try {
        updated = context!.users.update(user.id, patch, PROVISIONING);
      } catch (error) {
        if (error instanceof HttpError)
          throw new ScimError(error.statusCode, error.message, "mutability");
        throw error;
      }
    }
    const previous = textOf(before?.attributes && attribute(before.attributes, "userName"));
    if (previous && previous.toLowerCase() !== userName.toLowerCase())
      store().delete(nameKey(previous));
    const stored: Stored = { attributes, created: before?.created ?? now(), lastModified: now() };
    store().set(`scim:user:${user.id}`, JSON.stringify(stored));
    store().set(nameKey(userName), user.id);
    return updated;
  };

  /** Everyone the provider may see, in the order they joined. */
  const everyone = () =>
    context!.users
      .list()
      .filter((user) => visible(user))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));

  const counted = () =>
    store()
      .list("scim:user:")
      .filter(({ value }) => !parse<Stored>(value)?.deleted).length;

  /** Whether the request carries the token made in Workspace settings. */
  const authorized = (req: Request) => {
    const made = token();
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!made || !match) return false;
    const given = Buffer.from(s256(match[1]!));
    const held = Buffer.from(made.hash);
    if (given.length !== held.length || !timingSafeEqual(given, held)) return false;
    const at = now();
    if (!usedAt || at - usedAt > USED_EVERY_MS) store().set("scim:used", JSON.stringify(at));
    usedAt = at;
    return true;
  };

  function register(given: ExtensionContext) {
    context = given;
    const { route } = given;

    /** A SCIM route: the token checked, the answer and any refusal in SCIM's JSON. */
    const scim = <E extends Parameters<typeof route>[0]>(
      endpoint: E,
      work: (
        req: Request,
        params: Record<string, string>,
      ) => Promise<{
        status?: number;
        body?: unknown;
      }>,
    ) =>
      route(endpoint, (async ({
        req,
        reply,
        params,
      }: {
        req: Request;
        reply: Reply;
        params: unknown;
      }) => {
        const send = (status: number, body?: unknown) =>
          body === undefined
            ? reply.code(status).header("cache-control", "no-store").send()
            : reply
                .code(status)
                .header("content-type", SCIM_JSON)
                .header("cache-control", "no-store")
                .send(JSON.stringify(body));
        if (!authorized(req)) {
          reply.header("www-authenticate", 'Bearer realm="OwnBase SCIM"');
          return send(
            401,
            new ScimError(401, "This needs the SCIM token made in Workspace settings.").body(),
          );
        }
        try {
          const answer = await work(req, params as Record<string, string>);
          return send(answer.status ?? 200, answer.body);
        } catch (error) {
          if (error instanceof ScimError) return send(error.status, error.body());
          given.log.error(error, "SCIM request failed");
          return send(500, new ScimError(500, "Something went wrong here. Try again.").body());
        }
      }) as never);

    const bodyOf = (req: Request): Attributes => {
      const body = (req as unknown as { body?: unknown }).body;
      if (!isObject(body))
        throw new ScimError(400, "Send the person as a JSON object.", "invalidSyntax");
      return body;
    };

    scim(eeEndpoints.scimServiceProviderConfig, async () => ({
      body: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
        documentationUri: "https://github.com/Blazeiscoding/OwnBase/blob/main/docs/DEPLOYMENT.md",
        patch: { supported: true },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults: PAGE_MAX },
        changePassword: { supported: false },
        sort: { supported: false },
        etag: { supported: false },
        authenticationSchemes: [
          {
            type: "oauthbearertoken",
            name: "Bearer token",
            description: "The token made in Workspace settings, under Sign-in.",
            primary: true,
          },
        ],
        meta: {
          resourceType: "ServiceProviderConfig",
          location: `${base()}/ServiceProviderConfig`,
        },
      },
    }));

    scim(eeEndpoints.scimResourceTypes, async () => ({
      body: {
        schemas: [LIST_SCHEMA],
        totalResults: 1,
        itemsPerPage: 1,
        startIndex: 1,
        Resources: [USER_TYPE(base())],
      },
    }));

    scim(eeEndpoints.scimSchemas, async () => ({
      body: {
        schemas: [LIST_SCHEMA],
        totalResults: SCHEMAS.length,
        itemsPerPage: SCHEMAS.length,
        startIndex: 1,
        Resources: SCHEMAS.map((schema) => ({
          ...schema,
          meta: { resourceType: "Schema", location: `${base()}/Schemas/${schema.id}` },
        })),
      },
    }));

    scim(eeEndpoints.scimListUsers, async (req) => {
      const query = (req as unknown as { query: Record<string, unknown> }).query ?? {};
      const number = (value: unknown, fallback: number) => {
        const n = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : fallback;
        return n;
      };
      const startIndex = Math.max(1, number(query.startIndex, 1));
      const count = Math.min(PAGE_MAX, Math.max(0, number(query.count, 100)));
      const filter =
        typeof query.filter === "string" && query.filter.trim() ? parseFilter(query.filter) : null;
      const all = everyone()
        .map((user) => resource(user))
        .filter((r) => !filter || matches(r, filter));
      const page = all.slice(startIndex - 1, startIndex - 1 + count);
      return {
        body: {
          schemas: [LIST_SCHEMA],
          totalResults: all.length,
          itemsPerPage: page.length,
          startIndex,
          Resources: page,
        },
      };
    });

    scim(eeEndpoints.scimGetUser, async (_req, { id }) => ({ body: resource(userOrMissing(id!)) }));

    scim(eeEndpoints.scimCreateUser, async (req) => {
      const sent = bodyOf(req);
      if (!opts.licensed())
        throw new ScimError(403, "Adding people needs an Enterprise license with SCIM.");
      const userName = textOf(attribute(sent, "userName"));
      if (!userName) throw new ScimError(400, "Every person needs a userName.", "invalidValue");
      if (holderOf(userName))
        throw new ScimError(
          409,
          `Someone here has the userName ${userName} already.`,
          "uniqueness",
        );
      // Someone the provider deleted and adds again is the same person, with their messages.
      const returning = store()
        .list("scim:user:")
        .map(({ key, value }) => ({
          id: key.slice("scim:user:".length),
          stored: parse<Stored>(value),
        }))
        .find(
          ({ id, stored }) =>
            stored?.deleted &&
            textOf(attribute(stored.attributes, "userName")).toLowerCase() ===
              userName.toLowerCase() &&
            !!context!.users.get(id),
        );
      let user: User;
      let before: Stored | null = null;
      if (returning) {
        user = context!.users.get(returning.id)!;
        before = returning.stored;
      } else {
        const handle = handleFrom(
          userName.split("@")[0] || displayNameFrom(sent),
          (h) => !!context!.users.byHandle(h),
        );
        try {
          user = await context!.users.create({
            handle,
            displayName: displayNameFrom(sent) || handle,
          });
        } catch (error) {
          if (error instanceof HttpError)
            throw new ScimError(
              error.statusCode === 409 ? 409 : 400,
              error.message,
              "invalidValue",
            );
          throw error;
        }
      }
      // Added, or added again, is active unless the provider says otherwise.
      const active = attribute(sent, "active");
      const made = keep(user, { ...sent, active: active ?? true }, before);
      return { status: 201, body: resource(made) };
    });

    scim(eeEndpoints.scimReplaceUser, async (req, { id }) => {
      const user = userOrMissing(id!);
      const before = storedOf(user.id);
      return { body: resource(keep(user, bodyOf(req), before)) };
    });

    scim(eeEndpoints.scimPatchUser, async (req, { id }) => {
      const user = userOrMissing(id!);
      const before = storedOf(user.id);
      const current = resource(user, before);
      const next = applyPatch(current, bodyOf(req));
      return { body: resource(keep(user, next, before)) };
    });

    scim(eeEndpoints.scimDeleteUser, async (_req, { id }) => {
      const user = userOrMissing(id!);
      const before = storedOf(user.id);
      const attributes = before?.attributes ?? {
        userName: user.handle,
        displayName: user.displayName,
      };
      if (!user.deactivated) {
        try {
          context!.users.update(user.id, { deactivated: true }, PROVISIONING);
        } catch (error) {
          if (error instanceof HttpError)
            throw new ScimError(error.statusCode, error.message, "mutability");
          throw error;
        }
      }
      const userName = textOf(attribute(attributes, "userName"));
      if (userName && store().get(nameKey(userName)) === user.id) store().delete(nameKey(userName));
      const stored: Stored = {
        attributes,
        created: before?.created ?? user.createdAt,
        lastModified: now(),
        deleted: true,
      };
      store().set(`scim:user:${user.id}`, JSON.stringify(stored));
      return { status: 204 };
    });

    // Groups are not offered: an empty list says so to a provider that asks.
    scim(eeEndpoints.scimListGroups, async () => ({
      body: {
        schemas: [LIST_SCHEMA],
        totalResults: 0,
        itemsPerPage: 0,
        startIndex: 1,
        Resources: [],
      },
    }));

    for (const endpoint of eeEndpoints.scimElsewhere)
      scim(endpoint, async () => {
        throw new ScimError(404, "This server offers Users alone, at /scim/v2/Users.");
      });

    route(eeEndpoints.scimMakeToken, async () => {
      if (!opts.licensed())
        throw new HttpError(
          403,
          "license_required",
          "Provisioning needs an Enterprise license with SCIM.",
        );
      const value = TOKEN_PREFIX + randomToken();
      store().set("scim:token", JSON.stringify({ hash: s256(value), madeAt: now() }));
      store().delete("scim:used");
      usedAt = null;
      return {
        reveal: {
          label: "SCIM token",
          value,
          note: "Copy it into your identity provider now. It is shown only this once, and making another replaces it.",
        },
      };
    });

    route(eeEndpoints.scimTurnOff, async () => {
      store().delete("scim:token");
      store().delete("scim:used");
      usedAt = null;
      return {};
    });
  }

  function settingsPanels(): SettingsPanel[] {
    if (!context) return [];
    const made = token();
    // The free edition shows nothing, unless provisioning was set up already:
    // its owner still sees it, and can turn it off.
    if (!opts.licensed() && !made) return [];
    const used = lastUsed();
    const people = counted();
    const actions: SettingsAction[] = [];
    if (opts.licensed())
      actions.push(
        made
          ? {
              id: "token",
              label: "Make a new token",
              path: eeEndpoints.scimMakeToken.path,
              confirm: {
                title: "Make a new token?",
                text: "The token your identity provider has now stops working at once.",
                action: "Make a new token",
              },
            }
          : { id: "token", label: "Make a token", path: eeEndpoints.scimMakeToken.path },
      );
    if (made)
      actions.push({
        id: "off",
        label: "Turn off",
        path: eeEndpoints.scimTurnOff.path,
        confirm: {
          title: "Turn off provisioning?",
          text: "Your identity provider can no longer add, change or deactivate anyone here. People it added stay.",
          action: "Turn off",
        },
      });
    const address = context.publicUrl()
      ? base()
      : "this server's public address followed by /scim/v2";
    return [
      {
        id: "scim",
        title: "Provisioning with SCIM",
        description: `Your identity provider, such as Okta or Microsoft Entra ID, can add people here, keep their names current and deactivate them when they leave. In its SCIM settings, give it the address ${address}, and a token made here as the bearer token.`,
        fields: [],
        ...(!opts.licensed()
          ? {
              problem:
                "Provisioning needs an Enterprise license with SCIM. People it added stay, and it can still change and deactivate them, but it adds nobody new.",
            }
          : {}),
        ...(made
          ? {
              status: `Token made on ${day(made.madeAt)}, ${used ? `last used on ${day(used)}` : "not used yet"}. ${people} ${people === 1 ? "person" : "people"} added by your identity provider.`,
            }
          : {}),
        actions,
      },
    ];
  }

  return {
    register,
    settingsPanels,
    accountFor(email) {
      if (!context) return null;
      const wanted = email.toLowerCase();
      for (const { key, value } of store().list("scim:user:")) {
        const stored = parse<Stored>(value);
        if (!stored || stored.deleted) continue;
        if (addresses(stored.attributes).includes(wanted)) return key.slice("scim:user:".length);
      }
      return null;
    },
  };
}

/** The one kind of resource offered (RFC 7643 6). */
const USER_TYPE = (base: string) => ({
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
  id: "User",
  name: "User",
  endpoint: "/Users",
  description: "A person in the workspace",
  schema: CORE_USER,
  schemaExtensions: [{ schema: ENTERPRISE_USER, required: false }],
  meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/User` },
});

const text = (name: string, description: string, extra: Attributes = {}) => ({
  name,
  type: "string",
  multiValued: false,
  description,
  required: false,
  caseExact: false,
  mutability: "readWrite",
  returned: "default",
  uniqueness: "none",
  ...extra,
});

/** What this server reads of a person (RFC 7643 7). Anything else sent is kept and given back. */
const SCHEMAS = [
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
    id: CORE_USER,
    name: "User",
    description: "A person in the workspace",
    attributes: [
      text("userName", "Unique within the workspace. Its first part becomes the username here.", {
        required: true,
        uniqueness: "server",
      }),
      text("displayName", "The name people see here."),
      {
        name: "name",
        type: "complex",
        multiValued: false,
        description: "Used for the name people see when there is no displayName.",
        required: false,
        mutability: "readWrite",
        returned: "default",
        subAttributes: [
          text("formatted", "The whole name"),
          text("givenName", "First name"),
          text("familyName", "Last name"),
        ],
      },
      {
        name: "emails",
        type: "complex",
        multiValued: true,
        description:
          "Single sign-on links a person's first sign-in by a verified address in these.",
        required: false,
        mutability: "readWrite",
        returned: "default",
        subAttributes: [
          text("value", "The address"),
          text("type", "work, home or other"),
          { ...text("primary", "The main address"), type: "boolean" },
        ],
      },
      {
        name: "active",
        type: "boolean",
        multiValued: false,
        description: "false deactivates the person here and ends their sessions.",
        required: false,
        mutability: "readWrite",
        returned: "default",
      },
      text("externalId", "The provider's own id for the person.", { caseExact: true }),
    ],
  },
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
    id: ENTERPRISE_USER,
    name: "EnterpriseUser",
    description: "Kept as sent and given back; not shown here.",
    attributes: [
      text("employeeNumber", "Kept as sent."),
      text("department", "Kept as sent."),
      text("organization", "Kept as sent."),
    ],
  },
];
