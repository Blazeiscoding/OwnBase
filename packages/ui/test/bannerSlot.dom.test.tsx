import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Channel, User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { WorkspaceScreen } from "../src/screens/WorkspaceScreen.js";
import { Banner } from "../src/components/Banner.js";
import type { HostingLine } from "../src/components/Sidebar.js";
import { writeRoute } from "../src/lib/route.js";
import type { Platform } from "../src/platform.js";

/**
 * One place for banners, under the conversation's header (UX-25): one at a
 * time, the most pressing, and this computer's hosting in the sidebar.
 */
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
  // Unmount before the globals go: the setup file's cleanup runs after this hook.
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const notSaved = <Banner tone="alert">Could not save changes to sign-ins on this device.</Banner>;

function workspace(
  opts: { banner?: ReactNode; hosting?: HostingLine; channelId?: string; ready?: boolean } = {},
) {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  // A browser that has not been asked about notifications yet.
  vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn() });
  const client = new WorkspaceClient("http://127.0.0.1:9", "synthetic-test-token");
  clients.push(client);
  if (opts.ready !== false)
    client.store.setState({
      self: owner,
      users: { [owner.id]: owner },
      workspaceId: "W_BANNERS",
      channels: { [general.id]: general },
      memberships: { [general.id]: 0 },
      status: "online",
    });
  writeRoute(
    client.baseUrl,
    { channelId: opts.channelId ?? general.id, threadRootId: null },
    "replace",
  );
  vi.spyOn(client, "loadTimeline").mockResolvedValue();
  vi.spyOn(client, "loadCommands").mockResolvedValue();
  vi.spyOn(client.api, "channelMembers").mockResolvedValue({ memberIds: [owner.id] });
  vi.spyOn(client.api, "listPins").mockResolvedValue({ messages: [], nextCursor: null, total: 0 });
  const platform: Platform = {
    kind: "web",
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
  };
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <WorkspaceScreen
          client={client}
          platform={platform}
          onLeaveWorkspace={() => {}}
          onSignedOut={() => {}}
          banner={opts.banner}
          hosting={opts.hosting}
        />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  return client;
}

/** Past the check of saved access, which shows a banner of its own while it waits. */
const opened = () => screen.findByRole("button", { name: /^Members/ }, { timeout: 3_000 });

describe("the banner place", () => {
  it("asks about notifications under the header when nothing more pressing is there", async () => {
    workspace();
    const ask = await screen.findByRole("region", { name: "Notifications" });
    // Under the header, not above it.
    const header = document.querySelector("header.channel-header")!;
    expect(header.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows sign-ins that could not be saved instead of the ask, one at a time", async () => {
    workspace({ banner: notSaved });
    await opened();
    expect(
      await screen.findByText("Could not save changes to sign-ins on this device."),
    ).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
  });

  it("puts a conversation that could not be opened first, and the next banner after Dismiss", async () => {
    const user = userEvent.setup();
    workspace({ banner: notSaved, channelId: "C_GONE" });
    await screen.findByRole("navigation", { name: "Workspace navigation" }, { timeout: 3_000 });
    const alert = await screen.findByRole("alert", {}, { timeout: 3_000 });
    expect(alert).toHaveTextContent(/not available/);
    expect(screen.queryByText("Could not save changes to sign-ins on this device.")).toBeNull();

    await user.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(
      await screen.findByText("Could not save changes to sign-ins on this device."),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });
});

describe("this computer's hosting", () => {
  const hosting = (onManage = vi.fn()): HostingLine => ({
    text: "Hosting Rocket Team on this computer",
    state: "live",
    onManage,
  });

  it("is a line under the workspace's name, with Manage", async () => {
    const user = userEvent.setup();
    const onManage = vi.fn();
    workspace({ hosting: hosting(onManage) });
    const nav = await screen.findByRole("navigation", { name: "Workspace navigation" });
    expect(within(nav).getByRole("status")).toHaveTextContent(
      "Hosting Rocket Team on this computer",
    );
    await user.click(within(nav).getByRole("button", { name: "Manage hosting" }));
    expect(onManage).toHaveBeenCalledOnce();
  });

  it("is there, with any banner, while the workspace is still connecting", async () => {
    workspace({ hosting: hosting(), banner: notSaved, ready: false });
    await waitFor(() =>
      expect(screen.getByText("Connecting to the workspace…")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Manage hosting" })).toBeVisible();
    expect(screen.getByText("Could not save changes to sign-ins on this device.")).toBeVisible();
  });
});
