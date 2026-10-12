import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient, type HuddleState } from "@slackoss/client-core";
import type { User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { VoiceVideoSettings } from "../src/components/VoiceVideoSettings.js";
import { HuddleControls } from "../src/components/HuddleControls.js";
import { HuddleButton } from "../src/components/HuddleBar.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";
import { noiseFilter } from "../src/lib/noiseFilter.js";

/**
 * Choosing the microphone, speaker and camera (Voice & video): from settings
 * or from the huddle itself, kept on this device, and changing a call in
 * progress only once the new device has opened.
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

const inHuddle: HuddleState = {
  channelId: "C_GENERAL",
  micMuted: false,
  cameraOn: false,
  sharingScreen: false,
  localCameraStream: null,
  localScreenStream: null,
  speaking: false,
  micLost: false,
  peers: [],
};

/** A laptop with a headset plugged in, as Chromium lists it once allowed. */
const LAPTOP = [
  { kind: "audioinput", deviceId: "default", label: "Default - Headset Microphone (USB)" },
  { kind: "audioinput", deviceId: "mic-usb", label: "Headset Microphone (USB)" },
  { kind: "audioinput", deviceId: "mic-array", label: "Microphone Array (Realtek)" },
  { kind: "videoinput", deviceId: "cam-front", label: "Integrated Camera" },
  { kind: "videoinput", deviceId: "cam-desk", label: "Desk Camera" },
  { kind: "audiooutput", deviceId: "default", label: "Default - Speakers (Realtek)" },
  { kind: "audiooutput", deviceId: "spk-usb", label: "Headset Earphone (USB)" },
];

let listed: { kind: string; deviceId: string; label: string }[];
const media = HTMLMediaElement.prototype as { setSinkId?: unknown };

beforeEach(() => {
  listed = LAPTOP;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: () => Promise.resolve(listed),
      getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop() {} }] })),
      addEventListener() {},
      removeEventListener() {},
    },
  });
  media.setSinkId = vi.fn(() => Promise.resolve());
});

afterEach(() => {
  vi.restoreAllMocks();
  delete media.setSinkId;
});

function setup(saved: unknown = null, huddle: HuddleState | null = null) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: sam, users: { [sam.id]: sam }, status: "online", huddle });
  const set = vi.fn(async (_key: string, _value: unknown) => {});
  // A platform of its own each time: the preference is kept per platform.
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T,>(key: string) => (key === "call-preferences" ? (saved as T) : null),
      set,
    },
    notify: () => {},
  };
  const setMicrophone = vi.spyOn(client, "setMicrophone").mockResolvedValue();
  const setCamera = vi.spyOn(client, "setCamera").mockResolvedValue();
  const wrap = (ui: React.ReactNode) => (
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <main>{ui}</main>
      </ClientContext.Provider>
    </PlatformContext.Provider>
  );
  return { client, set, setMicrophone, setCamera, wrap };
}

/** The settings once the saved choices and the device list have both arrived. */
async function settings(saved: unknown = null, huddle: HuddleState | null = null) {
  const ctx = setup(saved, huddle);
  render(ctx.wrap(<VoiceVideoSettings />));
  const microphone = screen.getByRole("combobox", { name: "Microphone" });
  await waitFor(() => expect(microphone).toBeEnabled());
  await screen.findByRole("option", { name: "Microphone Array (Realtek)" });
  return { ...ctx, microphone, user: userEvent.setup() };
}

const optionsOf = (select: HTMLElement) =>
  within(select)
    .getAllByRole("option")
    .map((option) => option.textContent);

