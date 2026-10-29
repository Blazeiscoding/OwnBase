import { describe, expect, it, vi, type MockInstance } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, User } from "@ownbase/protocol";
import { ClientContext, OpenMessageContext } from "../src/context.js";
import { MessageItem } from "../src/components/MessageItem.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
import { linkedMessages } from "../src/lib/linkedMessages.js";
import { accessibilityProblems } from "./accessibility.js";

/** A link to a message in this workspace shows that message in a card under the words. */
const person = (id: string, displayName: string): User => ({
  id,
  handle: displayName.split(" ")[0]!.toLowerCase(),
  displayName,
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});
const room = (id: string, type: Channel["type"], name: string): Channel => ({
  id,
  type,
  name,
  topic: "",
  description: "",
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
});
const sam = person("U_SAM", "Sam Rivera");
const priya = person("U_PRIYA", "Priya Shah");
const message = (over: Partial<Message> = {}): Message => ({
  id: "M_1",
  channelId: "C_GENERAL",
  userId: "U_PRIYA",
  text: "",
  threadRootId: null,
  broadcast: false,
  seq: 7,
  createdAt: Date.UTC(2026, 9, 20, 9, 30),
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  actions: [],
  ...over,
});
const HERE = "http://127.0.0.1:9";
// Sam's message in #design, which Priya links to from #general.
const plan = message({
  id: "M_PLAN",
  channelId: "C_DESIGN",
  userId: "U_SAM",
  text: "Ship it Friday.",
  createdAt: Date.UTC(2026, 9, 19, 16, 0),
});
const linkTo = (target: Pick<Message, "channelId" | "id">, server = HERE) =>
  `${server}/#/c/${target.channelId}/m/${target.id}`;

type Answers = MockInstance<WorkspaceClient["api"]["getMessage"]>;

/** `answer` sets up what the server says before the row first asks. */
function shown(item: Message, held: Message[] = [], answer?: (getMessage: Answers) => void) {
  const client = new WorkspaceClient(HERE, "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { U_SAM: sam, U_PRIYA: priya },
    channels: {
      C_GENERAL: room("C_GENERAL", "public", "general"),
      C_DESIGN: room("C_DESIGN", "public", "design"),
    },
    memberships: { C_GENERAL: 0, C_DESIGN: 0 },
    status: "online",
    timelines: {
      C_DESIGN: { items: held, hasMore: false, hasMoreNewer: false, loaded: true },
    },
  });
  const getMessage = vi.spyOn(client.api, "getMessage");
  answer?.(getMessage);
  const openMessage = vi.fn();
  render(
    <ToastProvider>
      <ConfirmProvider>
        <ClientContext.Provider value={client}>
          <OpenMessageContext.Provider value={openMessage}>
            <MessageItem message={item} compact={false} />
          </OpenMessageContext.Provider>
        </ClientContext.Provider>
      </ConfirmProvider>
    </ToastProvider>,
  );
  const row = screen.getByRole("article", { name: "Message from Priya Shah" });
  return { client, getMessage, openMessage, row, user: userEvent.setup() };
}

