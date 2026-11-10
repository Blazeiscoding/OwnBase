import { describe, expect, it, vi } from "vitest";
import { DesktopError } from "../src/shared/desktopError.js";
import {
  answering,
  appRecipients,
  fromTrustedWindow,
  REFUSED,
  rendererUrlTrust,
  settingKey,
  ticketDownloadUrl,
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

describe("an answered call", () => {
  it("runs for the app, gets the request's arguments and answers with what it resolved to", async () => {
    const handler = vi.fn(async (_event: IpcSender, url: unknown) => `saved ${String(url)}`);
    const answer = answering(() => mainWindow(), trusted, handler as never);
    await expect(answer(request(), "a")).resolves.toEqual({ ok: true, value: "saved a" });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("refuses anything else before its work starts, naming nothing", async () => {
    const handler = vi.fn();
    const answer = answering(() => mainWindow(), trusted, handler);
    for (const from of [request({ sender: 8 }), request({ url: "about:blank" })])
      await expect(answer(from, "servers")).resolves.toEqual({
        ok: false,
        error: { code: "refused", message: REFUSED },
      });
    expect(handler).not.toHaveBeenCalled();
    expect(REFUSED).not.toMatch(/servers|storage|hosting/);
  });

  it("asks for the main window on every request, so a new window is the one trusted", async () => {
    let current: TrustedWindow | null = null;
    const answer = answering(
      () => current,
      trusted,
      () => "ok" as never,
    );
    expect(await answer(request())).toMatchObject({ ok: false });
    current = mainWindow();
    expect(await answer(request())).toEqual({ ok: true, value: "ok" });
  });

  it("answers a failure with its code, never by rejecting", async () => {
    const coded = answering(
      () => mainWindow(),
      trusted,
      () => {
        throw new DesktopError("quitting", "OwnBase is shutting down.");
      },
    );
    await expect(coded(request())).resolves.toEqual({
      ok: false,
      error: { code: "quitting", message: "OwnBase is shutting down." },
    });
    const plain = answering(
      () => mainWindow(),
      trusted,
      async () => {
        throw new Error("The folder could not be opened.");
      },
    );
    await expect(plain(request())).resolves.toEqual({
      ok: false,
      error: { code: "failed", message: "The folder could not be opened." },
    });
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
 * Who hears what the main process pushes (F09): invite links, hosting. Only the app's own
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

  it("is nobody once the window has navigated away or closed", () => {
    expect(appRecipients(recipient("about:blank"), trusted)).toEqual([]);
    expect(appRecipients(recipient("https://example.com/"), trusted)).toEqual([]);
    expect(appRecipients(recipient(PAGE, { destroyed: true }), trusted)).toEqual([]);
    expect(appRecipients(null, trusted)).toEqual([]);
  });
});

describe("which addresses the window may have the app download", () => {
  const TICKET = "a".repeat(64);

  it("is a ticketed file or a workspace copy, also below a path prefix", () => {
    for (const url of [
      `https://chat.example.com/api/files/01JABCDEFGHJKMNPQRSTVWXYZ0?download=${TICKET}`,
      `http://192.168.1.4:4000/api/admin/copy/7f0c2a1e-58c9-4b5e-9d0e-2c4ab1f8e6d3?download=${TICKET}`,
      `https://example.com/team/api/admin/copy/7f0c2a1e?download=${TICKET}`,
    ])
      expect(ticketDownloadUrl(url)).toBe(url);
  });

  it("is refused for any other address, scheme, sign-in or query", () => {
    for (const url of [
      `https://example.com/api/me?download=${TICKET}`,
      `https://example.com/api/admin/copy?download=${TICKET}`,
      `https://example.com/api/files/01J/extra?download=${TICKET}`,
      `file:///api/files/01J?download=${TICKET}`,
      `https://user:pass@example.com/api/files/01J?download=${TICKET}`,
      "https://example.com/api/files/01J?download=short",
      `https://example.com/api/files/01J?download=${TICKET}&next=1`,
      "https://example.com/api/files/01J",
    ])
      expect(() => ticketDownloadUrl(url)).toThrow("Invalid download URL");
    expect(() => ticketDownloadUrl(42)).toThrow("Invalid download request");
  });
});
