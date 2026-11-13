import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  NOTIFICATION_CLICK,
  NOTIFICATION_WORKER,
  OPEN_LINK,
} from "../src/lib/workerNotifications.js";

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
  pages: Array<{
    postMessage: (message: unknown) => void;
    focus: () => Promise<unknown>;
    focused?: boolean;
  }>,
) {
  const listeners = new Map<string, (event: unknown) => void>();
  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    skipWaiting: vi.fn(),
    registration: { scope: "https://chat.example/", showNotification: vi.fn(async () => {}) },
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
  /** A push from the server carrying `data`; resolves when the worker is done. */
  const push = async (data: unknown) => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.get("push")!({
      data: data === undefined ? null : { json: () => data },
      waitUntil: (work: Promise<unknown>) => {
        done = work;
      },
    });
    await done;
  };
  return { self, listeners, click, push };
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
    expect([...listeners.keys()].sort()).toEqual(["install", "notificationclick", "push"]);
  });
});

describe("a push from the server", () => {
  const sent = {
    title: "Priya in #design",
    body: "The launch moves to Friday",
    tag: "c:C1",
    channelId: "C1",
    messageId: "M1",
  };

  it("is shown when no window of the app is in front", async () => {
    const behind = page();
    const { push, self } = worker([behind]);
    await push(sent);
    expect(self.registration.showNotification).toHaveBeenCalledWith("Priya in #design", {
      body: "The launch moves to Friday",
      tag: "c:C1",
      data: { link: "https://chat.example/#/c/C1/m/M1" },
    });
  });

  it("is left to the page when a window of the app is in front, which notified already", async () => {
    const { push, self } = worker([page(), { ...page(), focused: true }]);
    await push(sent);
    expect(self.registration.showNotification).not.toHaveBeenCalled();
  });

  it("opens only the app when what it names cannot be a conversation", async () => {
    const { push, self } = worker([]);
    await push({ ...sent, channelId: "../x", tag: 7 });
    expect(self.registration.showNotification).toHaveBeenCalledWith("Priya in #design", {
      body: "The launch moves to Friday",
      tag: undefined,
      data: { link: "https://chat.example/" },
    });
    await push(undefined);
    expect(self.registration.showNotification).toHaveBeenLastCalledWith("OwnBase", {
      body: "",
      tag: undefined,
      data: { link: "https://chat.example/" },
    });
  });

  it("opens the message when clicked: in a new window, or the page used last", async () => {
    const link = "https://chat.example/#/c/C1/m/M1";
    const none = worker([]);
    await none.click({ link });
    expect(none.self.clients.openWindow).toHaveBeenCalledWith(link);

    const [last, earlier] = [page(), page()];
    const open = worker([last, earlier]);
    await open.click({ link });
    expect(last.postMessage).toHaveBeenCalledWith({ type: OPEN_LINK, link });
    expect(last.focus).toHaveBeenCalled();
    expect(earlier.postMessage).not.toHaveBeenCalled();
    expect(open.self.clients.openWindow).not.toHaveBeenCalled();
  });
});
