import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Channel, User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { WorkspaceScreen } from "../src/screens/WorkspaceScreen.js";
import { writeRoute } from "../src/lib/route.js";
import type { Platform } from "../src/platform.js";

/**
 * Between a phone and a laptop a side panel covers the conversation, and on a
 * phone the drawer does. What is covered goes out of reach of the keyboard and
 * the screen reader, but the main landmark around it stays: a page with none
 * leaves a screen reader nothing to jump to, and axe reports
 * `landmark-one-main`.
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
  // Unmount before the globals go.
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** `width` decides which of the layout's media queries match. */
function workspace(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const wide = query === "(min-width: 761px) and (min-height: 481px)";
    const under = /^\(max-width: (\d+)px\)/.exec(query);
    return {
      matches: wide ? width >= 761 : under ? width <= Number(under[1]) : false,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });
  const client = new WorkspaceClient("http://127.0.0.1:9", "synthetic-test-token");
  clients.push(client);
  client.store.setState({
    self: owner,
    users: { [owner.id]: owner },
    workspaceId: "W_LANDMARK",
    workspaceName: "Landmark Team",
    channels: { [general.id]: general },
    memberships: { [general.id]: 0 },
    status: "online",
  });
  writeRoute(client.baseUrl, { channelId: general.id, threadRootId: null }, "replace");
  vi.spyOn(client, "loadTimeline").mockResolvedValue();
  vi.spyOn(client, "loadCommands").mockResolvedValue();
  vi.spyOn(client.api, "listSaved").mockResolvedValue({ messages: [], nextCursor: null });
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
  // The screen checks the saved access before it shows the workspace.
  const ready = () => screen.findByRole("button", { name: "Open navigation" }, { timeout: 3_000 });
  const nav = () => screen.getByRole("navigation", { name: "Workspace navigation" });
  return { ready, nav };
}

/** Axe's own rule, run on the whole document: a main landmark a screen reader can reach. */
async function mainLandmarkProblems(): Promise<string[]> {
  // Axe asks whether a modal covers the page by what is under five points of
  // the window; jsdom lays nothing out, so nothing is.
  const elementsFromPoint = document.elementsFromPoint;
  document.elementsFromPoint = () => [];
  try {
    const results = await axe.run(document, { runOnly: ["landmark-one-main"] });
    return results.violations.map((violation) => violation.id);
  } finally {
    document.elementsFromPoint = elementsFromPoint;
  }
}

/** Whether `element`, or anything around it, is out of reach. */
const covered = (element: Element) => element.closest("[inert]") !== null;

describe("the main landmark", () => {
  it("stays while a side panel covers the conversation, with what it covers out of reach", async () => {
    const user = userEvent.setup();
    const { ready, nav } = workspace(900);
    await ready();
    expect(await mainLandmarkProblems()).toEqual([]);

    await user.click(within(nav()).getByRole("button", { name: "Saved" }));
    const saved = await screen.findByRole("complementary", { name: "Saved" });
    const main = screen.getByRole("main");
    await waitFor(() => expect(covered(main.querySelector("textarea")!)).toBe(true));
    expect(await mainLandmarkProblems()).toEqual([]);
    expect(covered(main.querySelector(".channel-header")!)).toBe(true);
    // The landmark itself, the panel and the navigation are not covered.
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(covered(main)).toBe(false);
    expect(covered(saved)).toBe(false);
    expect(covered(nav())).toBe(false);

    await user.click(within(saved).getByRole("button", { name: "Close Saved" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Saved" })).toBeNull());
    expect(main.querySelector("[inert]")).toBeNull();
  });

  it("stays while the phone's drawer is open", async () => {
    const user = userEvent.setup();
    const { ready, nav } = workspace(390);
    const toggle = await ready();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const main = screen.getByRole("main");
    expect(covered(main.querySelector("textarea")!)).toBe(true);
    expect(await mainLandmarkProblems()).toEqual([]);
    expect(covered(main)).toBe(false);
    expect(covered(nav())).toBe(false);
  });
});
