import { addTrustedAddress, applyDraftChanges, applyOutboxChanges } from "@slackoss/client-core";
import type { Platform } from "../src/platform.js";

/**
 * One device's storage as the desktop app keeps it: every read, write and
 * outbox or drafts merge from every window takes its turn in one queue, and a
 * merge is a single turn (`applyOutboxChanges`, as `mergeOutboxSetting` runs
 * it; `applyDraftChanges`, as `mergeDraftsSetting` does; `addTrustedAddress`,
 * as the `storage:trustAddress` handler does). After a drafts
 * merge, every other window hears what is stored, as the main process tells
 * them.
 * `pausedWindow` gives a window whose first read of `key` stops, once it has
 * its answer, until `resume` is called: the moment another window can act.
 */
export function sharedDevice(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
  // What each window listens for, as the main process tells every other window.
  const draftListeners = new Set<{
    from: object;
    key: string;
    cb: (stored: unknown) => void;
  }>();
  let queue: Promise<unknown> = Promise.resolve();
  const turn = <T>(op: () => T): Promise<T> => {
    const next = queue.then(op);
    queue = next.catch(() => {});
    return next;
  };
  const window = (hold?: { key: string; reached: () => void; until: Promise<void> }) => {
    let held = false;
    const self = {};
    const platform: Platform = {
      kind: "desktop",
      notify: () => {},
      storage: {
        get: async <T>(name: string) => {
          const value = await turn(() => (values.get(name) ?? null) as T | null);
          if (hold && !held && name === hold.key) {
            held = true;
            hold.reached();
            await hold.until;
          }
          return value;
        },
        set: (name, value) =>
          turn(() => {
            if (value === null) values.delete(name);
            else values.set(name, value);
          }),
        // As the main process's settings queue: only where nothing is stored.
        initialize: (name, value) =>
          turn(() => {
            if (!values.has(name)) values.set(name, value);
            return values.get(name);
          }),
        mergeOutbox: (name, changes, enveloped) =>
          turn(() => {
            const { value, outbox } = applyOutboxChanges(
              values.get(name) ?? null,
              changes,
              enveloped,
            );
            values.set(name, value);
            return outbox;
          }),
        mergeDrafts: (name, changes, enveloped) =>
          turn(() => {
            const { value, drafts } = applyDraftChanges(
              values.get(name) ?? null,
              changes,
              enveloped,
            );
            values.set(name, value);
            for (const listener of draftListeners)
              if (listener.from !== self && listener.key === name) listener.cb(value);
            return drafts;
          }),
        watchDrafts: (name, cb) => {
          const listener = { from: self, key: name, cb };
          draftListeners.add(listener);
          return () => void draftListeners.delete(listener);
        },
        trustAddress: (name, address) =>
          turn(() => {
            const { value, addresses } = addTrustedAddress(values.get(name) ?? null, address);
            values.set(name, value);
            return addresses;
          }),
      },
    };
    return platform;
  };
  const pausedWindow = (key: string) => {
    let resume = () => {};
    let reached = () => {};
    const paused = new Promise<void>((resolve) => (reached = resolve));
    const until = new Promise<void>((resolve) => (resume = resolve));
    return { platform: window({ key, reached, until }), paused, resume };
  };
  return { values, window, pausedWindow };
}
