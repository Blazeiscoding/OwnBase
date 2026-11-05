import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { GETTING_STARTED_COPY_KEY, GettingStarted } from "../src/components/GettingStarted.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

const person = (id: string, role: User["role"] = "member"): User => ({
  id,
  handle: id.toLowerCase(),
  displayName: id,
  role,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});
const room = (id: string, name: string): Channel => ({
  id,
  type: "public",
  name,
  topic: "",
  description: "",
  creatorId: "U_OWNER",
  archived: false,
  createdAt: 0,
});

const realNotification = globalThis.Notification;
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(GETTING_STARTED_COPY_KEY);
  if (realNotification) globalThis.Notification = realNotification;
  else delete (globalThis as { Notification?: unknown }).Notification;
});

const SLOT = "local:v1:W_ROCKET:U_OWNER:getting-started";

function checklist(
  options: {
    role?: User["role"];
    saved?: unknown;
    /** A store that has not answered yet, as on a slow start. */
    unread?: boolean;
    kind?: Platform["kind"];
    /** What the workspace is called; named by its owner unless said. */
    workspaceName?: string;
  } = {},
) {
  globalThis.Notification = { permission: "default" } as unknown as typeof Notification;
  const values = new Map<string, unknown>(options.saved ? [[SLOT, options.saved]] : []);
  const platform: Platform = {
    kind: options.kind ?? "web",
    storage: {
      get: <T,>(name: string) =>
        options.unread
          ? new Promise<T | null>(() => {})
          : Promise.resolve((values.get(name) ?? null) as T | null),
      set: async (name: string, value: unknown) => void values.set(name, value),
    },
    notify: () => {},
  };
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  const owner = person("U_OWNER", options.role ?? "owner");
  client.store.setState({
    self: owner,
    workspaceId: "W_ROCKET",
    workspaceName: options.workspaceName ?? "Rocket Team",
    users: { U_OWNER: owner },
    channels: { C_GENERAL: room("C_GENERAL", "general") },
    status: "online",
  });
  const calls: string[] = [];
  const utils = render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <GettingStarted
          onNewChannel={() => calls.push("new channel")}
          onInvite={() => calls.push("invite")}
          onNotifications={() => calls.push("notifications")}
          onNameWorkspace={() => calls.push("name")}
          activeChannelName="#general"
          onTryHuddle={() => calls.push("huddle")}
        />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  return { client, values, calls, ...utils, user: userEvent.setup() };
}

const section = () => screen.findByRole("region", { name: "Getting started" });
const stepNames = (list: HTMLElement) =>
  within(list)
    .getAllByRole("listitem")
    .map((item) => item.textContent);
const allSteps = (card: HTMLElement) =>
  within(card).getByRole("button", { name: "Show all steps" });

