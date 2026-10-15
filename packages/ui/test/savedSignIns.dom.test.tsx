import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import { App } from "../src/App.js";
import type { Platform, SavedServer } from "../src/platform.js";

/**
 * The saved sign-ins are one list on the device, and every window has its own
 * copy of it from when it opened. A window used to write its whole copy back,
 * so one left open brought back a sign-in another window had forgotten since,
 * or wiped one another window had added (Q05). Here "another window" changes
 * what is stored while this one is open, and this one then changes workspace.
 */
const signIn = (port: number, workspaceName: string): SavedServer => ({
  url: `http://127.0.0.1:${port}`,
  token: `${workspaceName.toLowerCase().replace(/\W+/g, "-")}-token-not-a-credential`,
  workspaceName,
  handle: "sam",
  lastUsedAt: 0,
});
const rocket = { ...signIn(9, "Rocket Team"), lastUsedAt: 1 };
const design = signIn(10, "Design Guild");
const third = signIn(11, "Third Place");
const fourth = signIn(12, "Fourth Wall");

afterEach(() => {
  // Unmount before the globals go: the setup file's cleanup runs after this
  // hook, and a screen still mounting would reach for matchMedia without them.
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** This window, opened on Rocket Team with what the device had saved then. */
async function openWindow(saved: SavedServer[]) {
  // jsdom has no media queries; the workspace screen asks whether the window is wide.
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const connect = vi.spyOn(WorkspaceClient.prototype, "connect").mockImplementation(() => {});
  const device = { servers: saved, unreadable: false, writes: 0 };
  const platform: Platform = {
    kind: "web",
    storage: {
      get: (async (key: string, options?: { strict?: boolean }) => {
        if (key !== "servers") return null;
        if (!device.unreadable) return device.servers;
        if (options?.strict) throw new Error("locked");
        return null;
      }) as Platform["storage"]["get"],
      set: async (key: string, value: unknown) => {
        if (key !== "servers") return;
        // A write still lands when reads are refused: that is how a list read
        // as empty would wipe the one that could not be read.
        device.servers = value as SavedServer[];
        device.writes += 1;
      },
    },
    notify: () => {},
  };
  render(<App platform={platform} />);
  await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
  const first = connect.mock.contexts[0] as WorkspaceClient;
  // The first client never connects, so the sidebar knows the workspace by
  // what the saved sign-in called it.
  act(() =>
    first.store.setState({
      status: "online",
      workspaceName: "Rocket Team",
      self: {
        id: "U_SAM",
        handle: "sam",
        displayName: "Sam Rivera",
        role: "member",
        statusText: "",
        statusEmoji: "",
        isBot: false,
        deactivated: false,
        dndUntil: null,
        createdAt: 0,
      },
    }),
  );
  // Opening it is itself saved: it becomes the one used most recently.
  await waitFor(() => expect(device.writes).toBe(1));
  const user = userEvent.setup();
  const switchTo = async (workspaceName: string) => {
    await user.click(await screen.findByRole("button", { name: "Rocket Team, workspace menu" }));
    await user.click(screen.getByRole("menuitem", { name: `${workspaceName} · @sam` }));
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
  };
  return { device, connect, user, switchTo };
}

const urls = (list: SavedServer[]) => list.map((server) => server.url);

describe("a window left open while the saved sign-ins change elsewhere", () => {
  it("does not bring back a sign-in another window has forgotten", async () => {
    const { device, switchTo } = await openWindow([rocket, design, third]);
    // Another window forgets Third Place.
    device.servers = device.servers.filter((server) => server.url !== third.url);

    await switchTo("Design Guild");

    await waitFor(() => expect(device.writes).toBe(2));
    expect(urls(device.servers)).toEqual([design.url, rocket.url]);
  });

  it("does not wipe a sign-in another window has added", async () => {
    const { device, switchTo } = await openWindow([rocket, design]);
    // Another window signs in to Fourth Wall.
    device.servers = [fourth, ...device.servers];

    await switchTo("Design Guild");

    await waitFor(() => expect(device.writes).toBe(2));
    expect(urls(device.servers)).toEqual([design.url, fourth.url, rocket.url]);
    expect(device.servers.find((server) => server.url === fourth.url)).toEqual(fourth);
  });

  it("does not save again a sign-in it opens after another window forgot it", async () => {
    const { device, connect, switchTo } = await openWindow([rocket, design]);
    // Another window forgets Design Guild, which this window still lists.
    device.servers = device.servers.filter((server) => server.url !== design.url);

    await switchTo("Design Guild");

    // It opens, with the sign-in this window still held, and that is all.
    const second = connect.mock.contexts[1] as WorkspaceClient;
    expect(second.baseUrl).toBe(design.url);
    await waitFor(() => expect(device.writes).toBe(2));
    expect(urls(device.servers)).toEqual([rocket.url]);
  });

  it("takes a sign-in made again elsewhere over the older one it held", async () => {
    const { device, switchTo } = await openWindow([rocket, design]);
    // Another window signed in to Design Guild again, and holds a newer token.
    const renewed = { ...design, token: "renewed-token-not-a-credential", lastUsedAt: 5 };
    device.servers = device.servers.map((server) => (server.url === design.url ? renewed : server));

    await switchTo("Design Guild");

    await waitFor(() => expect(device.writes).toBe(2));
    expect(device.servers.find((server) => server.url === design.url)).toEqual(renewed);
  });
});

describe("saved sign-ins that cannot be read", () => {
  it("are not written over, and a change waits for Retry", async () => {
    const { device, user, switchTo } = await openWindow([rocket, design]);
    const before = device.servers;
    device.unreadable = true;

    await switchTo("Design Guild");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save changes to sign-ins on this device.",
    );
    expect(device.servers).toBe(before);
    expect(device.writes).toBe(1);

    device.unreadable = false;
    await user.click(screen.getByRole("button", { name: "Retry saving" }));
    await waitFor(() => expect(urls(device.servers)).toEqual([design.url, rocket.url]));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
