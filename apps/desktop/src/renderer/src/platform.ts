import type { DesktopErrorCode, DesktopHosting } from "@ownbase/protocol/desktop";
import type { OpenedSystemMicrophone, Platform } from "@ownbase/ui";
import {
  CHANNELS,
  MICROPHONE_PORT,
  type Args,
  type Channel,
  type OwnBaseBridge,
  type Result,
} from "../../shared/bridge.js";

declare global {
  interface Window {
    /** Absent when this page is opened in a plain browser. */
    ownbase?: OwnBaseBridge;
  }
}

/** A desktop call that failed, with the code the UI acts on. */
export class DesktopCallError extends Error {
  constructor(
    readonly code: DesktopErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DesktopCallError";
  }
}

/** Electron's wording when the bridge itself rejects, before the reason it was given. */
const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/;

export type Call = <C extends Channel>(channel: C, ...args: Args<C>) => Promise<Result<C>>;

export function invoker(bridge: Pick<OwnBaseBridge, "invoke">): Call {
  return async (channel, ...args) => {
    let reply;
    try {
      reply = await bridge.invoke(channel, ...args);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      throw new DesktopCallError("internal", message.replace(IPC_PREFIX, "") || message);
    }
    if (reply.ok) return reply.value;
    throw new DesktopCallError(reply.error.code, reply.error.message);
  };
}

type Callers<M extends Record<string, Channel>> = {
  [K in keyof M]: (...args: Args<M[K]>) => Promise<Result<M[K]>>;
};

function callers<M extends Record<string, Channel>>(call: Call, channels: M): Callers<M> {
  return Object.fromEntries(
    Object.entries(channels).map(([name, channel]) => [
      name,
      (...args: unknown[]) => (call as (c: Channel, ...a: unknown[]) => unknown)(channel, ...args),
    ]),
  ) as unknown as Callers<M>;
}

/**
 * Every hosting call, on the channel `hosting:` followed by its path in
 * `DesktopHosting`, as the bridge names them all.
 */
export function hostingCalls(call: Call): DesktopHosting {
  const hosting: Record<string, unknown> = {};
  for (const channel of CHANNELS) {
    const [prefix, ...path] = channel.split(":");
    if (prefix !== "hosting") continue;
    let at = hosting;
    for (const step of path.slice(0, -1)) at = (at[step] ??= {}) as Record<string, unknown>;
    at[path.at(-1)!] = (...args: unknown[]) =>
      (call as (c: Channel, ...a: unknown[]) => unknown)(channel, ...args);
  }
  return hosting as unknown as DesktopHosting;
}

/**
 * Windows drops a notification whose tag runs past 54 characters, with no
 * error and no word from Electron, and the screen's tags (an account's
 * address and id, then what it is about) are longer than that. So Electron is
 * given a fingerprint of the tag instead (cyrb53, 53 bits): the same tag gives
 * the same one, so telling about something again still replaces it.
 */
function windowsTag(tag: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < tag.length; i++) {
    const ch = tag.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** How long an opened microphone's port may take to arrive. */
const PORT_MS = 5000;

/**
 * Microphones the app opens itself on Windows (the main process's
 * microphone.ts). Each one's sound arrives on a port of its own, posted to
 * this window by the preload before or after the answer to opening it, so
 * ports are held here until they are asked for.
 */
export function systemMicrophone(
  call: Call,
  target: Window = window,
): NonNullable<Platform["systemMicrophone"]> {
  const arrived = new Map<number, MessagePort>();
  const waiting = new Map<number, (port: MessagePort) => void>();
  target.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== target) return;
    const data = event.data as { type?: unknown; session?: unknown } | null;
    const port = event.ports[0];
    if (data?.type !== MICROPHONE_PORT || typeof data.session !== "number" || !port) return;
    const take = waiting.get(data.session);
    if (take) {
      waiting.delete(data.session);
      take(port);
    } else {
      arrived.set(data.session, port);
    }
  });
  const portFor = (session: number) =>
    new Promise<MessagePort>((resolve, reject) => {
      const held = arrived.get(session);
      if (held) {
        arrived.delete(session);
        resolve(held);
        return;
      }
      const timer = setTimeout(() => {
        waiting.delete(session);
        reject(new Error("the microphone's sound did not arrive"));
      }, PORT_MS);
      waiting.set(session, (port) => {
        clearTimeout(timer);
        resolve(port);
      });
    });
  return {
    list: () => call("microphone:list"),
    open: async (id): Promise<OpenedSystemMicrophone> => {
      const { session, sampleRate, name } = await call("microphone:open", id);
      const close = () => void call("microphone:close", session).catch(() => {});
      try {
        return { port: await portFor(session), sampleRate, name, close };
      } catch (err) {
        close();
        throw err;
      }
    },
  };
}

