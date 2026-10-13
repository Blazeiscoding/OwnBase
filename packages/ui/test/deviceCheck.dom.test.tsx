import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { User } from "@slackoss/protocol";
import { accessibilityProblems } from "./accessibility.js";

const heard = vi.hoisted(() => ({
  onLevel: null as ((level: number) => void) | null,
  settings: [] as unknown[],
  stop: vi.fn(),
}));

vi.mock("@slackoss/client-core", async (original) => ({
  ...(await original<typeof import("@slackoss/client-core")>()),
  testMicrophone: vi.fn(async (onLevel: (level: number) => void, settings: unknown) => {
    heard.onLevel = onLevel;
    heard.settings.push(settings);
    return { label: "Headset Microphone (USB)", metered: true, stop: heard.stop };
  }),
}));

const { ClientContext, PlatformContext } = await import("../src/context.js");
const { HuddleButton } = await import("../src/components/HuddleBar.js");
const { DeviceCheckDialog } = await import("../src/components/DeviceCheckDialog.js");
const { useCallPreferences } = await import("../src/lib/callPreferences.js");
const { noiseFilter } = await import("../src/lib/noiseFilter.js");
type Platform = import("../src/platform.js").Platform;

/**
 * Asked once, before the first huddle on a device with more than one
 * microphone or camera: which of each, heard and seen first, and kept.
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

/** A laptop with a headset and a desk camera plugged in, as Chromium lists it once allowed. */
const LAPTOP = [
  { kind: "audioinput", deviceId: "default", label: "Default - Headset Microphone (USB)" },
  { kind: "audioinput", deviceId: "mic-usb", label: "Headset Microphone (USB)" },
  { kind: "audioinput", deviceId: "mic-array", label: "Microphone Array (Realtek)" },
  { kind: "videoinput", deviceId: "cam-front", label: "Integrated Camera" },
  { kind: "videoinput", deviceId: "cam-desk", label: "Desk Camera" },
];
/** One of each, as most desktops have. */
const DESKTOP = [
  { kind: "audioinput", deviceId: "default", label: "Default - Microphone (USB)" },
  { kind: "audioinput", deviceId: "mic-usb", label: "Microphone (USB)" },
  { kind: "videoinput", deviceId: "cam-usb", label: "USB Camera" },
];
/** What Chromium lists before a page may use a device: no ids, no names. */
const HIDDEN = [
  { kind: "audioinput", deviceId: "", label: "" },
  { kind: "videoinput", deviceId: "", label: "" },
];

let listed: { kind: string; deviceId: string; label: string }[];
const enumerate = vi.fn(() => Promise.resolve(listed));
const camera = vi.fn();
/** The preferences as the workspace holds them, to join without the button. */
let calls!: ReturnType<typeof useCallPreferences>;

beforeEach(() => {
  listed = LAPTOP;
  heard.onLevel = null;
  heard.settings = [];
  heard.stop.mockReset();
  camera.mockReset();
  enumerate.mockClear();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: enumerate,
      getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) => {
        camera(constraints.video);
        return { getTracks: () => [{ stop() {} }] };
      }),
      addEventListener() {},
      removeEventListener() {},
    },
  });
});

afterEach(() => vi.restoreAllMocks());

/** The workspace's part: the question shows while a join waits on it. */
function Host() {
  calls = useCallPreferences();
  return (
    <main>
      <HuddleButton channelId="C_GENERAL" />
      {calls.checkingDevices && <DeviceCheckDialog />}
    </main>
  );
}

function setup(saved: unknown = { joinMuted: false }) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: sam, users: { [sam.id]: sam }, status: "online" });
  const set = vi.fn(async (_key: string, _value: unknown) => {});
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T,>(key: string) => (key === "call-preferences" ? (saved as T) : null),
      set,
    },
    notify: () => {},
  };
  const join = vi.spyOn(client, "joinHuddle").mockResolvedValue();
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <Host />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const user = userEvent.setup();
  const start = async () => {
    // The saved preferences arrive first.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    await user.click(screen.getByRole("button", { name: "Start a huddle" }));
  };
  return { client, set, join, user, start };
}

const dialog = () => screen.findByRole("dialog", { name: "Choose your microphone and camera" });

