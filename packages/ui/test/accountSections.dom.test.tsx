import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { SessionInfo, User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { AccountDialog, type AccountSection } from "../src/components/AccountDialog.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";
import { workspaceParts } from "./workspaceParts.js";

const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

const realNotification = globalThis.Notification;
// jsdom lays nothing out, so it has nothing to scroll into view.
Element.prototype.scrollIntoView ??= () => {};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (realNotification) globalThis.Notification = realNotification;
  else delete (globalThis as { Notification?: unknown }).Notification;
});

/** A browser whose notification permission starts where the test says. */
function browserNotifications(permission: NotificationPermission) {
  const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  globalThis.Notification = { permission, requestPermission } as unknown as typeof Notification;
  return requestPermission;
}

function settings(
  section?: AccountSection,
  kind: Platform["kind"] = "web",
  sessions: SessionInfo[] = [],
) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: sam, users: { [sam.id]: sam }, status: "online" });
  vi.spyOn(client.api, "listSessions").mockResolvedValue({ sessions });
  vi.spyOn(client.api, "storageUsage").mockResolvedValue({
    usedBytes: 0,
    limitBytes: null,
    availableBytes: null,
    maxFileBytes: 10_000_000,
  });
  const updateMe = vi.spyOn(client.api, "updateMe").mockResolvedValue({ user: sam });
  const platform: Platform = {
    kind,
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
  };
  const onSectionChange = vi.fn();
  const parts = workspaceParts(client, { shell: { platform } });
  const view = (at?: AccountSection) =>
    parts.wrap(<AccountDialog onClose={() => {}} section={at} onSectionChange={onSectionChange} />);
  const { rerender } = render(view(section));
  const dialog = screen.getByRole("dialog", { name: "Account settings" });
  return {
    client,
    dialog,
    updateMe,
    onSectionChange,
    moveTo: (at: AccountSection) => rerender(view(at)),
    user: userEvent.setup(),
  };
}

