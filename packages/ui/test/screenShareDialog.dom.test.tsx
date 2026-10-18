import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { webPlatform, type Platform, type ShareableSource } from "../src/platform.js";
import { HuddleControls } from "../src/components/HuddleControls.js";
import { QUALITY_KEY, REFRESH_MS } from "../src/components/ScreenShareDialog.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * The desktop app's own screen picker, in the manner of Discord's (CALL-01):
 * windows and screens with a picture of each, how sharp and smooth to send
 * it, and Share. A browser keeps its own picker.
 */
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

const shot = (id: string) => `data:image/jpeg;base64,${id}`;
const editor: ShareableSource = {
  id: "window:1:0",
  name: "Editor",
  kind: "window",
  thumbnail: shot("editor"),
  icon: "data:image/png;base64,editor",
};
const notes: ShareableSource = {
  id: "window:2:0",
  name: "Notes",
  kind: "window",
  thumbnail: "",
  icon: "",
};
const screen1: ShareableSource = {
  id: "screen:0:0",
  name: "Screen 1",
  kind: "screen",
  thumbnail: shot("one"),
  icon: "",
};
const screen2: ShareableSource = { ...screen1, id: "screen:1:0", name: "Screen 2" };

function picker(
  options: {
    /** A fresh list, with pictures taken now. */
    sources?: () => Promise<ShareableSource[]>;
    /** The last list, given at once; none unless given. */
    quick?: () => Promise<ShareableSource[] | null>;
    choose?: (id: string) => Promise<void>;
    desktop?: boolean;
  } = {},
) {
  const full = options.sources ?? (async () => [screen1, screen2, editor, notes]);
  const sources = vi.fn((asked?: { quick?: boolean }) =>
    asked?.quick ? (options.quick?.() ?? Promise.resolve(null)) : full(),
  );
  const choose = vi.fn(options.choose ?? (async () => {}));
  const platform: Platform = {
    ...webPlatform(),
    ...(options.desktop === false ? {} : { screenShare: { sources, choose } }),
  };
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { U_SAM: sam },
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
      peers: [],
    },
  });
  const share = vi.spyOn(client, "toggleScreenShare").mockResolvedValue();
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <HuddleControls />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  return { platform, client, sources, choose, share };
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Share screen" }));
  return screen.findByRole("dialog", { name: "Share your screen" });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

