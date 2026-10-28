import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NO_MICROPHONES,
  SystemMicrophones,
  isEndpointId,
  parseEvent,
  parseMicrophoneList,
  type HelperProcess,
} from "../src/main/microphone.js";

/**
 * Microphones the app opens itself on Windows, as other apps do (the browser
 * opens them raw, without the sound effects set up in Windows). One helper
 * process each; its samples go to the page on a port.
 */
class FakeHelper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdinEnded = false;
  kill = vi.fn(() => {
    this.emit("exit", null);
    return true;
  });
  constructor(readonly args: string[]) {
    super();
    const end = this.stdin.end.bind(this.stdin);
    this.stdin.end = ((...args: Parameters<typeof end>) => {
      this.stdinEnded = true;
      return end(...args);
    }) as typeof this.stdin.end;
  }
  say(event: Record<string, unknown>) {
    this.stderr.write(`${JSON.stringify(event)}\n`);
  }
}

class FakePort extends EventEmitter {
  messages: unknown[] = [];
  postMessage(message: unknown) {
    this.messages.push(message);
  }
  close = vi.fn();
  start = vi.fn();
}

function setup(helperPath: string | null = "C:\\OwnBase\\ownbase-microphone.exe", startMs = 5000) {
  const helpers: FakeHelper[] = [];
  const spawn = vi.fn((_path: string, args: string[]) => {
    const helper = new FakeHelper(args);
    helpers.push(helper);
    return helper as unknown as HelperProcess;
  });
  return { microphones: new SystemMicrophones(helperPath, spawn, startMs), spawn, helpers };
}

