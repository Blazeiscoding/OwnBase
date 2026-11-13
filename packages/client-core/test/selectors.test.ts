import { describe, expect, it } from "vitest";
import type { Channel } from "@ownbase/protocol";
import { mentionsElsewhere, selfMay, snoozedUntil, waitsForAttention } from "../src/index.js";

const room = (id: string, extra: Partial<Channel> = {}) =>
  ({ id, type: "public", name: id, ...extra }) as Channel;
const dm = (id: string, other: string) =>
  ({ id, type: "dm", memberIds: ["me", other] }) as unknown as Channel;

const state = {
  self: { id: "me" } as never,
  blocked: ["troll"],
  channels: {
    general: room("general"),
    quiet: room("quiet"),
    old: room("old", { archived: true }),
    pal: dm("pal", "friend"),
    shun: dm("shun", "troll"),
    read: room("read"),
  },
  memberships: { general: 1, quiet: 1, old: 1, pal: 1, shun: 1, read: 5 },
  channelLastSeq: { general: 2, quiet: 2, old: 2, pal: 2, shun: 2, read: 5 },
  prefs: { quiet: { muted: true } } as never,
  mentionCounts: { general: 2, pal: 1 },
};

describe("what asks for attention", () => {
  it("counts unread conversations that are not on screen, muted, archived or with someone blocked", () => {
    const waiting = Object.keys(state.channels).filter((id) => waitsForAttention(state, id, null));
    expect(waiting).toEqual(["general", "pal"]);
    expect(waitsForAttention(state, "general", "general")).toBe(false);
  });

  it("counts mentions everywhere but the conversation on screen", () => {
    expect(mentionsElsewhere(state, null)).toBe(3);
    expect(mentionsElsewhere(state, "general")).toBe(1);
  });

  it("says when Do Not Disturb ends only while it is on", () => {
    expect(snoozedUntil(2_000, 1_000)).toBe(2_000);
    expect(snoozedUntil(1_000, 1_000)).toBeNull();
    expect(snoozedUntil(null)).toBeNull();
  });

  it("offers what the server would let this account call, by the endpoint table", () => {
    const as = (role: "owner" | "member" | "guest") => ({ self: { role } as never });
    expect(selfMay(as("member"), "pinMessage")).toBe(true);
    expect(selfMay(as("guest"), "pinMessage")).toBe(false);
    expect(selfMay(as("guest"), "sendMessage")).toBe(true);
    expect(selfMay(as("member"), "listReports")).toBe(false);
    expect(selfMay(as("owner"), "transferOwnership")).toBe(true);
    expect(selfMay({ self: null }, "sendMessage")).toBe(false);
  });
});
