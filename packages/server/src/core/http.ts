import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { LOGGER_OPTIONS } from "../redact.js";
import { SECURITY_HEADERS } from "../securityHeaders.js";
import { isMissingAsset, webCacheControl } from "../webClient.js";

export interface HttpOptions {
  logger?: boolean | { stream: NodeJS.WritableStream };
  maxFileSize: number;
  webDistPath?: string;
}

export interface Http {
  app: FastifyInstance;
  /**
   * Every route handler still running. Closing the listener destroys the
   * connections but not the handlers behind them: a slash command waiting on
   * its app wakes up afterwards and goes on to read and write the database. So
   * shutdown waits for these to finish before closing it.
   */
  runningHandlers: Set<Promise<void>>;
}

/** The HTTP server, with everything every route shares and none of the routes. */
export async function createHttp(opts: HttpOptions): Promise<Http> {
  const app = Fastify({
    // Redacting where the log is configured rather than at each call site: the
    // leak is Fastify's own request logging, which no route goes through.
    logger: opts.logger
      ? { ...LOGGER_OPTIONS, ...(typeof opts.logger === "object" ? opts.logger : {}) }
      : false,
    forceCloseConnections: true,
  });

  const runningHandlers = new Set<Promise<void>>();
  // Before any route, since it only applies to routes added after.
  app.addHook("onRoute", (route) => {
    const handler = route.handler;
    route.handler = function (req, reply) {
      const result = handler.call(this, req, reply) as unknown;
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        const settled = Promise.resolve(result).then(
          () => {},
          () => {},
        );
        runningHandlers.add(settled);
        void settled.then(() => runningHandlers.delete(settled));
      }
      return result as ReturnType<typeof handler>;
    };
  });
  // The default allow-list is GET/HEAD/POST only, which silently breaks
  // reactions, edits, deletes, pins and saves in the browser.
  await app.register(cors, {
    origin: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    // How long to wait after "too much at once", for clients on another origin.
    exposedHeaders: ["retry-after"],
  });
  await app.register(multipart, { limits: { fileSize: opts.maxFileSize, files: 1 } });

  // On every response rather than only on the client's HTML. An API reply is
  // not a page, but it can be navigated to directly, and a header that is
  // always there cannot be forgotten on the one route that needed it.
  app.addHook("onSend", async (_req, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
  });

  // Slack-style integrations often post `payload=<json>` as a form rather than
  // JSON, so accept that shape too. Small enough not to warrant a plugin.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error);
      }
    },
  );

  // JSON under a name of its own (RFC 6839), such as SCIM's application/scim+json,
  // which identity providers send to the Enterprise edition's provisioning (P10).
  app.addContentTypeParser(
    /^application\/[a-z0-9.-]+\+json(?:\s*;|$)/i,
    { parseAs: "string" },
    app.getDefaultJsonParser("error", "error"),
  );

  // Serve the browser client (if bundled) so teammates without the app can join.
  const servesWebClient = !!opts.webDistPath && existsSync(join(opts.webDistPath, "index.html"));
  if (servesWebClient) {
    const root = opts.webDistPath!;
    // The build writes a Brotli and a gzip copy of each text file beside it;
    // the plugin sends the one the browser accepts, with Vary: Accept-Encoding.
    await app.register(fastifyStatic, {
      root,
      preCompressed: true,
      setHeaders: (reply, file) => reply.header("cache-control", webCacheControl(root, file)),
    });
  }
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? "";
    // A Slack Web API method this server does not implement. Slack's answer is
    // `unknown_method`, which its SDK reports by name; a bare 404 would reach
    // a bot as a transport failure that says nothing about why.
    if (/^\/api\/[a-z]+(?:\.[A-Za-z]+)+(?:[?#]|$)/.test(url)) {
      return reply.status(200).send({ ok: false, error: "unknown_method" });
    }
    if (!servesWebClient || url.startsWith("/api/") || url.startsWith("/ws")) {
      return reply.status(404).send({ error: "not_found" });
    }
    if (isMissingAsset(url)) {
      return reply.status(404).header("cache-control", "no-store").send({ error: "not_found" });
    }
    return reply.sendFile("index.html");
  });

  return { app, runningHandlers };
}
