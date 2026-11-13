import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { PushSettings } from "../src/components/PushSettings.js";
import {
  keepPushCurrent,
  pushBlock,
  pushKeyBytes,
  type PushEnvironment,
} from "../src/lib/webPush.js";
import type { Platform } from "../src/platform.js";
import { render } from "./render.js";
import { accessibilityProblems } from "./accessibility.js";

/** "Notify me when OwnBase is closed" (G09): one browser, one account. */
const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};
const ACCOUNT = "http://127.0.0.1:9 U_SAM";
/** A made-up server key: 65 bytes, as a P-256 point is. */
const SERVER_KEY = Buffer.alloc(65, 7).toString("base64url");

const env = (over: Partial<PushEnvironment> = {}): PushEnvironment => ({
  isSecureContext: true,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150.0",
  maxTouchPoints: 0,
  standalone: false,
  hasPush: true,
  permission: "default",
  ...over,
});

describe("whether a browser can be pushed to", () => {
  it("says why not, in the order someone can do something about it", () => {
    expect(pushBlock(env())).toBeNull();
    expect(pushBlock(env({ isSecureContext: false }))).toBe("insecure");
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1";
    expect(pushBlock(env({ userAgent: iphone, hasPush: false }))).toBe("home-screen");
    expect(pushBlock(env({ userAgent: iphone, standalone: true }))).toBeNull();
    // iPadOS says it is a Mac, with a touch screen.
    const ipad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1";
    expect(pushBlock(env({ userAgent: ipad, maxTouchPoints: 5 }))).toBe("home-screen");
    expect(pushBlock(env({ userAgent: ipad }))).toBeNull();
    expect(pushBlock(env({ hasPush: false }))).toBe("unsupported");
    expect(pushBlock(env({ permission: "denied" }))).toBe("denied");
  });

  it("reads the server's key as the bytes the browser subscribes with", () => {
    expect([...pushKeyBytes(SERVER_KEY)]).toEqual([...Buffer.alloc(65, 7)]);
  });
});

/** A browser's push machinery, as far as the switch uses it. */
function fakeBrowser(permission: NotificationPermission = "default") {
  const subscription = {
    endpoint: "https://push.example.com/send/abc",
    options: { applicationServerKey: null as ArrayBuffer | null },
    toJSON: () => ({
      endpoint: "https://push.example.com/send/abc",
      keys: { p256dh: "p256dh-from-the-browser", auth: "auth-from-the-browser" },
    }),
    unsubscribe: vi.fn(async () => true),
  };
  let current: typeof subscription | null = null;
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async (options: { applicationServerKey: Uint8Array }) => {
      subscription.options.applicationServerKey = options.applicationServerKey
        .buffer as ArrayBuffer;
      current = subscription;
      return subscription;
    }),
  };
  const registration = { pushManager };
  const container = {
    register: vi.fn(async () => registration),
    ready: Promise.resolve(registration),
    getRegistration: vi.fn(async () => registration),
  };
  const notification = {
    permission,
    requestPermission: vi.fn(async () => {
      notification.permission = "granted";
      return "granted" as const;
    }),
  };
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", notification);
  Object.defineProperty(navigator, "serviceWorker", { value: container, configurable: true });
  return { subscription, pushManager, notification, forget: () => (current = null) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

function setUp(saved: Record<string, unknown> = {}) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: sam, users: { [sam.id]: sam }, status: "online" });
  const stored: Record<string, unknown> = { ...saved };
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T,>(key: string) => (stored[key] ?? null) as T | null,
      set: async (key: string, value: unknown) => {
        stored[key] = value;
      },
    },
    notify: () => {},
  };
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <PushSettings />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  return { client, platform, stored };
}