export function electronPlatform(bridge: OwnBaseBridge): Platform {
  const call = invoker(bridge);
  const { capabilities } = bridge;
  const { openAtLogin, ...hosting } = hostingCalls(call);
  const preparing = {
    capture: new Set<() => void | Promise<void>>(),
    persist: new Set<() => void | Promise<void>>(),
  };
  bridge.on("window:prepareClose", (id) => {
    void (async () => {
      let saved = false;
      try {
        for (const capture of [...preparing.capture]) await capture();
        await Promise.all([...preparing.persist].map((persist) => persist()));
        saved = true;
      } catch {
        // Failure is handed back to the native close decision; it must not silently quit.
      }
      await call("window:preparedClose", id, saved).catch(() => {});
    })();
  });
  return {
    kind: "desktop",
    onPrepareClose: (phase, prepare) => {
      preparing[phase].add(prepare);
      return () => {
        preparing[phase].delete(prepare);
      };
    },
    downloadFile: (url) => call("file:download", url),
    setWindowTheme: (theme) => void call("window:setTheme", theme).catch(() => {}),
    // One window, so nothing else changes what it stores: no watch* here.
    storage: {
      get: async <T>(key: string, options?: { strict?: boolean }) =>
        (await call("storage:get", key, options)) as T | null,
      ...callers(call, {
        set: "storage:set",
        initialize: "storage:initialize",
        trustAddress: "storage:trustAddress",
        mergeOutbox: "storage:mergeOutbox",
        mergeDrafts: "storage:mergeDrafts",
        mergeRecord: "storage:mergeRecord",
      }),
    },
    notify: (title, body, onClick, options) => {
      const tag = options?.tag === undefined ? undefined : windowsTag(options.tag);
      const note = new Notification(title, { body, silent: false, tag });
      if (onClick) {
        note.onclick = (event) => {
          event.preventDefault();
          // The renderer cannot raise a window that is minimized or closed to
          // the tray; the main process can.
          void call("window:reveal").catch(() => {});
          onClick();
          note.close();
        };
      }
    },
    screenShare: {
      ...callers(call, { sources: "screen:sources", choose: "screen:choose" }),
      sound: capabilities.screenSound,
    },
    ...(capabilities.systemMicrophone ? { systemMicrophone: systemMicrophone(call) } : {}),
    discoverLan: (cb) => {
      void call("lan:snapshot").then(cb, () => {});
      return bridge.on("lan:servers", cb);
    },
    deepLinks: {
      consumePending: () => call("deeplink:consume"),
      subscribe: (cb) => bridge.on("deeplink", cb),
    },
    hosting: {
      ...hosting,
      subscribe: (cb) => bridge.on("hosting:changed", cb),
      openAtLogin: capabilities.openAtLogin ? openAtLogin : null,
    },
  };
}

/**
 * Keeps the main process told where this page is, so a page that crashes or
 * fails to load comes back to the same place, side panel, thread, dialog and
 * reading position included (F08). The history entry holds all of that, and
 * a reload keeps the address but not the entry. Reports are gathered for a
 * moment, since reading position changes as someone scrolls.
 */
export async function followPlace(
  bridge: Pick<OwnBaseBridge, "invoke">,
  delayMs = 250,
): Promise<void> {
  const call = invoker(bridge);
  // A recovered page starts from the entry it had; the app checks that entry
  // belongs to the workspace it opens before using it.
  const recovered = await call("window:takePlace").catch(() => null);
  if (recovered && window.history.state == null)
    window.history.replaceState(recovered, "", window.location.href);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const report = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void call("window:rememberPlace", window.location.href, window.history.state).catch(() => {});
    }, delayMs);
  };
  for (const method of ["pushState", "replaceState"] as const) {
    const original = window.history[method].bind(window.history);
    window.history[method] = (...args: Parameters<History["pushState"]>) => {
      original(...args);
      report();
    };
  }
  window.addEventListener("popstate", report);
  window.addEventListener("hashchange", report);
  report();
}
