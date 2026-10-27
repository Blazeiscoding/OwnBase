import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, ServerToClient, User } from "@ownbase/protocol";
import { ClientContext } from "../src/context.js";
import { MessageTimeline } from "../src/components/MessageTimeline.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Private command answers stay within what the app keeps (REV-04), and the
 * conversation says, without repeating them, that older ones were cleared.
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
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
};

function setup() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { U_SAM: sam },
    channels: { C_GENERAL: general },
    memberships: { C_GENERAL: 0 },
    status: "online",
    workspaceName: "Rocket Team",
  });
  vi.spyOn(client.api, "listMessages").mockResolvedValue({
    messages: [],
    readThroughSeq: 0,
  } as never);
  const connection = client as unknown as { handleServerMessage(message: ServerToClient): void };
  const answer = (n: number) =>
    connection.handleServerMessage({
      type: "ephemeral",
      event: {
        type: "ephemeral.message",
        channelId: "C_GENERAL",
        id: `E${n}`,
        userId: "",
        text: `Private answer number ${n}`,
        createdAt: n,
      },
    });
  render(
    <ToastProvider>
      <ConfirmProvider>
        <ClientContext.Provider value={client}>
          <MessageTimeline
            channelId="C_GENERAL"
            onOpenThread={vi.fn()}
            onChannelClick={vi.fn()}
            onOpenProfile={vi.fn()}
          />
        </ClientContext.Provider>
      </ConfirmProvider>
    </ToastProvider>,
  );
  return { client, answer };
}

describe("private answers in the timeline", () => {
  it("shows at most twenty, says how many older ones were cleared, and the note can be dismissed by keyboard", async () => {
    const user = userEvent.setup();
    const { client, answer } = setup();
    act(() => {
      for (let n = 1; n <= 23; n++) answer(n);
    });
    expect(screen.getAllByText(/^Private answer number/)).toHaveLength(20);
    expect(screen.queryByText("Private answer number 3")).toBeNull();
    expect(screen.getByText("Private answer number 23")).toBeVisible();
    expect(
      screen.getByText("3 older private answers here were cleared to make room."),
    ).toBeVisible();
    expect(await accessibilityProblems(screen.getByLabelText("Message history"))).toEqual([]);

    const dismiss = screen.getByRole("button", { name: "Dismiss note about cleared answers" });
    dismiss.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByText(/cleared to make room/)).toBeNull();
    expect(client.state.ephemeralsDropped).toEqual({});
    // The answers themselves stay until they are dismissed one by one.
    expect(screen.getAllByText(/^Private answer number/)).toHaveLength(20);
  });

  it("says one, in the singular", () => {
    const { answer } = setup();
    act(() => {
      for (let n = 1; n <= 21; n++) answer(n);
    });
    expect(screen.getByText("1 older private answer here was cleared to make room.")).toBeVisible();
  });
});