describe("which microphone and camera, asked before a first huddle", () => {
  it("asks first, listening and showing the camera, then joins with the choice and keeps it", async () => {
    const { set, join, user, start } = setup();
    await start();
    const asked = await dialog();
    expect(join).not.toHaveBeenCalled();
    // Join stays in sight, whatever the devices above it need of the window.
    const scroller = asked.querySelector(".dialog-scroll")!;
    expect(scroller).toContainElement(within(asked).getByRole("combobox", { name: "Microphone" }));
    expect(scroller).not.toContainElement(
      within(asked).getByRole("button", { name: "Join huddle" }),
    );

    // It listens at once, and shows the camera without being asked.
    expect(await within(asked).findByText(/^Listening to/)).toHaveTextContent(
      "Listening to Headset Microphone (USB).",
    );
    const meter = within(asked).getByRole("meter", { name: "Microphone level" });
    act(() => heard.onLevel!(0.25));
    expect(meter).toHaveAttribute("aria-valuenow", "50");
    await waitFor(() => expect(camera).toHaveBeenCalled());
    expect(within(asked).getByText(/^Only you see this/)).toBeVisible();
    expect(await accessibilityProblems(document.body)).toEqual([]);

    // Another microphone is heard in its place, and another camera shown.
    await user.selectOptions(
      within(asked).getByRole("combobox", { name: "Microphone" }),
      "Microphone Array (Realtek)",
    );
    await waitFor(() => expect(heard.settings.at(-1)).toEqual({ deviceId: "mic-array" }));
    await user.selectOptions(
      within(asked).getByRole("combobox", { name: "Camera" }),
      "Desk Camera",
    );
    await waitFor(() =>
      expect(camera).toHaveBeenLastCalledWith(
        expect.objectContaining({ deviceId: { exact: "cam-desk" } }),
      ),
    );
    expect(join).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();

    await user.click(within(asked).getByRole("button", { name: "Join huddle" }));
    await waitFor(() =>
      expect(join).toHaveBeenCalledWith("C_GENERAL", {
        muted: false,
        microphone: { deviceId: "mic-array" },
        cameraId: "cam-desk",
        noiseFilter,
      }),
    );
    expect(set).toHaveBeenCalledWith("call-preferences", {
      joinMuted: false,
      microphoneId: "mic-array",
      cameraId: "cam-desk",
      devicesChecked: true,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(heard.stop).toHaveBeenCalled();

    // Once.
    await user.click(screen.getByRole("button", { name: "Start a huddle" }));
    await waitFor(() => expect(join).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the system's defaults when those are the answer, and still asks only once", async () => {
    const { set, join, user, start } = setup();
    await start();
    await user.click(within(await dialog()).getByRole("button", { name: "Join huddle" }));
    await waitFor(() =>
      expect(join).toHaveBeenCalledWith("C_GENERAL", { muted: false, noiseFilter }),
    );
    expect(set).toHaveBeenCalledWith("call-preferences", {
      joinMuted: false,
      devicesChecked: true,
    });
  });

  it("joins nothing on Cancel, and asks again next time", async () => {
    const { set, join, user, start } = setup();
    await start();
    await user.click(within(await dialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start a huddle" })).toBeEnabled(),
    );
    expect(join).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Start a huddle" }));
    expect(await dialog()).toBeVisible();
  });

  it("leaves a question asked right after Cancel open", async () => {
    const { client, join, start } = setup();
    await start();
    // Asked again before the first dialog has finished leaving.
    let joining!: Promise<void>;
    act(() => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
      joining = calls.joinHuddle(client, "C_GENERAL");
    });
    const asked = await dialog();
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(asked).toBeVisible();
    expect(join).not.toHaveBeenCalled();

    await userEvent.click(within(asked).getByRole("button", { name: "Join huddle" }));
    await act(async () => joining);
    expect(join).toHaveBeenCalledTimes(1);
  });

  it("joins nothing when the huddle stopped being wanted while the devices were listed", async () => {
    listed = DESKTOP;
    let list!: (devices: typeof listed) => void;
    enumerate.mockReturnValueOnce(new Promise((resolve) => (list = resolve)));
    const { client, join } = setup();
    await waitFor(() => expect(calls.loaded).toBe(true));
    let wanted = true;
    const joining = calls.joinHuddle(client, "C_GENERAL", () => wanted);
    await waitFor(() => expect(enumerate).toHaveBeenCalled());
    // Another channel was opened meanwhile.
    wanted = false;
    list(DESKTOP);
    await act(async () => joining);
    expect(join).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([
    ["one microphone and one camera", DESKTOP, { joinMuted: false }],
    ["a browser keeping the devices' names back", HIDDEN, { joinMuted: false }],
    ["a device asked before", LAPTOP, { joinMuted: false, devicesChecked: true }],
    ["a microphone chosen in settings", LAPTOP, { joinMuted: false, microphoneId: "mic-usb" }],
  ])("joins without asking for %s", async (_name, devices, saved) => {
    listed = devices;
    const { join, start } = setup(saved);
    await start();
    await waitFor(() => expect(join).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
