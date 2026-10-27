import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "@ownbase/client-core";
import type { User } from "@ownbase/protocol";
import { ActivityPanel } from "../src/components/ActivityPanel.js";
import { FriendsDialog } from "../src/components/FriendsDialog.js";
import { ClientContext } from "../src/context.js";
import { useTabs, type TabChoice } from "../src/lib/useTabs.js";
import { accessibilityProblems } from "./accessibility.js";

afterEach(() => vi.restoreAllMocks());

const SEASONS = ["spring", "summer", "autumn"] as const;
type Season = (typeof SEASONS)[number];

function Seasons(props: { onSelect?: (tab: Season, how: TabChoice) => void }) {
  const [season, setSeason] = useState<Season>("spring");
  const tabs = useTabs({
    label: "Seasons",
    tabs: SEASONS,
    selected: season,
    onSelect(tab, how) {
      props.onSelect?.(tab, how);
      setSeason(tab);
    },
  });
  return (
    <main>
      <div {...tabs.listProps}>
        {SEASONS.map((s) => (
          <button key={s} {...tabs.tabProps(s)}>
            {s[0]!.toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
      <div {...tabs.panelProps}>
        <p>About {season}</p>
        <button>Plant something</button>
      </div>
    </main>
  );
}

function setup(onSelect?: (tab: Season, how: TabChoice) => void) {
  const user = userEvent.setup();
  render(<Seasons onSelect={onSelect} />);
  const list = screen.getByRole("tablist", { name: "Seasons" });
  const tab = (name: string) => within(list).getByRole("tab", { name });
  return { user, list, tab };
}

describe("a row of tabs", () => {
  it("is a named tablist with one selected tab, one Tab stop and a panel named by that tab", async () => {
    const { user, list, tab } = setup();
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    const panel = screen.getByRole("tabpanel", { name: "Spring" });
    for (const t of tabs) expect(t).toHaveAttribute("aria-controls", panel.id);
    expect(await accessibilityProblems()).toEqual([]);

    // Tab goes from the selected tab straight into the panel, past the others.
    await user.tab();
    expect(tab("Spring")).toHaveFocus();
    await user.tab();
    expect(within(panel).getByRole("button", { name: "Plant something" })).toHaveFocus();
  });

  it("moves with Left and Right, wrapping at both ends, and selection follows", async () => {
    const onSelect = vi.fn();
    const { user, tab } = setup(onSelect);
    tab("Spring").focus();
    await user.keyboard("{ArrowRight}");
    expect(tab("Summer")).toHaveFocus();
    expect(tab("Summer")).toHaveAttribute("aria-selected", "true");
    expect(tab("Summer")).toHaveAttribute("tabindex", "0");
    expect(tab("Spring")).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel", { name: "Summer" })).toHaveTextContent("About summer");
    expect(onSelect).toHaveBeenLastCalledWith("summer", "key");

    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(tab("Spring")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(tab("Autumn")).toHaveFocus();
    expect(tab("Autumn")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Autumn" })).toBeVisible();
  });

  it("goes to the ends with Home and End, and tells nobody when the tab stays the same", async () => {
    const onSelect = vi.fn();
    const { user, tab } = setup(onSelect);
    tab("Spring").focus();
    await user.keyboard("{End}");
    expect(tab("Autumn")).toHaveFocus();
    expect(tab("Autumn")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(tab("Spring")).toHaveFocus();
    expect(tab("Spring")).toHaveAttribute("aria-selected", "true");
    expect(onSelect.mock.calls).toEqual([
      ["autumn", "key"],
      ["spring", "key"],
    ]);
    await user.keyboard("{Home}");
    await user.click(tab("Spring"));
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("selects a clicked tab, and says it was a click", async () => {
    const onSelect = vi.fn();
    const { user, tab } = setup(onSelect);
    await user.click(tab("Autumn"));
    expect(tab("Autumn")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Autumn" })).toBeVisible();
    expect(onSelect).toHaveBeenCalledWith("autumn", "click");
  });

  it("leaves keys held with Alt, Ctrl or Meta to others, such as Alt+Left for Back", () => {
    const { tab } = setup();
    tab("Spring").focus();
    for (const modifier of ["altKey", "ctrlKey", "metaKey"]) {
      const handled = !fireEvent.keyDown(tab("Spring"), { key: "ArrowRight", [modifier]: true });
      expect(handled).toBe(false);
      expect(tab("Spring")).toHaveAttribute("aria-selected", "true");
      expect(tab("Spring")).toHaveFocus();
    }
    // Keys a tab has no use for are not taken either.
    expect(fireEvent.keyDown(tab("Spring"), { key: "ArrowDown" })).toBe(true);
  });
});

const person = (id: string, handle: string, displayName: string): User => ({
  id,
  handle,
  displayName,
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});
const sam = person("U_SAM", "sam", "Sam Rivera");
const priya = person("U_PRIYA", "priya", "Priya Shah");
const alex = person("U_ALEX", "alex", "Alex Kim");

/** A workspace client that never connects: Sam, a friend in Alex and a request from Priya. */
function offlineClient() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam, [priya.id]: priya, [alex.id]: alex },
    friends: [
      { userId: alex.id, status: "accepted", createdAt: 0 },
      { userId: priya.id, status: "incoming", createdAt: 0 },
    ],
    status: "online",
  });
  return client;
}

describe("views that were pressed buttons", () => {
  it("Friends switches between friends, requests and adding friends as tabs", async () => {
    const user = userEvent.setup();
    render(
      <ClientContext.Provider value={offlineClient()}>
        <FriendsDialog onClose={() => {}} onOpenProfile={() => {}} />
      </ClientContext.Provider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Friends" });
    const list = within(dialog).getByRole("tablist", { name: "People filters" });
    const friends = within(list).getByRole("tab", { name: "Friends" });
    expect(friends).toHaveAttribute("aria-selected", "true");
    expect(
      within(list)
        .getAllByRole("tab")
        .map((t) => t.tabIndex),
    ).toEqual([0, -1, -1]);
    const panel = within(dialog).getByRole("tabpanel", { name: "Friends" });
    expect(within(panel).getByRole("textbox", { name: "Find people" })).toBeVisible();
    expect(within(panel).getByText("Alex Kim")).toBeVisible();
    // The search stays over the people, who are the one thing that scrolls.
    const scrollers = dialog.querySelectorAll(".dialog-scroll");
    expect(scrollers).toHaveLength(1);
    expect(scrollers[0]).toContainElement(within(panel).getByText("Alex Kim"));
    expect(scrollers[0]).not.toContainElement(
      within(panel).getByRole("textbox", { name: "Find people" }),
    );
    expect(within(dialog).queryByRole("button", { pressed: true })).not.toBeInTheDocument();
    expect(await accessibilityProblems(dialog)).toEqual([]);

    friends.focus();
    await user.keyboard("{ArrowRight}");
    const requests = within(list).getByRole("tab", { name: "Requests (1)" });
    expect(requests).toHaveFocus();
    expect(requests).toHaveAttribute("aria-selected", "true");
    const requestsPanel = within(dialog).getByRole("tabpanel", { name: "Requests (1)" });
    expect(within(requestsPanel).getByText("Priya Shah")).toBeVisible();
    expect(within(requestsPanel).getByRole("button", { name: "Accept" })).toBeVisible();
    await user.keyboard("{End}");
    expect(within(list).getByRole("tab", { name: "Add friends" })).toHaveFocus();
    expect(within(dialog).getByRole("tabpanel", { name: "Add friends" })).toBeVisible();
    await user.keyboard("{ArrowRight}");
    expect(friends).toHaveFocus();
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("Activity switches between everything unread and mentions as tabs", async () => {
    const user = userEvent.setup();
    const client = offlineClient();
    const activity = vi
      .spyOn(client.api, "activity")
      .mockResolvedValue({ messages: [], nextCursor: null });
    render(
      <main>
        <ClientContext.Provider value={client}>
          <ActivityPanel onClose={() => {}} onJump={() => {}} />
        </ClientContext.Provider>
      </main>,
    );
    const panel = screen.getByRole("complementary", { name: "Activity" });
    const list = within(panel).getByRole("tablist", { name: "Activity filter" });
    const unread = within(list).getByRole("tab", { name: "All" });
    expect(unread).toHaveAttribute("aria-selected", "true");
    expect(within(panel).getByRole("tabpanel", { name: "All" })).toHaveTextContent(
      "Unread messages in conversations you joined.",
    );
    expect(await within(panel).findByText("You're caught up.")).toBeVisible();
    expect(await accessibilityProblems(panel)).toEqual([]);

    unread.focus();
    await user.keyboard("{ArrowLeft}");
    const mentions = within(list).getByRole("tab", { name: "Mentions" });
    expect(mentions).toHaveFocus();
    expect(mentions).toHaveAttribute("aria-selected", "true");
    expect(within(panel).getByRole("tabpanel", { name: "Mentions" })).toHaveTextContent(
      "Direct and room-wide mentions in conversations you joined.",
    );
    await waitFor(() => expect(activity).toHaveBeenLastCalledWith("mentions", expect.anything()));
    expect(await within(panel).findByText("No mentions yet.")).toBeVisible();
  });
});
