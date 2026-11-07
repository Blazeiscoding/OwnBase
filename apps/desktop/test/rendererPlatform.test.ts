import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopCapabilities } from "@ownbase/protocol/desktop";
import type { Channel, EventName, OwnBaseBridge } from "../src/shared/bridge.js";
import {
  DesktopCallError,
  electronPlatform,
  followPlace,
  invoker,
  systemMicrophone,
} from "../src/renderer/src/platform.js";

const NONE: DesktopCapabilities = {
  readerLocale: null,
  screenSound: false,
  systemMicrophone: false,
  openAtLogin: false,
};

/**
 * A bridge as the preload builds it: each call answered by `answer` (a value,
 * or a thrown error that becomes the reply's failure), and events pushed with `push`.
 */
function fakeBridge(
  answer: (channel: Channel, args: unknown[]) => unknown = () => undefined,
  capabilities: Partial<DesktopCapabilities> = {},
) {
  const calls: [Channel, unknown[]][] = [];
  const listeners = new Map<EventName, Set<(payload: never) => void>>();
  const bridge: OwnBaseBridge = {
    invoke: (async (channel: Channel, ...args: unknown[]) => {
      calls.push([channel, args]);
      try {
        return { ok: true, value: await answer(channel, args) };
      } catch (error) {
        const { code = "failed", message } = error as { code?: string; message: string };
        return { ok: false, error: { code, message } };
      }
    }) as OwnBaseBridge["invoke"],
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(listener as (payload: never) => void);
      return () => set.delete(listener as (payload: never) => void);
    },
    capabilities: { ...NONE, ...capabilities },
  };
  const push = (event: EventName, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(payload as never);
  };
  return { bridge, calls, push };
}

async function failureOf(call: Promise<unknown>) {
  return call.then(
    () => null,
    (reason: unknown) => reason as DesktopCallError,
  );
}

describe("a desktop call", () => {
  it("resolves to the value the main process answered, sending the arguments as given", async () => {
    const { bridge, calls } = fakeBridge((_channel, [folder, name]) => ({
      folder,
      name: (name as string).trim(),
    }));
    const hosting = electronPlatform(bridge).hosting!;
    expect(await hosting.rename("rocket-team", " Blue Team ")).toEqual({
      folder: "rocket-team",
      name: "Blue Team",
    });
    expect(calls).toEqual([["hosting:rename", ["rocket-team", " Blue Team "]]]);
  });

  it("rejects with the failure's code and the main process's own words", async () => {
    const { bridge } = fakeBridge(() => {
      throw { code: "registry-newer", message: "A newer version of OwnBase saved the list." };
    });
    const failure = await failureOf(electronPlatform(bridge).hosting!.list());
    expect(failure).toBeInstanceOf(DesktopCallError);
    expect(failure).toMatchObject({
      code: "registry-newer",
      message: "A newer version of OwnBase saved the list.",
    });
  });

  it("drops Electron's prefix once when the bridge itself rejects", async () => {
    const rejecting = (reason: unknown) => invoker({ invoke: () => Promise.reject(reason) });
    const failure = await failureOf(
      rejecting(
        new Error(
          "Error invoking remote method 'hosting:openToAll': TypeError: Stop using the current public address first.",
        ),
      )("hosting:openToAll", "invite_only"),
    );
    expect(failure).toMatchObject({
      code: "internal",
      message: "Stop using the current public address first.",
    });

    // Something to read is kept when the prefix is all there is.
    const bare = "Error invoking remote method 'hosting:stop': Error: ";
    expect(await failureOf(rejecting(new Error(bare))("hosting:stop"))).toMatchObject({
      message: bare,
    });
    expect(await failureOf(rejecting("the connector went away")("hosting:stop"))).toMatchObject({
      code: "internal",
      message: "the connector went away",
    });
  });
});

