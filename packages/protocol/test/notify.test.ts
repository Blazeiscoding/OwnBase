import { describe, expect, it } from "vitest";
import { notifyDecision, reminderNotifyDecision, type NotifyInputs } from "../src/notify.js";

const NOW = 1_700_000_000_000;

const inputs = (
  over: Partial<NotifyInputs> = {},
  message: Partial<NotifyInputs["message"]> = {},
): NotifyInputs => ({
  selfId: "me",
  message: { userId: "them", text: "hello", threadRootId: null, replyTo: null, ...message },
  senderBlocked: false,
  channelType: "public",
  prefs: { muted: false, notifyLevel: "all", notifyChosen: true },
  notifyDefault: "mentions",
  threadMuted: false,
  dndUntil: null,
  now: NOW,
  live: true,
  ...over,
});

const reason = (over: Partial<NotifyInputs> = {}, message: Partial<NotifyInputs["message"]> = {}) =>
  notifyDecision(inputs(over, message)).reason;

describe("notifyDecision", () => {
  it("never notifies nobody, or the sender of their own message", () => {
    expect(reason({ selfId: null })).toBe("own-message");
    expect(reason({}, { userId: "me" })).toBe("own-message");
  });

  it("stays silent for a blocked sender and outside the conversation", () => {
    expect(reason({ senderBlocked: true }, { text: "<@me>" })).toBe("blocked");
    expect(reason({ channelType: null }, { text: "<@me>" })).toBe("not-a-member");
  });

  it("stays silent in a muted conversation, even for a mention", () => {
    expect(
      reason({ prefs: { muted: true, notifyLevel: "all", notifyChosen: true } }, { text: "<@me>" }),
    ).toBe("muted");
  });

  it("follows the level chosen, or the account's default", () => {
    expect(
      reason(
        { prefs: { muted: false, notifyLevel: "nothing", notifyChosen: true } },
        { text: "<@me>" },
      ),
    ).toBe("level");
    // Not chosen: the default of mentions holds a plain message back.
    expect(reason({ prefs: { muted: false, notifyLevel: "all", notifyChosen: false } })).toBe(
      "level",
    );
    expect(reason({ prefs: undefined, notifyDefault: "all" })).toBe("all");
    expect(reason({ prefs: undefined, notifyDefault: null })).toBe("level");
  });

  it("lets a muted thread speak only for what is addressed to this person", () => {
    expect(reason({ threadMuted: true }, { threadRootId: "root" })).toBe("thread-muted");
    expect(reason({ threadMuted: true }, { threadRootId: "root", text: "<@me>" })).toBe("mention");
  });

  it("holds everything back during Do Not Disturb, and lets it through after", () => {
    expect(reason({ dndUntil: NOW + 1 }, { text: "<@me>" })).toBe("dnd");
    expect(reason({ dndUntil: NOW }, { text: "<@me>" })).toBe("mention");
  });

  it("notifies for every message in a direct conversation, whatever the level", () => {
    const quiet = { muted: false, notifyLevel: "mentions" as const, notifyChosen: true };
    expect(reason({ channelType: "dm", prefs: quiet })).toBe("dm");
    // A room-wide mention is just words in a DM.
    expect(reason({ channelType: "group_dm", prefs: quiet }, { text: "<!here>" })).toBe("dm");
  });

  it("names a person by mention or by a reply that pings them", () => {
    const quiet = { muted: false, notifyLevel: "mentions" as const, notifyChosen: true };
    expect(reason({ prefs: quiet }, { text: "hi <@me>" })).toBe("mention");
    expect(
      reason({ prefs: quiet }, { replyTo: { id: "m", userId: "me", ping: true } as never }),
    ).toBe("mention");
    expect(
      reason({ prefs: quiet }, { replyTo: { id: "m", userId: "me", ping: false } as never }),
    ).toBe("level");
  });

  it("rings @channel for everyone, @here only for whoever is around", () => {
    const quiet = { muted: false, notifyLevel: "mentions" as const, notifyChosen: true };
    expect(reason({ prefs: quiet, live: false }, { text: "<!channel>" })).toBe("broadcast");
    expect(reason({ prefs: quiet, live: true }, { text: "<!here>" })).toBe("broadcast");
    expect(reason({ prefs: quiet, live: false }, { text: "<!here>" })).toBe("not-here");
  });

  it("notifies for any message where the level is everything", () => {
    expect(notifyDecision(inputs())).toEqual({ notify: true, reason: "all" });
  });
});

describe("reminderNotifyDecision", () => {
  it("waits during Do Not Disturb, and otherwise notifies", () => {
    expect(reminderNotifyDecision(NOW + 1, NOW)).toEqual({ notify: false, reason: "dnd" });
    expect(reminderNotifyDecision(null, NOW)).toEqual({ notify: true, reason: "reminder" });
  });
});