describe("choosing what to share in the desktop app", () => {
  it("opens the app's own picker, with windows first and a picture of each", async () => {
    const user = userEvent.setup();
    const { share } = picker();
    const dialog = await open(user);
    expect(share).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("tab", { name: "Windows" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const windows = await within(dialog).findByRole("radiogroup", { name: "Windows" });
    expect(
      within(windows)
        .getAllByRole("radio")
        .map((r) => r.closest("label")!.textContent),
    ).toEqual(["Editor", "Notes"]);
    expect(windows.querySelector(`img[src="${shot("editor")}"]`)).not.toBeNull();
    // No window is chosen for you: the one on top is usually this app.
    expect(within(windows).getByRole("radio", { name: "Editor" })).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Share window" })).toBeEnabled();
  });

  it("says to choose a window when Share is pressed without one, and goes to the list", async () => {
    const user = userEvent.setup();
    const { choose, share } = picker();
    const dialog = await open(user);
    const windows = await within(dialog).findByRole("radiogroup", { name: "Windows" });
    const button = within(dialog).getByRole("button", { name: "Share window" });
    expect(button).not.toHaveAttribute("aria-disabled");

    await user.click(button);
    expect(choose).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Choose a window to share.");
    expect(windows).toHaveAttribute("aria-invalid", "true");
    expect(windows).toHaveAccessibleDescription("Choose a window to share.");
    // Focus is on the first window, which is not chosen by being focused.
    const editor = within(windows).getByRole("radio", { name: "Editor" });
    expect(editor).toHaveFocus();
    expect(editor).not.toBeChecked();
    expect(await accessibilityProblems(dialog)).toEqual([]);

    // Enter in the list asks the same; choosing one takes the complaint away.
    await user.keyboard("{Enter}");
    expect(choose).not.toHaveBeenCalled();
    await user.keyboard("{ArrowRight}");
    expect(within(windows).getByRole("radio", { name: "Notes" })).toBeChecked();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(windows).not.toHaveAttribute("aria-invalid");
    await user.click(button);
    expect(choose).toHaveBeenCalledWith("window:2:0");
  });

  it("says why Share has nothing yet while the list is found, or when there is no window", async () => {
    const user = userEvent.setup();
    let fresh!: (sources: ShareableSource[]) => void;
    const { choose } = picker({ sources: () => new Promise((resolve) => (fresh = resolve)) });
    const dialog = await open(user);
    const button = within(dialog).getByRole("button", { name: "Share window" });
    await user.click(button);
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Still finding windows and screens. Choose one once they appear.",
    );
    expect(button).toHaveFocus();

    // The list arrives with a screen but no window: Screens is where to go.
    await act(async () => fresh([screen1]));
    await user.click(within(dialog).getByRole("tab", { name: "Windows" }));
    await user.click(within(dialog).getByRole("button", { name: "Share window" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Open the window you want to share first, or share a screen.",
    );
    expect(within(dialog).getByRole("tab", { name: "Screens" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Share screen" }));
    expect(choose).toHaveBeenCalledWith("screen:0:0");
  });

  it("shares the window chosen, at the quality chosen, and closes", async () => {
    const user = userEvent.setup();
    const { choose, share } = picker();
    const dialog = await open(user);
    await user.click(await within(dialog).findByRole("radio", { name: "Editor" }));
    await user.click(within(dialog).getByRole("radio", { name: "720p" }));
    await user.click(within(dialog).getByRole("radio", { name: "30 fps" }));
    await user.click(within(dialog).getByRole("button", { name: "Share window" }));
    expect(choose).toHaveBeenCalledWith("window:1:0");
    expect(share).toHaveBeenCalledWith({ height: 720, frameRate: 30 });
    // Named to the main process before the huddle asks for a screen.
    expect(choose.mock.invocationCallOrder[0]).toBeLessThan(share.mock.invocationCallOrder[0]!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("starts the Screens tab on the first screen, so Share works at once", async () => {
    const user = userEvent.setup();
    const { choose, share } = picker();
    const dialog = await open(user);
    await user.click(within(dialog).getByRole("tab", { name: "Screens" }));
    const screens = await within(dialog).findByRole("radiogroup", { name: "Screens" });
    expect(within(screens).getByRole("radio", { name: "Screen 1" })).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Share screen" }));
    expect(choose).toHaveBeenCalledWith("screen:0:0");
    expect(share).toHaveBeenCalledWith({ height: 1080, frameRate: 15 });
  });

  it("shares at once on Enter or a double click", async () => {
    const user = userEvent.setup();
    const { choose } = picker();
    let dialog = await open(user);
    await user.dblClick(await within(dialog).findByText("Notes"));
    expect(choose).toHaveBeenLastCalledWith("window:2:0");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    dialog = await open(user);
    await user.click(within(dialog).getByRole("tab", { name: "Screens" }));
    await user.click(await within(dialog).findByRole("radio", { name: "Screen 2" }));
    await user.keyboard("{Enter}");
    expect(choose).toHaveBeenLastCalledWith("screen:1:0");
  });

  it("opens on Screens when there is no window to share", async () => {
    const user = userEvent.setup();
    picker({ sources: async () => [screen1] });
    const dialog = await open(user);
    await within(dialog).findByRole("radiogroup", { name: "Screens" });
    expect(within(dialog).getByRole("tab", { name: "Screens" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.click(within(dialog).getByRole("tab", { name: "Windows" }));
    expect(within(dialog).getByText(/There is no window to share/)).toBeInTheDocument();
  });

  it("closes on Cancel without sharing anything", async () => {
    const user = userEvent.setup();
    const { choose, share } = picker();
    const dialog = await open(user);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(choose).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
  });

  it("remembers the quality chosen for next time", async () => {
    const user = userEvent.setup();
    const { platform } = picker();
    let dialog = await open(user);
    await user.click(within(dialog).getByRole("radio", { name: "60 fps" }));
    await waitFor(async () =>
      expect(await platform.storage.get(QUALITY_KEY)).toEqual({ height: 1080, frameRate: 60 }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    dialog = await open(user);
    await waitFor(() =>
      expect(within(dialog).getByRole("radio", { name: "60 fps" })).toBeChecked(),
    );
  });
});

describe("when sharing does not go as chosen", () => {
  it("says a window has closed since it was listed, and keeps the picker open", async () => {
    const user = userEvent.setup();
    const { share } = picker({
      choose: () => Promise.reject(new Error("That window has closed. Choose another.")),
    });
    const dialog = await open(user);
    await user.click(await within(dialog).findByRole("radio", { name: "Editor" }));
    await user.click(within(dialog).getByRole("button", { name: "Share window" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "That window has closed. Choose another.",
    );
    expect(share).not.toHaveBeenCalled();
    // Said beside the list, with focus back on the choice it is about.
    const windows = within(dialog).getByRole("radiogroup", { name: "Windows" });
    expect(windows).toHaveAccessibleDescription("That window has closed. Choose another.");
    expect(within(windows).getByRole("radio", { name: "Editor" })).toHaveFocus();
    // Choosing again clears it.
    await user.click(within(dialog).getByRole("radio", { name: "Notes" }));
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("says what the system refused, where a closed browser picker would say nothing", async () => {
    const user = userEvent.setup();
    const { share } = picker();
    share.mockRejectedValueOnce(new DOMException("Permission denied by system", "NotAllowedError"));
    const dialog = await open(user);
    await user.click(within(dialog).getByRole("tab", { name: "Screens" }));
    await user.click(within(dialog).getByRole("button", { name: "Share screen" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Your system blocked screen sharing.",
    );

    share.mockRejectedValueOnce(new DOMException("Permission denied", "NotAllowedError"));
    await user.click(within(dialog).getByRole("button", { name: "Share screen" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "Screen sharing could not start. Try again.",
      ),
    );
  });

  it("says when nothing could be listed, and lists again on Try again", async () => {
    const user = userEvent.setup();
    let fail = true;
    const { sources } = picker({
      sources: async () => {
        if (fail) throw new Error("capturer failed");
        return [screen1];
      },
    });
    const dialog = await open(user);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The screens and windows on this computer could not be listed.",
    );
    fail = false;
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    await within(dialog).findByRole("radiogroup", { name: "Screens" });
    // Each time, the last list first, then a fresh one.
    expect(sources.mock.calls.map(([asked]) => asked)).toEqual([
      { quick: true },
      { quick: false },
      { quick: true },
      { quick: false },
    ]);
  });
});

describe("keeping the pictures fresh", () => {
  it("shows the last list at once, while fresh pictures are taken", async () => {
    const user = userEvent.setup();
    let fresh!: (sources: ShareableSource[]) => void;
    picker({
      quick: async () => [screen1, { ...editor, name: "Editor (last time)" }],
      sources: () => new Promise((resolve) => (fresh = resolve)),
    });
    const dialog = await open(user);
    expect(await within(dialog).findByRole("radio", { name: "Editor (last time)" })).toBeVisible();
    await act(async () => fresh([screen1, editor, notes]));
    expect(await within(dialog).findByRole("radio", { name: "Notes" })).toBeVisible();
    expect(within(dialog).getByRole("radio", { name: "Editor" })).toBeVisible();
  });

  it("waits for a fresh list when there is no last one", async () => {
    const user = userEvent.setup();
    let fresh!: (sources: ShareableSource[]) => void;
    picker({ sources: () => new Promise((resolve) => (fresh = resolve)) });
    const dialog = await open(user);
    expect(within(dialog).getByRole("status")).toHaveTextContent("Finding screens and windows…");
    await act(async () => fresh([screen1, editor]));
    expect(await within(dialog).findByRole("radio", { name: "Editor" })).toBeVisible();
  });

  it("lists again every few seconds while open, and stops once closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let listed = [screen1, editor];
    const { sources } = picker({ sources: async () => listed });
    const dialog = await open(user);
    await within(dialog).findByRole("radio", { name: "Editor" });

    listed = [screen1, editor, notes];
    await act(() => vi.advanceTimersByTimeAsync(REFRESH_MS));
    expect(await within(dialog).findByRole("radio", { name: "Notes" })).toBeInTheDocument();

    // The chosen window closes: Share says so, and to choose another.
    await user.click(within(dialog).getByRole("radio", { name: "Notes" }));
    listed = [screen1, editor];
    await act(() => vi.advanceTimersByTimeAsync(REFRESH_MS));
    await waitFor(() => expect(within(dialog).queryByRole("radio", { name: "Notes" })).toBeNull());
    await user.click(within(dialog).getByRole("button", { name: "Share window" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "That window has closed. Choose another.",
    );
    expect(within(dialog).getByRole("radio", { name: "Editor" })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    const calls = sources.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(REFRESH_MS * 3));
    expect(sources).toHaveBeenCalledTimes(calls);
  });
});

describe("in a browser", () => {
  it("asks the browser, which shows its own picker", async () => {
    const user = userEvent.setup();
    const { share } = picker({ desktop: false });
    await user.click(screen.getByRole("button", { name: "Share screen" }));
    expect(share).toHaveBeenCalledWith();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