describe("Voice & video settings", () => {
  it("lists each kind of device with the system's default first, and keeps a choice", async () => {
    const { microphone, set, setMicrophone, user } = await settings();
    expect(optionsOf(microphone)).toEqual([
      "System default (Headset Microphone (USB))",
      "Headset Microphone (USB)",
      "Microphone Array (Realtek)",
    ]);
    expect(optionsOf(screen.getByRole("combobox", { name: "Speaker" }))).toEqual([
      "System default (Speakers (Realtek))",
      "Headset Earphone (USB)",
    ]);
    expect(optionsOf(screen.getByRole("combobox", { name: "Camera" }))).toEqual([
      "System default",
      "Integrated Camera",
      "Desk Camera",
    ]);
    expect(await accessibilityProblems(document.body)).toEqual([]);

    await user.selectOptions(microphone, "Microphone Array (Realtek)");
    expect(set).toHaveBeenCalledWith("call-preferences", {
      joinMuted: false,
      microphoneId: "mic-array",
      // A choice made here means a first huddle need not ask.
      devicesChecked: true,
    });
    // Outside a call there is nothing to change over.
    expect(setMicrophone).not.toHaveBeenCalled();
    await waitFor(() => expect(microphone).toHaveValue("mic-array"));

    await user.selectOptions(microphone, "System default (Headset Microphone (USB))");
    expect(set).toHaveBeenLastCalledWith("call-preferences", {
      joinMuted: false,
      devicesChecked: true,
    });
  });

  it("in a huddle, changes the call over first, and keeps nothing when the device will not start", async () => {
    const { microphone, set, setMicrophone, user } = await settings(
      { joinMuted: true, noiseSuppression: false },
      inHuddle,
    );
    setMicrophone.mockRejectedValueOnce(new DOMException("busy", "NotReadableError"));
    await user.selectOptions(microphone, "Microphone Array (Realtek)");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your microphone could not start. Another app may be using it",
    );
    expect(set).not.toHaveBeenCalled();
    expect(microphone).toHaveValue("");

    await user.selectOptions(microphone, "Microphone Array (Realtek)");
    // The processing chosen before goes with it.
    expect(setMicrophone).toHaveBeenLastCalledWith({
      deviceId: "mic-array",
      noiseSuppression: false,
    });
    expect(set).toHaveBeenCalledWith("call-preferences", {
      joinMuted: true,
      noiseSuppression: false,
      microphoneId: "mic-array",
      devicesChecked: true,
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cleans up the microphone's sound as chosen, strong and on until chosen otherwise", async () => {
    const { set, setMicrophone, user } = await settings({ joinMuted: false }, inHuddle);
    const strong = screen.getByRole("radio", { name: /^Strong/ });
    const standard = screen.getByRole("radio", { name: /^Standard/ });
    const off = screen.getByRole("radio", { name: /^Off/ });
    expect(strong).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Echo cancellation/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Automatic volume/ })).toBeChecked();

    // The browser's own suppression in place of the strong filter.
    await user.click(standard);
    expect(setMicrophone).toHaveBeenLastCalledWith({ noiseSuppression: true, noiseFilter: false });
    expect(set).toHaveBeenLastCalledWith("call-preferences", {
      joinMuted: false,
      noiseSuppression: true,
      noiseFilter: false,
    });
    await waitFor(() => expect(standard).toBeChecked());

    await user.click(off);
    expect(setMicrophone).toHaveBeenLastCalledWith({ noiseSuppression: false, noiseFilter: false });
    await waitFor(() => expect(off).toBeChecked());

    await user.click(strong);
    expect(setMicrophone).toHaveBeenLastCalledWith({ noiseSuppression: true, noiseFilter: true });
    await waitFor(() => expect(strong).toBeChecked());
  });

  it("keeps noise suppression off for someone who turned it off before there was a choice", async () => {
    await settings({ joinMuted: false, noiseSuppression: false });
    expect(screen.getByRole("radio", { name: /^Off/ })).toBeChecked();
  });

  it("changes the camera of a call in progress, and plays through the chosen speaker", async () => {
    const { set, setCamera, setMicrophone, user } = await settings(null, inHuddle);
    await user.selectOptions(screen.getByRole("combobox", { name: "Camera" }), "Desk Camera");
    expect(setCamera).toHaveBeenCalledWith("cam-desk");
    expect(setMicrophone).not.toHaveBeenCalled();
    expect(set).toHaveBeenLastCalledWith("call-preferences", {
      joinMuted: false,
      cameraId: "cam-desk",
      devicesChecked: true,
    });

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Speaker" }),
      "Headset Earphone (USB)",
    );
    expect(set).toHaveBeenLastCalledWith("call-preferences", {
      joinMuted: false,
      cameraId: "cam-desk",
      speakerId: "spk-usb",
      devicesChecked: true,
    });
    await waitFor(() => expect(media.setSinkId).toHaveBeenCalledWith("spk-usb"));
  });

  it("offers no speaker where the browser cannot choose one", async () => {
    delete media.setSinkId;
    await settings();
    expect(screen.queryByRole("combobox", { name: "Speaker" })).toBeNull();
  });

  it("keeps a chosen device that is unplugged as such, rather than showing another", async () => {
    const { microphone } = await settings({ joinMuted: false, microphoneId: "mic-gone" });
    expect(microphone).toHaveValue("mic-gone");
    expect(optionsOf(microphone)).toContain("A microphone that is not connected");
  });

  it("asks once for the devices' names when the browser keeps them back", async () => {
    listed = LAPTOP.map((device, i) => ({ ...device, deviceId: `id-${i}`, label: "" }));
    const ctx = setup();
    render(ctx.wrap(<VoiceVideoSettings />));
    const reveal = await screen.findByRole("button", { name: "Show device names" });
    expect(screen.getByRole("option", { name: "Microphone 1" })).toBeInTheDocument();
    listed = LAPTOP;
    await userEvent.setup().click(reveal);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(await screen.findByRole("option", { name: "Microphone Array (Realtek)" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show device names" })).toBeNull();
  });
});

describe("joining with the chosen devices", () => {
  it("opens the chosen microphone and camera, and ignores what it cannot read", async () => {
    const { client, wrap } = setup({
      joinMuted: false,
      microphoneId: "mic-usb",
      cameraId: "cam-desk",
      speakerId: "spk-usb",
      echoCancellation: false,
      noiseSuppression: "loud",
      noiseFilter: "yes",
      autoGainControl: 3,
    });
    const join = vi.spyOn(client, "joinHuddle").mockResolvedValue();
    render(wrap(<HuddleButton channelId="C_GENERAL" />));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await userEvent.setup().click(screen.getByRole("button", { name: "Start a huddle" }));
    expect(join).toHaveBeenCalledWith("C_GENERAL", {
      muted: false,
      microphone: { deviceId: "mic-usb", echoCancellation: false },
      cameraId: "cam-desk",
      noiseFilter,
    });
  });
});

describe("choosing devices from the huddle", () => {
  function controls(saved: unknown = { joinMuted: false, microphoneId: "mic-usb" }) {
    const ctx = setup(saved, inHuddle);
    const onOpenSettings = vi.fn();
    render(ctx.wrap(<HuddleControls onOpenSettings={onOpenSettings} />));
    return { ...ctx, onOpenSettings, user: userEvent.setup() };
  }

  it("lists microphones and speakers beside Mute, with the one in use ticked", async () => {
    const { user, set, setMicrophone } = controls();
    const trigger = screen.getByRole("button", { name: "Microphone and speaker" });
    await waitFor(() => expect(trigger).toBeEnabled());
    await user.click(trigger);
    const menu = await screen.findByRole("menu", { name: "Microphone and speaker" });
    await within(menu).findByRole("menuitemradio", { name: "Microphone Array (Realtek)" });
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map(
          (item) =>
            `${item.textContent}${item.getAttribute("aria-checked") === "true" ? " ✓" : ""}`,
        ),
    ).toEqual([
      "System default (Headset Microphone (USB))",
      "Headset Microphone (USB) ✓",
      "Microphone Array (Realtek)",
      "System default (Speakers (Realtek)) ✓",
      "Headset Earphone (USB)",
    ]);
    expect(await accessibilityProblems(document.body)).toEqual([]);

    await user.click(
      within(menu).getByRole("menuitemradio", { name: "Microphone Array (Realtek)" }),
    );
    expect(setMicrophone).toHaveBeenCalledWith({ deviceId: "mic-array" });
    expect(set).toHaveBeenCalledWith("call-preferences", {
      joinMuted: false,
      microphoneId: "mic-array",
      devicesChecked: true,
    });
  });

  it("says why a camera chosen there did not start, and leads to the rest of the settings", async () => {
    const { user, setCamera, set, onOpenSettings } = controls();
    setCamera.mockRejectedValueOnce(new DOMException("gone", "NotFoundError"));
    const trigger = screen.getByRole("button", { name: "Camera options" });
    await waitFor(() => expect(trigger).toBeEnabled());
    await user.click(trigger);
    const menu = await screen.findByRole("menu", { name: "Camera options" });
    await user.click(await within(menu).findByRole("menuitemradio", { name: "Desk Camera" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No camera was found.");
    expect(set).not.toHaveBeenCalled();

    // The menu puts back a trigger of its own on closing; find it again.
    await user.click(screen.getByRole("button", { name: "Camera options" }));
    await user.click(
      within(await screen.findByRole("menu", { name: "Camera options" })).getByRole("menuitem", {
        name: "Voice & video settings",
      }),
    );
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("keeps the menus out of full screen, where they would open out of sight", () => {
    const ctx = setup(null, inHuddle);
    render(ctx.wrap(<HuddleControls overlay />));
    expect(screen.queryByRole("button", { name: "Microphone and speaker" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Camera options" })).toBeNull();
  });
});