describe("account settings, a section at a time", () => {
  it("opens on your profile, and names every section as a tab", async () => {
    browserNotifications("granted");
    const { dialog } = settings();
    const tabs = within(dialog).getByRole("tablist", { name: "Account settings" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual([
      "Profile",
      "Notifications",
      "Appearance",
      "Composing",
      "Voice & video",
      "Security",
      "Devices",
      "Storage",
    ]);
    const profile = within(tabs).getByRole("tab", { name: "Profile" });
    expect(profile).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("tabpanel", { name: "Profile" })).toContainElement(
      within(dialog).getByRole("form", { name: "Your profile" }),
    );
    // Only the chosen tab is a Tab stop.
    expect(
      within(tabs)
        .getAllByRole("tab")
        .filter((tab) => tab.tabIndex === 0),
    ).toEqual([profile]);
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("moves between sections with the arrow keys, Home and End, wrapping at the ends", async () => {
    browserNotifications("granted");
    const { dialog, user } = settings();
    const tab = (name: string) => within(dialog).getByRole("tab", { name });
    act(() => tab("Profile").focus());
    await user.keyboard("{ArrowDown}");
    expect(tab("Notifications")).toHaveFocus();
    expect(tab("Notifications")).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("tabpanel", { name: "Notifications" })).toBeVisible();
    await user.keyboard("{ArrowRight}{End}");
    expect(tab("Storage")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(tab("Profile")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(tab("Storage")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(tab("Profile")).toHaveFocus();
  });

  it("scrolls only the section being read, and opens each at its start", async () => {
    browserNotifications("granted");
    const { dialog, moveTo, user } = settings("calls");
    const panel = within(dialog).getByRole("tabpanel", { name: "Voice & video" });
    // The section is what scrolls, under its name; the list of sections is beside it.
    const scroller = () => dialog.querySelector<HTMLElement>(".dialog-scroll")!;
    expect(dialog.querySelectorAll(".dialog-scroll")).toHaveLength(1);
    expect(panel).toContainElement(scroller());
    expect(scroller()).toContainElement(within(panel).getByRole("heading", { name: "Microphone" }));
    expect(scroller()).not.toContainElement(
      within(panel).getByRole("heading", { name: "Voice & video" }),
    );
    expect(panel).not.toContainElement(within(dialog).getByRole("tablist"));
    expect(panel).not.toContainElement(
      within(dialog).getByRole("heading", { name: "Account settings" }),
    );

    // Each section scrolls on its own, from its start. One that was scrolled
    // leaves nothing behind, not even the fade along its top edge.
    const calls = scroller();
    calls.scrollTop = 300;
    await user.click(within(dialog).getByRole("tab", { name: "Security" }));
    expect(within(dialog).getByRole("tabpanel", { name: "Security" })).toBe(panel);
    expect(scroller()).not.toBe(calls);
    expect(scroller().scrollTop).toBe(0);
    // And when Back or Forward chooses the section.
    const security = scroller();
    security.scrollTop = 120;
    moveTo("appearance");
    expect(scroller()).not.toBe(security);
    expect(scroller().scrollTop).toBe(0);
  });

  it("says when someone chooses a section, and follows one chosen for it, as Back does", async () => {
    browserNotifications("granted");
    const { dialog, onSectionChange, moveTo, user } = settings("profile");
    await user.click(within(dialog).getByRole("tab", { name: "Devices" }));
    expect(onSectionChange).toHaveBeenLastCalledWith("devices");
    moveTo("composing");
    expect(within(dialog).getByRole("tab", { name: "Composing" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(dialog).getByRole("tabpanel", { name: "Composing" })).toBeVisible();
  });

  it("opens on the section it was asked for", () => {
    const { dialog } = settings("security");
    expect(within(dialog).getByRole("tab", { name: "Security" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(dialog).getByLabelText("Current password")).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Sign out of this workspace" }),
    ).toBeVisible();
  });

  it("leaves a confirmation behind with the section it belonged to", async () => {
    const session = (id: string, current: boolean): SessionInfo => ({
      id,
      current,
      userAgent: "Mozilla/5.0 (iPhone)",
      createdAt: 0,
      lastSeenAt: 0,
      expiresAt: 0,
    });
    const { dialog, user } = settings("devices", "web", [
      session("S1", true),
      session("S2", false),
    ]);
    const others = () => within(dialog).getByRole("button", { name: "Sign out all other devices" });
    await user.click(
      await within(dialog).findByRole("button", { name: "Sign out all other devices" }),
    );
    expect(within(dialog).getByRole("region", { name: "Confirm sign out" })).toBeVisible();
    await user.click(within(dialog).getByRole("tab", { name: "Composing" }));
    expect(within(dialog).queryByRole("region", { name: "Confirm sign out" })).toBeNull();
    await user.click(within(dialog).getByRole("tab", { name: "Devices" }));
    expect(others()).toBeEnabled();
  });

  it("saves your profile and says so, without closing", async () => {
    const { dialog, updateMe, user } = settings("profile");
    await user.type(within(dialog).getByLabelText("Status text"), "Heads down");
    await user.click(within(dialog).getByRole("button", { name: "Save profile" }));
    expect(updateMe).toHaveBeenCalledWith({
      displayName: "Sam Rivera",
      statusEmoji: "",
      statusText: "Heads down",
      // Typed, it stays until changed.
      statusExpiresAt: null,
    });
    // In a notice over the dialog, which stays open.
    expect(await screen.findByText("Profile saved.")).toBeVisible();
    expect(dialog).not.toHaveTextContent("Profile saved.");
    expect(dialog).toBeInTheDocument();
  });
});

describe("the notifications section", () => {
  it("turns notifications on in a browser that has not been asked", async () => {
    const requestPermission = browserNotifications("default");
    const { dialog, user } = settings("notifications");
    expect(dialog).toHaveTextContent("Notifications are off in this browser.");
    await user.click(within(dialog).getByRole("button", { name: "Turn on notifications" }));
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(dialog).toHaveTextContent("Notifications are on in this browser.");
    expect(within(dialog).queryByRole("button", { name: "Turn on notifications" })).toBeNull();
  });

  it("says where to allow them once the browser has refused, and asks nothing", () => {
    const requestPermission = browserNotifications("denied");
    const { dialog } = settings("notifications");
    expect(dialog).toHaveTextContent("Allow them in the browser's site settings");
    expect(within(dialog).queryByRole("button", { name: "Turn on notifications" })).toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("leaves the desktop app's own notifications alone", () => {
    const requestPermission = browserNotifications("default");
    const { dialog } = settings("notifications", "desktop");
    expect(dialog).toHaveTextContent("The desktop app shows its own notifications");
    expect(within(dialog).queryByRole("button", { name: "Turn on notifications" })).toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("pauses and resumes notifications for the account, and notices when a pause ends", async () => {
    browserNotifications("granted");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 8, 26, 14, 0));
    const { client, dialog, user } = settings("notifications");
    const snooze = vi
      .spyOn(client, "snoozeNotificationsUntil")
      .mockImplementation(async (until) => {
        client.store.setState({ self: { ...sam, dndUntil: until } });
        return null;
      });
    const status = within(dialog).getByText(/A pause stops notifications/);
    expect(status).toHaveAttribute("role", "status");

    const before = Date.now();
    await user.click(within(dialog).getByRole("button", { name: "Pause for 30 minutes" }));
    const until = snooze.mock.lastCall![0]!;
    expect(until).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    expect(status).toHaveTextContent(/^Paused until .*, on every device you use\.$/);
    expect(within(dialog).queryByRole("button", { name: "Pause for 1 hour" })).toBeNull();

    // Ending by itself reads as not paused, with nothing pressed.
    await act(async () => vi.advanceTimersByTime(30 * 60_000 + 100));
    expect(status).toHaveTextContent("A pause stops notifications");

    await user.click(within(dialog).getByRole("button", { name: /^Pause until tomorrow at / }));
    expect(snooze).toHaveBeenLastCalledWith(new Date(2026, 8, 27, 9, 0).getTime());
    await user.click(within(dialog).getByRole("button", { name: "Resume notifications" }));
    expect(snooze).toHaveBeenLastCalledWith(null);
    expect(status).toHaveTextContent("A pause stops notifications");
  });
});

describe("the account's default for what notifies (v53)", () => {
  it("is chosen on Notifications, saved at once for every device, and says when it was not", async () => {
    browserNotifications("granted");
    const { client, dialog } = settings("notifications");
    act(() => client.store.setState({ notifyDefault: "mentions" }));
    const user = userEvent.setup();
    const save = vi
      .spyOn(client.api, "setNotifyDefault")
      .mockResolvedValueOnce({ level: "all" })
      .mockRejectedValueOnce(new Error("offline"));
    const group = within(dialog).getByRole("group", { name: "Notify me about" });
    expect(
      within(group).getByRole("radio", { name: /Direct messages and mentions/ }),
    ).toBeChecked();

    await user.click(within(group).getByRole("radio", { name: /Every message/ }));
    expect(save).toHaveBeenLastCalledWith("all");
    expect(within(group).getByRole("radio", { name: /Every message/ })).toBeChecked();

    await user.click(within(group).getByRole("radio", { name: /^Nothing/ }));
    expect(await within(group).findByRole("alert")).toHaveTextContent("Your choice was not saved.");
    expect(within(group).getByRole("radio", { name: /Every message/ })).toBeChecked();
  });
});
