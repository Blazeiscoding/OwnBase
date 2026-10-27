import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, ReplyReference, User } from "@ownbase/protocol";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "../src/components/Composer.js";
import { MessageItem } from "../src/components/MessageItem.js";
import { quoteLine } from "../src/components/ReplyQuote.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
import { ClientContext, OpenMessageContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Discord's two ways to answer a message: Reply, which answers it in place
 * in the same conversation, and Reply in thread, which opens its thread.
 */
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

const sam = person("U_SAM", "Sam Rivera");
const priya = person("U_PRIYA", "Priya Shah");

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

const message = (over: Partial<Message> = {}): Message => ({
  id: "M_1",
  channelId: general.id,
  userId: priya.id,
  text: "The *build* is green again.",
  threadRootId: null,
  broadcast: false,
  seq: 7,
  createdAt: 0,
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  actions: [],
  ...over,
});

const platform: Platform = {
  kind: "web",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};

function workspace(inlineReplies = true) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam, [priya.id]: priya },
    channels: { [general.id]: general },
    memberships: { [general.id]: 0 },
    status: "online",
    inlineReplies,
  });
  const send = vi.spyOn(client, "send").mockReturnValue(true);
  return { client, send };
}

async function renderConversation(
  messages: { message: Message; inThread?: boolean }[],
  options: { inlineReplies?: boolean; threadRootId?: string; openMessage?: () => void } = {},
) {
  const { client, send } = workspace(options.inlineReplies);
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <OpenMessageContext.Provider value={options.openMessage ?? null}>
          <ToastProvider>
            <ConfirmProvider>
              <main>
                {messages.map(({ message: m, inThread }) => (
                  <MessageItem key={m.id} message={m} compact={false} inThread={inThread} />
                ))}
                <Composer channelId={general.id} placeholder="Message #general" />
              </main>
              {options.threadRootId && (
                <aside>
                  <Composer
                    channelId={general.id}
                    threadRootId={options.threadRootId}
                    placeholder="Reply…"
                  />
                </aside>
              )}
            </ConfirmProvider>
          </ToastProvider>
        </OpenMessageContext.Provider>
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const box = screen.getByRole("textbox", { name: "Message #general" });
  await waitFor(() => expect(box).toBeEnabled());
  return { box, client, send, user: userEvent.setup() };
}

const quote = (over: Partial<ReplyReference> = {}): ReplyReference => ({
  id: "M_0",
  userId: priya.id,
  text: "Who is on call this week?",
  fileCount: 0,
  deleted: false,
  ping: true,
  ...over,
});

