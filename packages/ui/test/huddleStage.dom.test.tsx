import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient, type HuddlePeer, type HuddleState } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { ToastProvider } from "../src/components/Toast.js";
import { webPlatform, type Platform } from "../src/platform.js";
import { HuddleBar, HuddleButton } from "../src/components/HuddleBar.js";
import { bestFit, HuddleStage } from "../src/components/HuddleStage.js";
import { useHuddleView } from "../src/lib/huddleView.js";
import { accessibilityProblems } from "./accessibility.js";

/** Where call preferences are kept, as in the app. */
const platform = webPlatform();

// jsdom has no media pipeline: a video only needs somewhere to put a stream.
beforeAll(() => {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
});
const stream = () => ({}) as MediaStream;

const person = (id: string, displayName: string): User => ({
  id,
  handle: displayName.split(" ")[0]!.toLowerCase(),
  displayName,
  role: "member",
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
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
};

const peer = (userId: string, media: Partial<HuddlePeer> = {}): HuddlePeer => ({
  userId,
  audioStream: null,
  cameraStream: null,
  screenStream: null,
  connected: true,
  micMuted: false,
  speaking: false,
  ...media,
});

/** A huddle in #general over a client that never connects, you being Sam. */
function huddleClient(huddle: Partial<HuddleState>) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  const sam = person("U_SAM", "Sam Rivera");
  client.store.setState({
    self: sam,
    users: { U_SAM: sam, U_PRIYA: person("U_PRIYA", "Priya Shah") },
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
      peers: [peer("U_PRIYA")],
      ...huddle,
    },
  });
  return client;
}

function stage(
  huddle: Partial<HuddleState>,
  { on = platform, chat }: { on?: Platform; chat?: { shown: boolean } } = {},
) {
  const client = huddleClient(huddle);
  const onHide = vi.fn();
  const onToggle = vi.fn();
  render(
    <PlatformContext.Provider value={on}>
      <ClientContext.Provider value={client}>
        <HuddleStage onHide={onHide} chat={chat && { shown: chat.shown, onToggle }} />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  return { client, onHide, onToggle, user: userEvent.setup() };
}

const region = () => screen.getByRole("region", { name: "Huddle call" });
const control = (name: string) => within(region()).getByRole("button", { name });

/** Full screen as a browser gives it, which jsdom has none of. */
function fakeFullscreen() {
  let element: Element | null = null;
  const change = () => document.dispatchEvent(new Event("fullscreenchange"));
  const enter = vi.fn(function (this: Element) {
    element = this;
    change();
    return Promise.resolve();
  });
  const exit = vi.fn(() => {
    element = null;
    change();
    return Promise.resolve();
  });
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => true });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => element });
  Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
    configurable: true,
    value: enter,
  });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
  const restore = () => {
    for (const name of ["fullscreenEnabled", "fullscreenElement", "exitFullscreen"])
      Reflect.deleteProperty(document, name);
    Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
  };
  return { enter, exit, restore };
}

