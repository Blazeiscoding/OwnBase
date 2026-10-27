import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { SessionInfo, User } from "@ownbase/protocol";
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

const current: SessionInfo = {
  id: "S_CURRENT",
  createdAt: 1_700_000_000_000,
  lastSeenAt: 1_700_000_100_000,
  expiresAt: 1_800_000_000_000,
  userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0",
  current: true,
};

const other: SessionInfo = {
  ...current,
  id: "S_OTHER",
  userAgent: "Mozilla/5.0 (Macintosh) Firefox/120.0",
  current: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function accountDialog() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: sam, users: { [sam.id]: sam }, status: "online" });
  vi.spyOn(client.api, "storageUsage").mockResolvedValue({
    usedBytes: 0,
    limitBytes: null,
    availableBytes: null,
    maxFileBytes: 10_000_000,
  });
  const platform: Platform = {
    kind: "web",
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
  };
  const user = userEvent.setup();
  function renderDialog(section: AccountSection = "devices") {
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <AccountDialog onClose={() => {}} onSignedOut={() => {}} section={section} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Account settings" });
    const devices =
      section === "devices"
        ? within(dialog).getByRole("region", { name: "Signed-in devices" })
        : null;
    return { dialog, devices: devices! };
  }
  return { client, user, renderDialog };
}

afterEach(() => vi.restoreAllMocks());

