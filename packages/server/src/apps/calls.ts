import type { AppReceive, ID } from "@ownbase/protocol";
import type { ServerContext } from "../core/context.js";
import { HttpError } from "../httpError.js";
import { secretToken, ulid } from "../ids.js";
import { APP_CALLS_IN_FLIGHT } from "../limits.js";
import { OutboundError, postToUrl, type OutboundResponse } from "../outbound.js";
import { signatureHeaders } from "./signing.js";
import type { AppSockets } from "./sockets.js";

/**
 * One thing sent to an app, in the shape it takes on either way there:
 * an event's callback body, a command's form fields, or a press or form's
 * payload. Over a socket each is the envelope's payload; by URL, the body
 * Slack would post.
 */
export type AppCall =
  | { type: "events_api"; url: string; body: string; attempt: number; signingSecret: string }
  | { type: "slash_commands"; url: string; fields: Record<string, string> }
  | { type: "interactive"; url: string; payload: Record<string, unknown> };

const isolatedRefusal = () =>
  new OutboundError(
    "blocked_host",
    "this is an isolated copy of the workspace, which does not contact apps",
  );

/** Which app a call goes to, and how it is reached. */
export interface CallTarget {
  id: ID;
  receive: AppReceive;
}

/**
 * Whether an app can be sent a button press or a form's submission: over its
 * sockets (J14), or to the interactivity URL an app sent things by URL needs.
 */
export const takesPresses = (app: CallTarget & { interactivityUrl: string }): boolean =>
  app.receive === "socket" || app.interactivityUrl !== "";

/** Who a capability handed to an app acts for, and where. */
export interface CapabilityTarget {
  channelId: ID;
  botUserId: ID;
  invokerId: ID;
}

/**
 * The server's calls out to apps, and the checks every one of them shares:
 * how many may be waiting on apps at once, the refusal an isolated copy gives
 * them all, and whether what an app was handed is still good when it answers.
 */
