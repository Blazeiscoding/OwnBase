import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Channel, User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { WorkspaceScreen } from "../src/screens/WorkspaceScreen.js";
import { DirectMessagesPanel } from "../src/components/DirectMessagesPanel.js";
import { useOnScreenKeyboard } from "../src/lib/onScreenKeyboard.js";
import { writeRoute } from "../src/lib/route.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * On a phone (UX-70, UX-71): a bar along the bottom with Home, DMs, Activity
 * and You, so Activity and the DMs are found without the drawer; a swipe in
 * from the left edge that opens the drawer; and a layout that keeps clear of
 * the on-screen keyboard. jsdom lays nothing out, so what the bar covers is
 * the browser suite's to check.
 */
const person = (id: string, displayName: string, role: User["role"] = "member"): User => ({
  id,
  handle: displayName.toLowerCase(),
  displayName,
  role,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});
const owner = person("U_OWNER", "Owner", "owner");
const bobby = person("U_BOBBY", "Bobby");
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
const dm: Channel = { ...room("D_BOBBY", ""), type: "dm", memberIds: [owner.id, bobby.id] };

const clients: WorkspaceClient[] = [];
afterEach(() => {
  // Unmount before the globals go, and the hooks' marks on the root with it.
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  document.body.replaceChildren();
});

