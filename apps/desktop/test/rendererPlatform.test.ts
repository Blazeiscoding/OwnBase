import { afterEach, describe, expect, it, vi } from "vitest";
import { electronPlatform, followPlace, systemMicrophone } from "../src/renderer/src/platform.js";

type Bridge = Window["ownbase"];

/**
 * The renderer reads its bridge off `window` when the platform is built, so a
 * stub is enough to drive it; nothing else in the module touches the DOM.
 */
function platformRejecting(reason: unknown) {
  const failing = () => Promise.reject(reason);
  (globalThis as { window?: unknown }).window = {
    ownbase: {
      hostingOpenToAll: failing,
      hostingSetPublicAddress: failing,
    } as unknown as Bridge,
  };
  return electronPlatform();
}

/** The whole message, since a leftover prefix would still contain the sentence. */
async function messageFrom(call: Promise<unknown>): Promise<string> {
  return call.then(
    () => "resolved",
    (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)),
  );
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("handing over final local work before close", () => {
  function preparingPlatform() {
    let prepare!: (id: number) => void;
    const prepared = vi.fn(async (_id: number, _saved: boolean) => {});
    (globalThis as { window?: unknown }).window = {
      ownbase: {
        onPrepareClose: (listener: (id: number) => void) => {
          prepare = listener;
          return () => {};
        },
        preparedClose: prepared,
      } as unknown as Bridge,
    };
    return { platform: electronPlatform(), prepared, prepare: (id: number) => prepare(id) };
  }

  it("captures every visible composer before persistence and holds the reply until writes finish", async () => {
    const { platform, prepared, prepare } = preparingPlatform();
    const calls: string[] = [];
    let finish!: () => void;
    const writing = new Promise<void>((done) => {
      finish = done;
    });
    platform.onPrepareClose!("persist", async () => {
      calls.push("persist");
      await writing;
    });
    platform.onPrepareClose!("capture", () => {
      calls.push("channel");
    });
    platform.onPrepareClose!("capture", () => {
      calls.push("thread");
    });
    prepare(51);
    await vi.waitFor(() => expect(calls).toEqual(["channel", "thread", "persist"]));
    expect(prepared).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(prepared).toHaveBeenCalledWith(51, true));
  });

  it("reports a refused write, retries, and excludes owners that unmounted", async () => {
    const { platform, prepared, prepare } = preparingPlatform();
    const oldAccount = vi.fn();
    platform.onPrepareClose!("capture", oldAccount)();
    let failing = true;
    platform.onPrepareClose!("persist", async () => {
      if (failing) throw new Error("disk full");
    });
    prepare(61);
    await vi.waitFor(() => expect(prepared).toHaveBeenCalledWith(61, false));
    failing = false;
    prepare(62);
    await vi.waitFor(() => expect(prepared).toHaveBeenCalledWith(62, true));
    expect(oldAccount).not.toHaveBeenCalled();
  });
});

