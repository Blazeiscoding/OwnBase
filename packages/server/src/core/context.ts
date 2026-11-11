import type { ID, User } from "@ownbase/protocol";
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import type { Gateway } from "../gateway.js";
import { HttpError } from "../httpError.js";
import type { Limits, RateLimiter } from "../limits.js";
import type { Route } from "../route.js";
import type { ServerOptions } from "../options.js";
import type { Store } from "../store.js";
import type { BackgroundWork } from "./background.js";
import type { Commits } from "./commit.js";
import type { Lifecycle } from "./lifecycle.js";
import type { Network } from "./network.js";
import type { Settings } from "./settings.js";

/**
 * What every feature of the server is built on. `createWorkspaceServer`
 * makes one and hands it to each feature in turn; a feature's handlers are
 * plain functions over it, so they can be called without going through HTTP.
 */
export interface ServerContext {
  opts: ServerOptions;
  app: FastifyInstance;
  log: FastifyBaseLogger;
  db: DatabaseSync;
  store: Store;
  settings: Settings;
  gateway: Gateway;
  /** Registers one declared endpoint; see route.ts. */
  route: Route;
  /** The signed-in caller, checked again, for a handler that yields before it writes. */
  requireUser(req: FastifyRequest): User;
  /** Spends one unit of a limit, or throws the 429 that says when to come back. */
  ration(name: keyof Limits, key: string): void;
  /** Null when rationing is off. */
  limiter: RateLimiter | null;
  recordEvent: Commits["recordEvent"];
  mutate: Commits["mutate"];
  onRecorded: Commits["onRecorded"];
  onPublished: Commits["onPublished"];
  background: BackgroundWork;
  network: Network;
  lifecycle: Lifecycle;
}

/** Spends one unit of `name` for `key`, refusing with when to come back once it is spent. */
export function rationWith(limiter: RateLimiter | null) {
  return (name: keyof Limits, key: string): void => {
    if (!limiter) return;
    const { ok, retryAfterMs } = limiter.take(name, key);
    if (ok) return;
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    throw new HttpError(
      429,
      "too_many_requests",
      "That is more than this workspace allows for now. Try again shortly.",
      seconds,
    );
  };
}

/** The conversation, if the caller may read it; 404s otherwise, so its existence stays hidden. */
export function requireChannelAccess(store: Store, channelId: ID, user: User) {
  const channel = store.channels.get(channelId);
  if (!channel || !store.canAccess(channelId, user.id)) {
    throw new HttpError(404, "channel_not_found");
  }
  return channel;
}

/** A message the caller may read, or a 404 that does not say whether it exists. */
export function requireVisibleMessage(store: Store, messageId: ID, user: User) {
  const message = store.messages.get(messageId);
  if (!message || !store.canAccess(message.channelId, user.id)) {
    throw new HttpError(404, "message_not_found");
  }
  return message;
}

/** Guests read and take part in public channels; private rooms and DMs are closed to them. */
export const guestRestricted = () =>
  new HttpError(403, "guest_restricted", "Guests can only be in public channels.");

/** The type a picture's request declares; none when its body was not raw bytes. */
export const declaredPictureType = (req: FastifyRequest): string | undefined =>
  Buffer.isBuffer(req.body) ? req.headers["content-type"] : undefined;
