import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import * as protocol from "@ownbase/protocol";
import { endpoints, type EndpointSpec } from "@ownbase/protocol";

/**
 * The OpenAPI description of the native REST API (E18), built from the
 * endpoint table in @ownbase/protocol: each route's method, path, access,
 * the zod schemas its body and query are validated with, and the comment
 * above it. Nothing is written twice, so it cannot drift from the code
 * without the check in openapi.test.ts noticing.
 *
 * Answers are described in words only: the table types them for TypeScript
 * and has no schemas for them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const tableSource = readFileSync(resolve(here, "../../protocol/src/endpoints.ts"), "utf8").replace(
  /\r\n/g,
  "\n",
);

type Method = "get" | "post" | "put" | "patch" | "delete";
type Access = "anyone" | "bot" | "member" | "admin" | "owner";

/** One route, as the table declares it. */
export interface DescribedRoute {
  method: Method;
  /** Fastify's form, `/api/channels/:id`. */
  path: string;
  endpoint: EndpointSpec;
  access: Access;
  guests: boolean;
  comment: string;
}

/** The doc comment, or the run of line comments, directly above a table entry. */
function commentAbove(name: string): string {
  const at = tableSource.indexOf(`\n  ${name}: endpoint(`);
  if (at < 0) throw new Error(`${name} is not in endpoints.ts`);
  const before = tableSource.slice(0, at).trimEnd();
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

const ACCESS: Record<EndpointSpec["access"], Access> = {
  public: "anyone",
  guest: "member",
  member: "member",
  admin: "admin",
  owner: "owner",
  bot: "bot",
};

/** Every route under /api/ in the table, in the order it is declared. */
export function describedRoutes(): DescribedRoute[] {
  return Object.entries(endpoints as Record<string, EndpointSpec>)
    .filter(([, endpoint]) => endpoint.path.startsWith("/api/"))
    .map(([name, endpoint]) => ({
      method: endpoint.method.toLowerCase() as Method,
      path: endpoint.path,
      endpoint,
      access: ACCESS[endpoint.access],
      guests: endpoint.access === "guest",
      comment: commentAbove(name),
    }));
}

/** `CreateChannelBody` for `createChannelBody`, as a component's name. */
const componentName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** The name @ownbase/protocol exports a schema by. */
function nameOf(schema: z.ZodType): string {
  const found = Object.entries(protocol).find(([, value]) => value === schema);
  if (!found) throw new Error("a body schema in the endpoint table is not exported by name");
  return found[0];
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
  activity:
    "Mentions, replies and reactions addressed to the signed-in account, and channels it was removed from.",
  admin: "Running the workspace: members, audit history, reports, copies and status.",
  apps: "Apps and integrations: bot users, tokens, scopes, webhooks, commands, events.",
  auth: "Accounts, signing in and out, guests and sessions.",
  channels: "Conversations, their members, messages, threads and read state.",
  commands: "Slash commands, and the URL an app answers one through later.",
  conversations: "What the list of direct messages shows under each name.",
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
  const routes = describedRoutes();
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
    const { endpoint, guests } = route;
    const parameters: unknown[] = [...route.path.matchAll(/:(\w+)/g)].map(([, name]) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    }));

    if (endpoint.query) {
      const query = jsonSchema(endpoint.query);
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
    if (typeof endpoint.body === "object") {
      const name = componentName(nameOf(endpoint.body));
      if (!schemas[name]) {
        const { $schema: _, ...schema } = jsonSchema(endpoint.body);
        schemas[name] = schema;
      }
      requestBody = {
        required: !endpoint.bodyOptional,
        content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } },
      };
    } else if (endpoint.body === "image") {
      requestBody = {
        required: true,
        description: "The image itself, typed by its Content-Type.",
        content: { "image/*": { schema: { type: "string", format: "binary" } } },
      };
    } else if (endpoint.body === "file") {
      requestBody = {
        required: true,
        description: "One file, as the form's `file` field.",
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              properties: { file: { type: "string", format: "binary" } },
              required: ["file"],
            },
          },
        },
      };
    } else if (endpoint.body === "slack") {
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
              [String(endpoint.status ?? 200)]: { description: "Done." },
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
        "Generated from the endpoint table in @ownbase/protocol and the zod schemas the server validates requests with, by packages/server/test/openapi.test.ts, which fails when this file is out of date. Rewrite it with `pnpm --filter @ownbase/server exec vitest run test/openapi.test.ts -u`.",
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