/** Lets stream events land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const STARTED = {
  event: "started",
  sampleRate: 48000,
  channels: 2,
  name: "Microphone (KREO KAST)",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("what the helper says", () => {
  it("reads its list, keeping only what is well formed", () => {
    expect(
      parseMicrophoneList(
        JSON.stringify({
          default: "{0.0.1.00000000}.{a}",
          microphones: [
            { id: "{0.0.1.00000000}.{a}", name: "Microphone (A)" },
            { id: "", name: "nameless id" },
            { id: "{0.0.1.00000000}.{b}" },
            "nonsense",
          ],
        }),
      ),
    ).toEqual({
      defaultId: "{0.0.1.00000000}.{a}",
      microphones: [{ id: "{0.0.1.00000000}.{a}", name: "Microphone (A)" }],
    });
    expect(parseMicrophoneList("not json")).toEqual(NO_MICROPHONES);
    expect(parseMicrophoneList(JSON.stringify({ default: null }))).toEqual(NO_MICROPHONES);
  });

  it("takes an endpoint id only as one, without control characters or great length", () => {
    expect(isEndpointId("{0.0.1.00000000}.{d31ff253-cbe0-40f4-949c-2b6ba15c1806}")).toBe(true);
    expect(isEndpointId("default")).toBe(true);
    for (const id of ["", "a\nb", "x".repeat(513), 7, null]) expect(isEndpointId(id)).toBe(false);
  });

  it("reads its events, and nothing else, from its lines", () => {
    expect(parseEvent(JSON.stringify(STARTED))).toEqual(STARTED);
    expect(parseEvent('{"event":"ended","reason":"device-removed"}')).toEqual({
      event: "ended",
      reason: "device-removed",
    });
    expect(parseEvent('{"event":"started","sampleRate":5,"channels":1,"name":""}')).toBeNull();
    expect(parseEvent("Unhandled exception")).toBeNull();
  });
});

describe("listing Windows' microphones", () => {
  it("is nothing where the app does not open microphones itself", async () => {
    const { microphones, spawn } = setup(null);
    expect(await microphones.list()).toEqual(NO_MICROPHONES);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("is what the helper prints, or nothing when it fails", async () => {
    const { microphones, helpers } = setup();
    const listing = microphones.list();
    const helper = helpers[0]!;
    expect(helper.args).toEqual(["list"]);
    helper.stdout.write('{"default":null,"microphones":[{"id":"{a}","name":"Mic"}]}');
    await settle();
    helper.emit("exit", 0);
    expect(await listing).toEqual({ defaultId: null, microphones: [{ id: "{a}", name: "Mic" }] });

    const failing = microphones.list();
    helpers[1]!.emit("exit", 2);
    expect(await failing).toEqual(NO_MICROPHONES);
  });

  it("gives up on a helper that does not answer", async () => {
    vi.useFakeTimers();
    const { microphones, helpers } = setup();
    const listing = microphones.list();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await listing).toEqual(NO_MICROPHONES);
    expect(helpers[0]!.kill).toHaveBeenCalled();
  });
});

describe("opening a microphone", () => {
  async function opened(owner = 1) {
    const s = setup();
    const port = new FakePort();
    const opening = s.microphones.open(owner, "{kast}", port);
    const helper = s.helpers[0]!;
    helper.say(STARTED);
    const result = await opening;
    return { ...s, port, helper, result };
  }

  it("starts a helper for it and says its rate and name once it runs", async () => {
    const { helper, result, port } = await opened();
    expect(helper.args).toEqual(["capture", "{kast}"]);
    expect(result).toEqual({ session: 1, sampleRate: 48000, name: "Microphone (KREO KAST)" });
    expect(port.start).toHaveBeenCalled();
  });

  it("sends its samples on as whole floats, however the pipe splits them", async () => {
    const { helper, port } = await opened();
    const bytes = Buffer.from(new Float32Array([0.5, -0.25, 1]).buffer);
    helper.stdout.write(bytes.subarray(0, 6));
    helper.stdout.write(bytes.subarray(6));
    await settle();
    expect(port.messages.map((m) => [...(m as Float32Array)])).toEqual([[0.5], [-0.25, 1]]);
  });

  it("rejects, saying why, and lets the port go when it will not start", async () => {
    const { microphones, helpers } = setup();
    const port = new FakePort();
    const opening = microphones.open(1, "{kast}", port);
    helpers[0]!.say({ event: "error", message: "not found" });
    await expect(opening).rejects.toThrow("The microphone did not start: not found.");
    expect(port.close).toHaveBeenCalled();
    expect(helpers[0]!.stdinEnded).toBe(true);
    expect(microphones.openCount).toBe(0);

    const exiting = microphones.open(1, "{kast}", new FakePort());
    helpers[1]!.emit("exit", 2);
    await expect(exiting).rejects.toThrow("The microphone did not start (2).");
  });

  it("gives up on a helper that does not start in time", async () => {
    vi.useFakeTimers();
    const { microphones } = setup();
    const opening = microphones.open(1, "{kast}", new FakePort());
    const failed = expect(opening).rejects.toThrow("did not start in time");
    await vi.advanceTimersByTimeAsync(5000);
    await failed;
    expect(microphones.openCount).toBe(0);
  });

  it("refuses what is not a microphone, and where the app does not open them", async () => {
    await expect(setup().microphones.open(1, "a\nb", new FakePort())).rejects.toThrow(
      "Not a microphone.",
    );
    const port = new FakePort();
    await expect(setup(null).microphones.open(1, "{kast}", port)).rejects.toThrow(
      "does not open microphones itself",
    );
    expect(port.close).toHaveBeenCalled();
  });

  it("holds only a few for one window", async () => {
    const { microphones, helpers } = setup();
    for (let i = 0; i < 4; i++) {
      const opening = microphones.open(1, "{kast}", new FakePort());
      helpers[i]!.say(STARTED);
      await opening;
    }
    await expect(microphones.open(1, "{kast}", new FakePort())).rejects.toThrow("Too many");
    // Another window has its own.
    const other = microphones.open(2, "{kast}", new FakePort());
    helpers.at(-1)!.say(STARTED);
    await expect(other).resolves.toMatchObject({ session: 5 });
  });
});

describe("a microphone that ends", () => {
  it("tells the page why when the device goes, then closes its port", async () => {
    vi.useFakeTimers();
    const { microphones, helpers } = setup();
    const port = new FakePort();
    const opening = microphones.open(1, "{kast}", port);
    helpers[0]!.say(STARTED);
    await vi.advanceTimersByTimeAsync(0);
    await opening;
    helpers[0]!.say({ event: "ended", reason: "device-removed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(port.messages).toContainEqual({ ended: "device-removed" });
    expect(microphones.openCount).toBe(0);
    // A moment to hear why first.
    expect(port.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(port.close).toHaveBeenCalled();
  });

  it("tells the page when the helper stops by itself", async () => {
    const { microphones, helpers } = setup();
    const port = new FakePort();
    const opening = microphones.open(1, "{kast}", port);
    helpers[0]!.say(STARTED);
    await opening;
    helpers[0]!.emit("exit", null);
    expect(port.messages).toContainEqual({ ended: "helper-exited" });
  });

  it("stops the helper when the window lets it go, without telling the page it ended", async () => {
    const { microphones, helpers } = setup();
    const port = new FakePort();
    const opening = microphones.open(1, "{kast}", port);
    helpers[0]!.say(STARTED);
    const { session } = await opening;

    microphones.close(2, session);
    expect(microphones.openCount).toBe(1);
    microphones.close(1, session);
    expect(microphones.openCount).toBe(0);
    expect(helpers[0]!.stdinEnded).toBe(true);
    expect(port.close).toHaveBeenCalled();
    helpers[0]!.emit("exit", 0);
    expect(port.messages).not.toContainEqual(expect.objectContaining({ ended: expect.anything() }));
  });

  it("stops when the page's end of the port closes, or its window goes", async () => {
    const { microphones, helpers } = setup();
    const ports = [new FakePort(), new FakePort(), new FakePort()];
    for (const [i, owner] of [1, 1, 2].entries()) {
      const opening = microphones.open(owner, "{kast}", ports[i]!);
      helpers[i]!.say(STARTED);
      await opening;
    }
    ports[0]!.emit("close");
    expect(helpers[0]!.stdinEnded).toBe(true);
    microphones.closeOwner(1);
    expect(helpers[1]!.stdinEnded).toBe(true);
    expect(helpers[2]!.stdinEnded).toBe(false);
    microphones.closeAll();
    expect(helpers[2]!.stdinEnded).toBe(true);
  });
});

// The real helper, where it is built: Windows, after scripts/build-microphone.mjs.
const built = join(import.meta.dirname, "../native/bin/ownbase-microphone.exe");
describe.runIf(process.platform === "win32" && existsSync(built))("the helper itself", () => {
  it("lists this computer's microphones", async () => {
    const list = await new SystemMicrophones(built).list();
    expect(Array.isArray(list.microphones)).toBe(true);
    if (list.defaultId) expect(list.microphones.map((m) => m.id)).toContain(list.defaultId);
  });
});
