import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient, type HuddlePeer, type HuddleState } from "@slackoss/client-core";
import type { Channel, User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { webPlatform, type Platform } from "../src/platform.js";
import { HuddleBar } from "../src/components/HuddleBar.js";
import { bestFit, HuddleStage, type HuddleView } from "../src/components/HuddleStage.js";
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

function stage(huddle: Partial<HuddleState>, view: HuddleView = "docked", on = platform) {
  const client = huddleClient(huddle);
  const onViewChange = vi.fn();
  const utils = render(
    <PlatformContext.Provider value={on}>
      <ClientContext.Provider value={client}>
        <HuddleStage view={view} onViewChange={onViewChange} />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const rerender = (next: HuddleView) =>
    utils.rerender(
      <PlatformContext.Provider value={on}>
        <ClientContext.Provider value={client}>
          <HuddleStage view={next} onViewChange={onViewChange} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
  return { client, onViewChange, rerender, user: userEvent.setup() };
}

const region = () => screen.getByRole("region", { name: "Huddle video" });
const control = (name: string) => within(region()).getByRole("button", { name });

describe("the huddle stage", () => {
  it("shows nothing in a call without video, where the bar already says who is there", () => {
    stage({ peers: [peer("U_PRIYA", { micMuted: true })] });
    expect(screen.queryByRole("region", { name: "Huddle video" })).not.toBeInTheDocument();
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
    const { user } = stage({ localCameraStream: stream(), cameraOn: true }, "docked", device);
    const everyone = within(region()).getByRole("list", { name: "Everyone in the huddle" });
    // Yours is not yours to set.
    expect(within(everyone).getAllByRole("button", { name: /^Volume for / })).toHaveLength(1);
    const open = within(everyone).getByRole("button", { name: "Volume for Priya Shah" });
    expect(open).toHaveAttribute("aria-expanded", "false");
    await user.click(open);
    expect(open).toHaveAttribute("aria-expanded", "true");
    const tile = within(everyone).getByRole("group", { name: "Priya Shah, camera off" });
    // Inside her tile, not portalled out of the stage.
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
      "docked",
      device,
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

  it("expands over the chat, puts the video away, and says so without renaming the control", async () => {
    const { onViewChange, rerender, user } = stage({ localCameraStream: stream() });
    await user.click(control("Expand video"));
    expect(onViewChange).toHaveBeenLastCalledWith("expanded");
    rerender("expanded");
    expect(control("Expand video")).toHaveAttribute("aria-pressed", "true");
    // Covering the chat, there is nothing left to drag against.
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    await user.click(control("Expand video"));
    expect(onViewChange).toHaveBeenLastCalledWith("docked");
    await user.click(control("Hide video"));
    expect(onViewChange).toHaveBeenLastCalledWith("hidden");
    rerender("hidden");
    expect(screen.queryByRole("region", { name: "Huddle video" })).not.toBeInTheDocument();
  });

  it("can be made taller or shorter from the keyboard, within limits", async () => {
    const { user } = stage({ localCameraStream: stream() });
    const handle = screen.getByRole("separator", { name: "Resize huddle video" });
    expect(handle).toHaveAttribute("aria-valuenow", "50");
    handle.focus();
    await user.keyboard("{ArrowDown}");
    expect(handle).toHaveAttribute("aria-valuenow", "55");
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(handle).toHaveAttribute("aria-valuenow", "45");
    // The chat always keeps some room, and so does the video.
    await user.keyboard("{End}{ArrowDown}");
    expect(handle).toHaveAttribute("aria-valuenow", "80");
    await user.keyboard("{Home}{ArrowUp}");
    expect(handle).toHaveAttribute("aria-valuenow", "20");
  });

  it("comes back by itself when someone starts sharing", () => {
    const { client, onViewChange } = stage({ localCameraStream: stream() }, "hidden");
    expect(onViewChange).not.toHaveBeenCalled();
    act(() =>
      client.store.setState((s) => ({
        huddle: { ...s.huddle!, peers: [peer("U_PRIYA", { screenStream: stream() })] },
      })),
    );
    expect(onViewChange).toHaveBeenCalledWith("docked");
  });
});

describe("the huddle bar, with the video put away", () => {
  it("offers the video back while there is some to show", async () => {
    const client = huddleClient({ localCameraStream: stream() });
    const onViewChange = vi.fn();
    const { rerender } = render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <HuddleBar view="hidden" onViewChange={onViewChange} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Show video" }));
    expect(onViewChange).toHaveBeenCalledWith("docked");
    rerender(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <HuddleBar view="docked" onViewChange={onViewChange} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    expect(screen.queryByRole("button", { name: "Show video" })).not.toBeInTheDocument();
  });

  it("says who is sharing, in the status a screen reader announces", () => {
    const client = huddleClient({ peers: [peer("U_PRIYA", { screenStream: stream() })] });
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <HuddleBar />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "With Priya Shah · Priya Shah is sharing their screen",
    );
  });
});

describe("fitting tiles to the stage", () => {
  it("fills the space with one tile, as wide as the height allows", () => {
    expect(bestFit(1, 1000, 600)).toEqual({ columns: 1, width: 1000 });
    expect(bestFit(1, 1000, 360)).toEqual({ columns: 1, width: 640 });
  });

  it("puts two people side by side in a wide stage and one above the other in a tall one", () => {
    expect(bestFit(2, 1200, 300).columns).toBe(2);
    expect(bestFit(2, 400, 800).columns).toBe(1);
  });

  it("never lets the tiles spill out of the stage", () => {
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
