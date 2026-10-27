import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, Poll, User } from "@ownbase/protocol";
import {
  ClientContext,
  OpenMessageContext,
  PlatformContext,
  useWorkspace,
} from "../src/context.js";
import { MessageItem } from "../src/components/MessageItem.js";
import { Composer } from "../src/components/Composer.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Polls (E6): a poll's card votes and shows the count at once, takes a vote
 * back, shows who chose unless anonymous, shows a closed poll's result, lets
 * its author close it, and is not edited; the composer's + menu and /poll
 * open the window that makes one, which says what is missing.
 */
const person = (id: string, displayName: string, role: User["role"] = "member"): User => ({
  id,
  handle: displayName.split(" ")[0]!.toLowerCase(),
  displayName,
  role,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});
const sam = person("U_SAM", "Sam Rivera");
const priya = person("U_PRIYA", "Priya Shah");
const lee = person("U_LEE", "Lee Park");
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
const lunch = (poll: Partial<Poll> = {}, over: Partial<Message> = {}): Message => ({
  id: "M_POLL",
  channelId: "C_GENERAL",
  userId: "U_PRIYA",
  text: "Where for lunch?",
  threadRootId: null,
  broadcast: false,
  seq: 7,
  createdAt: Date.UTC(2026, 9, 22, 9, 30),
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  actions: [],
  poll: {
    options: [
      { text: "Pizza", votes: 1, voterIds: ["U_PRIYA"] },
      { text: "Tacos", votes: 0, voterIds: [] },
      { text: "Salad", votes: 0, voterIds: [] },
    ],
    multiple: false,
    anonymous: false,
    voters: 1,
    closedAt: null,
    ...poll,
  },
  ...over,
});

/** The message as the store holds it, so votes heard back redraw it. */
function Held() {
  const message = useWorkspace((s) => s.timelines.C_GENERAL!.items[0]!);
  return <MessageItem message={message} compact={false} />;
}

function shown(message: Message, opts: { self?: User; told?: Record<string, number[]> } = {}) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: opts.self ?? sam,
    users: { U_SAM: sam, U_PRIYA: priya, U_LEE: lee },
    channels: { C_GENERAL: general },
    memberships: { C_GENERAL: 0 },
    status: "online",
    pollChoices: opts.told ?? {},
    timelines: {
      C_GENERAL: { items: [message], hasMore: false, hasMoreNewer: false, loaded: true },
    },
  });
  const votePoll = vi
    .spyOn(client.api, "votePoll")
    .mockImplementation(async (_id, choices) => ({ message, choices }));
  const closePoll = vi.spyOn(client.api, "closePoll");
  render(
    <ToastProvider>
      <ConfirmProvider>
        <ClientContext.Provider value={client}>
          <OpenMessageContext.Provider value={vi.fn()}>
            <Held />
          </OpenMessageContext.Provider>
        </ClientContext.Provider>
      </ConfirmProvider>
    </ToastProvider>,
  );
  const card = screen.getByRole("group", { name: "Where for lunch?" });
  return { client, votePoll, closePoll, card, user: userEvent.setup() };
}

const choice = (card: HTMLElement, name: string) =>
  within(card).getByRole("button", { name: new RegExp(`^${name},`) });

