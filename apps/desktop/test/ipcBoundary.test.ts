import { describe, expect, it, vi } from "vitest";
import {
  appRecipients,
  fromTrustedWindow,
  guarded,
  REFUSED,
  rendererUrlTrust,
  settingKey,
  type IpcSender,
  type TrustedWindow,
} from "../src/main/ipcBoundary.js";

/**
 * Who may ask the main process for work (REV-14): the app's own window, its
 * top frame, showing the app's page. Another window loading the same
 * preload, or a frame inside the page, is refused before any work starts.
 */
const PAGE = "file:///opt/OwnBase/resources/app.asar/out/renderer/index.html";
const trusted = rendererUrlTrust(PAGE);

function mainWindow(overrides: { destroyed?: boolean; contentsDestroyed?: boolean } = {}) {
  return {
    isDestroyed: () => overrides.destroyed === true,
    webContents: {
      id: 7,
      isDestroyed: () => overrides.contentsDestroyed === true,
      mainFrame: { processId: 3, routingId: 1 },
    },
  } satisfies TrustedWindow;
}

function request(
  overrides: Partial<NonNullable<IpcSender["senderFrame"]>> & { sender?: number } = {},
) {
  const { sender = 7, ...frame } = overrides;
  return {
    sender: { id: sender },
    senderFrame: { url: `${PAGE}#/w/1/c/2`, processId: 3, routingId: 1, parent: null, ...frame },
  } satisfies IpcSender;
}

describe("the app's own page", () => {
  it("is the page the window loaded, whatever its hash or query", () => {
    expect(trusted(PAGE)).toBe(true);
    expect(trusted(`${PAGE}#/w/1/c/2`)).toBe(true);
    expect(trusted(`${PAGE}?debug=1`)).toBe(true);
  });

  it("is not a blank page, another file, another origin or nonsense", () => {
    expect(trusted("about:blank")).toBe(false);
    expect(trusted("file:///opt/OwnBase/resources/app.asar/out/renderer/other.html")).toBe(false);
    expect(trusted("https://example.com/out/renderer/index.html")).toBe(false);
    expect(trusted("not a url")).toBe(false);
  });

  it("is the dev server's page in development", () => {
    const dev = rendererUrlTrust("http://localhost:5173/");
    expect(dev("http://localhost:5173/#/w/1")).toBe(true);
    expect(dev("http://localhost:5174/")).toBe(false);
    expect(dev("http://localhost:5173/elsewhere")).toBe(false);
  });
});

describe("a request to the main process", () => {
  it("is answered from the main window's top frame showing the app", () => {
    expect(fromTrustedWindow(request(), mainWindow(), trusted)).toBe(true);
  });

  it("is refused from another window, even one with the same preload", () => {
    expect(fromTrustedWindow(request({ sender: 8 }), mainWindow(), trusted)).toBe(false);
  });

  it("is refused from a frame inside the page", () => {
    const child = request({ parent: { url: PAGE }, routingId: 2 });
    expect(fromTrustedWindow(child, mainWindow(), trusted)).toBe(false);
    // Even one claiming the top frame's routing: a parent is a parent.
    expect(fromTrustedWindow(request({ parent: {} }), mainWindow(), trusted)).toBe(false);
  });

  it("is refused from a frame that is not the window's current top frame", () => {
    expect(fromTrustedWindow(request({ processId: 4 }), mainWindow(), trusted)).toBe(false);
    expect(fromTrustedWindow(request({ routingId: 9 }), mainWindow(), trusted)).toBe(false);
  });

  it("is refused once the frame has gone", () => {
    const gone = { sender: { id: 7 }, senderFrame: null };
    expect(fromTrustedWindow(gone, mainWindow(), trusted)).toBe(false);
  });

  it("is refused when the main window shows anything but the app", () => {
    expect(fromTrustedWindow(request({ url: "about:blank" }), mainWindow(), trusted)).toBe(false);
    expect(fromTrustedWindow(request({ url: "https://example.com/" }), mainWindow(), trusted)).toBe(
      false,
    );
  });

  it("is refused with no main window, or one closing", () => {
    expect(fromTrustedWindow(request(), null, trusted)).toBe(false);
    expect(fromTrustedWindow(request(), mainWindow({ destroyed: true }), trusted)).toBe(false);
    expect(fromTrustedWindow(request(), mainWindow({ contentsDestroyed: true }), trusted)).toBe(
      false,
    );
  });
});

describe("a guarded handler", () => {
  it("runs for the app and gets the request's arguments", async () => {
    const handler = vi.fn(
      async (_event: IpcSender, key: string, value: number) => `${key}=${value}`,
    );
    const guardedHandler = guarded(() => mainWindow(), trusted, handler);
    await expect(guardedHandler(request(), "theme", 2)).resolves.toBe("theme=2");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("refuses anything else before its work starts, naming nothing", () => {
    const handler = vi.fn();
    const guardedHandler = guarded(() => mainWindow(), trusted, handler);
    expect(() => guardedHandler(request({ sender: 8 }), "servers")).toThrow(REFUSED);
    expect(() => guardedHandler(request({ url: "about:blank" }), "servers")).toThrow(REFUSED);
    expect(handler).not.toHaveBeenCalled();
    expect(REFUSED).not.toMatch(/servers|storage|hosting/);
  });

  it("asks for the main window on every request, so a new window is the one trusted", () => {
    let current: TrustedWindow | null = null;
    const handler = vi.fn(() => "ok");
    const guardedHandler = guarded(() => current, trusted, handler);
    expect(() => guardedHandler(request())).toThrow(REFUSED);
    current = mainWindow();
    expect(guardedHandler(request())).toBe("ok");
  });
});

describe("a settings key", () => {
  it("is any reasonable name, including a workspace address", () => {
    expect(settingKey("servers")).toBe("servers");
    expect(settingKey("outbox:http://[fe80::1]:8686/")).toBe("outbox:http://[fe80::1]:8686/");
    expect(settingKey("x".repeat(1024))).toHaveLength(1024);
  });

  it("is refused when not a string, empty, too long or holding control characters", () => {
    for (const key of [
      undefined,
      null,
      1,
      {},
      ["servers"],
      "",
      "x".repeat(1025),
      "a\nb",
      "a\u0000b",
    ])
      expect(() => settingKey(key)).toThrow("Not a settings key.");
  });
});

/**
 * Who hears what the main process pushes (F09): drafts and unsent messages
 * merged from another window, invite links, hosting. Only the app's own
 * window, live and showing the app's page; a foreign window loading the
 * same preload hears nothing, nor does the app's window once it has
 * navigated away.
 */
describe("who hears what the main process pushes", () => {
  function recipient(url: string, overrides: { destroyed?: boolean; id?: number } = {}) {
    return {
      isDestroyed: () => overrides.destroyed === true,
      webContents: { id: overrides.id ?? 7, isDestroyed: () => false, getURL: () => url },
    };
  }

  it("is the app's window showing the app's page", () => {
    const win = recipient(`${PAGE}#/w/1/c/2`);
    expect(appRecipients(win, trusted)).toEqual([win]);
  });

  it("is nobody once the window has navigated away, closed, or is the one that changed it", () => {
    expect(appRecipients(recipient("about:blank"), trusted)).toEqual([]);
    expect(appRecipients(recipient("https://example.com/"), trusted)).toEqual([]);
    expect(appRecipients(recipient(PAGE, { destroyed: true }), trusted)).toEqual([]);
    expect(appRecipients(recipient(PAGE), trusted, 7)).toEqual([]);
    expect(appRecipients(null, trusted)).toEqual([]);
  });
});
