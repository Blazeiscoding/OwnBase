import { z } from "zod";

const id = z.string().min(1).max(128);
const signal = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("offer"), sdp: z.string().max(100_000) }),
  z.object({ kind: z.literal("answer"), sdp: z.string().max(100_000) }),
  z.object({
    kind: z.literal("media"),
    camera: z.boolean(),
    screen: z.boolean(),
    muted: z.boolean().optional(),
    screenSound: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("ice"),
    candidate: z.object({
      candidate: z.string().max(4096),
      sdpMid: z.string().max(128).nullable(),
      sdpMLineIndex: z.number().int().nonnegative().max(100).nullable(),
    }),
  }),
]);

const counts = z.object({
  host: z.number().int().nonnegative().max(1000),
  srflx: z.number().int().nonnegative().max(1000),
  prflx: z.number().int().nonnegative().max(1000),
  relay: z.number().int().nonnegative().max(1000),
});
const candidateKind = z.enum(["host", "srflx", "prflx", "relay"]);
const state = z.string().max(32);
const report = z.object({
  outcome: z.enum(["connected", "stalled", "failed"]),
  afterMs: z.number().int().nonnegative().max(86_400_000),
  iceServers: z.object({
    stun: z.number().int().nonnegative().max(100),
    turn: z.number().int().nonnegative().max(100),
  }),
  local: counts,
  remote: counts,
  connectionState: state,
  iceConnectionState: state,
  route: z
    .object({ local: candidateKind, remote: candidateKind, protocol: z.enum(["udp", "tcp"]) })
    .optional(),
  retries: z.number().int().nonnegative().max(100),
  cause: z
    .enum([
      "signalling",
      "no_ice_servers",
      "no_public_route_here",
      "no_public_route_there",
      "needs_relay",
      "unknown",
    ])
    .optional(),
});

export const socketMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    token: z.string().min(1).max(256),
    lastSeq: z.number().int().nonnegative().nullable(),
    protocolVersion: z.number().int(),
    syncVersion: z.literal(1).optional(),
  }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("typing"), channelId: id }),
  z.object({ type: z.literal("huddle.join"), channelId: id, requestId: id.optional() }),
  z.object({ type: z.literal("huddle.leave"), channelId: id }),
  z.object({ type: z.literal("huddle.signal"), channelId: id, to: id, signal }),
  z.object({ type: z.literal("huddle.report"), channelId: id, peer: id, report }),
  z.object({ type: z.literal("idle"), idle: z.boolean() }),
  z.object({ type: z.literal("huddle.decline"), channelId: id }),
]);