describe("answering a message in place", () => {
  it("says whom you reply to, can leave them unnotified, and sends what it answers", async () => {
    const original = message();
    const { box, send, user } = await renderConversation([{ message: original }]);
    expect(screen.getByRole("button", { name: "Reply in thread" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect(screen.getByText("Replying to")).toHaveTextContent("Replying to Priya Shah");
    expect(box).toHaveFocus();
    // Sending later cannot answer in place, so it is not offered meanwhile.
    await user.type(box, "On it");
    expect(screen.queryByRole("button", { name: "Send later" })).not.toBeInTheDocument();

    const notify = screen.getByRole("button", { name: "Notify Priya Shah" });
    expect(notify).toHaveAttribute("aria-pressed", "true");
    await user.click(notify);
    expect(notify).toHaveAttribute("aria-pressed", "false");
    expect(await accessibilityProblems(document.body)).toEqual([]);

    await user.click(box);
    await user.keyboard("{Enter}");
    expect(send).toHaveBeenLastCalledWith(
      general.id,
      "On it",
      expect.objectContaining({
        replyTo: {
          id: original.id,
          userId: priya.id,
          text: original.text,
          fileCount: 0,
          deleted: false,
          ping: false,
        },
      }),
    );
    // One send answers it; the next is an ordinary message again.
    expect(screen.queryByText("Replying to")).not.toBeInTheDocument();
    await user.type(box, "Next");
    expect(screen.getByRole("button", { name: "Send later" })).toBeInTheDocument();
  });

  it("is cancelled by Escape or its close button, and Shift leaves the author unnotified", async () => {
    const { box, user } = await renderConversation([{ message: message() }]);
    await user.click(screen.getByRole("button", { name: "Reply" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Replying to")).not.toBeInTheDocument();

    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("button", { name: "Reply" }));
    await user.keyboard("{/Shift}");
    expect(screen.getByRole("button", { name: "Notify Priya Shah" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await user.click(screen.getByRole("button", { name: "Cancel reply" }));
    expect(screen.queryByText("Replying to")).not.toBeInTheDocument();
    expect(box).toHaveFocus();
  });

  it("offers no notification toggle when you answer yourself", async () => {
    const { user } = await renderConversation([{ message: message({ userId: sam.id }) }]);
    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect(screen.getByText("Replying to")).toHaveTextContent("Replying to Sam Rivera");
    expect(screen.queryByRole("button", { name: /^Notify/ })).not.toBeInTheDocument();
  });

  it("answers a reply inside its thread from the thread's own box", async () => {
    const root = message({ id: "M_ROOT" });
    const inThread = message({ id: "M_IN", threadRootId: root.id, text: "Checking now" });
    const { user } = await renderConversation(
      [
        { message: root, inThread: true },
        { message: inThread, inThread: true },
      ],
      { threadRootId: root.id },
    );
    // The thread's first message is the thread: there is nothing to answer in place.
    const [rootRow, replyRow] = screen.getAllByRole("article");
    expect(within(rootRow!).queryByRole("button", { name: "Reply" })).not.toBeInTheDocument();
    await user.click(within(replyRow!).getByRole("button", { name: "Reply" }));
    const aside = screen.getByRole("complementary");
    expect(within(aside).getByText("Replying to")).toHaveTextContent("Replying to Priya Shah");
    expect(within(aside).getByRole("textbox", { name: "Reply…" })).toHaveFocus();
    expect(within(screen.getByRole("main")).queryByText("Replying to")).not.toBeInTheDocument();
  });

  it("is not offered by a server that would post it as an ordinary message", async () => {
    const { user } = await renderConversation([{ message: message() }], { inlineReplies: false });
    expect(screen.queryByRole("button", { name: "Reply" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Actions for message from Priya Shah" }));
    expect(screen.queryByRole("menuitem", { name: "Reply" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Reply in thread" })).toBeInTheDocument();
  });
});

describe("a reply's quote", () => {
  it("names the author and how it began, and shows the original in place", async () => {
    const original = message({ id: "M_0", text: "Who is on call this week?" });
    const reply = message({ id: "M_2", userId: sam.id, text: "Me", replyTo: quote() });
    const openMessage = vi.fn();
    const { user } = await renderConversation([{ message: original }, { message: reply }], {
      openMessage,
    });
    const shown = screen.getAllByRole("article")[0]!;
    shown.scrollIntoView = vi.fn();
    await user.click(
      // jsdom drops the spaces a browser reads between these spans.
      screen.getByRole("button", {
        name: /^Replying to ?@Priya Shah ?Who is on call this week\?$/,
      }),
    );
    expect(shown.scrollIntoView).toHaveBeenCalled();
    expect(shown).toHaveClass("reply-flash");
    expect(openMessage).not.toHaveBeenCalled();
  });

  it("jumps to an original that is not on screen", async () => {
    const reply = message({ id: "M_2", userId: sam.id, text: "Me", replyTo: quote() });
    const openMessage = vi.fn();
    const { user } = await renderConversation([{ message: reply }], { openMessage });
    await user.click(screen.getByRole("button", { name: /Replying to ?@Priya Shah/ }));
    expect(openMessage).toHaveBeenCalledWith(general.id, "M_0");
  });

  it("says when the original was deleted, with nothing to open", async () => {
    const gone = quote({ userId: "", text: "", deleted: true });
    await renderConversation([{ message: message({ id: "M_2", replyTo: gone }) }]);
    expect(screen.getByText("The original message was deleted")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /original message/ })).not.toBeInTheDocument();
  });

  it("says a picture sent alone was sent, rather than nothing", async () => {
    await renderConversation([
      { message: message({ id: "M_2", replyTo: quote({ text: "", fileCount: 2 }) }) },
    ]);
    expect(
      screen.getByRole("button", { name: /Replying to ?@Priya Shah ?Sent 2 files/ }),
    ).toBeInTheDocument();
  });

  it("marks a reply that notified you as a mention does", async () => {
    await renderConversation([
      { message: message({ id: "M_2", replyTo: quote({ userId: sam.id }) }) },
      { message: message({ id: "M_3", replyTo: quote({ userId: sam.id, ping: false }) }) },
    ]);
    const [notified, quiet] = screen.getAllByRole("article");
    expect(notified).toHaveClass("bg-mention");
    expect(quiet).not.toHaveClass("bg-mention");
  });

  it("reads names and labels on one line, without formatting marks", () => {
    const users = { [priya.id]: priya };
    const channels = { [general.id]: general };
    expect(
      quoteLine(
        `*Ship it*, <@${priya.id}>!\nSee <#${general.id}> and <https://example.com|the doc>; keep snake_case_names.`,
        users,
        channels,
      ),
    ).toBe("Ship it, @Priya Shah! See #general and the doc; keep snake_case_names.");
  });
});
