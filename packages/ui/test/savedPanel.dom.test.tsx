import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, User } from "@ownbase/protocol";
import { ClientContext } from "../src/context.js";
import { SavedPanel } from "../src/components/MessageListPanel.js";
import { ToastProvider } from "../src/components/Toast.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * A saved message can be taken out of Saved from the Saved panel itself,
 * without opening it first: the row goes at once, with Undo.
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

const general: Channel = {
  id: "C_GENERAL",
  type: "public",
  name: "general",
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
};

const message = (id: string, text: string, seq: number): Message => ({
  id,
  channelId: general.id,
  userId: sam.id,
  text,
  threadRootId: null,
  broadcast: false,
  seq,
  createdAt: 0,
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  actions: [],
});

const first = message("M1", "Ship list for Friday", 1);
const second = message("M2", "Venue contract", 2);

/** A server that keeps its own saved set, so the list it gives follows the requests. */
function setup() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam },
    channels: { [general.id]: general },
    memberships: { [general.id]: 0 },
    status: "online",
    saved: { M1: true, M2: true },
  });
  const onServer = new Set(["M1", "M2"]);
  vi.spyOn(client.api, "listSaved").mockImplementation(async () => ({
    messages: [first, second].filter((m) => onServer.has(m.id)),
    nextCursor: null,
  }));
  const unsave = vi.spyOn(client.api, "unsaveMessage").mockImplementation(async (id) => {
    onServer.delete(id);
    return { ok: true };
  });
  const save = vi.spyOn(client.api, "saveMessage").mockImplementation(async (id) => {
    onServer.add(id);
    return { ok: true };
  });
  render(
    <ClientContext.Provider value={client}>
      <ToastProvider>
        <SavedPanel onClose={vi.fn()} onJump={vi.fn()} />
      </ToastProvider>
    </ClientContext.Provider>,
  );
  const panel = screen.getByRole("complementary", { name: "Saved" });
  return { client, panel, unsave, save, user: userEvent.setup() };
}

const row = (panel: HTMLElement, text: string) =>
  within(panel).getByText(text).closest("li") as HTMLElement;

describe("removing a message from the Saved panel", () => {
  it("takes the row away at once, and Undo brings it back", async () => {
    const { client, panel, unsave, save, user } = setup();
    await within(panel).findByText("Ship list for Friday");
    expect(await accessibilityProblems(panel)).toEqual([]);

    await user.click(
      within(row(panel, "Ship list for Friday")).getByRole("button", {
        name: "Remove from Saved",
      }),
    );
    expect(within(panel).queryByText("Ship list for Friday")).toBeNull();
    expect(within(panel).getByText("Venue contract")).toBeVisible();
    expect(client.state.saved).toEqual({ M2: true });
    expect(unsave).toHaveBeenCalledWith("M1");

    const notice = (await screen.findByText("Removed from Saved.")).closest("[data-toast]");
    await user.click(within(notice as HTMLElement).getByRole("button", { name: "Undo" }));
    expect(save).toHaveBeenCalledWith("M1");
    expect(await within(panel).findByText("Ship list for Friday")).toBeVisible();
    expect(client.state.saved).toEqual({ M1: true, M2: true });
  });

  it("puts the row back and says so when the server refuses", async () => {
    const { client, panel, unsave, user } = setup();
    unsave.mockRejectedValueOnce(new Error("offline"));
    await within(panel).findByText("Ship list for Friday");

    await user.click(
      within(row(panel, "Ship list for Friday")).getByRole("button", {
        name: "Remove from Saved",
      }),
    );
    expect(await screen.findByText("Could not remove that from Saved.")).toBeVisible();
    // Its Undo would have nothing to undo.
    expect(screen.queryByText("Removed from Saved.")).toBeNull();
    expect(within(panel).getByText("Ship list for Friday")).toBeVisible();
    expect(client.state.saved).toEqual({ M1: true, M2: true });

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(panel).queryByText("Ship list for Friday")).toBeNull());
    expect(client.state.saved).toEqual({ M2: true });
  });

  it("takes one row for a double-click, though the next row's button slides under it", async () => {
    const { client, panel, unsave, user } = setup();
    await within(panel).findByText("Ship list for Friday");

    await user.click(
      within(row(panel, "Ship list for Friday")).getByRole("button", {
        name: "Remove from Saved",
      }),
    );
    // Chromium counts the click that lands on the next row as the second of two.
    fireEvent.click(
      within(row(panel, "Venue contract")).getByRole("button", { name: "Remove from Saved" }),
      { detail: 2 },
    );
    expect(within(panel).getByText("Venue contract")).toBeVisible();
    expect(client.state.saved).toEqual({ M2: true });
    expect(unsave).toHaveBeenCalledTimes(1);
  });

  it("leaves keyboard focus on the next message, then on the panel's name", async () => {
    const { panel, user } = setup();
    await within(panel).findByText("Ship list for Friday");

    within(row(panel, "Ship list for Friday"))
      .getByRole("button", { name: "Remove from Saved" })
      .focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(
        within(row(panel, "Venue contract")).getByRole("button", { name: "Open message" }),
      ).toHaveFocus(),
    );

    await user.tab();
    expect(
      within(row(panel, "Venue contract")).getByRole("button", { name: "Remove from Saved" }),
    ).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(within(panel).getByRole("heading", { name: "Saved" })).toHaveFocus(),
    );
    expect(await within(panel).findByText(/Save for later/)).toBeVisible();
  });
});