describe("a link to a message", () => {
  it("shows one this device holds, as it is now, and opens it here", async () => {
    const { client, getMessage, openMessage, row, user } = shown(
      message({ text: `Read this ${linkTo(plan)}` }),
      [plan],
    );
    expect(within(row).getByText("Posted in #design")).toBeVisible();
    expect(within(row).getByText("Sam Rivera")).toBeVisible();
    expect(within(row).getByText("Ship it Friday.")).toBeVisible();
    expect(getMessage).not.toHaveBeenCalled();
    expect(await accessibilityProblems(row)).toEqual([]);

    await user.click(within(row).getByRole("button", { name: "View message" }));
    expect(openMessage).toHaveBeenCalledWith("C_DESIGN", "M_PLAN");

    // An edit there shows here as it is made.
    act(() =>
      client.store.setState((s) => ({
        timelines: {
          ...s.timelines,
          C_DESIGN: { ...s.timelines.C_DESIGN!, items: [{ ...plan, text: "Ship it Monday." }] },
        },
      })),
    );
    expect(within(row).getByText("Ship it Monday.")).toBeVisible();
    expect(within(row).queryByText("Ship it Friday.")).toBeNull();
  });

  it("asks the server for one this device does not hold, and says a reply is in a thread", async () => {
    const reply = message({
      id: "M_REPLY",
      channelId: "C_DESIGN",
      userId: "U_SAM",
      text: "Friday works.",
      threadRootId: "M_PLAN",
    });
    const { getMessage, row } = shown(message({ text: linkTo(reply) }), [], (answers) =>
      answers.mockResolvedValue({ message: reply }),
    );
    expect(await within(row).findByText("Friday works.")).toBeVisible();
    expect(within(row).getByText("Posted in a thread in #design")).toBeVisible();
    expect(getMessage).toHaveBeenCalledWith("C_DESIGN", "M_REPLY");
  });

  it("shows nothing for one deleted, or in a conversation this account cannot read", async () => {
    const gone = message({ id: "M_GONE", channelId: "C_DESIGN" });
    const secret = message({ id: "M_SECRET", channelId: "C_SECRET" });
    const { getMessage, row } = shown(
      message({ text: `${linkTo(gone)} and ${linkTo(secret)}` }),
      [],
      (answers) => answers.mockRejectedValue(new ApiError(404, "message_not_found")),
    );
    await waitFor(() => expect(getMessage).toHaveBeenCalledTimes(1));
    // Only the conversation this account can read was asked about.
    expect(getMessage).toHaveBeenCalledWith("C_DESIGN", "M_GONE");
    await act(() => Promise.resolve());
    expect(within(row).queryByText(/^Posted in/)).toBeNull();
  });

  it("asks again when its conversation changes, keeping what it showed while offline", async () => {
    const { client, getMessage, row } = shown(message({ text: linkTo(plan) }), [], (answers) =>
      answers.mockResolvedValueOnce({ message: plan }),
    );
    expect(await within(row).findByText("Ship it Friday.")).toBeVisible();

    const bump = () =>
      act(() =>
        client.store.setState((s) => ({
          changedContent: { ...s.changedContent, C_DESIGN: (s.changedContent.C_DESIGN ?? 0) + 1 },
        })),
      );
    getMessage.mockResolvedValueOnce({ message: { ...plan, text: "Ship it Monday." } });
    bump();
    expect(await within(row).findByText("Ship it Monday.")).toBeVisible();

    getMessage.mockRejectedValueOnce(new ApiError(0, "network_error"));
    bump();
    await waitFor(() => expect(getMessage).toHaveBeenCalledTimes(3));
    await act(() => Promise.resolve());
    expect(within(row).getByText("Ship it Monday.")).toBeVisible();

    // Deleted there: the card goes.
    getMessage.mockRejectedValueOnce(new ApiError(404, "message_not_found"));
    bump();
    await waitFor(() => expect(within(row).queryByText("Ship it Monday.")).toBeNull());
  });
});

describe("which links show a message", () => {
  const ours = (serverUrl: string) => serverUrl === HERE;

  it("takes links to this workspace's messages, each once, in the order named", () => {
    const other = message({ id: "M_OTHER", channelId: "C_GENERAL" });
    expect(
      linkedMessages(
        `${linkTo(other)} <${linkTo(plan)}|the plan> ${linkTo(other)} ${HERE}/#/c/C_DESIGN`,
        ours,
      ),
    ).toEqual([
      { channelId: "C_GENERAL", messageId: "M_OTHER" },
      { channelId: "C_DESIGN", messageId: "M_PLAN" },
    ]);
  });

  it("leaves links in code, and links to another server holding the same ids", () => {
    expect(
      linkedMessages(
        `\`${linkTo(plan)}\` and\n\`\`\`\n${linkTo(plan)}\n\`\`\`\n${linkTo(plan, "https://restored.example.org")}`,
        ours,
      ),
    ).toEqual([]);
  });

  it("shows at most three", () => {
    const text = ["A", "B", "C", "D"].map((id) => `${HERE}/#/c/C_GENERAL/m/M_${id}`).join(" ");
    expect(linkedMessages(text, ours).map((target) => target.messageId)).toEqual([
      "M_A",
      "M_B",
      "M_C",
    ]);
  });
});
