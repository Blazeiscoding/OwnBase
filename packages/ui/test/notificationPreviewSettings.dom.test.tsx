import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { AccountDialog } from "../src/components/AccountDialog.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/** Choosing what notifications show, for this workspace on this device (IMP-03). */
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

describe("what notifications show", () => {
  it("shows the message until chosen otherwise, and keeps the choice for this account", async () => {
    const user = userEvent.setup();
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    client.store.setState({ self: sam, users: { [sam.id]: sam }, status: "online" });
    vi.spyOn(client.api, "listSessions").mockResolvedValue({ sessions: [] });
    const saved = { "http://elsewhere:9 U_SAM": "none" };
    const set = vi.fn(async (_key: string, _value: unknown) => {});
    const platform: Platform = {
      kind: "desktop",
      storage: {
        get: async <T,>(key: string) =>
          (key === "notification-previews" ? saved : null) as T | null,
        set,
      },
      notify: () => {},
    };
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <AccountDialog onClose={() => {}} onSignedOut={() => {}} section="notifications" />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const group = screen.getByRole("group", { name: "What notifications show" });
    const message = within(group).getByRole("radio", { name: /^The message/ });
    await waitFor(() => expect(message).toBeChecked());
    expect(await accessibilityProblems(group)).toEqual([]);

    await user.click(within(group).getByRole("radio", { name: /^Nothing about it/ }));
    expect(set).toHaveBeenCalledWith("notification-previews", {
      "http://elsewhere:9 U_SAM": "none",
      "http://127.0.0.1:9 U_SAM": "none",
    });
    await waitFor(() =>
      expect(within(group).getByRole("radio", { name: /^Nothing about it/ })).toBeChecked(),
    );
  });
});