describe("what the platform offers", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("follows the capabilities the main process decided", () => {
    (globalThis as { window?: unknown }).window = new EventTarget();
    const without = electronPlatform(fakeBridge().bridge);
    expect(without.screenShare!.sound).toBe(false);
    expect(without.systemMicrophone).toBeUndefined();
    expect(without.hosting!.openAtLogin).toBeNull();

    const withAll = electronPlatform(
      fakeBridge(undefined, { screenSound: true, systemMicrophone: true, openAtLogin: true })
        .bridge,
    );
    expect(withAll.screenShare!.sound).toBe(true);
    expect(withAll.systemMicrophone).toBeDefined();
    expect(withAll.hosting!.openAtLogin).not.toBeNull();
  });

  it("has no storage watchers, as the desktop app has one window", () => {
    const { storage } = electronPlatform(fakeBridge().bridge);
    expect(storage.watchOutbox).toBeUndefined();
    expect(storage.watchDrafts).toBeUndefined();
    expect(storage.watchRecord).toBeUndefined();
  });

  it("hears the hosting status only as it is pushed", () => {
    const { bridge, push } = fakeBridge();
    const heard: unknown[] = [];
    const stop = electronPlatform(bridge).hosting!.subscribe((status) => heard.push(status));
    push("hosting:changed", { phase: "running" });
    stop();
    push("hosting:changed", { phase: "stopped" });
    expect(heard).toEqual([{ phase: "running" }]);
  });

  it("tells the window's frame the page's theme, and shrugs off a failure", async () => {
    const { bridge, calls } = fakeBridge(() => {
      throw new Error("no window");
    });
    expect(() => electronPlatform(bridge).setWindowTheme!("dark")).not.toThrow();
    await vi.waitFor(() => expect(calls).toEqual([["window:setTheme", ["dark"]]]));
  });
});

describe("handing over final local work before close", () => {
  function preparing() {
    const { bridge, calls, push } = fakeBridge();
    const prepared = () =>
      calls.filter(([channel]) => channel === "window:preparedClose").map(([, args]) => args);
    return {
      platform: electronPlatform(bridge),
      prepared,
      prepare: (id: number) => push("window:prepareClose", id),
    };
  }

  it("captures every visible composer before persistence and holds the reply until writes finish", async () => {
    const { platform, prepared, prepare } = preparing();
    const order: string[] = [];
    let finish!: () => void;
    const writing = new Promise<void>((done) => {
      finish = done;
    });
    platform.onPrepareClose!("persist", async () => {
      order.push("persist");
      await writing;
    });
    platform.onPrepareClose!("capture", () => {
      order.push("channel");
    });
    platform.onPrepareClose!("capture", () => {
      order.push("thread");
    });
    prepare(51);
    await vi.waitFor(() => expect(order).toEqual(["channel", "thread", "persist"]));
    expect(prepared()).toEqual([]);
    finish();
    await vi.waitFor(() => expect(prepared()).toEqual([[51, true]]));
  });

  it("reports a refused write, retries, and excludes owners that unmounted", async () => {
    const { platform, prepared, prepare } = preparing();
    const oldAccount = vi.fn();
    platform.onPrepareClose!("capture", oldAccount)();
    let failing = true;
    platform.onPrepareClose!("persist", async () => {
      if (failing) throw new Error("disk full");
    });
    prepare(61);
    await vi.waitFor(() => expect(prepared()).toEqual([[61, false]]));
    failing = false;
    prepare(62);
    await vi.waitFor(() =>
      expect(prepared()).toEqual([
        [61, false],
        [62, true],
      ]),
    );
    expect(oldAccount).not.toHaveBeenCalled();
  });
});

