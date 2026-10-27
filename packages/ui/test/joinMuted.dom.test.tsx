import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { AccountDialog } from "../src/components/AccountDialog.js";
import { HuddleButton } from "../src/components/HuddleBar.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";
import { noiseFilter } from "../src/lib/noiseFilter.js";

/**
 * Joining huddles with the microphone off (CALL-01): a choice kept on this
 * device, for every workspace, so nothing is heard before someone means it.
 */
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

afterEach(() => vi.restoreAllMocks());

function setup(saved: unknown = null) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: sam, users: { [sam.id]: sam }, status: "online" });
  const set = vi.fn(async (_key: string, _value: unknown) => {});
  // A platform of its own each time: the preference is kept per platform.
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T,>(key: string) => (key === "call-preferences" ? (saved as T) : null),
      set,
    },
    notify: () => {},
  };
  const wrap = (ui: React.ReactNode) => (
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>{ui}</ClientContext.Provider>
    </PlatformContext.Provider>
  );
  return { client, set, wrap };
}

describe("joining huddles with the microphone off", () => {
  it("is a choice under Voice & video, off until chosen, and kept on this device", async () => {
    const user = userEvent.setup();
    const { client, set, wrap } = setup();
    vi.spyOn(client.api, "listSessions").mockResolvedValue({ sessions: [] });
    render(wrap(<AccountDialog onClose={() => {}} onSignedOut={() => {}} section="calls" />));
    const panel = screen.getByRole("tabpanel", { name: "Voice & video" });
    const box = within(panel).getByRole("checkbox", {
      name: "Join huddles with my microphone off",
    });
    await waitFor(() => expect(box).toBeEnabled());
    expect(box).not.toBeChecked();
    expect(await accessibilityProblems(panel)).toEqual([]);

    await user.click(box);
    expect(set).toHaveBeenCalledWith("call-preferences", { joinMuted: true });
    expect(box).toBeChecked();
  });

  it("joins muted once chosen", async () => {
    const user = userEvent.setup();
    const { client, wrap } = setup({ joinMuted: true });
    const join = vi.spyOn(client, "joinHuddle").mockResolvedValue();
    render(wrap(<HuddleButton channelId="C_GENERAL" />));
    // Let the saved choice load before joining.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await user.click(screen.getByRole("button", { name: "Start a huddle" }));
    expect(join).toHaveBeenCalledWith("C_GENERAL", { muted: true, noiseFilter });
  });

  it("joins with the microphone on otherwise", async () => {
    const user = userEvent.setup();
    const { client, wrap } = setup();
    const join = vi.spyOn(client, "joinHuddle").mockResolvedValue();
    render(wrap(<HuddleButton channelId="C_GENERAL" />));
    await user.click(screen.getByRole("button", { name: "Start a huddle" }));
    expect(join).toHaveBeenCalledWith("C_GENERAL", { muted: false, noiseFilter });
  });
});
