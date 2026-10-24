import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  NOTIFICATION_PROMPT_SNOOZE_MS,
  NotificationBanner,
} from "../src/components/NotificationBanner.js";
import { webPlatform, type Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/** A browser Notification stand-in the tests can answer through. */
function installNotification(permission: NotificationPermission) {
  const created: Array<{
    title: string;
    body?: string;
    onclick: ((event: Event) => void) | null;
    close: () => void;
    closed: boolean;
  }> = [];
  const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  class FakeNotification {
    static permission: NotificationPermission = permission;
    static requestPermission = requestPermission;
    onclick: ((event: Event) => void) | null = null;
    closed = false;
    title: string;
    body?: string;
    constructor(title: string, options?: { body?: string }) {
      this.title = title;
      this.body = options?.body;
      created.push(this as unknown as (typeof created)[number]);
    }
    close() {
      this.closed = true;
    }
  }
  vi.stubGlobal("Notification", FakeNotification);
  return { created, requestPermission };
}

/** Settings kept in memory, as this device would keep them, counting reads. */
function deviceStorage() {
  const values = new Map<string, unknown>();
  const get = vi.fn(async (key: string) => values.get(key) ?? null);
  const storage: Platform["storage"] = {
    get: get as Platform["storage"]["get"],
    set: async (key, value) => {
      values.set(key, value);
    },
  };
  return { storage, values, get };
}

/** Renders the banner and waits until it has heard back from storage. */
async function banner(props: Parameters<typeof NotificationBanner>[0], reads: () => number) {
  const before = reads();
  const view = render(<NotificationBanner {...props} />);
  await waitFor(() => expect(reads()).toBe(before + 1));
  await act(async () => {});
  return view;
}

afterEach(() => vi.unstubAllGlobals());

describe("the notification banner", () => {
  it("offers to turn notifications on, and goes away once they are", async () => {
    const { requestPermission } = installNotification("default");
    const user = userEvent.setup();
    render(<NotificationBanner storage={deviceStorage().storage} />);
    const region = await screen.findByRole("region", { name: "Notifications" });
    expect(region).toHaveTextContent(/mentions while Tandem is in the background/);
    expect(await accessibilityProblems(region)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Turn on" }));
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: "Notifications" })).not.toBeInTheDocument();
  });

  it("stays away on this device for two weeks after Not now", async () => {
    const { requestPermission } = installNotification("default");
    const user = userEvent.setup();
    const { storage, values, get } = deviceStorage();
    const reads = () => get.mock.calls.length;
    let clock = 1_000_000;
    const now = () => clock;

    const first = await banner({ storage, now }, reads);
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("region", { name: "Notifications" })).not.toBeInTheDocument();
    expect(values.get("notificationPromptSnoozedAt")).toBe(1_000_000);
    expect(requestPermission).not.toHaveBeenCalled();
    first.unmount();

    // A reload the next day asks nothing,
    clock += 24 * 60 * 60 * 1000;
    const second = await banner({ storage, now }, reads);
    expect(screen.queryByRole("region", { name: "Notifications" })).not.toBeInTheDocument();
    second.unmount();

    // and once the two weeks are up, it offers again.
    clock = 1_000_000 + NOTIFICATION_PROMPT_SNOOZE_MS;
    await banner({ storage, now }, reads);
    expect(screen.getByRole("region", { name: "Notifications" })).toBeVisible();
  });

  it("shows nothing until this device has said whether it was put off", async () => {
    installNotification("default");
    const storage: Platform["storage"] = {
      get: () => new Promise(() => {}),
      set: async () => {},
    };
    render(<NotificationBanner storage={storage} />);
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Notifications" })).not.toBeInTheDocument();
  });

  it("still goes away when this device cannot remember the choice", async () => {
    installNotification("default");
    const user = userEvent.setup();
    const storage: Platform["storage"] = {
      get: async () => {
        throw new Error("settings locked");
      },
      set: async () => {
        throw new Error("settings locked");
      },
    };
    render(<NotificationBanner storage={storage} />);
    await user.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("region", { name: "Notifications" })).not.toBeInTheDocument();
  });

  it("stays out of the way when there is nothing to ask", async () => {
    const { storage } = deviceStorage();
    for (const permission of ["granted", "denied"] as const) {
      installNotification(permission);
      const { unmount } = render(<NotificationBanner storage={storage} />);
      await act(async () => {});
      expect(screen.queryByRole("region", { name: "Notifications" })).not.toBeInTheDocument();
      unmount();
    }
    vi.stubGlobal("Notification", undefined);
    render(<NotificationBanner storage={storage} />);
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Notifications" })).not.toBeInTheDocument();
  });
});