/** The page reports where it is, and starts from where it was after a crash (F08). */
describe("following the page's place", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  function page(state: unknown = null) {
    const listeners = new Map<string, () => void>();
    const history = {
      state,
      pushState(next: unknown, _unused: string, url?: string) {
        history.state = next;
        if (url) location.href = url;
      },
      replaceState(next: unknown, _unused: string, url?: string) {
        history.state = next;
        if (url) location.href = url;
      },
    };
    const location = { href: "file:///app/index.html#/c/C1" };
    (globalThis as { window?: unknown }).window = {
      history,
      location,
      addEventListener: (name: string, cb: () => void) => listeners.set(name, cb),
    };
    return { history, location, listeners };
  }

  it("starts a recovered page from its entry, then reports each change once it settles", async () => {
    vi.useFakeTimers();
    const { history, location, listeners } = page();
    const recovered = { ownbase: { server: "http://a", channelId: "C1", view: "saved" } };
    const { bridge, calls } = fakeBridge((channel) =>
      channel === "window:takePlace" ? recovered : undefined,
    );
    const reports = () => calls.filter(([channel]) => channel === "window:rememberPlace");
    await followPlace(bridge);
    expect(history.state).toEqual(recovered);

    history.pushState(
      { ownbase: { server: "http://a", channelId: "C2" } },
      "",
      "file:///app/index.html#/c/C2",
    );
    history.replaceState({ ownbase: { server: "http://a", channelId: "C2", scroll: 1 } }, "");
    await vi.advanceTimersByTimeAsync(300);
    expect(reports().at(-1)![1]).toEqual([location.href, history.state]);
    const before = reports().length;
    listeners.get("popstate")!();
    await vi.advanceTimersByTimeAsync(300);
    expect(reports().length).toBe(before + 1);
    vi.useRealTimers();
  });

  it("leaves an entry the page already has, and carries on when the main process refuses", async () => {
    const { history } = page({ ownbase: { server: "http://a", channelId: "C9" } });
    await followPlace(
      fakeBridge(() => ({ ownbase: { server: "http://a", channelId: "C1" } })).bridge,
    );
    expect(history.state).toEqual({ ownbase: { server: "http://a", channelId: "C9" } });
    page();
    await expect(
      followPlace(
        fakeBridge(() => {
          throw new Error("no");
        }).bridge,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("notifications", () => {
  afterEach(() => {
    delete (globalThis as { Notification?: unknown }).Notification;
  });

  it("tags each one briefly enough for Windows to show it", () => {
    const made: Array<{ title: string; body?: string; tag?: string }> = [];
    (globalThis as { Notification?: unknown }).Notification = class {
      constructor(title: string, options?: NotificationOptions) {
        made.push({ title, body: options?.body, tag: options?.tag });
      }
    };
    const platform = electronPlatform(fakeBridge().bridge);
    // How WorkspaceScreen tags a message: the account, then the message.
    const account = "http://192.168.1.20:8543 01M5NEH8VBQEKYEXT5BP4AH72Y";
    platform.notify("Bob", "one", undefined, { tag: `${account} 01M5NEH8VBQEKYEXT5BP4AH72Z` });
    platform.notify("Bob", "two", undefined, { tag: `${account} 01M5NEH8VBQEKYEXT5BP4AH730` });
    platform.notify("Bob", "one again", undefined, {
      tag: `${account} 01M5NEH8VBQEKYEXT5BP4AH72Z`,
    });
    platform.notify("Bob", "untagged");
    expect(made.map(({ title, body }) => [title, body])).toEqual([
      ["Bob", "one"],
      ["Bob", "two"],
      ["Bob", "one again"],
      ["Bob", "untagged"],
    ]);
    // Windows drops a notification whose tag runs past 54 characters, without
    // an error or a word from Electron (measured on Windows 11, Electron 44).
    for (const { tag } of made.slice(0, 3)) expect(tag!.length).toBeLessThanOrEqual(16);
    expect(made[0]!.tag).not.toBe(made[1]!.tag);
    expect(made[2]!.tag).toBe(made[0]!.tag);
    expect(made[3]!.tag).toBeUndefined();
  });
});

describe("microphones the app opens itself (Windows)", () => {
  /** A window as the preload posts ports to it. */
  function windowWithPorts() {
    const target = new EventTarget();
    const post = (data: unknown, port: MessagePort, source: unknown = target) =>
      target.dispatchEvent(Object.assign(new Event("message"), { data, source, ports: [port] }));
    return { target: target as unknown as Window, post };
  }

  function opening(session = 7, refusal?: { code: string; message: string }) {
    const { bridge, calls } = fakeBridge((channel) => {
      if (channel !== "microphone:open") return undefined;
      if (refusal) throw refusal;
      return { session, sampleRate: 48000, name: "Microphone (A)" };
    });
    const closed = () =>
      calls.filter(([channel]) => channel === "microphone:close").map(([, [id]]) => id);
    return { call: invoker(bridge), closed };
  }

  it("hands over the port whether it arrives before or after the answer", async () => {
    const { target, post } = windowWithPorts();
    const { call, closed } = opening();
    const system = systemMicrophone(call, target);

    const early = new MessageChannel().port1;
    post({ type: "ownbase:microphone-port", session: 7 }, early);
    await expect(system.open("{a}")).resolves.toMatchObject({ port: early, sampleRate: 48000 });

    const late = new MessageChannel().port1;
    const pending = system.open("{a}");
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Not this window's, and not this session's: both left alone.
    post({ type: "ownbase:microphone-port", session: 7 }, new MessageChannel().port1, {});
    post({ type: "ownbase:microphone-port", session: 8 }, new MessageChannel().port1);
    post({ type: "ownbase:microphone-port", session: 7 }, late);
    const opened = await pending;
    expect(opened.port).toBe(late);

    opened.close();
    await vi.waitFor(() => expect(closed()).toEqual([7]));
  });

  it("lets the microphone go when its sound never arrives", async () => {
    vi.useFakeTimers();
    try {
      const { call, closed } = opening();
      const pending = systemMicrophone(call, windowWithPorts().target).open("{a}");
      const failed = expect(pending).rejects.toThrow("did not arrive");
      await vi.advanceTimersByTimeAsync(5000);
      await failed;
      expect(closed()).toEqual([7]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says why it would not open", async () => {
    const { call } = opening(7, { code: "failed", message: "Too many microphones are open." });
    expect(
      await failureOf(systemMicrophone(call, windowWithPorts().target).open("{a}")),
    ).toMatchObject({ message: "Too many microphones are open." });
  });
});