describe("getting started, for whoever set the workspace up", () => {
  it("shows the next step, and every step one press away, each with a way to do it", async () => {
    const { calls, values, user } = checklist();
    const card = await section();
    expect(card).toHaveTextContent("4 of 4 left");
    // Folded, it is short: the next step alone, so the channels below stay in sight.
    expect(stepNames(card)).toEqual(["Create a channel"]);
    expect(allSteps(card)).toHaveAttribute("aria-expanded", "false");
    expect(await accessibilityProblems(card)).toEqual([]);

    await user.click(allSteps(card));
    expect(allSteps(card)).toHaveAttribute("aria-expanded", "true");
    // The list it opens is the one it names.
    expect(allSteps(card)).toHaveAttribute("aria-controls", within(card).getByRole("list").id);
    // Each step is one row, named for what pressing it does.
    expect(stepNames(card)).toEqual([
      "Create a channel",
      "Invite someone",
      "Turn on notifications",
      "Try a huddle in #general",
    ]);
    for (const name of [
      "New channel: Create a channel",
      "Invite: Invite someone",
      "Settings: Turn on notifications",
      "Start: Try a huddle in #general",
    ])
      await user.click(within(card).getByRole("button", { name }));
    expect(calls).toEqual(["new channel", "invite", "notifications", "huddle"]);
    expect(await accessibilityProblems(card)).toEqual([]);
    await waitFor(() => expect(values.get(SLOT)).toEqual({ expanded: true }));

    await user.click(allSteps(card));
    expect(stepNames(card)).toEqual(["Create a channel"]);
    await waitFor(() => expect(values.get(SLOT)).toEqual({ expanded: false }));
  });

  it("does the next step from its row, and folds and opens from the keyboard", async () => {
    const { calls, user } = checklist();
    const card = await section();
    await user.click(within(card).getByRole("button", { name: "New channel: Create a channel" }));
    expect(calls).toEqual(["new channel"]);

    allSteps(card).focus();
    await user.keyboard("{Enter}");
    expect(stepNames(card)).toHaveLength(4);
    await user.keyboard(" ");
    expect(stepNames(card)).toEqual(["Create a channel"]);
  });

  it("keeps every step listed once opened", async () => {
    checklist({ saved: { expanded: true } });
    const card = await section();
    expect(allSteps(card)).toHaveAttribute("aria-expanded", "true");
    expect(stepNames(card)).toHaveLength(4);
  });

  it("asks first for a name while the workspace has the one it started with", async () => {
    const { client, calls, user } = checklist({ workspaceName: "My Workspace" });
    const card = await section();
    expect(card).toHaveTextContent("5 of 5 left");
    expect(stepNames(card)).toEqual(["Name your workspace"]);
    await user.click(within(card).getByRole("button", { name: "Name it: Name your workspace" }));
    expect(calls).toEqual(["name"]);
    // Once named, the step has gone rather than sit there ticked.
    act(() => client.store.setState({ workspaceName: "Rocket Team" }));
    expect(card).toHaveTextContent("4 of 4 left");
    expect(stepNames(card)).toEqual(["Create a channel"]);
  });

  it("is not shown to anyone else", async () => {
    const { container } = checklist({ role: "member" });
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it("ticks steps off from what has happened, remembers a huddle, and goes when all are done", async () => {
    const { client, values, container, user } = checklist();
    const card = await section();
    act(() =>
      client.store.setState((s) => ({
        channels: { ...s.channels, C_DESIGN: room("C_DESIGN", "design") },
        users: { ...s.users, U_PRIYA: person("U_PRIYA") },
      })),
    );
    expect(card).toHaveTextContent("2 of 4 left");
    // The next step moves on to the first one still to do.
    expect(stepNames(card)).toEqual(["Turn on notifications"]);
    await user.click(allSteps(card));
    expect(within(card).getByText("Create a channel")).toHaveTextContent("Create a channel, done");
    expect(within(card).queryByRole("button", { name: /Create a channel/ })).toBeNull();

    act(() =>
      client.store.setState({
        huddle: {
          channelId: "C_GENERAL",
          micMuted: false,
          cameraOn: false,
          sharingScreen: false,
          localCameraStream: null,
          localScreenStream: null,
          speaking: false,
          micLost: false,
          peers: [],
        },
      }),
    );
    await waitFor(() => expect(values.get(SLOT)).toEqual({ expanded: true, huddleTried: true }));
    // Leaving the huddle does not take the tick back.
    act(() => client.store.setState({ huddle: null }));
    expect(card).toHaveTextContent("1 of 4 left");

    globalThis.Notification = { permission: "granted" } as unknown as typeof Notification;
    act(() => window.dispatchEvent(new Event("focus")));
    expect(container).toBeEmptyDOMElement();
  });

  it("counts notifications as on in the desktop app, which shows its own", async () => {
    checklist({ kind: "desktop" });
    const card = await section();
    expect(card).toHaveTextContent("3 of 4 left");
    expect(stepNames(card)).toEqual(["Create a channel"]);
  });

  it("stays hidden once put away", async () => {
    const { values, user, unmount } = checklist();
    await user.click(within(await section()).getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("region", { name: "Getting started" })).toBeNull();
    await waitFor(() => expect(values.get(SLOT)).toEqual({ dismissed: true }));
    unmount();
    const again = checklist({ saved: { dismissed: true } });
    await act(async () => {});
    expect(again.container).toBeEmptyDOMElement();
  });

  describe("drawn with the sidebar, not after it", () => {
    const copy = () =>
      JSON.parse(localStorage.getItem(GETTING_STARTED_COPY_KEY) ?? "null") as unknown;
    const keep = (value: unknown) =>
      localStorage.setItem(GETTING_STARTED_COPY_KEY, JSON.stringify({ [SLOT]: value }));

    it("draws the list as it was last time before the store answers", () => {
      keep({ expanded: true });
      checklist({ unread: true });
      // In the first frame, so the channels below are not pushed down later.
      const card = screen.getByRole("region", { name: "Getting started" });
      expect(stepNames(card)).toHaveLength(4);
    });

    it("draws nothing before the store answers once the list was put away", () => {
      keep({ dismissed: true });
      const { container } = checklist({ unread: true });
      expect(container).toBeEmptyDOMElement();
    });

    it("waits for the store on a device that has never shown it", () => {
      const { container } = checklist({ unread: true });
      expect(container).toBeEmptyDOMElement();
    });

    it("follows the store once read, and copies it for next time", async () => {
      keep({});
      checklist({ saved: { dismissed: true } });
      expect(screen.getByRole("region", { name: "Getting started" })).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.queryByRole("region", { name: "Getting started" })).toBeNull(),
      );
      expect(copy()).toEqual({ [SLOT]: { dismissed: true } });
    });

    it("keeps a press made before the store answers, and copies it", async () => {
      keep({});
      const { values, user } = checklist({ saved: { expanded: false } });
      await user.click(allSteps(screen.getByRole("region", { name: "Getting started" })));
      await act(async () => {});
      expect(allSteps(await section())).toHaveAttribute("aria-expanded", "true");
      expect(values.get(SLOT)).toEqual({ expanded: true });
      expect(copy()).toEqual({ [SLOT]: { expanded: true } });
    });

    it("copies only what it keeps", async () => {
      keep({ dismissed: "yes", expanded: true, note: "<script>" });
      const first = checklist({ unread: true });
      // "yes" is not a hide: only true is.
      expect(stepNames(screen.getByRole("region", { name: "Getting started" }))).toHaveLength(4);
      first.unmount();
      localStorage.setItem(GETTING_STARTED_COPY_KEY, "not json");
      const { values, user } = checklist({ saved: {} });
      await user.click(within(await section()).getByRole("button", { name: "Hide" }));
      await waitFor(() => expect(values.get(SLOT)).toEqual({ dismissed: true }));
      expect(copy()).toEqual({ [SLOT]: { dismissed: true } });
    });
  });
});
