import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient, type HuddlePeer, type HuddleState } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { render } from "./render.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import { webPlatform } from "../src/platform.js";
import { HuddleBar } from "../src/components/HuddleBar.js";
import { HuddleStage } from "../src/components/HuddleStage.js";
import { CallAnnouncer, REACTION_SAID_MS } from "../src/components/CallAnnouncer.js";
import { accessibilityProblems } from "./accessibility.js";

/** Reactions and raised hands in a call (K17), as each view shows them. */
const platform = webPlatform();

beforeAll(() => {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const person = (id: string, displayName: string): User => ({
  id,
  handle: displayName.split(" ")[0]!.toLowerCase(),
  displayName,
  role: "member",
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});

const general: Channel = {
  id: "C_GENERAL",
  type: "public",
  name: "general",
  topic: "",
  description: "",
  creatorId: "U_MAYA",
  archived: false,
  createdAt: 0,
};

const peer = (userId: string): HuddlePeer => ({
  userId,
  audioStream: null,
  cameraStream: null,
  screenStream: null,
  connected: true,
  micMuted: false,
  speaking: false,
});

const users = {
  U_MAYA: person("U_MAYA", "Maya Chen"),
  U_SAM: person("U_SAM", "Sam Rivera"),
  U_PRIYA: person("U_PRIYA", "Priya Shah"),
};

/** Maya's call with Sam and Priya. */
function call(huddle: Partial<HuddleState> = {}) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: users.U_MAYA,
    users,
    channels: { C_GENERAL: general },
    status: "online",
    huddle: {
      channelId: "C_GENERAL",
      micMuted: false,
      cameraOn: false,
      sharingScreen: false,
      localCameraStream: null,
      localScreenStream: null,
      speaking: false,
      micLost: false,
      peers: [peer("U_SAM"), peer("U_PRIYA")],
      ...huddle,
    },
  });
  return client;
}

function show(client: WorkspaceClient, view: "stage" | "bar") {
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        {view === "stage" ? (
          <HuddleStage onOpenSettings={() => {}} onHide={() => {}} />
        ) : (
          <HuddleBar onOpenSettings={() => {}} />
        )}
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  return userEvent.setup();
}

const tile = (name: RegExp) =>
  within(screen.getByRole("list", { name: "Everyone in the huddle" })).getByRole("group", {
    name,
  });

/** What the browser says of reduced motion, which jsdom does not know. */
function reducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: reduce && query.includes("prefers-reduced-motion: reduce"),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  );
}

describe("a reaction over its sender's tile", () => {
  it("rises from Sam's tile, and only his", () => {
    reducedMotion(false);
    show(call({ reactions: [{ id: 1, userId: "U_SAM", emoji: "👍" }] }), "stage");
    const sam = tile(/^Sam Rivera/);
    const float = sam.querySelector('[data-reaction="float"]');
    expect(float).toHaveTextContent("👍");
    expect(float).toHaveClass("animate-call-react");
    expect(float).toHaveAttribute("aria-hidden", "true");
    expect(sam.querySelector('[data-reaction="still"]')).toBeNull();
    expect(tile(/^Priya Shah/).querySelector("[data-reaction]")).toBeNull();
    expect(tile(/^You/).querySelector("[data-reaction]")).toBeNull();
  });

  it("stands still on the tile for someone who asked for less motion", () => {
    reducedMotion(true);
    show(
      call({
        reactions: [
          { id: 1, userId: "U_SAM", emoji: "👍" },
          { id: 2, userId: "U_SAM", emoji: "🎉" },
        ],
      }),
      "stage",
    );
    const sam = tile(/^Sam Rivera/);
    expect(sam.querySelector('[data-reaction="float"]')).toBeNull();
    const still = sam.querySelectorAll('[data-reaction="still"]');
    expect(still).toHaveLength(1);
    expect(still[0]).toHaveTextContent("🎉");
    expect(still[0]!.className).not.toMatch(/animate/);
  });
});

describe("a raised hand", () => {
  it("shows on the tile and is said in its name", async () => {
    show(call({ hands: ["U_PRIYA"] }), "stage");
    const priya = tile(/^Priya Shah/);
    expect(priya).toHaveAccessibleName("Priya Shah, hand raised, camera off");
    expect(priya.querySelector("[data-hand]")).not.toBeNull();
    expect(tile(/^Sam Rivera/).querySelector("[data-hand]")).toBeNull();
    expect(
      await accessibilityProblems(screen.getByRole("region", { name: "Huddle call" })),
    ).toEqual([]);
  });

  it("puts its person first in the bar's list of everyone, first raised first", async () => {
    const user = show(call({ hands: ["U_PRIYA", "U_MAYA"] }), "bar");
    await user.click(screen.getByRole("button", { name: "Everyone in the huddle (3)" }));
    const people = within(screen.getByRole("dialog", { name: "Everyone in the huddle" })).getByRole(
      "list",
      { name: "In the huddle" },
    );
    expect(
      within(people)
        .getAllByRole("listitem")
        .map((row) => row.getAttribute("aria-label")),
    ).toEqual(["Priya Shah, hand raised", "You, hand raised", "Sam Rivera"]);
  });
});