describe("what the renderer shows when the main process refuses", () => {
  it("shows the sentence the main process wrote, not the channel it arrived on", async () => {
    const platform = platformRejecting(
      new Error(
        "Error invoking remote method 'hosting:setPublicAddress': Error: Use a public HTTPS hostname without a path, credentials, query, or fragment.",
      ),
    );

    expect(await messageFrom(platform.hosting!.setPublicAddress!("http://localhost:8543"))).toBe(
      "Use a public HTTPS hostname without a path, credentials, query, or fragment.",
    );
  });

  it("does the same for opening to all, whatever the handler's error class was named", async () => {
    const platform = platformRejecting(
      new Error(
        "Error invoking remote method 'hosting:openToAll': TypeError: Stop using the current public address before changing it.",
      ),
    );

    expect(await messageFrom(platform.hosting!.openToAll!({ inviteOnly: true }))).toBe(
      "Stop using the current public address before changing it.",
    );
  });

  it("leaves a message that never went through Electron alone", async () => {
    const platform = platformRejecting(new Error("The app is quitting."));

    expect(await messageFrom(platform.hosting!.setPublicAddress!(""))).toBe("The app is quitting.");
  });

  it("keeps something to read when the prefix is the whole message", async () => {
    const bare = "Error invoking remote method 'hosting:setPublicAddress': Error: ";
    const platform = platformRejecting(new Error(bare));

    expect(await messageFrom(platform.hosting!.setPublicAddress!(""))).toBe(bare);
  });

  it("names the workspace to rename or open by its folder, and repeats why it would not", async () => {
    const renames: [string, string][] = [];
    (globalThis as { window?: unknown }).window = {
      ownbase: {
        hostingRename: async (folder: string, name: string) => {
          renames.push([folder, name]);
          if (!name.trim())
            throw new Error(
              "Error invoking remote method 'hosting:rename': Error: Use a workspace name of 1 to 80 characters without control characters.",
            );
          return { folder, name: name.trim() };
        },
        hostingOpenFolder: async () => {
          throw new Error(
            "Error invoking remote method 'hosting:openFolder': Error: The folder for Rocket Team could not be opened.",
          );
        },
      } as unknown as Bridge,
    };
    const hosting = electronPlatform().hosting!;

    expect(await hosting.rename!("rocket-team", " Blue Team ")).toEqual({
      folder: "rocket-team",
      name: "Blue Team",
    });
    expect(await messageFrom(hosting.rename!("rocket-team", " "))).toBe(
      "Use a workspace name of 1 to 80 characters without control characters.",
    );
    expect(renames).toEqual([
      ["rocket-team", " Blue Team "],
      ["rocket-team", " "],
    ]);
    expect(await messageFrom(hosting.openFolder!("rocket-team"))).toBe(
      "The folder for Rocket Team could not be opened.",
    );
  });

  it("reports a rejection that was never an Error at all", async () => {
    const platform = platformRejecting("the connector went away");

    expect(await messageFrom(platform.hosting!.setPublicAddress!(""))).toBe(
      "the connector went away",
    );
  });
});

describe("the outbox every window shares", () => {
  it("is merged in the main process and watched for the other windows' changes", async () => {
    const merged = { outbox: 2, entries: [], removed: [] };
    const calls: unknown[][] = [];
    let notify: (key: string, stored: unknown) => void = () => {};
    (globalThis as { window?: unknown }).window = {
      ownbase: {
        storageMergeOutbox: async (...args: unknown[]) => {
          calls.push(args);
          return merged;
        },
        onOutboxChanged: (cb: typeof notify) => {
          notify = cb;
          return () => {
            notify = () => {};
          };
        },
      } as unknown as Bridge,
    };
    const platform = electronPlatform();
    const changes = { put: [], remove: [{ nonce: "A", rev: 1 }] };
    expect(await platform.storage.mergeOutbox!("outbox-key", changes, true)).toBe(merged);
    expect(calls).toEqual([["outbox-key", changes, true]]);

    const heard: unknown[] = [];
    const stop = platform.storage.watchOutbox!("outbox-key", (stored) => heard.push(stored));
    notify("another-key", "not this one");
    notify("outbox-key", "stored now");
    stop();
    notify("outbox-key", "after stopping");
    expect(heard).toEqual(["stored now"]);
  });
});

describe("the drafts every window shares", () => {
  it("are merged in the main process and watched for the other windows' changes", async () => {
    const merged = { C1: "stored now" };
    const calls: unknown[][] = [];
    let notify: (key: string, stored: unknown) => void = () => {};
    (globalThis as { window?: unknown }).window = {
      ownbase: {
        storageMergeDrafts: async (...args: unknown[]) => {
          calls.push(args);
          return merged;
        },
        onDraftsChanged: (cb: typeof notify) => {
          notify = cb;
          return () => {
            notify = () => {};
          };
        },
      } as unknown as Bridge,
    };
    const platform = electronPlatform();
    const changes = { put: { C1: "stored now" }, remove: ["C2"] };
    expect(await platform.storage.mergeDrafts!("drafts-key", changes, true)).toBe(merged);
    expect(calls).toEqual([["drafts-key", changes, true]]);

    const heard: unknown[] = [];
    const stop = platform.storage.watchDrafts!("drafts-key", (stored) => heard.push(stored));
    notify("another-key", "not this one");
    notify("drafts-key", "stored now");
    stop();
    notify("drafts-key", "after stopping");
    expect(heard).toEqual(["stored now"]);
  });
});

