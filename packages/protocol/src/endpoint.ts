import type { z } from "zod";

/**
 * Who may call a route:
 * - `public`: anyone, signed in or not;
 * - `guest`: any signed-in account, guests included;
 * - `member`: a signed-in account that is not a guest;
 * - `admin`: the owner or an admin;
 * - `owner`: the owner alone;
 * - `bot`: an app, with its bot token, as Slack's Web API is called.
 */
export type Access = "public" | "guest" | "member" | "admin" | "owner" | "bot";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

declare const answerType: unique symbol;

/** A JSON answer of type `T`. */
export interface JsonAnswer<T> {
  readonly kind: "json";
  readonly [answerType]?: T;
}

/**
 * What a route answers with: JSON of a declared type; the bytes of a file or
 * picture; Slack's plain-text "ok"; or a page or redirect, for a browser.
 */
export type Answer = JsonAnswer<unknown> | { readonly kind: "bytes" | "text" | "page" };

export const json = <T>(): JsonAnswer<T> => ({ kind: "json" });
export const bytes = { kind: "bytes" } as const;
export const text = { kind: "text" } as const;
export const page = { kind: "page" } as const;

/**
 * What a route reads: JSON its schema validates; `image`, the bytes of one
 * picture typed by its Content-Type; `file`, a multipart upload of one file;
 * or `slack`, Slack's arguments as JSON or a form, which the route reads
 * itself so that a refusal keeps Slack's shape.
 */
export type BodyKind = z.ZodType | "image" | "file" | "slack";

export interface EndpointSpec {
  method: HttpMethod;
  /** Fastify's form: `/api/channels/:id`. */
  path: string;
  access: Access;
  /** Reachable by an account that must choose a new password first. */
  whileLocked?: true;
  /**
   * A one-time ticket in `?download=` stands in for the session, for a
   * browser navigation that cannot send one.
   */
  ticket?: true;
  query?: z.ZodType;
  body?: BodyKind;
  /** The body may be left out, and reads as `{}`. */
  bodyOptional?: true;
  answer: Answer;
  /** The status of a success, when it is not 200. */
  status?: 201;
  /** How long a client waits for the answer. */
  timeoutMs?: number;
}

/** How long a client waits when an endpoint does not say. */
export const DEFAULT_TIMEOUT_MS = 10_000;

export type Endpoint<S extends EndpointSpec = EndpointSpec> = S & { timeoutMs: number };

export function endpoint<const S extends EndpointSpec>(spec: S): Endpoint<S> {
  return { ...spec, timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS };
}

type ParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamNames<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;

/** `{ id: string; userId: string }` for `/api/channels/:id/members/:userId`. */
export type PathParams<P extends string> = { [K in ParamNames<P>]: string };

/** The path parameters a client gives: text, or a number such as a seq. */
export type ParamsIn<E extends EndpointSpec> = { [K in ParamNames<E["path"]>]: string | number };

export type QueryOf<E extends EndpointSpec> = E["query"] extends z.ZodType
  ? z.output<E["query"]>
  : undefined;
export type QueryIn<E extends EndpointSpec> = E["query"] extends z.ZodType
  ? z.input<E["query"]>
  : undefined;

export type BodyOf<E extends EndpointSpec> = E["body"] extends z.ZodType
  ? z.output<E["body"]>
  : undefined;
export type BodyIn<E extends EndpointSpec> = E["body"] extends z.ZodType
  ? z.input<E["body"]>
  : undefined;

/** What a JSON route answers with. */
export type AnswerOf<E extends EndpointSpec> = E["answer"] extends JsonAnswer<infer T> ? T : never;

/**
 * The path with each parameter filled in and encoded, so an id or an emoji
 * holding `/`, `?` or `#` stays one segment.
 */
export function fillPath(path: string, params: Record<string, unknown> = {}): string {
  return path.replace(/:(\w+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new TypeError(`${path} needs :${name}`);
    return encodeURIComponent(String(value));
  });
}

/** `GET /api/me`, as a route is named in logs and lists. */
export const routeName = (e: Pick<EndpointSpec, "method" | "path">) => `${e.method} ${e.path}`;
