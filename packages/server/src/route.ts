import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteOptions,
} from "fastify";
import { ZodError } from "zod";
import {
  isAdministrator,
  type App,
  type BodyOf,
  type Endpoint,
  type EndpointSpec,
  type JsonAnswer,
  type PathParams,
  type QueryOf,
  type User,
} from "@ownbase/protocol";
import { HttpError, passwordChangeRequired } from "./httpError.js";

declare module "fastify" {
  interface FastifyContextConfig {
    endpoint?: EndpointSpec;
  }
}

type CallerOf<E extends EndpointSpec> = E["access"] extends "public" | "bot"
  ? undefined
  : E extends { ticket: true }
    ? User | null
    : User;

/**
 * The reply of a route that answers with JSON: its headers and status, but
 * not its answer, which is what the handler returns. A sent reply is
 * thenable, so returning one would satisfy any declared answer.
 */
export interface JsonReply {
  header(name: string, value: string): JsonReply;
  status(statusCode: number): JsonReply;
  hasHeader(name: string): boolean;
}

/** Slack's arguments, read by the route itself, may also be refused by it, with a status of its own. */
type SendsItself<E> = E extends { answer: JsonAnswer<unknown> }
  ? E extends { body: "slack" }
    ? true
    : false
  : true;

export interface RouteContext<E extends EndpointSpec> {
  req: FastifyRequest;
  reply: SendsItself<E> extends true ? FastifyReply : JsonReply;
  /** Who is signed in; null for a request a download ticket stands in for. */
  user: CallerOf<E>;
  /** The app calling, for a Slack Web API method. */
  bot: E["access"] extends "bot" ? App : undefined;
  params: PathParams<E["path"]>;
  query: QueryOf<E>;
  body: E extends { body: "image" } ? Buffer : E extends { body: "slack" } ? unknown : BodyOf<E>;
}

/** What a handler returns: the declared JSON, or the reply it sent. */
type HandlerResult<E extends EndpointSpec> =
  E["answer"] extends JsonAnswer<infer T>
    ? SendsItself<E> extends true
      ? T | FastifyReply
      : T
    : FastifyReply;

export type RouteHandler<E extends EndpointSpec> = (
  context: RouteContext<E>,
) => Promise<HandlerResult<E>>;

/**
 * Registers one declared endpoint. The handler is a type of its own, held to
 * `RouteHandler<E>`, so that the literal answers it returns stay literal.
 */
export type Route = <E extends Endpoint, H extends RouteHandler<E>>(
  endpoint: E,
  handler: H,
) => void;

export interface RouterOptions {
  app: FastifyInstance;
  log: FastifyBaseLogger;
  /** The account a request's session token belongs to. */
  sessionUser(req: FastifyRequest): User | null;
  mustChangePassword(userId: string): boolean;
  /** The app a Slack Web API call is made as, by its bot token. */
  botCaller(req: FastifyRequest): App | null;
  /** Says which scopes the app's token holds, on every answer to it, as Slack does. */
  sayScopes(reply: FastifyReply, app: App): void;
}

export interface Router {
  route: Route;
  /**
   * The signed-in caller of the request's route, by the route's own access:
   * for a handler that yields and must check again that the session is
   * still good before it goes on.
   */
  signedIn(req: FastifyRequest): User;
}

/**
 * Registers every REST route from its declaration: signs the caller in,
 * checks their access, validates the params, query and body, and answers
 * every refusal in one shape, `{ error, message }` with its status.
 */
export function createRouter(opts: RouterOptions): Router {
  const { app } = opts;

  // A route registered any other way would skip signing in and validation.
  app.addHook("onRoute", (added) => {
    if (/^\/(api|hooks)\//.test(added.url) && !added.config?.endpoint) {
      throw new Error(`${String(added.method)} ${added.url} is not a declared endpoint`);
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "invalid_request", details: err.issues });
    }
    if (err instanceof HttpError) {
      if (err.retryAfter !== undefined) reply.header("retry-after", String(err.retryAfter));
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    const fastifyErr = err as { statusCode?: number; message?: string };
    if (typeof fastifyErr.statusCode === "number" && fastifyErr.statusCode < 500) {
      return reply
        .status(fastifyErr.statusCode)
        .send({ error: "bad_request", message: fastifyErr.message });
    }
    opts.log.error(err);
    return reply.status(500).send({ error: "internal" });
  });

  const signIn = (req: FastifyRequest, endpoint: EndpointSpec): User => {
    const user = opts.sessionUser(req);
    if (!user) throw new HttpError(401, "unauthorized");
    if (user.role === "guest" && endpoint.access !== "guest") {
      throw new HttpError(
        403,
        "guest_not_allowed",
        "Guests cannot do this. Create an account to do it.",
      );
    }
    if (!endpoint.whileLocked && opts.mustChangePassword(user.id)) throw passwordChangeRequired();
    if (endpoint.access === "admin" && !isAdministrator(user.role)) {
      throw new HttpError(403, "admin_only");
    }
    if (endpoint.access === "owner" && user.role !== "owner") {
      throw new HttpError(403, "owner_only", "Only the workspace's owner can do this.");
    }
    return user;
  };

  const route: Route = (endpoint, handler) => {
    const options: RouteOptions = {
      method: endpoint.method,
      url: endpoint.path,
      config: { endpoint },
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        let user: User | null | undefined;
        let bot: App | undefined;
        if (endpoint.access === "bot") {
          const caller = opts.botCaller(req);
          if (!caller) return { ok: false, error: "invalid_auth" };
          opts.sayScopes(reply, caller);
          bot = caller;
        } else if (endpoint.access !== "public") {
          const ticket = endpoint.ticket
            ? (req.query as { download?: unknown }).download
            : undefined;
          user = ticket !== undefined ? null : signIn(req, endpoint);
        }
        const context = {
          req,
          reply,
          user,
          bot,
          params: req.params,
          query: endpoint.query?.parse(req.query),
          body:
            typeof endpoint.body === "object"
              ? endpoint.body.parse(req.body ?? (endpoint.bodyOptional ? {} : undefined))
              : endpoint.body === "image"
                ? Buffer.isBuffer(req.body)
                  ? req.body
                  : Buffer.alloc(0)
                : req.body,
        } as RouteContext<typeof endpoint>;
        if (endpoint.status) reply.status(endpoint.status);
        return handler(context) as Promise<unknown>;
      },
    };
    if (endpoint.body !== "image") {
      app.route(options);
      return;
    }
    // A picture arrives as itself, typed by its Content-Type, so these routes
    // read every body as bytes, whatever it says it is, and the picture's own
    // check answers.
    void app.register(async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) =>
        done(null, body),
      );
      scope.route(options);
    });
  };

  return {
    route,
    signedIn(req) {
      const endpoint = req.routeOptions.config.endpoint;
      if (!endpoint) throw new Error(`${req.method} ${req.url} is not a declared route`);
      return signIn(req, endpoint);
    },
  };
}
