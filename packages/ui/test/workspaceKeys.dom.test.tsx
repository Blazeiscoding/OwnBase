import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { WorkspaceScreen } from "../src/screens/WorkspaceScreen.js";
import { writeRoute } from "../src/lib/route.js";
import type { Platform } from "../src/platform.js";
import type { OtherWorkspace } from "../src/components/Sidebar.js";
import { AppNotices } from "./workspaceParts.js";

/**
 * In the desktop app Ctrl/Cmd+1–9 open the workspace at that place on the
 * rail, as in Slack's. A browser keeps those keys for its tabs, so there they
 * do nothing of ours.
 */
const owner: User = {
  id: "U_OWNER",
  handle: "owner",
  displayName: "Owner",
  role: "owner",
  canInvite: true,
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
const others: OtherWorkspace[] = [
  { url: "http://apple.test", name: "Apple Co", handle: "owner" },
  { url: "http://zebra.test", name: "Zebra Club", handle: "owner" },
];

const clients: WorkspaceClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function workspace(kind: Platform["kind"]) {
  // A laptop's window: the rail and sidebar are on screen.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 761px) and (min-height: 481px)",
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const client = new WorkspaceClient("http://127.0.0.1:9", "synthetic-test-token");
  clients.push(client);
  client.store.setState({
    self: owner,
    users: { [owner.id]: owner },
    workspaceId: "W_KEYS",
    workspaceName: "Middle Team",
    channels: { [general.id]: general },
    memberships: { [general.id]: 0 },
    status: "online",
  });
  writeRoute(client.baseUrl, { channelId: general.id, threadRootId: null }, "replace");
  vi.spyOn(client, "loadTimeline").mockResolvedValue();
  vi.spyOn(client.api, "listSaved").mockResolvedValue({ messages: [], nextCursor: null });
  const platform: Platform = {
    kind,
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
  };
  const opened: string[] = [];
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <AppNotices>
          <WorkspaceScreen
            client={client}
            platform={platform}
            onLeaveWorkspace={() => {}}
            onSignedOut={() => {}}
            otherWorkspaces={others}
            railPlace={1}
            onOpenWorkspace={(url) => opened.push(url)}
          />
        </AppNotices>
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  // The rail is on screen before the effect that listens for keys has run:
  // a busy machine shows the gap, so wait out the effects as well.
  const ready = async () => {
    await screen.findByRole("group", { name: "Workspaces" });
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  };
  const press = (digit: number, extra: Partial<KeyboardEventInit> = {}) =>
    fireEvent.keyDown(window, {
      key: String(digit),
      code: `Digit${digit}`,
      ctrlKey: true,
      ...extra,
    });
  return { ready, press, opened };
}

describe("Ctrl/Cmd+number", () => {
  it("opens the workspace at that place on the rail, in the desktop app", async () => {
    const { ready, press, opened } = workspace("desktop");
    await ready();
    press(1);
    press(2); // This one: nothing to open.
    press(3);
    press(4); // Past the last.
    press(3, { shiftKey: true }); // Ctrl+Shift+number is the composer's lists.
    expect(opened).toEqual(["http://apple.test", "http://zebra.test"]);
  });

  it("is left to the browser on the web", async () => {
    const { ready, press, opened } = workspace("web");
    await ready();
    press(1);
    expect(opened).toEqual([]);
  });
});
