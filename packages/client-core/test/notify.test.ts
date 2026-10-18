import { describe, expect, it } from "vitest";
import type { Channel, Message, User } from "@slackoss/protocol";
import { decideNotification, isMessageOnScreen, notificationBody } from "../src/notify.js";
import type { WorkspaceState } from "../src/index.js";

const me: User = {
  id: "U_ME",
  handle: "me",
  displayName: "Me",
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

const them: User = { ...me, id: "U_THEM", handle: "them", displayName: "Them" };

const channel = (type: Channel["type"], id = "C1"): Channel => ({
  id,
  type,
  name: type === "public" || type === "private" ? "general" : "",
  topic: "",
  description: "",
  creatorId: them.id,
  archived: false,
  createdAt: 0,
});

const message = (over: Partial<Message> = {}): Message => ({
  id: "M1",
  channelId: "C1",
  userId: them.id,
  text: "hello there",
  threadRootId: null,
  broadcast: false,
  seq: 1,
  createdAt: 0,
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  actions: [],
  ...over,
});

function state(over: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    friends: [],
    status: "online",
    workspaceName: "W",
    workspaceId: null,
    inlineReplies: true,
    scheduledEvents: true,
    activityThreads: true,
    stars: true,
    workspaceSettings: true,
    accessPolicy: "account_required",
    scheduledChanges: 0,
    self: me,
    users: { [me.id]: me, [them.id]: them },
    channels: { C1: channel("public") },
    memberships: { C1: 0 },
    repliesRead: { C1: 0 },
    prefs: { C1: { notifyLevel: "mentions", muted: false } },
    prefsWrites: {},
    channelLastSeq: {},
    presence: {},
    typing: {},
    lastSeq: 0,
    timelines: {},
    threads: {},
    threadPages: {},
    pending: [],
    saved: {},
    removedHistory: {},
    changedContent: {},
    memberChanges: {},
    threadFollows: {},
    mentionCounts: {},
    drafts: {},
    huddles: {},
    ephemerals: {},
    ephemeralsDropped: {},
    modal: null,
    commands: [],
    huddle: null,
    ...over,
  };
}

describe("decideNotification", () => {
  it("stays quiet for your own messages", () => {
    const d = decideNotification(state(), message({ userId: me.id }));
    expect(d).toEqual({ notify: false, reason: "own-message" });
  });

  it("stays quiet for channels you are not in", () => {
    const d = decideNotification(state({ memberships: {} }), message());
    expect(d).toEqual({ notify: false, reason: "not-a-member" });
  });

  it("at the default level, notifies only on a mention", () => {
    expect(decideNotification(state(), message()).notify).toBe(false);
    const mention = message({ text: `morning <@${me.id}>` });
    expect(decideNotification(state(), mention)).toEqual({ notify: true, reason: "mention" });
  });

  it("counts a reply that notifies you of an answer to your message as a mention", () => {
    const answer = (ping: boolean, userId = me.id) =>
      message({
        text: "agreed",
        replyTo: { id: "M0", userId, text: "thoughts?", fileCount: 0, deleted: false, ping },
      });
    expect(decideNotification(state(), answer(true))).toEqual({ notify: true, reason: "mention" });
    // Told not to notify, or answering someone else, it is an ordinary message.
    expect(decideNotification(state(), answer(false)).notify).toBe(false);
    expect(decideNotification(state(), answer(true, them.id)).notify).toBe(false);
  });

  it("notifies on every message when the channel is set to all", () => {
    const s = state({ prefs: { C1: { notifyLevel: "all", muted: false } } });
    expect(decideNotification(s, message())).toEqual({ notify: true, reason: "all" });
  });

  it("stays quiet at level nothing, even for a mention", () => {
    const s = state({ prefs: { C1: { notifyLevel: "nothing", muted: false } } });
    const mention = message({ text: `oi <@${me.id}>` });
    expect(decideNotification(s, mention)).toEqual({ notify: false, reason: "level" });
  });

  it("mute beats every level", () => {
    const s = state({ prefs: { C1: { notifyLevel: "all", muted: true } } });
    expect(decideNotification(s, message())).toEqual({ notify: false, reason: "muted" });
  });

  it("notifies on DMs without needing a mention", () => {
    const s = state({ channels: { C1: channel("dm") } });
    expect(decideNotification(s, message())).toEqual({ notify: true, reason: "dm" });
  });

  it("honours Do Not Disturb while it lasts, and stops when it expires", () => {
    const now = 1_000_000;
    const snoozed = state({
      self: { ...me, dndUntil: now + 60_000 },
      channels: { C1: channel("dm") },
    });
    expect(decideNotification(snoozed, message(), { now })).toEqual({
      notify: false,
      reason: "dnd",
    });

    const expired = state({
      self: { ...me, dndUntil: now - 1 },
      channels: { C1: channel("dm") },
    });
    expect(decideNotification(expired, message(), { now }).notify).toBe(true);
  });

  it("falls back to mentions-only when a channel has no stored preference", () => {
    const s = state({ prefs: {} });
    expect(decideNotification(s, message()).notify).toBe(false);
    expect(decideNotification(s, message({ text: `<@${me.id}> ping` })).notify).toBe(true);
  });
});