function workspace(options: { phone?: boolean; self?: User; kind?: Platform["kind"] } = {}) {
  const phone = options.phone ?? true;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: phone && query.includes("max-width"),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const self = options.self ?? owner;
  const client = new WorkspaceClient("http://127.0.0.1:9", "synthetic-test-token");
  clients.push(client);
  client.store.setState({
    self,
    users: { [owner.id]: owner, [bobby.id]: bobby, [self.id]: self },
    workspaceId: "W_PHONE",
    workspaceName: "Phone Team",
    channels: { [general.id]: general, [design.id]: design, [dm.id]: dm },
    memberships: { [general.id]: 0, [design.id]: 0, [dm.id]: 0 },
    activityThreads: true,
    status: "online",
  });
  writeRoute(client.baseUrl, { channelId: general.id, threadRootId: null }, "replace");
  vi.spyOn(client, "loadTimeline").mockResolvedValue();
  vi.spyOn(client, "loadCommands").mockResolvedValue();
  vi.spyOn(client.api, "activity").mockResolvedValue({ messages: [], nextCursor: null });
  const platform: Platform = {
    kind: options.kind ?? "web",
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
  const bar = () => screen.getByRole("navigation", { name: "Main navigation" });
  const item = (name: string) => within(bar()).getByRole("button", { name });
  const drawer = () => screen.getByRole("button", { name: "Open navigation" });
  return { client, ready, bar, item, drawer };
}

describe("the phone's bottom bar", () => {
  it("offers Home, DMs, Activity and You, with Home marked as where you are", async () => {
    const { ready, bar, item } = workspace();
    await ready();
    expect(
      within(bar())
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Home", "DMs", "Activity", "You"]);
    expect(item("Home")).toHaveAttribute("aria-current", "page");
    expect(item("Activity")).not.toHaveAttribute("aria-current");
    // Each is labelled in words under its icon, not by the icon alone.
    expect(item("DMs")).toHaveTextContent("DMs");
    expect(await accessibilityProblems(bar())).toEqual([]);
    // The drawer holds the workspace's heading, so with it closed the name is
    // still the page's heading, in its banner.
    // (jsdom takes every header for a banner, so the element is looked up directly.)
    const banner = document.querySelector<HTMLElement>(".workspace-shell > header")!;
    expect(within(banner).getByRole("heading", { level: 1 })).toHaveTextContent("Phone Team");
  });

  it("is not there on a wider window, nor in the desktop app", async () => {
    workspace({ phone: false });
    expect(await screen.findByRole("button", { name: "Open navigation" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
    cleanup();

    const desktop = workspace({ kind: "desktop" });
    await desktop.ready();
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
  });

  it("opens Activity and the DMs without the drawer, and a DM from there", async () => {
    const user = userEvent.setup();
    const { ready, item, drawer } = workspace();
    await ready();

    await user.click(item("Activity"));
    expect(await screen.findByRole("complementary", { name: "Activity" })).toBeInTheDocument();
    expect(item("Activity")).toHaveAttribute("aria-current", "page");
    expect(item("Home")).not.toHaveAttribute("aria-current");

    await user.click(item("DMs"));
    const dms = await screen.findByRole("complementary", { name: "Direct messages" });
    expect(item("DMs")).toHaveAttribute("aria-current", "page");
    // A place of its own, so Back closes it and a reload opens it again.
    await waitFor(() => expect(window.location.hash).toBe(`#/c/${general.id}/p/dms`));
    expect(drawer()).toHaveAttribute("aria-expanded", "false");

    await user.click(within(dms).getByRole("button", { name: /Bobby/ }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Direct messages" })).toBeNull(),
    );
    await waitFor(() => expect(window.location.hash).toBe(`#/c/${dm.id}`));
    expect(item("Home")).toHaveAttribute("aria-current", "page");
  });

  it("goes Home to the conversation, and from there to the list of every conversation", async () => {
    const user = userEvent.setup();
    const { ready, item, drawer } = workspace();
    await ready();
    await user.click(item("Activity"));
    await screen.findByRole("complementary", { name: "Activity" });

    await user.click(item("Home"));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Activity" })).toBeNull(),
    );
    expect(drawer()).toHaveAttribute("aria-expanded", "false");

    await user.click(item("Home"));
    expect(drawer()).toHaveAttribute("aria-expanded", "true");
    // The drawer covers the bar, which is out of reach beneath it, and has the
    // workspace's heading itself.
    expect(document.querySelector(".bottom-bar")).toHaveAttribute("inert");
    expect(document.querySelector(".workspace-shell > header")).toBeNull();
  });

  it("says what waits in each place, and leaves out the conversation on screen", async () => {
    const { client, ready, item } = workspace();
    await ready();
    expect(item("Home")).not.toHaveAccessibleDescription();
    expect(item("DMs")).not.toHaveAccessibleDescription();
    expect(item("Activity")).not.toHaveAccessibleDescription();

    act(() =>
      client.store.setState({
        channelLastSeq: { [general.id]: 4, [design.id]: 2, [dm.id]: 3 },
        mentionCounts: { [general.id]: 5, [design.id]: 2 },
      }),
    );
    await waitFor(() => expect(item("DMs")).toHaveAccessibleDescription("1 unread conversation"));
    expect(item("DMs")).toHaveTextContent(/^1/);
    expect(item("Activity")).toHaveAccessibleDescription("2 mentions");
    expect(item("Home")).toHaveAccessibleDescription("Unread messages in channels");

    // Muted, a DM waits quietly; read, a channel no longer waits.
    act(() =>
      client.store.setState({
        prefs: { [dm.id]: { notifyLevel: "all", muted: true } },
        memberships: { [general.id]: 0, [design.id]: 2, [dm.id]: 0 },
        mentionCounts: {},
        threadFollows: {
          M_ROOT: {
            rootId: "M_ROOT",
            channelId: design.id,
            following: true,
            lastReadSeq: 0,
            lastSeq: 3,
            revision: 1,
          },
        },
      }),
    );
    await waitFor(() => expect(item("DMs")).not.toHaveAccessibleDescription());
    expect(item("Home")).not.toHaveAccessibleDescription();
    expect(item("Activity")).toHaveAccessibleDescription("Unread replies in threads you follow");
  });

  it("leaves DMs out for a guest, who has none", async () => {
    const { ready, bar } = workspace({ self: person("U_GUEST", "Visitor", "guest") });
    await ready();
    expect(
      within(bar())
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Home", "Activity", "You"]);
  });

  it("opens the account menu from You, and gives focus back to it", async () => {
    const user = userEvent.setup();
    const { ready, item } = workspace();
    await ready();
    await user.click(item("You"));
    const menu = screen.getByRole("menu", { name: "Your account" });
    expect(within(menu).getByRole("menuitem", { name: "Profile and status" })).toBeVisible();
    expect(within(menu).getByRole("menuitem", { name: "Account settings" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Your account" })).toBeNull();
    expect(item("You")).toHaveFocus();
  });
});

describe("the drawer and Escape", () => {
  it("closes from Jump to…, even with a hint the pointer opened on the rail", async () => {
    const user = userEvent.setup();
    const { ready, drawer } = workspace();
    await ready();
    const nav = () => screen.getByRole("navigation", { name: "Workspace navigation" });
    const jumpTo = () => within(nav()).getByRole("button", { name: /^Jump to…/ });

    // Opening the drawer puts focus on Jump to…, and Escape gives it back.
    await user.click(drawer());
    expect(drawer()).toHaveAttribute("aria-expanded", "true");
    expect(jumpTo()).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(drawer()).toHaveAttribute("aria-expanded", "false"));
    expect(drawer()).toHaveFocus();

    // The drawer slides in under the pointer that opened it, onto the rail of
    // workspaces, whose hint then shows. Focus is still on Jump to…, so the
    // Escape is the drawer's: the hint goes, and the drawer closes with it.
    await user.click(drawer());
    expect(jumpTo()).toHaveFocus();
    fireEvent.pointerEnter(within(nav()).getByRole("button", { name: "Phone Team" }), {
      pointerType: "mouse",
    });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Phone Team");
    expect(jumpTo()).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(drawer()).toHaveAttribute("aria-expanded", "false"));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(drawer()).toHaveFocus();
  });

  it("puts away the hint of the control holding focus first, as a dialog does", async () => {
    const user = userEvent.setup();
    const { ready, drawer } = workspace();
    await ready();
    await user.click(drawer());
    const nav = screen.getByRole("navigation", { name: "Workspace navigation" });
    act(() => within(nav).getByRole("button", { name: "Browse channels" }).focus());
    expect(screen.getByRole("tooltip")).toHaveTextContent("Browse channels");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(drawer()).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(drawer()).toHaveAttribute("aria-expanded", "false"));
    expect(drawer()).toHaveFocus();
  });
});

/** A finger on the screen, as the browser reports it: the event and where its one touch is. */
function touch(type: "touchstart" | "touchmove" | "touchend", x = 0, y = 0) {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "touches", {
    value: type === "touchend" ? [] : [{ identifier: 1, clientX: x, clientY: y }],
  });
  act(() => {
    document.body.dispatchEvent(event);
  });
}

describe("the swipe that opens the drawer", () => {
  it("opens it from the left edge and closes it with a swipe back", async () => {
    const { ready, drawer } = workspace();
    await ready();
    touch("touchstart", 12, 400);
    touch("touchmove", 40, 404);
    expect(drawer()).toHaveAttribute("aria-expanded", "false");
    touch("touchmove", 90, 410);
    expect(drawer()).toHaveAttribute("aria-expanded", "true");
    touch("touchend");

    touch("touchstart", 300, 400);
    touch("touchmove", 200, 404);
    await waitFor(() => expect(drawer()).toHaveAttribute("aria-expanded", "false"));
  });

  it("leaves a swipe that starts away from the edge, and a scroll, alone", async () => {
    const { ready, drawer } = workspace();
    await ready();
    touch("touchstart", 200, 400);
    touch("touchmove", 320, 400);
    touch("touchend");
    expect(drawer()).toHaveAttribute("aria-expanded", "false");

    // Mostly downwards from the edge: the conversation is being scrolled.
    touch("touchstart", 10, 400);
    touch("touchmove", 20, 440);
    touch("touchmove", 90, 520);
    touch("touchend");
    expect(drawer()).toHaveAttribute("aria-expanded", "false");
  });

  it("does nothing where there is no drawer", async () => {
    const { ready, drawer } = workspace({ phone: false });
    await ready();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("min-width"),
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    touch("touchstart", 10, 400);
    touch("touchmove", 120, 400);
    expect(drawer()).toHaveAttribute("aria-expanded", "false");
  });
});

/** A visualViewport the test moves, as a phone's keyboard would. */
function fakeViewport(height: number) {
  const viewport = Object.assign(new EventTarget(), { height, scale: 1, pageTop: 0 });
  vi.stubGlobal("visualViewport", viewport);
  return {
    viewport,
    move(next: Partial<{ height: number; scale: number; pageTop: number }>) {
      Object.assign(viewport, next);
      act(() => {
        viewport.dispatchEvent(new Event("resize"));
      });
    },
  };
}

describe("the on-screen keyboard", () => {
  const root = document.documentElement;

  it("keeps the page in the part left in sight where the browser does not shrink it", () => {
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("innerHeight", 800);
    const { move } = fakeViewport(800);
    const field = document.body.appendChild(document.createElement("textarea"));
    renderHook(() => useOnScreenKeyboard());
    expect(root).not.toHaveAttribute("data-visual-viewport");
    expect(root).not.toHaveAttribute("data-keyboard");

    // iOS Safari: the page stays 800 tall, and the part in sight is shorter and moved down.
    act(() => field.focus());
    move({ height: 420, pageTop: 120 });
    expect(root).toHaveAttribute("data-visual-viewport");
    expect(root.style.getPropertyValue("--visual-height")).toBe("420px");
    expect(root.style.getPropertyValue("--visual-top")).toBe("120px");
    expect(root).toHaveAttribute("data-keyboard");

    move({ height: 800, pageTop: 0 });
    expect(root).not.toHaveAttribute("data-visual-viewport");
    expect(root.style.getPropertyValue("--visual-height")).toBe("");
    expect(root).not.toHaveAttribute("data-keyboard");
  });

  it("only marks the keyboard where the browser shrinks the page itself", async () => {
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("innerHeight", 800);
    const { move } = fakeViewport(800);
    const field = document.body.appendChild(document.createElement("textarea"));
    renderHook(() => useOnScreenKeyboard());
    act(() => field.focus());
    // Chrome on Android: the page and the part in sight shrink together.
    vi.stubGlobal("innerHeight", 450);
    move({ height: 450 });
    expect(root).toHaveAttribute("data-keyboard");
    expect(root).not.toHaveAttribute("data-visual-viewport");

    // Leaving the field: no keyboard, whatever the height says for a moment.
    act(() => field.blur());
    await waitFor(() => expect(root).not.toHaveAttribute("data-keyboard"));
  });

  it("leaves a zoomed page, and a page nobody is typing on, alone", () => {
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("innerHeight", 800);
    const { move } = fakeViewport(800);
    renderHook(() => useOnScreenKeyboard());
    move({ height: 300 });
    expect(root).toHaveAttribute("data-visual-viewport");
    expect(root).not.toHaveAttribute("data-keyboard");
    move({ height: 400, scale: 2 });
    expect(root).not.toHaveAttribute("data-visual-viewport");
  });

  it("takes its marks away when the screen goes", () => {
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("innerHeight", 800);
    const { move } = fakeViewport(800);
    const hook = renderHook(() => useOnScreenKeyboard());
    move({ height: 400 });
    expect(root).toHaveAttribute("data-visual-viewport");
    hook.unmount();
    expect(root).not.toHaveAttribute("data-visual-viewport");
    expect(root.style.getPropertyValue("--visual-top")).toBe("");
  });
});

describe("the Direct messages panel", () => {
  function panel(state: Partial<WorkspaceClient["state"]> = {}) {
    const client = new WorkspaceClient("http://127.0.0.1:9", "synthetic-test-token");
    clients.push(client);
    client.store.setState({
      self: owner,
      users: { [owner.id]: owner, [bobby.id]: bobby },
      channels: { [general.id]: general, [dm.id]: dm },
      memberships: { [general.id]: 0, [dm.id]: 0 },
      status: "online",
      ...state,
    });
    const props = {
      onClose: vi.fn(),
      onOpen: vi.fn(),
      onNewMessage: vi.fn(),
      onFriends: vi.fn(),
    };
    render(
      <ClientContext.Provider value={client}>
        <DirectMessagesPanel activeChannelId={general.id} {...props} />
      </ClientContext.Provider>,
    );
    return {
      client,
      ...props,
      aside: screen.getByRole("complementary", { name: "Direct messages" }),
    };
  }

  it("lists the conversations, says which wait, and opens one", async () => {
    const user = userEvent.setup();
    const { aside, onOpen } = panel({
      channelLastSeq: { [dm.id]: 2 },
      mentionCounts: { [dm.id]: 1 },
    });
    // It takes focus on its heading, as every side panel does.
    expect(within(aside).getByRole("heading", { name: "Direct messages" })).toHaveFocus();
    const row = within(aside).getByRole("button", { name: /Bobby/ });
    expect(within(row).getByLabelText("1 unread mention")).toBeInTheDocument();
    await user.click(row);
    expect(onOpen).toHaveBeenCalledWith(dm.id);
    expect(await accessibilityProblems(aside)).toEqual([]);
  });

  it("says how to start one when there are none", async () => {
    const user = userEvent.setup();
    const { aside, onNewMessage } = panel({ channels: { [general.id]: general } });
    expect(within(aside).getByText(/No direct messages yet/)).toBeInTheDocument();
    await user.click(within(aside).getAllByRole("button", { name: "New message" }).at(-1)!);
    expect(onNewMessage).toHaveBeenCalled();
  });

  it("tells a guest what they have instead", () => {
    const guest = person("U_GUEST", "Visitor", "guest");
    const { aside } = panel({ self: guest, channels: { [general.id]: general } });
    expect(within(aside).getByText(/Direct messages are for members/)).toBeInTheDocument();
    expect(within(aside).queryByRole("button", { name: "New message" })).toBeNull();
  });

  it("says the list may be out of date while the connection is down", () => {
    const { aside } = panel({ status: "reconnecting" });
    expect(within(aside).getByText(/Not connected/)).toHaveAttribute("role", "status");
    // What this device knows is still listed.
    expect(within(aside).getByRole("button", { name: /Bobby/ })).toBeInTheDocument();
  });
});
