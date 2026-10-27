import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { GettingStarted } from "../src/components/GettingStarted.js";
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
  if (realNotification) globalThis.Notification = realNotification;
  else delete (globalThis as { Notification?: unknown }).Notification;
});

const SLOT = "local:v1:W_ROCKET:U_OWNER:getting-started";

function checklist(
  options: { role?: User["role"]; saved?: unknown; kind?: Platform["kind"] } = {},
) {
  globalThis.Notification = { permission: "default" } as unknown as typeof Notification;
  const values = new Map<string, unknown>(options.saved ? [[SLOT, options.saved]] : []);
  const platform: Platform = {
    kind: options.kind ?? "web",
    storage: {
      get: async <T,>(name: string) => (values.get(name) ?? null) as T | null,
      set: async (name: string, value: unknown) => void values.set(name, value),
    },
    notify: () => {},
  };
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  const owner = person("U_OWNER", options.role ?? "owner");
  client.store.setState({
    self: owner,
    workspaceId: "W_ROCKET",
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
});