describe("the call's reaction and hand buttons", () => {
  it("open the quick reactions, send one, and raise the hand", async () => {
    const client = call();
    const react = vi.spyOn(client, "reactInHuddle").mockImplementation(() => {});
    const hand = vi.spyOn(client, "toggleHand").mockImplementation(() => {});
    const user = show(client, "stage");
    const controls = within(screen.getByRole("region", { name: "Huddle call" }));

    const reactions = controls.getByRole("button", { name: "Reactions" });
    expect(reactions).toHaveAttribute("aria-expanded", "false");
    await user.click(reactions);
    const bar = controls.getByRole("group", { name: "Reactions" });
    expect(
      within(bar)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Thumbs up", "Heart", "Laughing", "Party", "Clapping", "Surprised", "More emoji"]);
    await user.click(within(bar).getByRole("button", { name: "Thumbs up" }));
    expect(react).toHaveBeenCalledWith("👍");
    // It stays open for another.
    await user.click(within(bar).getByRole("button", { name: "Clapping" }));
    expect(react).toHaveBeenLastCalledWith("👏");
    expect(await accessibilityProblems(bar)).toEqual([]);
    await user.keyboard("{Escape}");
    expect(controls.queryByRole("group", { name: "Reactions" })).toBeNull();
    expect(reactions).toHaveFocus();

    const raise = controls.getByRole("button", { name: "Raise hand", pressed: false });
    await user.click(raise);
    expect(hand).toHaveBeenCalledOnce();
    // Pressed once the server says the hand is up.
    act(() => client.store.setState((s) => ({ huddle: { ...s.huddle!, hands: ["U_MAYA"] } })));
    expect(controls.getByRole("button", { name: "Raise hand", pressed: true })).toBe(raise);
  });

  it("show the newest reaction beside the faces in the bar", () => {
    show(call({ reactions: [{ id: 3, userId: "U_SAM", emoji: "🎉" }] }), "bar");
    const region = screen.getByRole("region", { name: "Active huddle" });
    expect(region.querySelector('[data-reaction="ticker"]')).toHaveTextContent("🎉");
  });
});

describe("what a screen reader hears of reactions and hands", () => {
  const announcer = (props: Partial<Parameters<typeof CallAnnouncer>[0]> = {}) => (
    <CallAnnouncer peerIds={["U_SAM", "U_PRIYA"]} users={users} selfId="U_MAYA" {...props} />
  );

  it("says a reaction at most once every five seconds, and not your own", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      announcer({ reactions: [{ id: 1, userId: "U_SAM", emoji: "👀" }] }),
    );
    const log = screen.getByRole("log", { name: "Huddle updates" });
    // One already showing when the call came up is not news.
    expect(log).toBeEmptyDOMElement();

    rerender(announcer({ reactions: [{ id: 2, userId: "U_MAYA", emoji: "👍" }] }));
    expect(log).toBeEmptyDOMElement();
    rerender(announcer({ reactions: [{ id: 3, userId: "U_SAM", emoji: "👍" }] }));
    expect(log).toHaveTextContent(/^Sam Rivera reacted 👍$/);
    rerender(announcer({ reactions: [{ id: 4, userId: "U_PRIYA", emoji: "🎉" }] }));
    act(() => void vi.advanceTimersByTime(REACTION_SAID_MS - 1));
    rerender(announcer({ reactions: [{ id: 5, userId: "U_PRIYA", emoji: "😂" }] }));
    expect(log).not.toHaveTextContent("Priya");
    act(() => void vi.advanceTimersByTime(1));
    rerender(announcer({ reactions: [{ id: 6, userId: "U_PRIYA", emoji: "😮" }] }));
    expect(log).toHaveTextContent("Priya Shah reacted 😮");
    expect(log.querySelectorAll("p")).toHaveLength(2);
  });

  it("says a hand raised once, not one up before you came, nor your own", () => {
    const { rerender } = render(announcer({ hands: ["U_SAM"] }));
    const log = screen.getByRole("log", { name: "Huddle updates" });
    rerender(announcer({ hands: ["U_SAM", "U_PRIYA"] }));
    rerender(announcer({ hands: ["U_SAM", "U_PRIYA", "U_MAYA"] }));
    rerender(announcer({ hands: ["U_SAM", "U_PRIYA", "U_MAYA"], reactions: [] }));
    expect(log).toHaveTextContent(/^Priya Shah raised their hand$/);
  });
});
