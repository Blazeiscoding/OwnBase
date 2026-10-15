import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Channel, User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { WorkspaceScreen } from "../src/screens/WorkspaceScreen.js";
import { writeRoute } from "../src/lib/route.js";
import type { Platform } from "../src/platform.js";

/**
 * On a phone the sidebar is behind the menu button, so the button says when
 * something is waiting there: a count of mentions, or a dot for unread
 * messages, and the same in words. The open conversation and muted channels
 * do not count.
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
const room = (id: string, name: string): Channel => ({
  id,
  type: "public",
  name,
  topic: "",
  description: "",
  creatorId: owner.id,
  archived: false,
  createdAt: 0,
});
const general = room("C_GENERAL", "general");
const design = room("C_DESIGN", "design");

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

function workspace() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("max-width"),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const client = new WorkspaceClient("http://127.0.0.1:9", "synthetic-test-token");
  clients.push(client);
  client.store.setState({
    self: owner,
    users: { [owner.id]: owner },
    workspaceId: "W_BADGE",
    channels: { [general.id]: general, [design.id]: design },
    memberships: { [general.id]: 0, [design.id]: 0 },
    status: "online",
  });
  writeRoute(client.baseUrl, { channelId: general.id, threadRootId: null }, "replace");
  vi.spyOn(client, "loadTimeline").mockResolvedValue();
  vi.spyOn(client, "loadCommands").mockResolvedValue();
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
        />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const toggle = () => screen.getByRole("button", { name: "Open navigation" });
  // The screen checks the saved access before it shows the workspace.
  const ready = () => screen.findByRole("button", { name: "Open navigation" }, { timeout: 3_000 });
  return { client, ready, toggle };
}

describe("the phone's menu button", () => {
  it("says what is waiting elsewhere, and nothing for the open conversation", async () => {
    const { client, ready, toggle } = workspace();
    expect(await ready()).not.toHaveAccessibleDescription();

    // A mention in the open conversation is already in front of you.
    act(() => client.store.setState({ mentionCounts: { [general.id]: 3 } }));
    expect(toggle()).not.toHaveAccessibleDescription();

    // The screen is still fetching parts of itself, so a change can show a moment later.
    act(() => client.store.setState({ mentionCounts: { [general.id]: 3, [design.id]: 2 } }));
    await waitFor(() => expect(toggle()).toHaveAccessibleDescription("2 mentions elsewhere"));
    expect(toggle()).toHaveTextContent("2");

    act(() => client.store.setState({ mentionCounts: {}, channelLastSeq: { [design.id]: 5 } }));
    await waitFor(() => expect(toggle()).toHaveAccessibleDescription("Unread messages elsewhere"));
  });

  it("stays quiet for a muted channel", async () => {
    const { client, ready, toggle } = workspace();
    await ready();
    act(() =>
      client.store.setState({
        channelLastSeq: { [design.id]: 5 },
        prefs: { [design.id]: { notifyLevel: "all", muted: true } },
      }),
    );
    expect(toggle()).not.toHaveAccessibleDescription();
  });
});