describe("a poll in a message", () => {
  it("votes, shows the count at once, moves the vote, and takes it back", async () => {
    const { card, votePoll, user } = shown(lunch());
    expect(card).toHaveTextContent("Choose one");
    expect(card).toHaveTextContent("1 vote");
    expect(choice(card, "Pizza")).toHaveAccessibleName("Pizza, 1 vote: Priya Shah");
    expect(choice(card, "Pizza")).toHaveAttribute("aria-pressed", "false");
    expect(await accessibilityProblems(card)).toEqual([]);

    await user.click(choice(card, "Tacos"));
    expect(votePoll).toHaveBeenLastCalledWith("M_POLL", [1]);
    expect(choice(card, "Tacos")).toHaveAttribute("aria-pressed", "true");
    expect(choice(card, "Tacos")).toHaveAccessibleName("Tacos, 1 vote: you");
    expect(card).toHaveTextContent("2 votes");

    // One choice: picking another moves the vote.
    await user.click(choice(card, "Salad"));
    expect(votePoll).toHaveBeenLastCalledWith("M_POLL", [2]);
    expect(choice(card, "Tacos")).toHaveAttribute("aria-pressed", "false");
    expect(choice(card, "Salad")).toHaveAttribute("aria-pressed", "true");

    // Pressing it again takes the vote back.
    await user.click(choice(card, "Salad"));
    expect(votePoll).toHaveBeenLastCalledWith("M_POLL", []);
    await waitFor(() => expect(choice(card, "Salad")).toHaveAttribute("aria-pressed", "false"));
    expect(card).toHaveTextContent("1 vote");
  });

  it("takes any number of choices when the poll allows it", async () => {
    const { card, votePoll, user } = shown(lunch({ multiple: true }));
    expect(card).toHaveTextContent("Choose any");
    await user.click(choice(card, "Pizza"));
    await user.click(choice(card, "Salad"));
    await waitFor(() => expect(votePoll).toHaveBeenLastCalledWith("M_POLL", [0, 2]));
    expect(choice(card, "Pizza")).toHaveAccessibleName("Pizza, 2 votes: Priya Shah and you");
    expect(choice(card, "Salad")).toHaveAttribute("aria-pressed", "true");
    // Two people of two chose Pizza: a share of the voters, not of the votes.
    expect(choice(card, "Pizza")).toHaveTextContent("100%");
  });

  it("names whoever chose, not only the people the message names", () => {
    const { card } = shown(
      lunch({
        voters: 2,
        options: [
          { text: "Pizza", votes: 1, voterIds: ["U_PRIYA"] },
          { text: "Tacos", votes: 1, voterIds: ["U_LEE"] },
          { text: "Salad", votes: 0, voterIds: [] },
        ],
      }),
    );
    expect(choice(card, "Tacos")).toHaveAccessibleName("Tacos, 1 vote: Lee Park");
  });

  it("names nobody in an anonymous poll, and shows your own choice from the server", () => {
    const { card } = shown(
      lunch({
        anonymous: true,
        voters: 2,
        options: [
          { text: "Pizza", votes: 1 },
          { text: "Tacos", votes: 1 },
          { text: "Salad", votes: 0 },
        ],
      }),
      { told: { M_POLL: [1] } },
    );
    expect(card).toHaveTextContent("Choose one · Anonymous");
    expect(choice(card, "Pizza")).toHaveAccessibleName("Pizza, 1 vote");
    expect(choice(card, "Tacos")).toHaveAttribute("aria-pressed", "true");
    expect(card).not.toHaveTextContent("Priya");
  });

  it("puts a refused vote back and says so", async () => {
    const { card, votePoll, user } = shown(lunch());
    votePoll.mockRejectedValue(new ApiError(409, "poll_closed", "This poll is closed."));
    await user.click(choice(card, "Tacos"));
    expect(await screen.findByText(/Your vote did not go through/)).toBeVisible();
    expect(choice(card, "Tacos")).toHaveAttribute("aria-pressed", "false");
    expect(card).toHaveTextContent("1 vote");
  });

  it("shows a closed poll's result, with nothing to press", async () => {
    const { card } = shown(lunch({ closedAt: Date.now() }), { self: priya });
    expect(card).toHaveTextContent("Closed");
    expect(within(card).queryAllByRole("button")).toEqual([]);
    expect(card).toHaveTextContent("Pizza, 1 vote: you, your choice");
    expect(await accessibilityProblems(card)).toEqual([]);
  });

  it("can be closed by its author only, after asking", async () => {
    const theirs = shown(lunch());
    expect(within(theirs.card).queryByRole("button", { name: "Close poll" })).toBeNull();
    cleanup();

    const mine = shown(lunch(), { self: priya });
    mine.closePoll.mockResolvedValue({ message: lunch({ closedAt: 1 }) });
    await mine.user.click(within(mine.card).getByRole("button", { name: "Close poll" }));
    const asked = await screen.findByRole("dialog", { name: "Close this poll?" });
    await mine.user.click(within(asked).getByRole("button", { name: "Close poll" }));
    expect(mine.closePoll).toHaveBeenCalledWith("M_POLL");
    await waitFor(() => expect(mine.card).toHaveTextContent("Closed"));
  });

  it("is not offered for editing, even to its author", async () => {
    const { user } = shown(lunch(), { self: priya });
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Actions for message from Priya Shah" }));
    const menu = screen.getByRole("menu", { name: "Actions for message from Priya Shah" });
    expect(within(menu).queryByRole("menuitem", { name: "Edit message" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Delete message" })).toBeInTheDocument();
  });
});

function composer(opts: { polls?: boolean; self?: User; threadRootId?: string } = {}) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: opts.self ?? sam,
    users: { U_SAM: sam, U_PRIYA: priya },
    channels: { C_GENERAL: general },
    status: "online",
    pollChoices: opts.polls === false ? null : {},
  });
  const send = vi.spyOn(client, "send").mockReturnValue(true);
  const platform: Platform = {
    kind: "web",
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
  };
  render(
    <ToastProvider>
      <ConfirmProvider>
        <PlatformContext.Provider value={platform}>
          <ClientContext.Provider value={client}>
            <Composer
              channelId="C_GENERAL"
              threadRootId={opts.threadRootId}
              placeholder="Message #general"
            />
          </ClientContext.Provider>
        </PlatformContext.Provider>
      </ConfirmProvider>
    </ToastProvider>,
  );
  return { client, send, user: userEvent.setup() };
}

