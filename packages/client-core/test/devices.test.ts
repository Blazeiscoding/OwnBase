import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canChooseSpeaker,
  listMediaDevices,
  microphoneConstraints,
  openSaved,
  wantsNoiseFilter,
  wantsSystemMicrophone,
} from "../src/devices.js";

/** What Chromium's `enumerateDevices` gives on Windows, stand-ins for the default included. */
function devices(list: { kind: MediaDeviceKind; deviceId: string; label: string }[]) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { enumerateDevices: () => Promise.resolve(list) } },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
});

describe("the devices to choose from (Voice & video)", () => {
  it("lists each device once, without the browser's stand-ins for the default", async () => {
    devices([
      { kind: "audioinput", deviceId: "default", label: "Default - Headset Microphone (USB)" },
      { kind: "audioinput", deviceId: "communications", label: "Communications - Headset (USB)" },
      { kind: "audioinput", deviceId: "mic-usb", label: "Headset Microphone (USB)" },
      { kind: "audioinput", deviceId: "mic-array", label: "Microphone Array (Realtek)" },
      { kind: "videoinput", deviceId: "cam-1", label: "Integrated Camera" },
      { kind: "audiooutput", deviceId: "default", label: "Default - Speakers (Realtek)" },
      { kind: "audiooutput", deviceId: "spk-1", label: "Speakers (Realtek)" },
    ]);
    expect(await listMediaDevices()).toEqual({
      microphones: [
        { id: "mic-usb", label: "Headset Microphone (USB)" },
        { id: "mic-array", label: "Microphone Array (Realtek)" },
      ],
      cameras: [{ id: "cam-1", label: "Integrated Camera" }],
      speakers: [{ id: "spk-1", label: "Speakers (Realtek)" }],
      named: true,
      defaultMicrophone: "Headset Microphone (USB)",
      defaultSpeaker: "Speakers (Realtek)",
    });
  });

  it("numbers devices whose names the browser keeps back, and says it is keeping them", async () => {
    devices([
      { kind: "audioinput", deviceId: "a1", label: "" },
      { kind: "audioinput", deviceId: "a2", label: "" },
      { kind: "videoinput", deviceId: "v1", label: "" },
      // Before any permission, Chromium gives one of each kind with no id at all.
      { kind: "audiooutput", deviceId: "", label: "" },
    ]);
    const lists = await listMediaDevices();
    expect(lists.named).toBe(false);
    expect(lists.microphones.map((d) => d.label)).toEqual(["Microphone 1", "Microphone 2"]);
    expect(lists.cameras.map((d) => d.label)).toEqual(["Camera 1"]);
    expect(lists.speakers).toEqual([]);
  });

  it("lists nothing where the page cannot reach devices at all", async () => {
    const lists = await listMediaDevices();
    expect(lists).toMatchObject({ microphones: [], cameras: [], speakers: [], named: false });
  });

  it("offers a choice of speaker only where the browser can play through one", () => {
    const g = globalThis as { HTMLMediaElement?: unknown };
    const before = g.HTMLMediaElement;
    try {
      g.HTMLMediaElement = class {};
      expect(canChooseSpeaker()).toBe(false);
      g.HTMLMediaElement = class {
        setSinkId() {}
      };
      expect(canChooseSpeaker()).toBe(true);
    } finally {
      g.HTMLMediaElement = before;
    }
  });
});

describe("how much noise to take out (Voice & video)", () => {
  it("uses the strong filter unless it, or suppression altogether, was turned off", () => {
    expect(wantsNoiseFilter()).toBe(true);
    expect(wantsNoiseFilter({ noiseFilter: true })).toBe(true);
    expect(wantsNoiseFilter({ noiseFilter: false })).toBe(false);
    // Turned off before there was a strong filter: still off.
    expect(wantsNoiseFilter({ noiseSuppression: false })).toBe(false);
    expect(wantsNoiseFilter({ noiseSuppression: false, noiseFilter: true })).toBe(false);
  });

  it("leaves the browser's own suppression off under the filter, rather than run both", () => {
    const audio = (filtered: boolean, settings = {}) =>
      (microphoneConstraints(settings, filtered).audio as MediaTrackConstraints).noiseSuppression;
    expect(audio(true)).toBe(false);
    expect(audio(false)).toBe(true);
    expect(audio(false, { noiseSuppression: false })).toBe(false);
  });
});

describe("when the system opens the microphone rather than the browser (Windows)", () => {
  const off = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

  it("only with none of the browser's processing chosen", () => {
    expect(wantsSystemMicrophone(off)).toBe(true);
    // Each is on unless turned off, so nothing chosen is all of them.
    expect(wantsSystemMicrophone()).toBe(false);
    expect(wantsSystemMicrophone({ ...off, echoCancellation: undefined })).toBe(false);
    expect(wantsSystemMicrophone({ ...off, autoGainControl: true })).toBe(false);
    expect(wantsSystemMicrophone({ ...off, noiseSuppression: true })).toBe(false);
  });

  it("with the strong filter standing in for the browser's suppression", () => {
    const strong = { echoCancellation: false, autoGainControl: false };
    expect(wantsSystemMicrophone(strong, true)).toBe(true);
    expect(wantsSystemMicrophone(strong, false)).toBe(false);
    expect(wantsSystemMicrophone({ ...strong, echoCancellation: true }, true)).toBe(false);
  });
});

describe("opening a saved device (Voice & video)", () => {
  const opened = (id: string | undefined) => ({ id }) as unknown as MediaStream;
  const refusal = (name: string, constraint?: string) =>
    Object.assign(new Error(""), { name, constraint });

  it("asks for the saved one, and for the default only when it is not connected", async () => {
    const asked: (string | undefined)[] = [];
    const missing = vi.fn();
    const open = async (id: string | undefined) => {
      asked.push(id);
      if (id === "headset") throw refusal("OverconstrainedError", "deviceId");
      return opened(id);
    };
    expect(await openSaved("desk-mic", open, missing)).toEqual({ id: "desk-mic" });
    expect(await openSaved("headset", open, missing)).toEqual({ id: undefined });
    expect(await openSaved(undefined, open, missing)).toEqual({ id: undefined });
    expect(asked).toEqual(["desk-mic", "headset", undefined, undefined]);
    expect(missing).toHaveBeenCalledTimes(1);
  });

  it("falls back for a device that is gone, but not for one that is there and will not start", async () => {
    const failing = (err: Error) => async (id: string | undefined) => {
      if (id) throw err;
      return opened(id);
    };
    await expect(openSaved("x", failing(refusal("NotFoundError")))).resolves.toEqual({
      id: undefined,
    });
    for (const err of [
      refusal("NotReadableError"),
      refusal("NotAllowedError"),
      refusal("OverconstrainedError", "width"),
    ])
      await expect(openSaved("x", failing(err))).rejects.toBe(err);
  });
});
