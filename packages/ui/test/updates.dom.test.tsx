import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { User } from "@ownbase/protocol";
import type { UpdateStatus } from "@ownbase/protocol/desktop";
import { PlatformContext } from "../src/context.js";
import { AccountDialog } from "../src/components/AccountDialog.js";
import { UpdateBanner } from "../src/components/Updates.js";
import type { Platform } from "../src/platform.js";
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

Element.prototype.scrollIntoView ??= () => {};
afterEach(() => vi.restoreAllMocks());

const READY: UpdateStatus = {
  mode: "install",
  version: "0.1.0-beta.33",
  automatic: true,
  phase: "ready",
  newVersion: "0.1.0-beta.34",
  offer: true,
};

/** The desktop app's updates, answering as the main process would, with `status`. */
function desktopUpdates(status: UpdateStatus) {
  const listeners = new Set<(status: UpdateStatus) => void>();
  const updates = {
    mode: status.mode as "install" | "notify",
    status: vi.fn(async () => status),
    setAutomatic: vi.fn(async (on: boolean) => ({ ...status, automatic: on })),
    check: vi.fn(async () => status),
    restart: vi.fn(async () => ({ restarting: true }) as const),
    later: vi.fn(async () => {}),
    reportCall: vi.fn(async () => {}),
    openDownloadPage: vi.fn(async () => {}),
    subscribe: (cb: (status: UpdateStatus) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const push = (next: UpdateStatus) => act(() => listeners.forEach((cb) => cb(next)));
  return { updates, push };
}

function platformWith(updates?: Platform["updates"]): Platform {
  return {
    kind: updates ? "desktop" : "web",
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
    ...(updates ? { updates } : {}),
  };
}

function settings(platform: Platform) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: sam, users: { [sam.id]: sam }, status: "online" });
  vi.spyOn(client.api, "listSessions").mockResolvedValue({ sessions: [] });
  const parts = workspaceParts(client, { shell: { platform } });
  render(parts.wrap(<AccountDialog onClose={() => {}} section="updates" />));
  return {
    dialog: screen.getByRole("dialog", { name: "Account settings" }),
    user: userEvent.setup(),
  };
}

describe("the Updates section of Account settings", () => {
  it("is not in the browser, which has no updates of its own", async () => {
    const { dialog, user } = settings(platformWith());
    expect(within(dialog).queryByRole("tab", { name: "Updates" })).toBeNull();
    // Asked for by its address, it opens on the profile instead.
    expect(within(dialog).getByRole("tab", { name: "Profile" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.type(within(dialog).getByRole("searchbox"), "update automatically");
    expect(within(dialog).queryByRole("button", { name: /Update automatically/ })).toBeNull();
  });

  it("says which version this is, and keeps the choice to update automatically", async () => {
    const { updates } = desktopUpdates({ ...READY, phase: "idle", offer: false });
    const { dialog, user } = settings(platformWith(updates));
    expect(within(dialog).getByRole("tab", { name: "Updates" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await within(dialog).findByText("You have OwnBase 0.1.0-beta.33.")).toBeVisible();
    const box = within(dialog).getByRole("checkbox", { name: "Update automatically" });
    expect(box).toBeChecked();
    await user.click(box);
    expect(updates.setAutomatic).toHaveBeenCalledWith(false);
    await user.click(within(dialog).getByRole("button", { name: "Check now" }));
    expect(updates.check).toHaveBeenCalledTimes(1);
    // The search finds it in the desktop app.
    await user.click(within(dialog).getByRole("tab", { name: "Profile" }));
    await user.type(within(dialog).getByRole("searchbox"), "update automatically");
    await user.click(within(dialog).getByRole("button", { name: /^Update automatically/ }));
    expect(within(dialog).getByRole("tab", { name: "Updates" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("offers the restart once a version is downloaded, and says why it cannot", async () => {
    const { updates } = desktopUpdates(READY);
    updates.restart.mockResolvedValue({ restarting: false, reason: "You are in a call." } as never);
    const { dialog, user } = settings(platformWith(updates));
    await user.click(await within(dialog).findByRole("button", { name: "Restart to update" }));
    expect(updates.restart).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("You are in a call.");
  });
});

describe("the notice that a new version is ready", () => {
  function banner(updates: Platform["updates"]) {
    render(
      <PlatformContext.Provider value={platformWith(updates)}>
        <UpdateBanner />
      </PlatformContext.Provider>,
    );
    return userEvent.setup();
  }

  it("shows when the app offers it, and restarts into the new version", async () => {
    const { updates } = desktopUpdates(READY);
    const user = banner(updates);
    expect(await screen.findByText(/A new version of OwnBase is ready/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(updates.restart).toHaveBeenCalledTimes(1);
  });

  it("says why it cannot restart during a call", async () => {
    const { updates } = desktopUpdates(READY);
    updates.restart.mockResolvedValue({
      restarting: false,
      reason: "Leave the call first.",
    } as never);
    const user = banner(updates);
    await user.click(await screen.findByRole("button", { name: "Restart to update" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Leave the call first.");
  });

  it("goes when put off, and stays away while the app does not offer it", async () => {
    const { updates, push } = desktopUpdates(READY);
    const user = banner(updates);
    await user.click(await screen.findByRole("button", { name: "Later" }));
    expect(updates.later).toHaveBeenCalledTimes(1);
    push({ ...READY, offer: false });
    expect(screen.queryByText(/A new version/)).toBeNull();
  });

  it("sends the Mac app to the website for it", async () => {
    const { updates } = desktopUpdates({ ...READY, mode: "notify", phase: "available" });
    const user = banner(updates);
    expect(await screen.findByText("A new version of OwnBase is available.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Get it" }));
    expect(updates.openDownloadPage).toHaveBeenCalledTimes(1);
    expect(updates.restart).not.toHaveBeenCalled();
  });

  it("is not shown in the browser", () => {
    const { container } = render(
      <PlatformContext.Provider value={platformWith()}>
        <UpdateBanner />
      </PlatformContext.Provider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
