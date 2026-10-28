import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenedSystemMicrophone, Platform } from "../src/platform.js";
import { matchMicrophone, systemMicrophoneOpener } from "../src/lib/systemMicrophone.js";

/**
 * Microphones the desktop app opens itself on Windows, as other apps do, so
 * the sound effects set up in Windows reach calls. The browser names a device
 * by its own id; Windows by its endpoint; the two meet by name.
 */
const KAST = { id: "{0.0.1.00000000}.{d31f}", name: "Microphone (KREO KAST)" };
const C18 = { id: "{0.0.1.00000000}.{7332}", name: "Microphone (Audiocular C18)" };

describe("which of Windows' microphones the browser's device is", () => {
  it("is the one with its name, less the USB ids Chromium adds", () => {
    expect(matchMicrophone("Microphone (KREO KAST) (0a67:d1b5)", [C18, KAST])).toBe(KAST);
    expect(matchMicrophone("Microphone (Audiocular C18)", [C18, KAST])).toBe(C18);
  });

  it("is none when two share the name, or the browser keeps names back", () => {
    const twin = { id: "{0.0.1.00000000}.{9999}", name: KAST.name };
    expect(matchMicrophone("Microphone (KREO KAST) (0a67:d1b5)", [KAST, twin])).toBeNull();
    expect(matchMicrophone("", [KAST])).toBeNull();
    expect(matchMicrophone("Microphone (Webcam)", [KAST])).toBeNull();
  });
});

/** Just enough Web Audio to play a port into a stream. */
const audio = vi.hoisted(() => ({
  contexts: [] as {
    options: unknown;
    addModule: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }[],
  nodes: [] as {
    port: { postMessage: ReturnType<typeof vi.fn>; onmessage: ((e: unknown) => void) | null };
  }[],
  track: { stop: () => {} },
}));

class FakeAudioContext {
  state = "suspended";
  audioWorklet = { addModule: vi.fn(async () => {}) };
  close = vi.fn(async () => {});
  constructor(readonly options: unknown) {
    audio.contexts.push({ options, addModule: this.audioWorklet.addModule, close: this.close });
  }
  async resume() {
    this.state = "running";
  }
  createMediaStreamDestination() {
    return { channelCount: 2, stream: { getTracks: () => [audio.track] } };
  }
}

class FakeWorkletNode {
  port = { postMessage: vi.fn(), onmessage: null as ((e: unknown) => void) | null };
  connect = vi.fn();
  disconnect = vi.fn();
  constructor(
    readonly context: unknown,
    readonly name: string,
  ) {
    audio.nodes.push(this);
  }
}

const g = globalThis as unknown as Record<string, unknown>;

function devices(list: { deviceId: string; label: string }[]) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        enumerateDevices: async () => list.map((d) => ({ ...d, kind: "audioinput" })),
      },
    },
  });
}

/** A platform that lists `microphones` and opens any of them. */
function platform(microphones = [C18, KAST], defaultId: string | null = C18.id) {
  const closes: ReturnType<typeof vi.fn>[] = [];
  const open = vi.fn(async (id: string): Promise<OpenedSystemMicrophone> => {
    const close = vi.fn();
    closes.push(close);
    const { port1 } = new MessageChannel();
    return {
      port: port1,
      sampleRate: 48000,
      name: microphones.find((m) => m.id === id)!.name,
      close,
    };
  });
  const list = vi.fn(async () => ({ defaultId, microphones }));
  return {
    platform: { systemMicrophone: { list, open } } satisfies Pick<Platform, "systemMicrophone">,
    open,
    closes,
  };
}

beforeEach(() => {
  audio.contexts = [];
  audio.nodes = [];
  g.AudioContext = FakeAudioContext;
  g.AudioWorkletNode = FakeWorkletNode;
  devices([
    { deviceId: "kast", label: "Microphone (KREO KAST) (0a67:d1b5)" },
    { deviceId: "hidden", label: "" },
  ]);
});

afterEach(() => {
  delete g.AudioContext;
  delete g.AudioWorkletNode;
});

describe("opening a microphone as other apps on this computer do", () => {
  it("is not offered where the platform cannot", () => {
    expect(systemMicrophoneOpener(null)).toBeUndefined();
    expect(systemMicrophoneOpener({})).toBeUndefined();
  });

  it("opens the browser's device by its name, at its own rate, through the worklet", async () => {
    const { platform: p, open, closes } = platform();
    const mic = await systemMicrophoneOpener(p)!("kast");
    expect(open).toHaveBeenCalledWith(KAST.id);
    expect(mic).toMatchObject({ label: "Microphone (KREO KAST)" });
    expect(audio.contexts[0]!.options).toMatchObject({ sampleRate: 48000 });
    expect(audio.contexts[0]!.addModule).toHaveBeenCalledOnce();
    // The samples go to the worklet's thread, the port handed over with them.
    const [message, transfer] = audio.nodes[0]!.port.postMessage.mock.calls[0]!;
    expect(transfer).toEqual([message.port]);

    const ended = vi.fn();
    mic!.onEnded = ended;
    audio.nodes[0]!.port.onmessage!({ data: { ended: "device-removed" } });
    expect(ended).toHaveBeenCalledOnce();

    mic!.stop();
    mic!.stop();
    expect(closes[0]).toHaveBeenCalledOnce();
    expect(audio.contexts[0]!.close).toHaveBeenCalledOnce();
  });

  it("opens the system's default when no device is chosen", async () => {
    const { platform: p, open } = platform();
    await systemMicrophoneOpener(p)!(undefined);
    expect(open).toHaveBeenCalledWith(C18.id);
  });

  it("gives up, for the browser to open it, when it cannot tell which device", async () => {
    const twin = { id: "{0.0.1.00000000}.{9999}", name: KAST.name };
    for (const [deviceId, setup] of [
      ["kast", platform([KAST, twin])],
      ["hidden", platform()],
      [undefined, platform([KAST], null)],
    ] as const) {
      expect(await systemMicrophoneOpener(setup.platform)!(deviceId)).toBeNull();
      expect(setup.open).not.toHaveBeenCalled();
    }
  });

  it("rejects as getUserMedia does for a device the browser does not list", async () => {
    const { platform: p, open } = platform();
    await expect(systemMicrophoneOpener(p)!("unplugged")).rejects.toMatchObject({
      name: "NotFoundError",
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("lets the device go when its sound cannot be played", async () => {
    const { platform: p, closes } = platform();
    g.AudioWorkletNode = undefined;
    await expect(systemMicrophoneOpener(p)!("kast")).rejects.toThrow("cannot play it");
    expect(closes[0]).toHaveBeenCalledOnce();
  });
});
