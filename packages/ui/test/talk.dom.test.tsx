import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { render } from "./render.js";
import userEvent from "@testing-library/user-event";
import {
  WorkspaceClient,
  type CallKeyAction,
  type HuddlePeer,
  type HuddleState,
} from "@ownbase/client-core";
import type { User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";
import { HuddleBar } from "../src/components/HuddleBar.js";
import { HuddleAudio } from "../src/components/HuddleAudio.js";
import { VoiceVideoSettings } from "../src/components/VoiceVideoSettings.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Deafen, push to talk, and the keys for them (K16): the controls in the call,
 * the keys while the window is in front, the desktop app's keys from any app,
 * and where they are chosen.
 */
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
const sam = person("U_SAM", "Sam Rivera");
const priya = person("U_PRIYA", "Priya Shah");

const peer = (media: Partial<HuddlePeer> = {}): HuddlePeer => ({
  userId: "U_PRIYA",
  audioStream: {} as MediaStream,
  cameraStream: null,
  screenStream: null,
  connected: true,
  micMuted: false,
  speaking: false,
  ...media,
});

const inHuddle = (over: Partial<HuddleState> = {}): HuddleState => ({
  channelId: "C_GENERAL",
  micMuted: false,
  cameraOn: false,
  sharingScreen: false,
  localCameraStream: null,
  localScreenStream: null,
  speaking: false,
  micLost: false,
  peers: [peer()],
  ...over,
});

/** The desktop app's keys from any app, as a test drives them; other apps hold `othersHold`. */
function desktopKeys(othersHold: string[] = []) {
  let press: ((action: CallKeyAction) => void) | null = null;
  let tellTaken: ((taken: CallKeyAction[]) => void) | null = null;
  const keys = {
    set: vi.fn(async (keys: Record<CallKeyAction, string | null> | null) =>
      keys
        ? (["mute", "deafen", "talk"] as const).filter((a) => othersHold.includes(keys[a] ?? ""))
        : [],
    ),
    onPress: (cb: (action: CallKeyAction) => void) => {
      press = cb;
      return () => (press = null);
    },
    onTaken: (cb: (taken: CallKeyAction[]) => void) => {
      tellTaken = cb;
      return () => (tellTaken = null);
    },
  };
  return {
    keys,
    press: (action: CallKeyAction) => act(() => press!(action)),
    taken: (list: CallKeyAction[]) => act(() => tellTaken!(list)),
  };
}

let mediaDevices: unknown;
beforeEach(() => {
  mediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: () => Promise.resolve([]),
      getUserMedia: vi.fn(),
      addEventListener() {},
      removeEventListener() {},
    },
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
});
afterEach(() => {
  vi.restoreAllMocks();
  if (mediaDevices)
    Object.defineProperty(navigator, "mediaDevices", mediaDevices as PropertyDescriptor);
});

function setup({
  saved = null,
  huddle = inHuddle(),
  callKeys,
}: {
  saved?: unknown;
  huddle?: HuddleState | null;
  callKeys?: Platform["callKeys"];
} = {}) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { U_SAM: sam, U_PRIYA: priya },
    status: "online",
    huddle,
  });
  const set = vi.fn(async (_key: string, _value: unknown) => {});
  const platform: Platform = {
    kind: callKeys ? "desktop" : "web",
    storage: {
      get: async <T,>(key: string) => (key === "call-preferences" ? (saved as T) : null),
      set,
    },
    notify: () => {},
    ...(callKeys ? { callKeys } : {}),
  };
  const calls = {
    mic: vi.spyOn(client, "toggleMic").mockImplementation(() => {}),
    deafen: vi.spyOn(client, "toggleDeafen").mockImplementation(() => {}),
    press: vi.spyOn(client, "pressTalk").mockImplementation(() => {}),
    release: vi.spyOn(client, "releaseTalk").mockImplementation(() => {}),
    toggleTalk: vi.spyOn(client, "toggleTalk").mockImplementation(() => {}),
    pushToTalk: vi.spyOn(client, "setPushToTalk").mockImplementation(() => {}),
  };
  const wrap = (ui: React.ReactNode) => (
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <main>{ui}</main>
      </ClientContext.Provider>
    </PlatformContext.Provider>
  );
  return { client, set, calls, wrap, user: userEvent.setup() };
}

