import { z } from "./zod.js";
import { callReport, huddleSignal } from "./huddle.js";

/** An id a client names, over the socket or in a request. */
export const idSchema = z.string().min(1).max(64);

/** Everything a client can send over the socket; the server refuses anything else. */
export const clientMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    token: z.string().min(1).max(256),
    lastSeq: z.number().int().nonnegative().nullable(),
    protocolVersion: z.number().int(),
  }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("typing"), channelId: idSchema }),
  z.object({ type: z.literal("huddle.join"), channelId: idSchema, requestId: idSchema }),
  z.object({ type: z.literal("huddle.leave"), channelId: idSchema }),
  z.object({
    type: z.literal("huddle.signal"),
    channelId: idSchema,
    to: idSchema,
    signal: huddleSignal,
  }),
  /** How one of this side's connections in a huddle went, for the host's call log. */
  z.object({
    type: z.literal("huddle.report"),
    channelId: idSchema,
    peer: idSchema,
    report: callReport,
  }),
  /**
   * Whether this device has gone idle, nobody touching it for a while, or is
   * in use again (E9). Every device idle makes the account away.
   */
  z.object({ type: z.literal("idle"), idle: z.boolean() }),
  /** Says no to a ring this account is being rung by (E10). */
  z.object({ type: z.literal("huddle.decline"), channelId: idSchema }),
  /**
   * An emoji floated over this person's tile for everyone in the huddle (K17).
   * Never stored; the server passes on at most one every `HUDDLE_REACTION_MS`.
   */
  z.object({
    type: z.literal("huddle.react"),
    channelId: idSchema,
    emoji: z.string().min(1).max(64),
  }),
  /** Raises or lowers this person's hand in the huddle, until they lower it or leave (K17). */
  z.object({ type: z.literal("huddle.hand"), channelId: idSchema, raised: z.boolean() }),
  /** Rings a member of the channel into its huddle, from a device in it (K18). */
  z.object({ type: z.literal("huddle.ask"), channelId: idSchema, userId: idSchema }),
]);

export type ClientToServer = z.infer<typeof clientMessage>;
