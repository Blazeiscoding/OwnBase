import { describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, User } from "@ownbase/protocol";
import { ClientContext } from "../src/context.js";
import { ThreadsPanel } from "../src/components/MessageListPanel.js";
import { MessageTimeline } from "../src/components/MessageTimeline.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
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

const message: Message = {
  id: "M_1",
  channelId: "C_GENERAL",
  userId: "U_SAM",
  text: "Standup notes are in the doc.",
  threadRootId: null,
  broadcast: false,
  seq: 7,
  createdAt: 0,
  editedAt: null,
  nonce: null,
  replyCount: 1,
  reactions: [],
  files: [],
  pinned: false,
  actions: [],
};

/** A workspace client that never connects, holding one channel. */
function offlineClient() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { U_SAM: sam },
    channels: { C_GENERAL: general },
    memberships: { C_GENERAL: 7 },
    status: "online",
    workspaceName: "Rocket Team",
  });
  return client;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("the threads list", () => {
  it("offers to show every thread when the unread filter leaves nothing, and keeps focus in the panel", async () => {
    const user = userEvent.setup();
    const client = offlineClient();
    vi.spyOn(client.api, "listFollowedThreads").mockImplementation(async (opts) => ({
      threads: opts?.unreadOnly ? [] : [{ root: message, lastSeq: 7, unreadCount: 0 }],
      nextCursor: null,
    }));
    render(
      <ClientContext.Provider value={client}>
        <ThreadsPanel onClose={vi.fn()} onJump={vi.fn()} />
      </ClientContext.Provider>,
    );
    const panel = screen.getByRole("complementary", { name: "Threads" });
    expect(await within(panel).findByText("Standup notes are in the doc.")).toBeVisible();

    await user.click(within(panel).getByRole("button", { name: "Unread only" }));
    const hint = await within(panel).findByText(
      "No unread replies. Threads you follow show up here when someone answers.",
    );
    // Said in the panel's status region, which a screen reader already watches.
    expect(hint.closest('[role="status"]')).not.toBeNull();
    const showAll = within(panel).getByRole("button", { name: "Show all threads" });
    expect(await accessibilityProblems(panel)).toEqual([]);

    act(() => showAll.focus());
    await user.keyboard("{Enter}");
    expect(await within(panel).findByText("Standup notes are in the doc.")).toBeVisible();
    expect(within(panel).getByRole("button", { name: "Unread only" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // The button went with the empty list; focus stayed in the panel with it.
    expect(document.activeElement).not.toBe(document.body);
    expect(panel).toContainElement(document.activeElement as HTMLElement);
  });
});

describe("a conversation's timeline", () => {
  it("stands in rows while it first loads, and Retry after a failure keeps focus in the timeline", async () => {
    const user = userEvent.setup();
    const client = offlineClient();
    const first = deferred<{ messages: Message[]; readThroughSeq: number }>();
    const second = deferred<{ messages: Message[]; readThroughSeq: number }>();
    vi.spyOn(client.api, "listMessages")
      .mockReturnValueOnce(first.promise as never)
      .mockReturnValueOnce(second.promise as never);
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
    const history = screen.getByLabelText("Message history");
    const status = within(history).getByRole("status");
    expect(status).toHaveTextContent("Loading conversation…");
    expect(status.querySelectorAll(".animate-pulse, .motion-safe\\:animate-pulse").length).toBe(3);

    await act(async () => first.reject(new Error("offline")));
    const failure = await within(history).findByRole("alert");
    expect(failure).toHaveTextContent("Could not load this conversation. Retry");
    expect(status).toBeEmptyDOMElement();

    // The failed request lets go on the next frame, as it does in a browser.
    await act(() => new Promise((done) => requestAnimationFrame(done)));
    act(() => within(failure).getByRole("button", { name: "Retry" }).focus());
    await user.keyboard("{Enter}");
    expect(within(history).queryByRole("alert")).not.toBeInTheDocument();
    expect(status).toHaveTextContent("Loading conversation…");
    expect(document.activeElement).not.toBe(document.body);
    expect(history).toContainElement(document.activeElement as HTMLElement);

    await act(async () => second.resolve({ messages: [message], readThroughSeq: 7 }));
    expect(await within(history).findByText("Standup notes are in the doc.")).toBeVisible();
    expect(status).toBeEmptyDOMElement();
  });
});