const PUSH = { joinMuted: false, talk: { mode: "push", releaseMs: 200 } };
const controls = () => screen.getByRole("group", { name: "Huddle controls" });

describe("deafen", () => {
  it("sits beside mute, says what it does, and shows when it is on", async () => {
    const { client, calls, wrap, user } = setup();
    render(wrap(<HuddleBar onOpenSettings={() => {}} />));
    const deafen = within(controls()).getByRole("button", { name: "Deafen", pressed: false });
    act(() => deafen.focus());
    expect(deafen).toHaveAccessibleDescription(
      "Deafen: hear nobody and mute your microphone. Shortcut: Ctrl Shift D",
    );
    await user.click(deafen);
    expect(calls.deafen).toHaveBeenCalledOnce();

    act(() =>
      client.store.setState((s) => ({ huddle: { ...s.huddle!, deafened: true, micMuted: true } })),
    );
    expect(within(controls()).getByRole("button", { name: "Deafen", pressed: true })).toBe(deafen);
    act(() => deafen.blur());
    act(() => deafen.focus());
    expect(deafen).toHaveAccessibleDescription("Undeafen. Shortcut: Ctrl Shift D");
    expect(await accessibilityProblems(controls())).toEqual([]);
  });

  it("shows who is deafened in the list of everyone in the huddle", async () => {
    const { wrap, user } = setup({
      huddle: inHuddle({
        deafened: true,
        micMuted: true,
        peers: [peer({ micMuted: true, deafened: true })],
      }),
    });
    render(wrap(<HuddleBar onOpenSettings={() => {}} />));
    await user.click(screen.getByRole("button", { name: "Everyone in the huddle (2)" }));
    const people = within(screen.getByRole("dialog", { name: "Everyone in the huddle" })).getByRole(
      "list",
      { name: "In the huddle" },
    );
    expect(
      within(people)
        .getAllByRole("listitem")
        .map((row) => row.getAttribute("aria-label")),
    ).toEqual(["You, deafened", "Priya Shah, deafened"]);
  });

  it("silences every voice and shared screen's sound while deafened", () => {
    const peers = [peer({ screenSoundStream: {} as MediaStream })];
    const { rerender, container } = render(<HuddleAudio peers={peers} />);
    const players = () => [...container.querySelectorAll("audio")];
    expect(players()).toHaveLength(2);
    expect(players().map((a) => a.muted)).toEqual([false, false]);
    rerender(<HuddleAudio peers={peers} deafened />);
    expect(players().map((a) => a.muted)).toEqual([true, true]);
    rerender(<HuddleAudio peers={peers} />);
    expect(players().map((a) => a.muted)).toEqual([false, false]);
  });
});

describe("push to talk", () => {
  it("offers a button to hold while push to talk is on, lit while talking", async () => {
    const { client, calls, wrap } = setup({ huddle: inHuddle({ pushToTalk: true }) });
    render(wrap(<HuddleBar onOpenSettings={() => {}} />));
    const hold = within(controls()).getByRole("button", { name: "Hold to talk", pressed: false });
    expect(hold).toHaveTextContent("Hold to talk");
    fireEvent.pointerDown(hold, { pointerId: 1 });
    expect(calls.press).toHaveBeenCalledOnce();
    act(() => client.store.setState((s) => ({ huddle: { ...s.huddle!, holdingTalk: true } })));
    expect(hold).toHaveAttribute("aria-pressed", "true");
    expect(hold).toHaveTextContent("Talking");
    fireEvent.pointerUp(hold, { pointerId: 1 });
    expect(calls.release).toHaveBeenCalled();

    // From the keyboard too, held down as the mouse is.
    calls.press.mockClear();
    calls.release.mockClear();
    fireEvent.keyDown(hold, { key: " " });
    fireEvent.keyDown(hold, { key: " ", repeat: true });
    expect(calls.press).toHaveBeenCalledOnce();
    fireEvent.keyUp(hold, { key: " " });
    expect(calls.release).toHaveBeenCalledOnce();
    expect(await accessibilityProblems(controls())).toEqual([]);
  });

  it("is not offered with voice activity", () => {
    const { wrap } = setup();
    render(wrap(<HuddleBar onOpenSettings={() => {}} />));
    expect(within(controls()).queryByRole("button", { name: "Hold to talk" })).toBeNull();
  });
});