describe("Signed-in devices list status", () => {
  it("does not call a failed first load empty, and keeps focus through Retry to a true empty list", async () => {
    const { client, user, renderDialog } = accountDialog();
    const firstLoad = deferred<{ sessions: SessionInfo[] }>();
    const retryLoad = deferred<{ sessions: SessionInfo[] }>();
    const listSessions = vi
      .spyOn(client.api, "listSessions")
      .mockImplementationOnce(() => firstLoad.promise)
      .mockImplementationOnce(() => retryLoad.promise);
    const { dialog, devices } = renderDialog();
    const status = within(devices).getByRole("status");

    expect(status).toHaveTextContent("Loading devices…");
    expect(within(devices).queryByText(/No active devices were returned/)).not.toBeInTheDocument();
    await act(async () => firstLoad.reject(new Error("offline")));
    expect(within(devices).getByRole("alert")).toHaveTextContent(
      "Could not load signed-in devices. Check your connection and try again.",
    );
    expect(within(devices).queryByText(/No active devices were returned/)).not.toBeInTheDocument();

    const retry = within(devices).getByRole("button", { name: "Retry" });
    retry.focus();
    await user.keyboard("{Enter}");
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(within(devices).getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Loading devices…");
    expect(retry).toHaveFocus();
    expect(retry).toHaveAttribute("aria-disabled", "true");

    await act(async () => retryLoad.resolve({ sessions: [] }));
    expect(within(devices).getByRole("status")).toBe(status);
    expect(status).toHaveTextContent(
      "No active devices were returned. Refresh to check your session.",
    );
    expect(within(devices).queryByRole("alert")).not.toBeInTheDocument();
    expect(status.parentElement).toHaveFocus();
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("keeps existing device rows on Refresh failure, then updates them on Retry", async () => {
    const { client, user, renderDialog } = accountDialog();
    const refresh = deferred<{ sessions: SessionInfo[] }>();
    const listSessions = vi
      .spyOn(client.api, "listSessions")
      .mockResolvedValueOnce({ sessions: [current, other] })
      .mockImplementationOnce(() => refresh.promise)
      .mockResolvedValueOnce({ sessions: [current] });
    const { devices } = renderDialog();
    const list = within(devices).getByRole("list", { name: "Signed-in devices" });
    expect(await within(list).findByText("Firefox · macOS")).toBeVisible();
    const status = within(devices).getByRole("status");

    await user.click(within(devices).getByRole("button", { name: "Refresh" }));
    expect(status).toHaveTextContent("Loading devices…");
    expect(within(list).getByText("Firefox · macOS")).toBeVisible();
    await act(async () => refresh.reject(new Error("offline")));
    expect(within(devices).getByRole("alert")).toHaveTextContent(
      "Could not load signed-in devices.",
    );
    expect(within(list).getByText("Firefox · macOS")).toBeVisible();
    expect(within(devices).queryByText(/No active devices were returned/)).not.toBeInTheDocument();

    await user.click(within(devices).getByRole("button", { name: "Retry" }));
    expect(listSessions).toHaveBeenCalledTimes(3);
    expect(within(devices).getByRole("status")).toBe(status);
    expect(within(list).queryByText("Firefox · macOS")).not.toBeInTheDocument();
    expect(within(list).getByText("Chrome · Windows")).toBeVisible();
    expect(within(devices).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores an older initial list result after a password change has refreshed sessions", async () => {
    const { client, user, renderDialog } = accountDialog();
    const firstLoad = deferred<{ sessions: SessionInfo[] }>();
    const listSessions = vi
      .spyOn(client.api, "listSessions")
      .mockImplementationOnce(() => firstLoad.promise)
      .mockResolvedValueOnce({ sessions: [current] });
    vi.spyOn(client.api, "changePassword").mockResolvedValue({ ok: true });
    const { dialog } = renderDialog("security");

    // Pasted rather than typed: this is about which list wins, and a keystroke
    // at a time is most of this test's time on a busy machine.
    for (const [label, value] of [
      ["Current password", "previous-password"],
      ["New password", "replacement-password"],
      ["Confirm new password", "replacement-password"],
    ] as const) {
      await user.click(within(dialog).getByLabelText(label));
      await user.paste(value);
    }
    await user.click(within(dialog).getByRole("button", { name: "Update password" }));
    expect(
      await within(dialog).findByText(
        "Password changed. Your other devices have been signed out; this device stays signed in.",
      ),
    ).toHaveAttribute("role", "status");
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));

    await act(async () => firstLoad.resolve({ sessions: [current, other] }));
    await user.click(within(dialog).getByRole("tab", { name: "Devices" }));
    const devices = within(dialog).getByRole("region", { name: "Signed-in devices" });
    expect(within(devices).getByText("Chrome · Windows")).toBeVisible();
    expect(within(devices).queryByText("Firefox · macOS")).not.toBeInTheDocument();
  });

  it("removes a successfully revoked device even if the follow-up list refresh fails", async () => {
    const { client, user, renderDialog } = accountDialog();
    vi.spyOn(client.api, "listSessions")
      .mockResolvedValueOnce({ sessions: [current, other] })
      .mockRejectedValueOnce(new Error("offline"));
    const revoke = vi.spyOn(client.api, "revokeSession").mockResolvedValue({ ok: true });
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = () => {};
    try {
      const { dialog, devices } = renderDialog();
      const list = within(devices).getByRole("list", { name: "Signed-in devices" });
      expect(await within(list).findByText("Firefox · macOS")).toBeVisible();

      await user.click(within(list).getByRole("button", { name: /Sign out Firefox · macOS/ }));
      await user.click(within(dialog).getByRole("button", { name: "Confirm sign out" }));

      expect(revoke).toHaveBeenCalledWith(other.id);
      expect(await within(devices).findByRole("alert")).toHaveTextContent(
        "Could not load signed-in devices.",
      );
      expect(within(dialog).getByText("That device has been signed out.")).toBeVisible();
      expect(within(list).getByText("Chrome · Windows")).toBeVisible();
      expect(within(list).queryByText("Firefox · macOS")).not.toBeInTheDocument();
      expect(
        within(devices).queryByRole("button", { name: "Sign out all other devices" }),
      ).not.toBeInTheDocument();
    } finally {
      if (scrollIntoView) Element.prototype.scrollIntoView = scrollIntoView;
      else delete (Element.prototype as { scrollIntoView?: () => void }).scrollIntoView;
    }
  });
});