async function typeInto(user: ReturnType<typeof userEvent.setup>, text: string) {
  const box = screen.getByRole("textbox", { name: "Message #general" });
  await waitFor(() => expect(box).toBeEnabled());
  await user.type(box, text);
  return box;
}

describe("making a poll", () => {
  it("opens from the + menu and says what is missing before it sends", async () => {
    const { send, user } = composer({ threadRootId: "M_ROOT" });
    await user.click(screen.getByRole("button", { name: "Add to message" }));
    const menu = screen.getByRole("menu", { name: "Add to message" });
    expect(within(menu).getByRole("menuitem", { name: "Upload a file" })).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: "Create a poll" }));
    const dialog = await screen.findByRole("dialog", { name: "Create a poll" });
    const create = within(dialog).getByRole("button", { name: "Create poll" });

    await user.click(create);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Write the question to ask.");
    expect(within(dialog).getByRole("textbox", { name: "Question" })).toHaveFocus();

    await user.type(within(dialog).getByRole("textbox", { name: "Question" }), "Team offsite?");
    // Enter moves on to the choices, and past the last filled one adds another.
    await user.keyboard("{Enter}Lisbon{Enter}");
    expect(within(dialog).getByRole("textbox", { name: "Choice 2" })).toHaveFocus();
    await user.keyboard("lisbon{Enter}");
    expect(within(dialog).getByRole("textbox", { name: "Choice 3" })).toHaveFocus();
    await user.keyboard("Porto");
    await user.click(create);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Each choice must be different.");
    expect(within(dialog).getByRole("textbox", { name: "Choice 2" })).toHaveFocus();
    expect(send).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Remove choice 2" }));
    await user.click(within(dialog).getByRole("checkbox", { name: /Allow more than one choice/ }));
    await user.click(within(dialog).getByRole("checkbox", { name: /Anonymous/ }));
    expect(await accessibilityProblems(dialog)).toEqual([]);
    await user.click(create);
    expect(send).toHaveBeenCalledWith("C_GENERAL", "Team offsite?", {
      threadRootId: "M_ROOT",
      poll: { options: ["Lisbon", "Porto"], multiple: true, anonymous: true },
    });
    expect(screen.queryByRole("dialog", { name: "Create a poll" })).toBeNull();
  });

  it("opens from /poll with its words as the question, and clears it once made", async () => {
    const { send, user } = composer();
    const box = await typeInto(user, "/poll Lunch at noon?{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Create a poll" });
    expect(within(dialog).getByRole("textbox", { name: "Question" })).toHaveValue("Lunch at noon?");
    expect(send).not.toHaveBeenCalled();
    await user.type(within(dialog).getByRole("textbox", { name: "Choice 1" }), "Yes");
    await user.type(within(dialog).getByRole("textbox", { name: "Choice 2" }), "No");
    await user.click(within(dialog).getByRole("button", { name: "Create poll" }));
    expect(send).toHaveBeenCalledWith("C_GENERAL", "Lunch at noon?", {
      poll: { options: ["Yes", "No"], multiple: false, anonymous: false },
    });
    await waitFor(() => expect(box).toHaveValue(""));
  });

  it("keeps the plain attach button where the server keeps no polls", async () => {
    const { send, user } = composer({ polls: false });
    expect(screen.getByRole("button", { name: "Attach a file" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add to message" })).toBeNull();
    // /poll is then the server's to answer.
    await typeInto(user, "/poll Lunch?{Enter}");
    expect(send).toHaveBeenCalledWith("C_GENERAL", "/poll Lunch?", expect.anything());
    expect(screen.queryByRole("dialog", { name: "Create a poll" })).toBeNull();
  });

  it("is not offered to a guest, and /poll says why", async () => {
    const { send, user } = composer({ self: person("U_GUEST", "Visitor", "guest") });
    expect(screen.queryByRole("button", { name: "Add to message" })).toBeNull();
    await typeInto(user, "/poll Lunch?{Enter}");
    expect(await screen.findByText(/Guests cannot make polls/)).toBeVisible();
    expect(send).not.toHaveBeenCalled();
  });
});