describe("the switch", () => {
  it("asks, subscribes and tells the server; then stops both", async () => {
    const browser = fakeBrowser();
    const { client, stored } = setUp();
    const pushKey = vi.spyOn(client.api, "pushKey").mockResolvedValue({ publicKey: SERVER_KEY });
    const add = vi.spyOn(client.api, "addPushSubscription").mockResolvedValue({ ok: true });
    const remove = vi.spyOn(client.api, "removePushSubscription").mockResolvedValue({ ok: true });
    const user = userEvent.setup();

    const toggle = screen.getByRole("switch", { name: "Notify me when OwnBase is closed" });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();
    expect(await accessibilityProblems(document.body)).toEqual([]);

    await user.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(browser.notification.requestPermission).toHaveBeenCalled();
    expect(pushKey).toHaveBeenCalled();
    expect(browser.pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: pushKeyBytes(SERVER_KEY),
    });
    // Until the choice of what notifications show is read, they show nothing.
    expect(add).toHaveBeenCalledWith({
      endpoint: "https://push.example.com/send/abc",
      keys: { p256dh: "p256dh-from-the-browser", auth: "auth-from-the-browser" },
      preview: expect.stringMatching(/^(full|none)$/),
    });
    expect(stored["push-accounts"]).toEqual({ [ACCOUNT]: "on" });

    await user.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(remove).toHaveBeenCalled();
    expect(browser.subscription.unsubscribe).toHaveBeenCalled();
    expect(stored["push-accounts"]).toEqual({ [ACCOUNT]: "off" });
  });

  it("stays off, and says what to do, when the browser refuses", async () => {
    fakeBrowser("denied");
    setUp();
    const toggle = screen.getByRole("switch", { name: "Notify me when OwnBase is closed" });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(screen.getByText(/blocks notifications from OwnBase/)).toBeVisible();
  });

  it("cannot be turned on over plain HTTP, and says why", async () => {
    fakeBrowser();
    vi.stubGlobal("isSecureContext", false);
    setUp();
    const toggle = screen.getByRole("switch", { name: "Notify me when OwnBase is closed" });
    await waitFor(() => expect(toggle).toBeDisabled());
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/only when OwnBase is opened over HTTPS/)).toBeVisible();
  });

  it("shows on only for the account that turned it on, in a browser still subscribed", async () => {
    const browser = fakeBrowser("granted");
    await browser.pushManager.subscribe({ applicationServerKey: pushKeyBytes(SERVER_KEY) });
    setUp({ "push-accounts": { [ACCOUNT]: "on" } });
    const toggle = screen.getByRole("switch", { name: "Notify me when OwnBase is closed" });
    await waitFor(() => expect(toggle).toBeChecked());
  });
});

describe("keeping the server's copy current", () => {
  it("sends the subscription again only for an account that turned it on", async () => {
    const browser = fakeBrowser("granted");
    await browser.pushManager.subscribe({ applicationServerKey: pushKeyBytes(SERVER_KEY) });
    const stored: Record<string, unknown> = {};
    const platform = {
      kind: "web",
      storage: {
        get: async (key: string) => stored[key] ?? null,
        set: async () => {},
      },
      notify: () => {},
    } as unknown as Platform;
    const send = vi.fn(async () => {});
    const granted = env({ permission: "granted" });

    await keepPushCurrent({ platform, account: ACCOUNT, preview: "sender", send, env: granted });
    expect(send).not.toHaveBeenCalled();

    stored["push-accounts"] = { [ACCOUNT]: "on", "http://127.0.0.1:9 U_OTHER": "off" };
    await keepPushCurrent({ platform, account: ACCOUNT, preview: "sender", send, env: granted });
    expect(send).toHaveBeenCalledWith({
      endpoint: "https://push.example.com/send/abc",
      keys: { p256dh: "p256dh-from-the-browser", auth: "auth-from-the-browser" },
      preview: "sender",
    });

    send.mockClear();
    await keepPushCurrent({
      platform,
      account: "http://127.0.0.1:9 U_OTHER",
      preview: "full",
      send,
      env: granted,
    });
    expect(send).not.toHaveBeenCalled();
  });
});
