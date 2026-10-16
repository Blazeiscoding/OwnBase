import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { AccountDialog, type AccountSection } from "../src/components/AccountDialog.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
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

function settings(section?: AccountSection, kind: Platform["kind"] = "web") {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: sam, users: { [sam.id]: sam }, status: "online" });
  vi.spyOn(client.api, "listSessions").mockResolvedValue({ sessions: [] });
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
  const view = (at?: AccountSection) => (
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <AccountDialog
          onClose={() => {}}
          onSignedOut={() => {}}
          section={at}
          onSectionChange={onSectionChange}
        />
      </ClientContext.Provider>
    </PlatformContext.Provider>
  );
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
    // The section is what scrolls; its name, and the list of sections, are beside it.
    expect(panel).toHaveClass("settings-scroll");
    expect(dialog.querySelectorAll(".settings-scroll")).toHaveLength(1);
    expect(panel).not.toContainElement(within(dialog).getByRole("tablist"));
    expect(panel).not.toContainElement(
      within(dialog).getByRole("heading", { name: "Account settings" }),
    );

    panel.scrollTop = 300;
    await user.click(within(dialog).getByRole("tab", { name: "Security" }));
    expect(within(dialog).getByRole("tabpanel", { name: "Security" })).toBe(panel);
    expect(panel.scrollTop).toBe(0);
    // And when Back or Forward chooses the section.
    panel.scrollTop = 120;
    moveTo("appearance");
    expect(panel.scrollTop).toBe(0);
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
    const { dialog, user } = settings("security");
    await user.click(within(dialog).getByRole("button", { name: "Sign out of this workspace" }));
    expect(within(dialog).getByRole("region", { name: "Confirm sign out" })).toBeVisible();
    await user.click(within(dialog).getByRole("tab", { name: "Composing" }));
    expect(within(dialog).queryByRole("region", { name: "Confirm sign out" })).toBeNull();
    await user.click(within(dialog).getByRole("tab", { name: "Security" }));
    expect(
      within(dialog).getByRole("button", { name: "Sign out of this workspace" }),
    ).toBeEnabled();
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
    expect(await within(dialog).findByText("Profile saved.")).toBeVisible();
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
    expect(dialog).toHaveTextContent("The desktop app shows notifications");
    expect(within(dialog).queryByRole("button", { name: "Turn on notifications" })).toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("pauses and resumes notifications for the account, and notices when a pause ends", async () => {
    browserNotifications("granted");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 8, 26, 14, 0));
    const { client, dialog, user } = settings("notifications");
    const snooze = vi.spyOn(client, "snoozeNotificationsUntil").mockImplementation((until) => {
      client.store.setState({ self: { ...sam, dndUntil: until } });
    });
    const status = within(dialog).getByText(/Pausing holds notifications/);
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
    expect(status).toHaveTextContent("Pausing holds notifications");

    await user.click(within(dialog).getByRole("button", { name: /^Pause until tomorrow at / }));
    expect(snooze).toHaveBeenLastCalledWith(new Date(2026, 8, 27, 9, 0).getTime());
    await user.click(within(dialog).getByRole("button", { name: "Resume notifications" }));
    expect(snooze).toHaveBeenLastCalledWith(null);
    expect(status).toHaveTextContent("Pausing holds notifications");
  });
});
