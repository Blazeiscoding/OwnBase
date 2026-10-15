import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Channel, User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { HuddleButton } from "../src/components/HuddleBar.js";
import { WorkspaceScreen } from "../src/screens/WorkspaceScreen.js";
import { useCallPreferences } from "../src/lib/callPreferences.js";
import { writeRoute } from "../src/lib/route.js";
import type { Platform } from "../src/platform.js";
import { noiseFilter } from "../src/lib/noiseFilter.js";

const owner: User = {
  id: "U_OWNER",
  handle: "owner",
  displayName: "Owner",
  role: "owner",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};
const general: Channel = {
  id: "C_GENERAL",
  type: "public",
  name: "general",
  topic: "",
  description: "",
  creatorId: owner.id,
  archived: false,
  createdAt: 0,
};
const clients: WorkspaceClient[] = [];
afterEach(() => {
  // Unmount before the globals go: the setup file's cleanup runs after this
  // hook, and a screen still mounting would reach for matchMedia without them.
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function setup(read: () => Promise<unknown>) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "synthetic-test-token");
  clients.push(client);
  client.store.setState({
    self: owner,
    users: { [owner.id]: owner },
    workspaceId: "W_CALLS",
    channels: { [general.id]: general },
    memberships: { [general.id]: 0 },
    status: "online",
  });
  // This fixture tests call admission in #general, independently of async
  // last-conversation restoration. Start with that conversation selected.
  writeRoute(client.baseUrl, { channelId: general.id, threadRootId: null }, "replace");
  const get = vi.fn(
    async <T,>(key: string) => (key === "call-preferences" ? await read() : null) as T | null,
  );
  const platform: Platform = {
    kind: "web",
    storage: { get: get as Platform["storage"]["get"], set: async () => {} },
    notify: () => {},
  };
  const join = vi.spyOn(client, "joinHuddle").mockResolvedValue();
  const wrap = (component: React.ReactNode) => (
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>{component}</ClientContext.Provider>
    </PlatformContext.Provider>
  );
  return { client, platform, get, join, wrap };
}