export function createAppCalls(ctx: ServerContext, sockets: AppSockets) {
  const { opts, store, gateway, ration, limiter, lifecycle } = ctx;

  /** Calls to apps in flight, keyed `account:<id>` and `app:<id>`. */
  const inFlight = new Map<string, number>();

  /**
   * Admits one call out to an app on an account's behalf, before anything is
   * prepared for it: a slow app holds its slot until it answers, so a person
   * pressing a button again and again, or everyone pressing one app's buttons,
   * is refused rather than queued without end. Returns the release, which the
   * caller runs however the call ends.
   */
  const admit = (accountId: ID, appId: ID): (() => void) => {
    if (!limiter) return () => {};
    const keys = [`account:${accountId}`, `app:${appId}`] as const;
    if ((inFlight.get(keys[0]) ?? 0) >= APP_CALLS_IN_FLIGHT.perAccount)
      throw new HttpError(
        429,
        "too_many_requests",
        "Your earlier requests to apps have not been answered yet. Try again when they finish.",
        1,
      );
    if ((inFlight.get(keys[1]) ?? 0) >= APP_CALLS_IN_FLIGHT.perApp)
      throw new HttpError(
        429,
        "app_busy",
        "That app is still answering other requests. Try again shortly.",
        1,
      );
    ration("appCall", accountId);
    for (const key of keys) inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of keys) {
        const left = (inFlight.get(key) ?? 1) - 1;
        if (left > 0) inFlight.set(key, left);
        else inFlight.delete(key);
      }
    };
  };

  /**
   * Posts `body` to an app, signed with `secret` the way Slack signs. Every
   * request to an app's URL goes through here, so an isolated copy refuses
   * them in one place, and `callApp` refuses a socket's the same way. The
   * refusal is a `blocked_host`, whose message the callers already show to
   * whoever pressed the button or ran the command.
   */
  const post = (
    url: string,
    body: string,
    contentType: string,
    secret: string,
    headers: Record<string, string> = {},
  ): Promise<OutboundResponse> =>
    opts.isolated
      ? Promise.reject(isolatedRefusal())
      : postToUrl(url, body, contentType, {
          allowPrivate: opts.allowPrivateHooks,
          signal: lifecycle.signal,
          headers: { ...signatureHeaders(secret, body), ...headers },
        });

  const postForm = (appId: ID, url: string, form: string): Promise<OutboundResponse> =>
    post(url, form, "application/x-www-form-urlencoded", store.apps.signingSecret(appId) ?? "");

  /**
   * Sends one event, command or press to an app, posted to its URL or as an
   * envelope over one of its sockets (J14), and answers as an HTTP call would:
   * an acknowledgement's payload stands for the body of a 200. Every failure,
   * a socket's included, is thrown the way a URL's is, so each caller keeps
   * the one path it already has for an app that did not answer.
   */
  const callApp = async (app: CallTarget, call: AppCall): Promise<OutboundResponse> => {
    if (app.receive === "socket") {
      if (opts.isolated) throw isolatedRefusal();
      const payload =
        call.type === "events_api"
          ? (JSON.parse(call.body) as unknown)
          : call.type === "slash_commands"
            ? call.fields
            : call.payload;
      const answer = await sockets.send(
        app.id,
        call.type,
        payload,
        call.type === "events_api"
          ? { retryAttempt: call.attempt, retryReason: call.attempt > 0 ? "timeout" : "" }
          : {},
      );
      return {
        status: 200,
        body:
          answer === undefined || answer === null
            ? ""
            : typeof answer === "string"
              ? answer
              : JSON.stringify(answer),
        contentType: "application/json",
      };
    }
    if (call.type === "events_api") {
      return post(
        call.url,
        call.body,
        "application/json",
        call.signingSecret,
        call.attempt > 0
          ? { "x-slack-retry-num": String(call.attempt), "x-slack-retry-reason": "http_error" }
          : {},
      );
    }
    const form =
      call.type === "slash_commands"
        ? new URLSearchParams(call.fields)
        : // Slack sends the JSON as a form field named payload.
          new URLSearchParams({ payload: JSON.stringify(call.payload) });
    return postForm(app.id, call.url, form.toString());
  };

  /**
   * Slack's url_verification handshake, worth keeping for more than
   * compatibility: an endpoint that cannot echo the challenge has not agreed to
   * receive anything, so this is also what stops the server being aimed at an
   * unrelated host as a way of flooding it.
   */
  const verifyCallbackUrl = async (url: string, appId: ID): Promise<void> => {
    const challenge = secretToken();
    const probe = JSON.stringify({ type: "url_verification", token: "", challenge });
    let answered: string;
    try {
      const res = await post(url, probe, "application/json", store.apps.signingSecret(appId) ?? "");
      answered = res.body.trim();
      if (answered.startsWith("{")) {
        answered = String((JSON.parse(answered) as { challenge?: unknown }).challenge ?? "");
      }
    } catch (err) {
      throw new HttpError(
        400,
        err instanceof OutboundError ? err.code : "unreachable",
        (err as Error).message,
      );
    }
    if (answered !== challenge) {
      throw new HttpError(
        400,
        "challenge_failed",
        "The URL did not answer the url_verification check with the challenge it was sent.",
      );
    }
  };

  /**
   * Whether a capability handed to an app is still good at the moment it is
   * being spent.
   *
   * A `response_url` lives half an hour, a `trigger_id` three minutes, and
   * even an ordinary reply arrives only after the app's own endpoint has
   * answered. In any of those gaps the app can be deleted or its bot
   * deactivated, the bot can be removed from the channel, the channel can be
   * archived or deleted, and the person being answered can be deactivated or
   * lose access. Checking only when the capability was handed out would make
   * every one of those revocations avoidable by waiting, so it is all checked
   * again here, where the reply would actually be posted.
   */
  const capabilityHolds = (target: CapabilityTarget): boolean => {
    const bot = store.people.get(target.botUserId);
    if (!bot || bot.deactivated) return false;
    if (!store.apps.forBotUser(target.botUserId)) return false;
    const channel = store.channels.get(target.channelId);
    if (!channel || channel.archived) return false;
    if (!store.canAccess(channel.id, bot.id)) return false;
    const invoker = store.people.get(target.invokerId);
    if (!invoker || invoker.deactivated) return false;
    return store.canAccess(channel.id, invoker.id);
  };

  /** Why a call to an app came to nothing, in words for the person who made it. */
  const whyFailed = (err: unknown): string => {
    if (err instanceof HttpError) {
      const reason = err.message.replace(/\.$/, "");
      return `its answer could not be posted: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`;
    }
    return err instanceof OutboundError && err.code === "blocked_host"
      ? err.message
      : "the app did not answer";
  };

  /** A private note back to the person who ran the command. */
  const sayEphemeral = (channelId: ID, toUserId: ID, fromUserId: ID, text: string): void => {
    gateway.tellPerson(toUserId, {
      type: "ephemeral.message",
      channelId,
      id: ulid(),
      userId: fromUserId,
      text,
      createdAt: Date.now(),
    });
  };

  return { admit, post, callApp, verifyCallbackUrl, capabilityHolds, whyFailed, sayEphemeral };
}

export type AppCalls = ReturnType<typeof createAppCalls>;
