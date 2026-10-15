import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Channel, Message, User } from "@slackoss/protocol";
import { App } from "../src/App.js";
import type { SavedServer } from "../src/platform.js";

const rocket: SavedServer = {
  url: "http://127.0.0.1:9",
  token: "test-token-not-a-credential",
  workspaceName: "Rocket Team",
  handle: "sam",
  lastUsedAt: 1,
};
const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};
const alex: User = { ...sam, id: "U_ALEX", handle: "alex", displayName: "Alex Chen" };
const general: Channel = {
  id: "C_GENERAL",
  type: "public",
  name: "general",
  topic: "",
  description: "",
  creatorId: alex.id,
  archived: false,
  createdAt: 0,
};

const mention = (over: Partial<Message> = {}): Message => ({
  id: "M_NEW",
  channelId: general.id,
  userId: alex.id,
  text: `<@${sam.id}> can you look at this?`,
  threadRootId: null,
  broadcast: false,
  seq: 5,
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

/** The workspace screen with #general open and focused, on a wide window. */
async function lookingAtGeneral(previews: Record<string, string> | null = null) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    // Wide: the layout's min-width queries hold and its max-width ones do not.
    matches: !query.includes("max-width"),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const connect = vi.spyOn(WorkspaceClient.prototype, "connect").mockImplementation(() => {});
  vi.spyOn(WorkspaceClient.prototype, "loadTimeline").mockResolvedValue(undefined as never);
  const notify = vi.fn();
  render(
    <App
      platform={{
        kind: "web",
        storage: {
          get: async <T,>(key: string) =>
            (key === "servers"
              ? [rocket]
              : key === "notification-previews"
                ? previews
                : null) as T | null,
          set: async () => {},
        },
        notify,
      }}
    />,
  );
  await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
  const client = connect.mock.contexts[0] as WorkspaceClient;
  act(() =>
    client.store.setState({
      status: "online",
      workspaceName: "Rocket Team",
      self: sam,
      users: { [sam.id]: sam, [alex.id]: alex },
      channels: { [general.id]: general },
      memberships: { [general.id]: 0 },
    }),
  );
  await waitFor(() => expect(screen.getByRole("textbox", { name: /general/ })).toBeVisible());
  const arrive = (message: Message) =>
    act(() => client.onIncomingMessage?.(message, { live: true }));
  /** As a reconnect replays what was missed. */
  const replay = (message: Message) =>
    act(() => client.onIncomingMessage?.(message, { live: false }));
  return { arrive, replay, notify, client };
}

describe("notifying about a message in the conversation on screen", () => {
  afterEach(() => {
    // Unmount before the globals go: the setup file's cleanup runs after this
    // hook, and a screen still mounting would reach for matchMedia without them.
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stays quiet for a mention in the channel being read", async () => {
    const { arrive, notify } = await lookingAtGeneral();
    arrive(mention());
    expect(notify).not.toHaveBeenCalled();
  });

  it("tells about a mention in a thread that is not open, though its channel is", async () => {
    const { arrive, notify } = await lookingAtGeneral();
    // It used to be silenced because #general was selected, though the reply
    // shows only inside a thread nobody had open.
    arrive(mention({ id: "M_REPLY", threadRootId: "M_ROOT" }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toBe("Alex Chen in #general");
  });

  describe("showing only what this account chose (IMP-03)", () => {
    const account = `${rocket.url} ${sam.id}`;
    const reply = () => mention({ id: "M_REPLY", threadRootId: "M_ROOT" });

    it("names nobody and says nothing of the message when the choice is nothing", async () => {
      const { arrive, notify } = await lookingAtGeneral({ [account]: "none" });
      arrive(reply());
      expect(notify).toHaveBeenCalledTimes(1);
      const [title, body] = notify.mock.calls[0]!;
      expect([title, body]).toEqual(["New message", "Open Tandem to read it."]);
      expect(`${title} ${body}`).not.toMatch(/Alex|general|look at this/);
    });

    it("names the sender and the channel, not the words, when the choice is the sender", async () => {
      const { arrive, notify } = await lookingAtGeneral({ [account]: "sender" });
      arrive(reply());
      expect(notify.mock.calls[0]!.slice(0, 2)).toEqual(["Alex Chen in #general", "New message"]);
    });

    it("shows the message for an account that has not chosen", async () => {
      const { arrive, notify } = await lookingAtGeneral({ "http://elsewhere:9 U_SAM": "none" });
      arrive(reply());
      expect(notify.mock.calls[0]!.slice(0, 2)).toEqual([
        "Alex Chen in #general",
        "@Sam Rivera can you look at this?",
      ]);
    });

    it("tags a message's notification the same in every window of the account", async () => {
      const { arrive, notify } = await lookingAtGeneral();
      arrive(reply());
      expect(notify.mock.calls[0]![3]).toEqual({ tag: `${account} M_REPLY` });
    });
  });

  describe("catching up after a reconnect (IMP-03)", () => {
    const account = `${rocket.url} ${sam.id}`;
    // Replies in a thread that is not open, so #general on screen does not hide them.
    const missed = (n: number) =>
      mention({ id: `M_MISSED_${n}`, threadRootId: "M_ROOT", seq: 10 + n });

    afterEach(() => vi.useRealTimers());

    async function caughtUp(count: number, previews: Record<string, string> | null = null) {
      const screen = await lookingAtGeneral(previews);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      for (let n = 0; n < count; n++) screen.replay(missed(n));
      return screen;
    }
    const settle = () => act(() => vi.advanceTimersByTime(1_000));

    it("tells about a hundred missed messages once, when the replay is over", async () => {
      const { notify } = await caughtUp(100);
      expect(notify).not.toHaveBeenCalled();
      settle();
      expect(notify).toHaveBeenCalledTimes(1);
      const [title, body, open, options] = notify.mock.calls[0]!;
      expect([title, body]).toEqual(["100 new messages in #general", "From Alex Chen"]);
      expect(options).toEqual({ tag: `${account} catch-up M_MISSED_0` });
      expect(open).toBeTypeOf("function");
    });

    it("names nobody and no conversation when the choice is nothing", async () => {
      const { notify } = await caughtUp(2, { [account]: "none" });
      settle();
      expect(notify.mock.calls[0]!.slice(0, 2)).toEqual([
        "2 new messages",
        "Open Tandem to read them.",
      ]);
    });

    it("leaves out what was read elsewhere or deleted, and tells the one left as itself", async () => {
      const { notify, client } = await caughtUp(3);
      // Read on another device up to the first; the second deleted since.
      act(() => client.store.setState({ memberships: { [general.id]: missed(0).seq } }));
      act(() => client.onMessageDeleted?.("M_MISSED_1"));
      settle();
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0]!.slice(0, 2)).toEqual([
        "Alex Chen in #general",
        "@Sam Rivera can you look at this?",
      ]);
      expect(notify.mock.calls[0]![3]).toEqual({ tag: `${account} M_MISSED_2` });
    });

    it("says nothing once the channel was muted before the summary", async () => {
      const { notify, client } = await caughtUp(5);
      act(() =>
        client.store.setState({
          prefs: { [general.id]: { notifyLevel: "mentions", muted: true } },
        }),
      );
      settle();
      expect(notify).not.toHaveBeenCalled();
    });

    it("keeps telling live messages one by one meanwhile", async () => {
      const { arrive, notify } = await caughtUp(4);
      arrive(mention({ id: "M_LIVE", threadRootId: "M_ROOT", seq: 99 }));
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0]![3]).toEqual({ tag: `${account} M_LIVE` });
      settle();
      expect(notify).toHaveBeenCalledTimes(2);
      expect(notify.mock.calls[1]![0]).toBe("4 new messages in #general");
    });
  });
});