describe("preference-aware huddle admission (N04)", () => {
  it("waits for a held valid microphone-off choice before the header joins", async () => {
    const saved = deferred<unknown>();
    const { join, get, wrap } = setup(() => saved.promise);
    render(wrap(<HuddleButton channelId={general.id} />));
    await userEvent.setup().click(screen.getByRole("button", { name: "Start a huddle" }));
    expect(join).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Start a huddle" })).toBeDisabled();
    await act(async () => saved.resolve({ joinMuted: true }));
    await waitFor(() =>
      expect(join).toHaveBeenCalledWith(general.id, { muted: true, noiseFilter }),
    );
    expect(get).toHaveBeenCalledWith("call-preferences", { strict: true });
  });

  it("uses the same initialized preference for Getting started", async () => {
    window.history.replaceState(null, "", "/");
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: !query.includes("max-width"),
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const saved = deferred<unknown>();
    const { client, platform, join, wrap } = setup(() => saved.promise);
    vi.spyOn(client, "loadTimeline").mockResolvedValue();
    vi.spyOn(client, "loadCommands").mockResolvedValue();
    render(
      wrap(
        <WorkspaceScreen
          client={client}
          platform={platform}
          onLeaveWorkspace={() => {}}
          onSignedOut={() => {}}
        />,
      ),
    );
    await userEvent
      .setup()
      .click(
        await screen.findByRole(
          "button",
          { name: "Start: Try a huddle in #general" },
          { timeout: 3_000 },
        ),
      );
    expect(join).not.toHaveBeenCalled();
    await act(async () => saved.resolve({ joinMuted: true }));
    await waitFor(() =>
      expect(join).toHaveBeenCalledWith(general.id, { muted: true, noiseFilter }),
    );
  });

  it("does not start a call when the workspace closes while preferences are pending", async () => {
    const saved = deferred<unknown>();
    const { client, join, wrap } = setup(() => saved.promise);
    const mounted = render(wrap(<HuddleButton channelId={general.id} />));
    await userEvent.setup().click(screen.getByRole("button", { name: "Start a huddle" }));
    mounted.unmount();
    client.destroy();
    await act(async () => saved.resolve({ joinMuted: true }));
    expect(join).not.toHaveBeenCalled();
  });

  it("cancels a pending header join when its channel changes", async () => {
    const saved = deferred<unknown>();
    const { join, wrap } = setup(() => saved.promise);
    const mounted = render(wrap(<HuddleButton channelId={general.id} />));
    await userEvent.setup().click(screen.getByRole("button", { name: "Start a huddle" }));
    mounted.rerender(wrap(<HuddleButton channelId="C_DIFFERENT" />));
    await act(async () => saved.resolve({ joinMuted: true }));
    expect(join).not.toHaveBeenCalled();
  });

  it("cancels a pending header join when the active workspace client changes", async () => {
    const saved = deferred<unknown>();
    const { join, platform, wrap } = setup(() => saved.promise);
    const replacement = setup(async () => ({ joinMuted: false }));
    const mounted = render(wrap(<HuddleButton channelId={general.id} />));
    await userEvent.setup().click(screen.getByRole("button", { name: "Start a huddle" }));
    mounted.rerender(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={replacement.client}>
          <HuddleButton channelId={general.id} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    await act(async () => saved.resolve({ joinMuted: true }));
    expect(join).not.toHaveBeenCalled();
    expect(replacement.join).not.toHaveBeenCalled();
  });

  it("cancels the Getting started join when navigation selects another channel", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: !query.includes("max-width"),
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const saved = deferred<unknown>();
    const { client, platform, join, wrap } = setup(() => saved.promise);
    client.store.setState({
      channels: { [general.id]: general, C_DESIGN: { ...general, id: "C_DESIGN", name: "design" } },
      memberships: { [general.id]: 0, C_DESIGN: 0 },
    });
    vi.spyOn(client, "loadTimeline").mockResolvedValue();
    vi.spyOn(client, "loadCommands").mockResolvedValue();
    render(
      wrap(
        <WorkspaceScreen
          client={client}
          platform={platform}
          onLeaveWorkspace={() => {}}
          onSignedOut={() => {}}
        />,
      ),
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole(
        "button",
        { name: "Start: Try a huddle in #general" },
        { timeout: 3_000 },
      ),
    );
    await user.click(screen.getByRole("button", { name: "# design" }));
    await act(async () => saved.resolve({ joinMuted: true }));
    expect(join).not.toHaveBeenCalled();
  });

  it("cancels the Getting started join when the active workspace changes", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: !query.includes("max-width"),
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const saved = deferred<unknown>();
    const { client, platform, join, wrap } = setup(() => saved.promise);
    const replacement = setup(async () => ({ joinMuted: false }));
    for (const candidate of [client, replacement.client]) {
      vi.spyOn(candidate, "loadTimeline").mockResolvedValue();
      vi.spyOn(candidate, "loadCommands").mockResolvedValue();
    }
    const mounted = render(
      wrap(
        <WorkspaceScreen
          client={client}
          platform={platform}
          onLeaveWorkspace={() => {}}
          onSignedOut={() => {}}
        />,
      ),
    );
    await userEvent
      .setup()
      .click(
        await screen.findByRole(
          "button",
          { name: "Start: Try a huddle in #general" },
          { timeout: 3_000 },
        ),
      );
    mounted.rerender(
      wrap(
        <WorkspaceScreen
          client={replacement.client}
          platform={platform}
          onLeaveWorkspace={() => {}}
          onSignedOut={() => {}}
        />,
      ),
    );
    await act(async () => saved.resolve({ joinMuted: true }));
    expect(join).not.toHaveBeenCalled();
    expect(replacement.join).not.toHaveBeenCalled();
  });

  it.each(["damaged", [], {}, { joinMuted: "yes" }])(
    "keeps the microphone off for unreadable preference %j",
    async (saved) => {
      const { join, wrap } = setup(async () => saved);
      render(wrap(<HuddleButton channelId={general.id} />));
      await userEvent.setup().click(screen.getByRole("button", { name: "Start a huddle" }));
      await waitFor(() =>
        expect(join).toHaveBeenCalledWith(general.id, { muted: true, noiseFilter }),
      );
    },
  );

  it("keeps a failed read restrictive and supports loading the saved choice again", async () => {
    let fail = true;
    let current!: ReturnType<typeof useCallPreferences>;
    function Reader() {
      current = useCallPreferences();
      return <p role="status">{current.error ?? (current.loaded ? "Loaded" : "Loading")}</p>;
    }
    const { client, join, wrap } = setup(async () => {
      if (fail) throw new Error("Storage unavailable");
      return { joinMuted: false };
    });
    render(
      wrap(
        <>
          <Reader />
          <HuddleButton channelId={general.id} />
        </>,
      ),
    );
    expect(
      await screen.findByText(
        "Could not load your preference. Huddles start with the microphone off.",
      ),
    ).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "Start a huddle" }));
    expect(join).toHaveBeenLastCalledWith(general.id, { muted: true, noiseFilter });
    fail = false;
    await act(async () => current.retryLoad());
    expect(screen.getByText("Loaded")).toBeVisible();
    await act(async () => current.joinHuddle(client, general.id));
    expect(join).toHaveBeenLastCalledWith(general.id, { muted: false, noiseFilter });
  });

  it.each(["older-first", "newer-first"])(
    "uses the latest retry and initialization when reads finish %s",
    async (order) => {
      const older = deferred<unknown>();
      const newer = deferred<unknown>();
      const read = vi
        .fn()
        .mockResolvedValueOnce({ joinMuted: false })
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(newer.promise);
      const { client, join, wrap } = setup(read);
      let current!: ReturnType<typeof useCallPreferences>;
      function Reader() {
        current = useCallPreferences();
        return null;
      }
      render(wrap(<Reader />));
      await waitFor(() => expect(current.loaded).toBe(true));
      act(() => {
        void current.retryLoad();
      });
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      const joining = current.joinHuddle(client, general.id);
      act(() => {
        void current.retryLoad();
      });
      await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
      if (order === "older-first") {
        await act(async () => older.resolve({ joinMuted: false }));
        expect(join).not.toHaveBeenCalled();
        expect(current.loaded).toBe(false);
        await act(async () => newer.resolve({ joinMuted: true }));
      } else {
        await act(async () => newer.resolve({ joinMuted: true }));
        await waitFor(() =>
          expect(join).toHaveBeenCalledWith(general.id, { muted: true, noiseFilter }),
        );
        await act(async () => older.resolve({ joinMuted: false }));
      }
      await act(async () => joining);
      expect(current.joinMuted).toBe(true);
      expect(join).toHaveBeenCalledWith(general.id, { muted: true, noiseFilter });
    },
  );

  it("keeps an explicit saved choice when an older retry read finishes later", async () => {
    const stale = deferred<unknown>();
    const read = vi
      .fn()
      .mockResolvedValueOnce({ joinMuted: true })
      .mockReturnValueOnce(stale.promise);
    const { client, platform, join, wrap } = setup(read);
    let current!: ReturnType<typeof useCallPreferences>;
    function Reader() {
      current = useCallPreferences();
      return null;
    }
    render(wrap(<Reader />));
    await waitFor(() => expect(current.loaded).toBe(true));
    act(() => {
      void current.retryLoad();
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    const joining = current.joinHuddle(client, general.id);
    const set = vi.spyOn(platform.storage, "set");
    await act(async () => current.setJoinMuted(false));
    expect(set).toHaveBeenCalledWith("call-preferences", { joinMuted: false });
    await waitFor(() =>
      expect(join).toHaveBeenCalledWith(general.id, { muted: false, noiseFilter }),
    );
    await act(async () => stale.resolve({ joinMuted: true }));
    expect(current.joinMuted).toBe(false);
    await act(async () => joining);
    expect(join).toHaveBeenCalledWith(general.id, { muted: false, noiseFilter });
  });
});