describe("a notification", () => {
  it("opens its message when clicked, and asks nothing when permission is missing", async () => {
    const { created } = installNotification("granted");
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    try {
      const opened: string[] = [];
      webPlatform().notify("Sam in #design", "ping", () => opened.push("message"));
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ title: "Sam in #design", body: "ping" });

      created[0]!.onclick?.(new Event("click"));
      expect(opened).toEqual(["message"]);
      expect(focus).toHaveBeenCalled();
      expect(created[0]!.closed).toBe(true);
    } finally {
      focus.mockRestore();
    }
  });

  it("shows nothing at all when permission was never granted", () => {
    const { created } = installNotification("default");
    webPlatform().notify("Sam in #design", "ping", () => {});
    expect(created).toHaveLength(0);
  });

  it("is shown by the service worker where a page may not make one (Android's Chrome)", async () => {
    installPageRefusingNotifications();
    const worker = installServiceWorker();
    const opened: string[] = [];
    const platform = webPlatform();
    platform.notify("Sam in #design", "ping", () => opened.push("ping"), { tag: "account m1" });
    platform.notify("Sam in #design", "pong", () => opened.push("pong"));
    await vi.waitFor(() => expect(worker.shown).toHaveLength(2));
    expect(worker.register.mock.calls).toEqual([["/notification-worker.js"]]);
    expect(worker.shown[0]).toMatchObject({
      title: "Sam in #design",
      options: { body: "ping", tag: "account m1" },
    });

    // The worker hands a click back naming the notification, which opens its message.
    worker.relayClick(worker.shown[1]!.options.data.click);
    expect(opened).toEqual(["pong"]);
    // One another page showed is not this page's to open.
    worker.relayClick("another page's");
    expect(opened).toEqual(["pong"]);
  });

  it("fails quietly where a page may not make one and there is no service worker", () => {
    installPageRefusingNotifications();
    expect(() => webPlatform().notify("Sam in #design", "ping", () => {})).not.toThrow();
  });
});

/** Android's Chrome: permission granted, but a page's `new Notification` throws. */
function installPageRefusingNotifications() {
  vi.stubGlobal(
    "Notification",
    class {
      static permission: NotificationPermission = "granted";
      constructor() {
        throw new TypeError(
          "Failed to construct 'Notification': Illegal constructor. Use ServiceWorkerRegistration.showNotification() instead.",
        );
      }
    },
  );
}

/** A service worker container that records what it is asked to show. */
function installServiceWorker() {
  const shown: Array<{
    title: string;
    options: NotificationOptions & { data: { click: string } };
  }> = [];
  const registration = {
    showNotification: async (title: string, options: (typeof shown)[number]["options"]) => {
      shown.push({ title, options });
    },
  };
  const container = new EventTarget();
  const register = vi.fn(async (_url: string) => registration);
  Object.assign(container, { register, ready: Promise.resolve(registration) });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
  onTestFinished(() => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  });
  const relayClick = (click: string) =>
    container.dispatchEvent(
      new MessageEvent("message", { data: { type: "tandem:notification-click", click } }),
    );
  return { shown, register, relayClick };
}
