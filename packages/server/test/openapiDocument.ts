import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import * as protocol from "@ownbase/protocol";
import { GUEST_ROUTES } from "../src/server.js";

/**
 * The OpenAPI description of the native REST API (E18), built from what the
 * server already says about each route: the route itself in server.ts, the
 * zod schema its handler parses the body or query with, which of the access
 * checks it calls, and the comment above it. Nothing is written twice, so it
 * cannot drift from the code without the check in openapi.test.ts noticing.
 *
 * Answers are described in words only: the server has no schemas for them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../src/server.ts"), "utf8").replace(/\r\n/g, "\n");

type Method = "get" | "post" | "put" | "patch" | "delete";
type Access = "anyone" | "bot" | "member" | "admin" | "owner";

/** One route as server.ts declares it. */
export interface SourceRoute {
  method: Method;
  /** Fastify's form, `/api/channels/:id`. */
  path: string;
  body: string | null;
  /** The body may be left out. */
  bodyOptional: boolean;
  /** The body is a file itself, typed by its Content-Type, not JSON. */
  bytes: boolean;
  query: string | null;
  access: Access;
  comment: string;
}

/** A route on the server, or on a scope of it such as the one that reads bodies as bytes. */
const ROUTE = /^ +(?:app|scope)\.(get|post|put|patch|delete)(?:<[^\n]*?>)?\(\s*"(\/api\/[^"]+)"/gm;

/** The doc comment, or the run of line comments, directly above a route. */
function commentAbove(start: number): string {
  const before = source.slice(0, start).trimEnd();
  if (before.endsWith("*/")) {
    const open = before.lastIndexOf("/**");
    return before
      .slice(open + 3, -2)
      .split("\n")
      .map((line) => line.replace(/^\s*\* ?/, "").trimEnd())
      .join("\n")
      .trim();
  }
  const lines: string[] = [];
  for (const line of before.split("\n").reverse()) {
    const comment = /^\s*\/\/ ?(.*)$/.exec(line);
    // A section heading such as "// ---------- apps ----------" names no route.
    if (!comment || comment[1]!.startsWith("---")) break;
    lines.unshift(comment[1]!);
  }
  return lines.join("\n").trim();
}

const RANK: Access[] = ["anyone", "bot", "member", "admin", "owner"];