/** The page reports where it is, and starts from where it was after a crash (F08). */
describe("following the page's place", () => {
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
    const rememberPlace = vi.fn(async () => {});
    await followPlace({ rememberPlace, takePlace: async () => recovered });
    expect(history.state).toEqual(recovered);

    history.pushState(
      { ownbase: { server: "http://a", channelId: "C2" } },
      "",
      "file:///app/index.html#/c/C2",
    );
    history.replaceState({ ownbase: { server: "http://a", channelId: "C2", scroll: 1 } }, "");
    await vi.advanceTimersByTimeAsync(300);
    expect(rememberPlace).toHaveBeenLastCalledWith(location.href, history.state);
    const calls = rememberPlace.mock.calls.length;
    listeners.get("popstate")!();
    await vi.advanceTimersByTimeAsync(300);
    expect(rememberPlace.mock.calls.length).toBe(calls + 1);
    vi.useRealTimers();
  });

  it("leaves an entry the page already has, and carries on when the main process refuses", async () => {
    const { history } = page({ ownbase: { server: "http://a", channelId: "C9" } });
    await followPlace({
      rememberPlace: async () => {},
      takePlace: async () => ({ ownbase: { server: "http://a", channelId: "C1" } }),
    });
    expect(history.state).toEqual({ ownbase: { server: "http://a", channelId: "C9" } });
    page();
    await expect(
      followPlace({
        rememberPlace: async () => {},
        takePlace: () => Promise.reject(new Error("no")),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("notifications", () => {
  afterEach(() => {
    delete (globalThis as { Notification?: unknown }).Notification;
  });

  /** What the renderer asks Electron to show, one entry per notification. */
  function shown() {
    const made: Array<{ title: string; body?: string; tag?: string }> = [];
    (globalThis as { window?: unknown }).window = { ownbase: {} as Bridge };
    (globalThis as { Notification?: unknown }).Notification = class {
      constructor(title: string, options?: NotificationOptions) {
        made.push({ title, body: options?.body, tag: options?.tag });
      }
    };
    return { platform: electronPlatform(), made };
  }

  it("tags each one briefly enough for Windows to show it", () => {
    const { platform, made } = shown();
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
    // Still one tag per thing told about, so telling it again replaces it.
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

  function bridge(session = 7) {
    return {
      microphones: vi.fn(async () => ({ defaultId: null, microphones: [] })),
      openMicrophone: vi.fn(async () => ({ session, sampleRate: 48000, name: "Microphone (A)" })),
      closeMicrophone: vi.fn(async () => {}),
    };
  }

  it("is offered only where the bridge has it", () => {
    expect(systemMicrophone({}, windowWithPorts().target)).toBeUndefined();
  });

  it("hands over the port whether it arrives before or after the answer", async () => {
    const { target, post } = windowWithPorts();
    const b = bridge();
    const system = systemMicrophone(b, target)!;

    const early = new MessageChannel().port1;
    post({ type: "ownbase:microphone-port", session: 7 }, early);
    await expect(system.open("{a}")).resolves.toMatchObject({ port: early, sampleRate: 48000 });

    const late = new MessageChannel().port1;
    const opening = system.open("{a}");
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Not this window's, and not this session's: both left alone.
    post({ type: "ownbase:microphone-port", session: 7 }, new MessageChannel().port1, {});
    post({ type: "ownbase:microphone-port", session: 8 }, new MessageChannel().port1);
    post({ type: "ownbase:microphone-port", session: 7 }, late);
    const opened = await opening;
    expect(opened.port).toBe(late);

    opened.close();
    expect(b.closeMicrophone).toHaveBeenCalledWith(7);
  });

  it("lets the microphone go when its sound never arrives", async () => {
    vi.useFakeTimers();
    try {
      const b = bridge();
      const opening = systemMicrophone(b, windowWithPorts().target)!.open("{a}");
      const failed = expect(opening).rejects.toThrow("did not arrive");
      await vi.advanceTimersByTimeAsync(5000);
      await failed;
      expect(b.closeMicrophone).toHaveBeenCalledWith(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says why it would not open, without the IPC channel's prefix", async () => {
    const b = bridge();
    b.openMicrophone.mockRejectedValue(
      new Error(
        "Error invoking remote method 'microphone:open': Error: Too many microphones are open.",
      ),
    );
    expect(await messageFrom(systemMicrophone(b, windowWithPorts().target)!.open("{a}"))).toBe(
      "Too many microphones are open.",
    );
  });
});
