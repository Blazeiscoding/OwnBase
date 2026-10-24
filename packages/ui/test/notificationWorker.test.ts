import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { NOTIFICATION_CLICK, NOTIFICATION_WORKER } from "../src/lib/workerNotifications.js";

/**
 * The web client's service worker, which shows the notifications a page may
 * not make itself and hands a click on one back to its page.
 */
const source = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../apps/web/public",
    `.${NOTIFICATION_WORKER}`,
  ),
  "utf8",
);

/** Runs the worker against a stand-in for its global scope. */
function worker(
  pages: Array<{ postMessage: (message: unknown) => void; focus: () => Promise<unknown> }>,
) {
  const listeners = new Map<string, (event: unknown) => void>();
  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    skipWaiting: vi.fn(),
    registration: { scope: "https://chat.example/" },
    clients: {
      matchAll: vi.fn(async () => pages),
      openWindow: vi.fn(async () => null),
    },
  };
  new Function("self", source)(self);
  /** A click on a notification the page showed with `data`; resolves when the worker is done. */
  const click = async (data: unknown) => {
    const close = vi.fn();
    let done: Promise<unknown> = Promise.resolve();
    listeners.get("notificationclick")!({
      notification: { data, close },
      waitUntil: (work: Promise<unknown>) => {
        done = work;
      },
    });
    await done;
    return close;
  };
  return { self, listeners, click };
}

function page() {
  return { postMessage: vi.fn(), focus: vi.fn(async () => undefined) };
}

describe("the notification worker", () => {
  it("hands a click to every page, and brings the one used last to the front", async () => {
    const [last, earlier] = [page(), page()];
    const { click, self } = worker([last, earlier]);
    const close = await click({ click: "n1" });
    expect(close).toHaveBeenCalled();
    expect(self.clients.matchAll).toHaveBeenCalledWith({
      type: "window",
      includeUncontrolled: true,
    });
    for (const each of [last, earlier])
      expect(each.postMessage).toHaveBeenCalledWith({ type: NOTIFICATION_CLICK, click: "n1" });
    expect(last.focus).toHaveBeenCalled();
    expect(earlier.focus).not.toHaveBeenCalled();
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });

  it("opens the app when the page that showed it has gone", async () => {
    const { click, self } = worker([]);
    await click(null);
    expect(self.clients.openWindow).toHaveBeenCalledWith("https://chat.example/");
  });

  it("takes over from an older copy at once, and handles no fetches", () => {
    const { self, listeners } = worker([]);
    listeners.get("install")!({});
    expect(self.skipWaiting).toHaveBeenCalled();
    expect([...listeners.keys()].sort()).toEqual(["install", "notificationclick"]);
  });
});