describe("notificationBody", () => {
  it("renders mentions as readable names", () => {
    const body = notificationBody(state(), message({ text: `hi <@${me.id}> and <@U_NOBODY>` }));
    expect(body).toBe("hi @Me and @someone");
  });

  it("reads a labelled link as its label, and an unlabelled one as its address", () => {
    const body = notificationBody(
      state(),
      message({ text: "build <https://ci.example.com/7|#7 failed>, see <https://ci.example.com>" }),
    );
    expect(body).toBe("build #7 failed, see https://ci.example.com");
  });

  it("describes attachments when there is no text", () => {
    const withFile = message({
      text: "",
      files: [{ id: "F1", name: "a.png", mime: "image/png", size: 1, width: 1, height: 1 }],
    });
    expect(notificationBody(state(), withFile)).toBe("Sent a file");
  });
  it("treats @channel as addressed to you, even on a mentions-only channel", () => {
    const s = state({ prefs: { C1: { notifyLevel: "mentions", muted: false } } });
    expect(decideNotification(s, message({ text: "<!channel> standup in five" }))).toEqual({
      notify: true,
      reason: "broadcast",
    });
    // Slack's #general-only variant means the same reach here.
    expect(decideNotification(s, message({ text: "<!everyone> fire drill" })).notify).toBe(true);
    // And a message with neither still respects the level.
    expect(decideNotification(s, message({ text: "just chatting" }))).toEqual({
      notify: false,
      reason: "level",
    });
  });

  it("rings for @here only while you are actually here", () => {
    const s = state({ prefs: { C1: { notifyLevel: "mentions", muted: false } } });
    const here = message({ text: "<!here> anyone free?" });
    expect(decideNotification(s, here, { live: true })).toEqual({
      notify: true,
      reason: "broadcast",
    });
    // Caught up on after a reconnect: you were not here when it was asked.
    expect(decideNotification(s, here, { live: false })).toEqual({
      notify: false,
      reason: "not-here",
    });
    // @channel is not conditional on being around, which is the difference
    // between the two and the reason both exist.
    expect(
      decideNotification(s, message({ text: "<!channel> read this" }), { live: false }).notify,
    ).toBe(true);
  });

  it("still obeys mute and Do Not Disturb when a room is addressed", () => {
    const muted = state({ prefs: { C1: { notifyLevel: "all", muted: true } } });
    expect(decideNotification(muted, message({ text: "<!channel> hello" }))).toEqual({
      notify: false,
      reason: "muted",
    });

    const now = 1_000_000;
    const snoozed = state({ self: { ...me, dndUntil: now + 60_000 } });
    expect(decideNotification(snoozed, message({ text: "<!channel> hello" }), { now })).toEqual({
      notify: false,
      reason: "dnd",
    });

    const nothing = state({ prefs: { C1: { notifyLevel: "nothing", muted: false } } });
    expect(decideNotification(nothing, message({ text: "<!here> hello" }))).toEqual({
      notify: false,
      reason: "level",
    });
  });

  it("ignores a room-wide mention in a direct message, where it means nothing", () => {
    const s = state({
      channels: { C1: channel("dm") },
      prefs: { C1: { notifyLevel: "mentions", muted: false } },
    });
    // Still notified, because it is a DM — but as a DM, not as a broadcast.
    expect(decideNotification(s, message({ text: "<!here> hi" }))).toEqual({
      notify: true,
      reason: "dm",
    });
  });

  it("reads room-wide mentions out in the notification body", () => {
    const s = state();
    expect(notificationBody(s, message({ text: "<!here> ship it" }))).toBe("@here ship it");
    expect(notificationBody(s, message({ text: "<!everyone> ship it" }))).toBe("@channel ship it");
  });
});

describe("isMessageOnScreen", () => {
  const looking = {
    focused: true,
    channelId: "C1",
    channelVisible: true,
    threadRootId: null,
    threadVisible: false,
  };
  const reply = (over: Partial<Message> = {}) => message({ threadRootId: "ROOT", ...over });

  it("counts a message in the conversation being looked at", () => {
    expect(isMessageOnScreen(message(), looking)).toBe(true);
    // A reply also sent to the channel shows in its timeline.
    expect(isMessageOnScreen(reply({ broadcast: true }), looking)).toBe(true);
  });

  it("does not count a reply in a thread that is not open, though its channel is", () => {
    expect(isMessageOnScreen(reply(), looking)).toBe(false);
    const otherThread = { ...looking, threadRootId: "OTHER", threadVisible: true };
    expect(isMessageOnScreen(reply(), otherThread)).toBe(false);
    const thisThread = { ...looking, threadRootId: "ROOT", threadVisible: true };
    expect(isMessageOnScreen(reply(), thisThread)).toBe(true);
  });

  it("does not count what is covered, in the background, or somewhere else", () => {
    expect(isMessageOnScreen(message(), { ...looking, focused: false })).toBe(false);
    // A phone's side panel over the timeline.
    const panelOver = {
      ...looking,
      channelVisible: false,
      threadRootId: "ROOT",
      threadVisible: true,
    };
    expect(isMessageOnScreen(message(), panelOver)).toBe(false);
    expect(isMessageOnScreen(reply(), panelOver)).toBe(true);
    // A phone's drawer over everything.
    const drawerOver = { ...panelOver, threadVisible: false };
    expect(isMessageOnScreen(reply(), drawerOver)).toBe(false);
    expect(isMessageOnScreen(message({ channelId: "C2" }), looking)).toBe(false);
  });
});
