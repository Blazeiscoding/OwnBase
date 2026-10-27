import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import { App } from "../src/App.js";
import type { HostingStatus, Platform, SavedServer } from "../src/platform.js";

const rocket: SavedServer = {
  url: "http://127.0.0.1:9",
  token: "test-token-not-a-credential",
  workspaceName: "Rocket Team",
  handle: "sam",
  lastUsedAt: 1,
};

/** A browser with one saved sign-in, and a way to hand the app links as they arrive. */
function appWithLinks(hosting?: {
  status: () => Promise<HostingStatus>;
  lastHosted: () => Promise<{ workspaceName: string; port: number } | null>;
}) {
  let deliver: (url: string) => void = () => {};
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T,>(key: string) => (key === "servers" ? [rocket] : null) as T | null,
      set: async () => {},
    },
    notify: () => {},
    deepLinks: {
      consumePending: async () => null,
      subscribe: (cb) => {
        deliver = cb;
        return () => {};
      },
    },
    ...(hosting
      ? {
          hosting: {
            ...hosting,
            start: async () => ({ running: false, phase: "stopped" as const }),
            stop: async () => {},
          },
        }
      : {}),
  };
  render(<App platform={platform} />);
  return {
    follow: (url: string) =>
      act(async () => {
        deliver(url);
      }),
  };
}

describe("following links from one workspace to another", () => {
  afterEach(() => vi.restoreAllMocks());

  it("leaves nothing of the open workspace connected behind the join screen, and can go back to it", async () => {
    // Workspace clients that never reach a server, and a record of which ones closed.
    const connect = vi.spyOn(WorkspaceClient.prototype, "connect").mockImplementation(() => {});
    const destroy = vi.spyOn(WorkspaceClient.prototype, "destroy");
    const { follow } = appWithLinks();
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    const opened = connect.mock.contexts[0];

    // An invite to a workspace this browser has never signed in to.
    await follow("ownbase://join?host=127.0.0.1:10&code=ABCD1234");
    await waitFor(() => expect(destroy.mock.contexts).toContain(opened));

    // A link back to a message in the first one opens that workspace again,
    // rather than taking it for the one still on screen. The previous
    // scheme still reads.
    await follow("ownbase://message?host=127.0.0.1:9&channel=C_DESIGN&id=M_PLAN");
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
  });
});

describe("reopening a workspace this computer hosted", () => {
  afterEach(() => vi.restoreAllMocks());

  it("parks on the join screen instead of reconnecting to a stopped workspace", async () => {
    const connect = vi.spyOn(WorkspaceClient.prototype, "connect").mockImplementation(() => {});
    appWithLinks({
      status: async () => ({ running: false, phase: "stopped" }),
      lastHosted: async () => ({ workspaceName: "Rocket Team", port: 9 }),
    });
    // The saved sign-in points at this computer's own stopped workspace, so
    // nothing connects: the join screen offers to host it again instead.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start hosting Rocket Team" })).toBeInTheDocument();
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("still reconnects when hosting runs, and reports a dropped public link", async () => {
    const connect = vi.spyOn(WorkspaceClient.prototype, "connect").mockImplementation(() => {});
    appWithLinks({
      status: async () => ({
        running: true,
        phase: "running",
        workspaceName: "Rocket Team",
        port: 9,
        warning: "The last-used hosting settings could not be saved.",
        openToAllError:
          "The public link stopped working (edge connection lost). Open to all again for a new link.",
      }),
      lastHosted: async () => ({ workspaceName: "Rocket Team", port: 9 }),
    });
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toHaveTextContent(/public link stopped working/);
    expect(screen.getByRole("alert")).not.toHaveTextContent(/settings could not be saved/);
    expect(screen.getByRole("button", { name: "Manage hosting" })).toBeVisible();
  });
});

describe("switching workspace from the sidebar", () => {
  afterEach(() => {
    // Unmount before the globals go: the setup file's cleanup runs after this
    // hook, and a screen still mounting would reach for matchMedia without them.
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens another saved workspace with its own sign-in, and closes the one it leaves", async () => {
    // jsdom has no media queries; the workspace screen asks whether the window is wide.
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const connect = vi.spyOn(WorkspaceClient.prototype, "connect").mockImplementation(() => {});
    const destroy = vi.spyOn(WorkspaceClient.prototype, "destroy");
    const design: SavedServer = {
      url: "http://127.0.0.1:10",
      token: "design-token-not-a-credential",
      workspaceName: "Design Guild",
      handle: "sam",
      lastUsedAt: 0,
    };
    const saved: SavedServer[][] = [];
    render(
      <App
        platform={{
          kind: "web",
          storage: {
            get: async <T,>(key: string) =>
              (key === "servers" ? [rocket, design] : null) as T | null,
            set: async (key: string, value: unknown) => {
              if (key === "servers") saved.push(value as SavedServer[]);
            },
          },
          notify: () => {},
        }}
      />,
    );
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    const first = connect.mock.contexts[0] as WorkspaceClient;
    expect(first.baseUrl).toBe(rocket.url);
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

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Rocket Team, workspace menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Design Guild · @sam" }));

    await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    const second = connect.mock.contexts[1] as WorkspaceClient;
    expect(second.baseUrl).toBe(design.url);
    // Its own saved sign-in, not the one it left.
    expect((second as unknown as { token: string }).token).toBe(design.token);
    expect(destroy.mock.contexts).toContain(first);
    // The workspace just opened is now the most recently used.
    await waitFor(() => expect(saved.at(-1)?.map((s) => s.url)).toEqual([design.url, rocket.url]));
  });
});
