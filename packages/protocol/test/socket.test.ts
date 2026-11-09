import { describe, expect, it } from "vitest";
import { clientMessage, inviteMemberBody, type ClientToServer } from "../src/index.js";

const id = (length: number) => "C".repeat(length);

describe("what a client may send over the socket", () => {
  it("takes every kind of message a client sends", () => {
    const sent: ClientToServer[] = [
      { type: "hello", token: "t", lastSeq: null, protocolVersion: 2 },
      { type: "ping" },
      { type: "typing", channelId: "C1" },
      { type: "huddle.join", channelId: "C1", requestId: "join-1" },
      { type: "huddle.leave", channelId: "C1" },
      { type: "huddle.signal", channelId: "C1", to: "U2", signal: { kind: "offer", sdp: "v=0" } },
      { type: "huddle.decline", channelId: "C1" },
      { type: "idle", idle: true },
    ];
    for (const message of sent) expect(clientMessage.safeParse(message).success).toBe(true);
  });

  it("holds ids to the limit a request's ids have", () => {
    expect(clientMessage.safeParse({ type: "typing", channelId: id(64) }).success).toBe(true);
    expect(clientMessage.safeParse({ type: "typing", channelId: id(65) }).success).toBe(false);
    expect(inviteMemberBody.safeParse({ userId: id(64) }).success).toBe(true);
    expect(inviteMemberBody.safeParse({ userId: id(65) }).success).toBe(false);
  });

  it("refuses anything else", () => {
    expect(clientMessage.safeParse({ type: "typing" }).success).toBe(false);
    expect(clientMessage.safeParse({ type: "shout", channelId: "C1" }).success).toBe(false);
  });
});