describe("the call", () => {
  it("shows everyone as a tile in a call without video, as Discord shows a voice channel", async () => {
    stage({ peers: [peer("U_PRIYA", { micMuted: true })] });
    expect(region()).toHaveTextContent("#general");
    const everyone = within(region()).getByRole("list", { name: "Everyone in the huddle" });
    expect(
      within(everyone)
        .getAllByRole("group")
        .map((tile) => tile.getAttribute("aria-label")),
    ).toEqual(["You, camera off", "Priya Shah, camera off, muted"]);
    // The controls are the call's own, along its bottom.
    expect(within(region()).getByRole("group", { name: "Huddle controls" })).toBeVisible();
    expect(control("Leave")).toBeVisible();
    expect(await accessibilityProblems(region())).toEqual([]);
  });

  it("gives everyone a tile of the same size, and says whose camera or microphone is off", async () => {
    stage({
      localCameraStream: stream(),
      cameraOn: true,
      peers: [peer("U_PRIYA", { micMuted: true })],
    });
    const everyone = within(region()).getByRole("list", { name: "Everyone in the huddle" });
    expect(
      within(everyone)
        .getAllByRole("group")
        .map((tile) => tile.getAttribute("aria-label")),
    ).toEqual(["You", "Priya Shah, camera off, muted"]);
    expect(await accessibilityProblems(region())).toEqual([]);
  });

  it("sets how loud someone is to you from their tile, in the tile so it shows in full screen", async () => {
    // A device of its own, so nobody stays muted for the tests after.
    const device = {
      kind: "web",
      storage: { get: async () => null, set: async () => {} },
      notify: () => {},
    } as unknown as Platform;
    const { user } = stage({ localCameraStream: stream(), cameraOn: true }, { on: device });
    const everyone = within(region()).getByRole("list", { name: "Everyone in the huddle" });
    // Yours is not yours to set.
    expect(within(everyone).getAllByRole("button", { name: /^Volume for / })).toHaveLength(1);
    const open = within(everyone).getByRole("button", { name: "Volume for Priya Shah" });
    expect(open).toHaveAttribute("aria-expanded", "false");
    await user.click(open);
    expect(open).toHaveAttribute("aria-expanded", "true");
    const tile = within(everyone).getByRole("group", { name: "Priya Shah, camera off" });
    // Inside her tile, not portalled out of the call.
    const volume = within(tile).getByRole("slider", { name: "Priya Shah's volume" });
    expect(volume).toHaveValue("100");
    await user.click(within(tile).getByRole("button", { name: "Mute Priya Shah for you" }));
    expect(
      within(everyone).getByRole("group", { name: "Priya Shah, camera off, muted for you" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(within(everyone).queryByRole("slider")).not.toBeInTheDocument();
    expect(open).toHaveFocus();
    expect(await accessibilityProblems(region())).toEqual([]);
  });

  it("says a shared screen has sound, and sets its volume apart from the sharer's voice", async () => {
    const device = {
      kind: "web",
      storage: { get: async () => null, set: async () => {} },
      notify: () => {},
    } as unknown as Platform;
    const { user } = stage(
      { peers: [peer("U_PRIYA", { screenStream: stream(), screenSoundStream: stream() })] },
      { on: device },
    );
    const share = within(region()).getByRole("group", { name: "Priya Shah's screen, with sound" });
    await user.click(control("Volume for Priya Shah's screen"));
    expect(within(share).getByRole("slider", { name: "Priya Shah's screen volume" })).toHaveValue(
      "100",
    );
    await user.click(
      within(share).getByRole("button", { name: "Mute Priya Shah's screen for you" }),
    );
    expect(
      within(region()).getByRole("group", { name: "Priya Shah's screen, sound muted for you" }),
    ).toBeInTheDocument();
    // Her voice is as it was.
    const strip = within(region()).getByRole("list", { name: "Everyone else" });
    expect(within(strip).getByRole("button", { name: "Pin Priya Shah, camera off" })).toBeVisible();
    expect(await accessibilityProblems(region())).toEqual([]);
  });

  it("tells you when everyone can hear your share as well as see it", () => {
    stage({ localScreenStream: stream(), sharingScreen: true, sharingScreenSound: true });
    expect(
      within(region()).getByRole("group", { name: "Your screen, with sound" }),
    ).toHaveTextContent("Everyone in the huddle can see and hear it");
  });

  it("gives a shared screen the main view, and lets you pin someone in its place", async () => {
    const { user } = stage({
      peers: [peer("U_PRIYA", { cameraStream: stream(), screenStream: stream() })],
    });
    expect(region()).toHaveTextContent("Priya Shah is sharing their screen");
    const strip = () => within(region()).getByRole("list", { name: "Everyone else" });
    expect(within(region()).getByRole("group", { name: "Priya Shah's screen" })).toBeVisible();
    expect(
      within(strip())
        .getAllByRole("button")
        .map((tile) => tile.getAttribute("aria-label")),
    ).toEqual(["Pin You, camera off", "Pin Priya Shah"]);
    expect(await accessibilityProblems(region())).toEqual([]);

    await user.click(within(strip()).getByRole("button", { name: "Pin Priya Shah" }));
    expect(region()).toHaveTextContent("Priya Shah is pinned");
    expect(within(strip()).getByRole("button", { name: "Pin Priya Shah's screen" })).toBeVisible();

    await user.click(control("Unpin Priya Shah"));
    expect(region()).toHaveTextContent("Priya Shah is sharing their screen");
  });

  it("puts everyone else in a row under a share, which can be put away", async () => {
    const { user } = stage({ peers: [peer("U_PRIYA", { screenStream: stream() })] });
    const strip = () => within(region()).queryByRole("list", { name: "Everyone else" });
    expect(strip()).toBeVisible();
    expect(control("Everyone else")).toHaveAttribute("aria-pressed", "true");
    await user.click(control("Everyone else"));
    expect(strip()).toBeNull();
    expect(control("Everyone else")).toHaveAttribute("aria-pressed", "false");
    await user.click(control("Everyone else"));
    expect(strip()).toBeVisible();
  });

  it("shows you a way to stop your own share instead of the share itself, full size", async () => {
    const { client, user } = stage({ localScreenStream: stream(), sharingScreen: true });
    const stop = vi.spyOn(client, "toggleScreenShare").mockResolvedValue();
    const yours = within(region()).getByRole("group", { name: "Your screen" });
    expect(yours).toHaveTextContent("You're sharing your screen");
    await user.click(within(yours).getByRole("button", { name: "Stop sharing" }));
    expect(stop).toHaveBeenCalledOnce();
  });

  it("can show a share at the same size as everyone else", async () => {
    const { user } = stage({ peers: [peer("U_PRIYA", { screenStream: stream() })] });
    await user.click(control("Grid view"));
    expect(control("Grid view")).toHaveAttribute("aria-pressed", "true");
    const everyone = within(region()).getByRole("list", { name: "Everyone in the huddle" });
    expect(within(everyone).getByRole("group", { name: "Priya Shah's screen" })).toBeVisible();
  });

  it("goes back to the chat, and shows or hides the chat beside it where there is room", async () => {
    const { onHide, onToggle, user } = stage(
      { localCameraStream: stream() },
      { chat: { shown: true } },
    );
    expect(control("Chat")).toHaveAttribute("aria-pressed", "true");
    await user.click(control("Chat"));
    expect(onToggle).toHaveBeenCalledOnce();
    await user.click(control("Hide call"));
    expect(onHide).toHaveBeenCalledOnce();
  });

  it("has no chat button where the chat has no room beside it", () => {
    stage({ localCameraStream: stream() });
    expect(within(region()).queryByRole("button", { name: "Chat" })).toBeNull();
    expect(control("Hide call")).toBeVisible();
  });

  it("fills the screen with a share, everyone else put away at first, until Escape", async () => {
    const fullscreen = fakeFullscreen();
    try {
      const { user } = stage({
        peers: [peer("U_PRIYA", { cameraStream: stream(), screenStream: stream() })],
      });
      const strip = () => within(region()).queryByRole("list", { name: "Everyone else" });
      await user.click(control("Full screen"));
      expect(fullscreen.enter).toHaveBeenCalledOnce();
      expect(fullscreen.enter.mock.contexts[0]).toBe(region());
      expect(control("Full screen")).toHaveAttribute("aria-pressed", "true");
      // The share alone: nobody else, and nothing that only matters beside the chat.
      expect(strip()).toBeNull();
      expect(control("Everyone else")).toHaveAttribute("aria-pressed", "false");
      expect(within(region()).queryByRole("button", { name: "Hide call" })).toBeNull();
      // Menus would open outside the full-screen picture, out of sight.
      expect(within(region()).queryByRole("button", { name: "Microphone and speaker" })).toBeNull();
      await user.click(control("Everyone else"));
      expect(strip()).toBeVisible();

      // The desktop app does not leave full screen on Escape by itself.
      await user.keyboard("{Escape}");
      expect(fullscreen.exit).toHaveBeenCalledOnce();
      expect(control("Full screen")).toHaveAttribute("aria-pressed", "false");
      // Out of full screen, the row is as it was there.
      expect(strip()).toBeVisible();
    } finally {
      fullscreen.restore();
    }
  });

  it("takes the theme's colours, and Onyx's in full screen, where a share fills the screen on black", async () => {
    const fullscreen = fakeFullscreen();
    try {
      const { user } = stage({ peers: [peer("U_PRIYA", { screenStream: stream() })] });
      expect(region()).not.toHaveClass("call-dark");
      await user.click(control("Full screen"));
      expect(region()).toHaveClass("call-dark");
      await user.keyboard("{Escape}");
      expect(region()).not.toHaveClass("call-dark");
    } finally {
      fullscreen.restore();
    }
  });

  it("tells the client how big it draws everyone's camera and share, and nothing out of sight (E13b)", async () => {
    // jsdom lays nothing out, so the stage is given a size to fit tiles to.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ width: 1000, height: 600 }),
    );
    const visibility = vi.spyOn(document, "visibilityState", "get");
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    try {
      const { client } = stage({ peers: [peer("U_PRIYA", { cameraStream: stream() })] });
      const told = vi.spyOn(client, "setCallViews");
      await act(async () => {});
      // You and Priya, one above the other; her tile in device pixels, at twice the CSS.
      const tile = Math.floor(bestFit(2, 1000, 600).width / (16 / 9));
      expect(told).toHaveBeenCalledOnce();
      expect(told).toHaveBeenLastCalledWith(
        new Map([["U_PRIYA", { camera: tile * 2, screen: 0 }]]),
      );

      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(told).toHaveBeenLastCalledWith(new Map());
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(told.mock.lastCall![0].get("U_PRIYA")).toEqual({ camera: tile * 2, screen: 0 });

      cleanup();
      expect(told).toHaveBeenLastCalledWith(new Map());

      // A share large, her camera in the row under it, then that row put away.
      const shared = stage({
        peers: [peer("U_PRIYA", { cameraStream: stream(), screenStream: stream() })],
      });
      const toldShare = vi.spyOn(shared.client, "setCallViews");
      await act(async () => {});
      const withRow = toldShare.mock.lastCall![0].get("U_PRIYA")!;
      expect(withRow.camera).toBeGreaterThan(0);
      expect(withRow.screen).toBeGreaterThan(withRow.camera * 3);
      await shared.user.click(control("Everyone else"));
      await act(async () => {});
      const rowAway = toldShare.mock.lastCall![0].get("U_PRIYA")!;
      expect(rowAway.camera).toBe(0);
      expect(rowAway.screen).toBeGreaterThan(withRow.screen);
    } finally {
      Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
      vi.restoreAllMocks();
    }
  });

  it("has nothing that moves forever, or blurs a video, so a still call is not drawn again (E13b)", () => {
    // Either has every frame of the call drawn again: in a call of seven each
    // cost a fifth of a core per person. The spinner shows only while connecting.
    const busy = (root: Element) =>
      [...root.querySelectorAll("[class]")]
        .map((el) => el.getAttribute("class")!)
        .filter((names) => /(^|\s)(backdrop-blur\S*|animate-(?!spin)\S+)/.test(names));
    // Everyone the same size, with a pin and a volume over each tile, then a share large.
    stage({ peers: [peer("U_PRIYA", { cameraStream: stream() })] });
    expect(within(region()).getAllByRole("button", { name: /^Pin / }).length).toBeGreaterThan(0);
    expect(busy(region())).toEqual([]);
    cleanup();
    const { client } = stage({
      peers: [peer("U_PRIYA", { cameraStream: stream(), screenStream: stream() })],
    });
    expect(busy(region())).toEqual([]);
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <HuddleButton channelId="C_GENERAL" />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const pill = screen.getByText("In huddle").parentElement!;
    expect(busy(pill)).toEqual([]);
  });

  it("goes in and out of full screen when the share is double-clicked", async () => {
    const fullscreen = fakeFullscreen();
    try {
      const { user } = stage({ peers: [peer("U_PRIYA", { screenStream: stream() })] });
      const share = () => within(region()).getByRole("group", { name: "Priya Shah's screen" });
      await user.dblClick(share());
      expect(fullscreen.enter).toHaveBeenCalledOnce();
      await user.dblClick(share());
      expect(fullscreen.exit).toHaveBeenCalledOnce();
    } finally {
      fullscreen.restore();
    }
  });
});

describe("the huddle bar", () => {
  function bar(huddle: Partial<HuddleState>, view?: "call" | "chat") {
    const client = huddleClient(huddle);
    const onViewChange = vi.fn();
    const ui = (next?: "call" | "chat") => (
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <HuddleBar view={next} onViewChange={onViewChange} />
        </ClientContext.Provider>
      </PlatformContext.Provider>
    );
    const { rerender } = render(ui(view));
    return { onViewChange, rerender: (next: "call" | "chat") => rerender(ui(next)) };
  }

  it("offers the call, with video or without", async () => {
    const { onViewChange } = bar({});
    await userEvent.setup().click(screen.getByRole("button", { name: "Show call" }));
    expect(onViewChange).toHaveBeenCalledWith("call");
  });

  it("keeps only the call's sound while the call shows, and the same sound after", () => {
    const { rerender } = bar({ peers: [peer("U_PRIYA", { audioStream: stream() })] }, "call");
    // The call has the controls; two sets would open two screen pickers.
    expect(screen.queryByRole("region", { name: "Active huddle" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Huddle controls" })).toBeNull();
    const sound = document.querySelector("audio");
    expect(sound).not.toBeNull();
    rerender("chat");
    expect(screen.getByRole("region", { name: "Active huddle" })).toBeVisible();
    // Not started again, so nobody's voice skips on the way.
    expect(document.querySelector("audio")).toBe(sound);
  });

  it("says who is sharing, in the status a screen reader announces", () => {
    bar({ peers: [peer("U_PRIYA", { screenStream: stream() })] });
    expect(screen.getByRole("status")).toHaveTextContent(
      "With Priya Shah · Priya Shah is sharing their screen",
    );
  });

  it("says once, in a notice that goes by itself, when a call grows past what it holds (E13b)", () => {
    const onCamera = (n: number) =>
      Array.from({ length: n }, (_, i) => peer(`U_${i}`, { cameraStream: stream() }));
    const client = huddleClient({ peers: onCamera(8) });
    vi.useFakeTimers();
    try {
      render(
        <ToastProvider>
          <PlatformContext.Provider value={platform}>
            <ClientContext.Provider value={client}>
              <HuddleBar />
            </ClientContext.Provider>
          </PlatformContext.Provider>
        </ToastProvider>,
      );
      const huddle = () => client.store.getState().huddle!;
      // Eight cameras hold up, and the bar itself no longer says anything about size.
      expect(screen.queryByText(/can stutter/)).toBeNull();
      expect(screen.getAllByRole("status")).toHaveLength(1);

      // Yours makes nine: told once, politely, with nothing to press but Dismiss.
      act(() => client.store.setState({ huddle: { ...huddle(), cameraOn: true } }));
      const notice = screen.getByText(
        "With more than 8 cameras on, the call can stutter. Turning cameras off helps.",
      );
      expect(notice.closest("[aria-live]")).toHaveAttribute("aria-live", "polite");
      // Someone else joining while it stays that big says nothing new: the notice
      // goes when its own five seconds are up, not five seconds after the join.
      act(() => vi.advanceTimersByTime(4000));
      act(() =>
        client.store.setState({ huddle: { ...huddle(), peers: [...huddle().peers, peer("U_X")] } }),
      );
      act(() => vi.advanceTimersByTime(1500));
      expect(screen.queryByText(/can stutter/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells a call of more than sixteen people, cameras off, that muting helps (E13b)", async () => {
    const others = Array.from({ length: 16 }, (_, i) => peer(`U_${i}`));
    const client = huddleClient({ peers: others });
    render(
      <ToastProvider>
        <PlatformContext.Provider value={platform}>
          <ClientContext.Provider value={client}>
            <HuddleBar />
          </ClientContext.Provider>
        </PlatformContext.Provider>
      </ToastProvider>,
    );
    expect(
      await screen.findByText(
        "Calls of more than 16 people can stutter. Muting when you're not talking helps.",
      ),
    ).toBeVisible();
  });
});

describe("which view a huddle opens in", () => {
  function View() {
    const [view, setView] = useHuddleView();
    return (
      <>
        <output aria-label="View">{view}</output>
        <button onClick={() => setView("call")}>Show call</button>
        <button onClick={() => setView("chat")}>Hide call</button>
      </>
    );
  }
  function watch(huddle: Partial<HuddleState>) {
    const client = huddleClient(huddle);
    render(
      <ClientContext.Provider value={client}>
        <View />
      </ClientContext.Provider>,
    );
    const set = (next: Partial<HuddleState>) =>
      act(() => client.store.setState((s) => ({ huddle: { ...s.huddle!, ...next } })));
    return { client, set, user: userEvent.setup() };
  }
  const view = () => screen.getByRole("status", { name: "View" }).textContent;

  it("opens the call when video starts, and goes back to the chat when it stops", () => {
    const { set } = watch({});
    expect(view()).toBe("chat");
    set({ localCameraStream: stream(), cameraOn: true });
    expect(view()).toBe("call");
    set({ localCameraStream: null, cameraOn: false });
    expect(view()).toBe("chat");
  });

  it("stays on a call you opened yourself after the video stops", async () => {
    const { set, user } = watch({});
    await user.click(screen.getByRole("button", { name: "Show call" }));
    set({ peers: [peer("U_PRIYA", { cameraStream: stream() })] });
    set({ peers: [peer("U_PRIYA")] });
    expect(view()).toBe("call");
  });

  it("opens again when someone starts sharing, after you went back to the chat", async () => {
    const { set, user } = watch({ localCameraStream: stream() });
    expect(view()).toBe("call");
    await user.click(screen.getByRole("button", { name: "Hide call" }));
    expect(view()).toBe("chat");
    set({ peers: [peer("U_PRIYA", { screenStream: stream() })] });
    expect(view()).toBe("call");
  });

  it("is the chat once the huddle is over", async () => {
    const { client, user } = watch({});
    await user.click(screen.getByRole("button", { name: "Show call" }));
    act(() => client.store.setState({ huddle: null }));
    expect(view()).toBe("chat");
  });
});

describe("fitting tiles to the call", () => {
  it("fills the space with one tile, as wide as the height allows", () => {
    expect(bestFit(1, 1000, 600)).toEqual({ columns: 1, width: 1000 });
    expect(bestFit(1, 1000, 360)).toEqual({ columns: 1, width: 640 });
  });

  it("puts two people side by side in a wide call and one above the other in a tall one", () => {
    expect(bestFit(2, 1200, 300).columns).toBe(2);
    expect(bestFit(2, 400, 800).columns).toBe(1);
  });

  it("never lets the tiles spill out of the call", () => {
    for (const [count, width, height] of [
      [3, 1000, 600],
      [4, 1600, 400],
      [5, 390, 300],
      [7, 1280, 720],
      [8, 700, 900],
    ] as const) {
      const fit = bestFit(count, width, height);
      const rows = Math.ceil(count / fit.columns);
      expect(fit.columns * fit.width + (fit.columns - 1) * 12).toBeLessThanOrEqual(width);
      expect(rows * (fit.width / (16 / 9)) + (rows - 1) * 12).toBeLessThanOrEqual(height);
      expect(fit.width).toBeGreaterThan(0);
    }
  });
});
