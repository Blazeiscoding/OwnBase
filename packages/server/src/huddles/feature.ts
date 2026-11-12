import { endpoints, type ID } from "@ownbase/protocol";
import type { ServerContext } from "../core/context.js";
import { HttpError } from "../httpError.js";
import type { Posting } from "../messages/posting.js";
import {
  createRelaySource,
  serverRelaySchema,
  withRelay,
  type IceServer,
  type ServerRelay,
} from "./relay.js";
import { HuddleRooms } from "./rooms.js";
import { iceServersSchema } from "./rtc.js";

/** What a missed call's note says, to search and notifications too (E10). */
const MISSED_CALL_TEXT = "Missed huddle";

/**
 * Huddles: who is in which huddle and the rings, which travel over the socket
 * (rooms.ts), and the HTTP side: the STUN and TURN servers calls are given,
 * and the call log.
 */
export function registerHuddles(ctx: ServerContext, { posting }: { posting: Posting }) {
  const { opts, log, store, gateway, route } = ctx;

  /**
   * The note a ring nobody answered leaves in its direct message, as from the
   * person who rang (E10). One who can no longer post there, deactivated or
   * gone from it, leaves none: posting refuses it as it would them.
   */
  const postMissedCall = (channelId: ID, callerId: ID): void => {
    try {
      posting.post({
        poster: { kind: "person", userId: callerId },
        channelId,
        text: MISSED_CALL_TEXT,
        threadRootId: null,
        nonce: null,
        fileIds: [],
        call: { kind: "missed" },
      });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
    }
  };
  const rooms = new HuddleRooms(gateway, store, {
    limiter: ctx.limiter,
    missedCall: postMissedCall,
    graceMs: opts.huddleGraceMs,
    ringMs: opts.huddleRingMs,
  });
  gateway.useHuddles(rooms);

  let iceServers: IceServer[] = opts.iceServers ?? [];
  const relaySource = (next: ServerRelay | null) =>
    createRelaySource(next === null ? null : serverRelaySchema.parse(next), {
      // The reason only: the request carried the API token.
      onError: (error) => log.warn({ reason: error.message }, "the call relay gave no password"),
    });
  let relay = relaySource(opts.relay ?? null);

  route(endpoints.rtcConfig, async ({ reply, user }) => {
    reply.header("Cache-Control", "no-store");
    return { iceServers: withRelay(iceServers, await relay.servers(user.id)) };
  });

  route(endpoints.callLog, async ({ reply, user: me }) => {
    reply.header("Cache-Control", "no-store");
    return { entries: rooms.calls.entries((channelId) => store.canAccess(channelId, me.id)) };
  });

  return {
    rooms,
    setIceServers(servers: NonNullable<typeof opts.iceServers>): void {
      iceServers = iceServersSchema.parse(servers);
    },
    /** Parsed before anything changes, so a refused relay leaves the old one. */
    setRelay(next: ServerRelay | null): void {
      relay = relaySource(next);
    },
    relayError: () => relay.error(),
  };
}