describe("the call keys while the window is in front", () => {
  const key = (type: "keyDown" | "keyUp", init: Record<string, unknown>) =>
    fireEvent[type](document.activeElement ?? document.body, init);

  it("mute and deafen with their keys, wherever focus is", async () => {
    const { calls, wrap } = setup();
    render(wrap(<HuddleBar onOpenSettings={() => {}} />));
    await waitFor(() => expect(calls.pushToTalk).toHaveBeenCalledWith(null));
    key("keyDown", { code: "Space", key: " ", ctrlKey: true, shiftKey: true });
    expect(calls.mic).toHaveBeenCalledOnce();
    key("keyDown", { code: "KeyD", key: "D", ctrlKey: true, shiftKey: true });
    key("keyDown", { code: "KeyD", key: "D", ctrlKey: true, shiftKey: true, repeat: true });
    expect(calls.deafen).toHaveBeenCalledOnce();
    // With voice activity, push to talk's key does nothing.
    key("keyDown", { code: "Space", key: " ", ctrlKey: true, altKey: true });
    expect(calls.press).not.toHaveBeenCalled();
  });

  it("talk while push to talk's key is held, until it or a modifier comes up", async () => {
    const { calls, wrap } = setup({ saved: PUSH });
    render(wrap(<HuddleBar onOpenSettings={() => {}} />));
    await waitFor(() => expect(calls.pushToTalk).toHaveBeenCalledWith({ releaseMs: 200 }));
    key("keyDown", { code: "Space", key: " ", ctrlKey: true, altKey: true });
    key("keyDown", { code: "Space", key: " ", ctrlKey: true, altKey: true, repeat: true });
    expect(calls.press).toHaveBeenCalledOnce();
    key("keyUp", { code: "AltLeft", key: "Alt", ctrlKey: true });
    expect(calls.release).toHaveBeenCalledOnce();

    key("keyDown", { code: "Space", key: " ", ctrlKey: true, altKey: true });
    expect(calls.press).toHaveBeenCalledTimes(2);
    // Another window coming to the front takes the key's coming up with it.
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(calls.release).toHaveBeenCalledTimes(2);
  });

  it("use keys chosen in place of the defaults", async () => {
    const { calls, wrap } = setup({
      saved: { joinMuted: false, keys: { mute: "F9", deafen: "Alt+KeyH", talk: "F10" } },
    });
    render(wrap(<HuddleBar onOpenSettings={() => {}} />));
    await waitFor(() => expect(calls.pushToTalk).toHaveBeenCalled());
    await waitFor(() => {
      key("keyDown", { code: "F9", key: "F9" });
      expect(calls.mic).toHaveBeenCalled();
    });
    key("keyDown", { code: "Space", key: " ", ctrlKey: true, shiftKey: true });
    expect(calls.mic).toHaveBeenCalledOnce();
    key("keyDown", { code: "KeyH", key: "h", altKey: true });
    expect(calls.deafen).toHaveBeenCalledOnce();
  });
});