/** The strictest check some code makes of who is calling, through any helper that makes one. */
function accessOf(code: string, helpers: Map<string, Access>): Access {
  let strictest: Access = "anyone";
  const raise = (access: Access) => {
    if (RANK.indexOf(access) > RANK.indexOf(strictest)) strictest = access;
  };
  // A lone `if (me.role !== "owner") throw`, not one alternative in an admin check.
  if (/\brequireOwner\(req\b/.test(code) || /\(\w+\.role !== "owner"\) throw/.test(code)) {
    raise("owner");
  }
  if (/\brequireAdmin\(req\b/.test(code)) raise("admin");
  if (/\brequireUser\(req\b/.test(code)) raise("member");
  if (/\bslackCaller\(req\b/.test(code)) raise("bot");
  for (const [name, access] of helpers) {
    if (new RegExp(`\\b${name}\\(req\\b`).test(code)) raise(access);
  }
  return strictest;
}

/**
 * Helpers that take the request and check who is calling, such as the one
 * every reset of another account goes through, by the check each makes.
 */
function accessHelpers(): Map<string, Access> {
  const helpers = new Map<string, Access>();
  const defined = [...source.matchAll(/^ {2}const (\w+) = (?:async )?\(\s*req\b/gm)].map(
    (match) => {
      const end = source.indexOf("\n  };", match.index);
      return { name: match[1]!, code: source.slice(match.index, end < 0 ? undefined : end) };
    },
  );
  // Twice, for a helper that calls another.
  for (let pass = 0; pass < 2; pass++) {
    for (const { name, code } of defined) {
      const access = accessOf(code.slice(code.indexOf("=>")), helpers);
      if (access !== "anyone") helpers.set(name, access);
    }
  }
  return helpers;
}

/** Every route in server.ts, in the order it is declared. */
export function sourceRoutes(): SourceRoute[] {
  const helpers = accessHelpers();
  const found = [...source.matchAll(ROUTE)];
  return found.map((match, i) => {
    const handler = source.slice(match.index, found[i + 1]?.index ?? source.length);
    const parsed = (from: "body" | "query") =>
      new RegExp(`\\b(\\w+)\\.parse\\(req\\.${from}\\b`).exec(handler)?.[1] ?? null;
    return {
      method: match[1] as Method,
      path: match[2]!,
      body: parsed("body"),
      // `req.body ?? {}`: a route that takes an empty body as well.
      bodyOptional: /\.parse\(req\.body \?\?/.test(handler),
      bytes: /\bBuffer\.isBuffer\(req\.body\)/.test(handler),
      query: parsed("query"),
      access: accessOf(handler, helpers),
      comment: commentAbove(match.index),
    };
  });
}

/** `CreateChannelBody` for `createChannelBody`, as a component's name. */
const componentName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** A protocol schema by the name the server imports it as. */
function schemaNamed(name: string): z.ZodType {
  const schema = (protocol as unknown as Record<string, unknown>)[name];
  if (!(schema instanceof z.ZodType)) {
    throw new Error(`server.ts parses with ${name}, which @ownbase/protocol does not export`);
  }
  return schema;
}

/** What the server accepts, as OpenAPI 3.0 reads it. */
const jsonSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { target: "openapi-3.0", io: "input", unrepresentable: "any" }) as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    $schema?: string;
  };

/** Comment text as paragraphs: lines in a paragraph run together. */
function prose(comment: string): string {
  return comment
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

/** The first sentence, which a reader of a list of routes sees. */
function summaryOf(description: string): string | undefined {
  const first = description.split("\n\n")[0];
  if (!first) return undefined;
  const sentence = /^.+?[.!?](?=\s|$)/.exec(first)?.[0] ?? first;
  return sentence.length <= 160 ? sentence : `${sentence.slice(0, 157).trimEnd()}…`;
}

const ACCESS_WORDS: Record<Access, string> = {
  anyone: "Anyone may call this, signed in or not.",
  bot: "Called with an app's bot token, as Slack's Web API is. A failure is HTTP 200 with `ok: false`.",
  member: "Needs a signed-in account.",
  admin: "Needs an administrator or the owner.",
  owner: "Needs the workspace owner.",
};

/** Which part of the API a route belongs to, for grouping. */
function tagOf(path: string): string {
  const first = path.split("/")[2]!;
  return first.includes(".") ? "slack" : first;
}

/**
 * What each group is for. A route under a new first segment needs a line
 * here, which openapi.test.ts asks for by name.
 */
export const TAG_WORDS: Record<string, string> = {
  activity: "Mentions, replies and reactions addressed to the signed-in account.",
  admin: "Running the workspace: members, audit history, reports, copies and status.",
  apps: "Apps and integrations: bot users, tokens, scopes, webhooks, commands, events.",
  auth: "Accounts, signing in and out, guests and sessions.",
  channels: "Conversations, their members, messages, threads and read state.",
  commands: "Slash commands, and the URL an app answers one through later.",
  files: "Uploads, downloads and the files shared in conversations.",
  friends: "Friend requests between members.",
  health: "Whether the server is up.",
  invites: "Invite codes.",
  "link-previews": "What the server found at links in messages.",
  me: "The signed-in account: profile, picture, two-step sign-in, blocks.",
  messages: "One message: edits, reactions, pins, saves, polls, reminders, reports, buttons.",
  reminders: "The signed-in account's reminders.",
  "rtc-config": "What calls connect through: ICE and TURN servers.",
  saved: "Messages the signed-in account saved.",
  scheduled: "Messages waiting to be sent later.",
  search: "Searching messages.",
  "server-info": "What this server is and supports, before signing in.",
  "sidebar-sections": "The signed-in account's own sidebar sections.",
  slack: "Slack's Web API methods, for apps: see docs/INTEGRATIONS.md.",
  storage: "How much room uploads have left.",
  subscriptions: "An app's event subscriptions and their deliveries.",
  threads: "Threads the signed-in account follows.",
  users: "Everyone in the workspace, and their pictures.",
  views: "Forms apps open: submitting and closing them.",
  webhooks: "Incoming webhook URLs.",
  workspace: "The workspace's own name and icon.",
};

/**
 * A name for the operation, which generated clients use as a function's.
 * Slack's methods keep theirs; the rest read their path, a parameter as
 * `By` and its name: `getChannelsByIdMessages`.
 */
function operationIdOf(method: Method, path: string): string {
  const name = path.slice("/api/".length);
  if (name.split("/")[0]!.includes(".")) return name;
  const words = name
    .split("/")
    .flatMap((segment) =>
      segment.startsWith(":") ? ["by", segment.slice(1)] : segment.split(/[-.]/),
    );
  return method + words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
}

export function openApiDocument() {
  const routes = sourceRoutes();
  const schemas: Record<string, unknown> = {
    Error: {
      type: "object",
      description:
        "Why a native route refused, with an HTTP status of 400 or more. `error` is a stable code; `message`, when present, is a sentence for people.",
      properties: {
        error: { type: "string" },
        message: { type: "string" },
        details: { description: "For `invalid_request`: what failed to validate." },
      },
      required: ["error"],
    },
    SlackAnswer: {
      type: "object",
      description:
        "Slack's answer shape. A refusal still has HTTP status 200, with `ok: false` and an `error` code.",
      properties: { ok: { type: "boolean" }, error: { type: "string" } },
      required: ["ok"],
      additionalProperties: true,
    },
  };
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const path = route.path.replace(/:(\w+)/g, "{$1}");
    const description = prose(route.comment);
    const guests = GUEST_ROUTES.has(`${route.method.toUpperCase()} ${route.path}`);
    const parameters: unknown[] = [...route.path.matchAll(/:(\w+)/g)].map(([, name]) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    }));

    if (route.query) {
      const query = jsonSchema(schemaNamed(route.query));
      for (const [name, schema] of Object.entries(query.properties ?? {})) {
        parameters.push({
          name,
          in: "query",
          required: query.required?.includes(name) ?? false,
          schema,
        });
      }
    }

    let requestBody: unknown;
    if (route.body) {
      const name = componentName(route.body);
      if (!schemas[name]) {
        const { $schema: _, ...schema } = jsonSchema(schemaNamed(route.body));
        schemas[name] = schema;
      }
      requestBody = {
        required: !route.bodyOptional,
        content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } },
      };
    } else if (route.bytes) {
      requestBody = {
        required: true,
        description: "The image itself, typed by its Content-Type.",
        content: { "image/*": { schema: { type: "string", format: "binary" } } },
      };
    } else if (route.access === "bot" && route.method === "post") {
      // Slack's methods read their arguments by hand, as JSON or a form.
      requestBody = {
        required: false,
        description: "Slack's arguments for this method, as listed in docs/INTEGRATIONS.md.",
        content: {
          "application/json": { schema: { type: "object", additionalProperties: true } },
          "application/x-www-form-urlencoded": {
            schema: { type: "object", additionalProperties: true },
          },
        },
      };
    }

    const notes = [ACCESS_WORDS[route.access], guests ? "Guests may call it too." : ""]
      .filter(Boolean)
      .join(" ");
    paths[path] ??= {};
    paths[path][route.method] = {
      operationId: operationIdOf(route.method, route.path),
      tags: [tagOf(route.path)],
      ...(summaryOf(description) ? { summary: summaryOf(description) } : {}),
      description: description ? `${description}\n\n${notes}` : notes,
      "x-access": route.access,
      ...(guests ? { "x-guests": true } : {}),
      security:
        route.access === "anyone"
          ? []
          : [route.access === "bot" ? { botToken: [] } : { session: [] }],
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses:
        route.access === "bot"
          ? {
              "200": {
                description: "Slack's answer, refusals included.",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/SlackAnswer" } },
                },
              },
              "429": { $ref: "#/components/responses/RateLimited" },
            }
          : {
              "200": { description: "Done." },
              default: { $ref: "#/components/responses/Error" },
            },
    };
  }

  const tags = [...new Set(routes.map((route) => tagOf(route.path)))]
    .sort()
    .map((name) => ({ name, description: TAG_WORDS[name] ?? "" }));

  return {
    openapi: "3.0.3",
    info: {
      title: "OwnBase REST API",
      version: String(protocol.PROTOCOL_VERSION),
      description: [
        "The REST routes under /api/ that the first-party clients use, and the Slack-compatible methods apps call. The native routes are not a stable public API: they change with the clients, and the version here is the client protocol's (`PROTOCOL_VERSION`). docs/INTEGRATIONS.md is the contract for apps.",
        "Generated from the server's source and the zod schemas it validates requests with, by packages/server/test/openapi.test.ts, which fails when this file is out of date. Rewrite it with `pnpm --filter @ownbase/server exec vitest run test/openapi.test.ts -u`.",
        "The WebSocket at /ws, incoming webhooks at /hooks/, the web client's files and the enterprise edition's routes are not described here.",
      ].join("\n\n"),
    },
    servers: [{ url: "/" }],
    tags,
    paths,
    components: {
      securitySchemes: {
        session: {
          type: "http",
          scheme: "bearer",
          description: "A session token, from POST /api/auth/login or /api/auth/register.",
        },
        botToken: {
          type: "http",
          scheme: "bearer",
          description:
            "An app's `xoxb-` bot token. Slack's methods also take it as a `token` field in the body.",
        },
      },
      schemas,
      responses: {
        Error: {
          description: "A refusal.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
        RateLimited: {
          description: "Too many calls for now. `Retry-After` says how many seconds to wait.",
          headers: { "Retry-After": { schema: { type: "integer" } } },
        },
      },
    },
  };
}