describe("the call keys from any app, in the desktop app", () => {
  it("are held for the call, push to talk's only when chosen, and let go on leaving", async () => {
    const desktop = desktopKeys();
    const { client, calls, wrap } = setup({ callKeys: desktop.keys });
    render(wrap(<HuddleBar onOpenSettings={() => {}} />));
    await waitFor(() =>
      expect(desktop.keys.set).toHaveBeenLastCalledWith({
        mute: "Mod+Shift+Space",
        deafen: "Mod+Shift+KeyD",
        talk: null,
      }),
    );
    desktop.press("mute");
    desktop.press("deafen");
    desktop.press("talk");
    expect(calls.mic).toHaveBeenCalledOnce();
    expect(calls.deafen).toHaveBeenCalledOnce();
    // Nothing says when a key held for another app comes up, so it starts and stops.
    expect(calls.toggleTalk).toHaveBeenCalledOnce();

    act(() => client.store.setState({ huddle: null }));
    expect(desktop.keys.set).toHaveBeenLastCalledWith(null);
  });

  it("hold push to talk's key too once push to talk is chosen", async () => {
    const desktop = desktopKeys();
    const { wrap } = setup({ saved: PUSH, callKeys: desktop.keys });
    render(wrap(<HuddleBar onOpenSettings={() => {}} />));
    await waitFor(() =>
      expect(desktop.keys.set).toHaveBeenLastCalledWith({
        mute: "Mod+Shift+Space",
        deafen: "Mod+Shift+KeyD",
        talk: "Mod+Alt+Space",
      }),
    );
  });

  it("say in settings when another app holds a key, until another key is chosen", async () => {
    const desktop = desktopKeys(["Mod+Shift+KeyD"]);
    const { wrap, user, set } = setup({ callKeys: desktop.keys });
    render(
      wrap(
        <>
          <HuddleBar onOpenSettings={() => {}} />
          <VoiceVideoSettings />
        </>,
      ),
    );
    expect(
      await screen.findByText(
        "Another app is using Ctrl Shift D, so it works only while OwnBase is in front. Choose another key to use it from other apps.",
      ),
    ).toBeVisible();
    expect(screen.getByText(/these keys work from any app, a game included/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Change the key for deafen or undeafen" }));
    // user-event knows no function keys, so the press is made by hand.
    fireEvent.keyDown(document.activeElement!, { key: "F8", code: "F8" });
    await waitFor(() =>
      expect(set).toHaveBeenLastCalledWith(
        "call-preferences",
        expect.objectContaining({ keys: expect.objectContaining({ deafen: "F8" }) }),
      ),
    );
    expect(screen.queryByText(/Another app is using/)).toBeNull();
    desktop.taken(["mute"]);
    expect(await screen.findByText(/Another app is using Ctrl Shift Space/)).toBeVisible();
  });
});

describe("choosing how to talk, and the keys, in Voice & video settings", () => {
  async function settings(saved: unknown = { joinMuted: false }) {
    const ctx = setup({ saved, huddle: null });
    render(ctx.wrap(<VoiceVideoSettings />));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /^Voice activity/ })).toBeEnabled(),
    );
    return ctx;
  }

  it("turns push to talk on with a release delay, kept on this device", async () => {
    const { user, set } = await settings();
    expect(screen.getByRole("radio", { name: /^Voice activity/ })).toBeChecked();
    expect(screen.queryByRole("combobox", { name: "Release delay" })).toBeNull();
    await user.click(screen.getByRole("radio", { name: /^Push to talk/ }));
    await waitFor(() =>
      expect(set).toHaveBeenLastCalledWith(
        "call-preferences",
        expect.objectContaining({ talk: { mode: "push", releaseMs: 200 } }),
      ),
    );
    const delay = screen.getByRole("combobox", { name: "Release delay" });
    expect(delay).toHaveValue("200");
    await user.selectOptions(delay, "500 ms");
    await waitFor(() =>
      expect(set).toHaveBeenLastCalledWith(
        "call-preferences",
        expect.objectContaining({ talk: { mode: "push", releaseMs: 500 } }),
      ),
    );
    expect(await accessibilityProblems(screen.getByRole("main"))).toEqual([]);
  });

  it("says in a browser that the keys work only while the tab is in front", async () => {
    await settings();
    expect(
      screen.getByText(
        "These keys work only while this tab is in front. The OwnBase desktop app can use them from any app.",
      ),
    ).toBeVisible();
  });

  it("takes the next keys pressed, refusing one that would type or one already used", async () => {
    const { user, set, calls } = await settings();
    const change = screen.getByRole("button", { name: "Change the key for mute or unmute" });
    await user.click(change);
    expect(change).toHaveAccessibleName("Press the new keys for mute or unmute");
    await user.keyboard("m");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Hold Ctrl or Alt with the key, or use a function key such as F9, so typing never sets it off.",
    );
    await user.keyboard("{Control>}{Shift>}d{/Shift}{/Control}");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Ctrl Shift D is already the key for deafen or undeafen. Choose another.",
    );
    await user.keyboard("{Control>}{Alt>}m{/Alt}{/Control}");
    await waitFor(() =>
      expect(set).toHaveBeenLastCalledWith(
        "call-preferences",
        expect.objectContaining({ keys: expect.objectContaining({ mute: "Mod+Alt+KeyM" }) }),
      ),
    );
    expect(change).toHaveAccessibleName("Change the key for mute or unmute");
    expect(calls.mic).not.toHaveBeenCalled();

    // Escape keeps the key as it was.
    await user.click(change);
    await user.keyboard("{Escape}");
    expect(change).toHaveAccessibleName("Change the key for mute or unmute");
  });
});
