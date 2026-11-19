import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, User, UserGroup } from "@ownbase/protocol";
import { describe, expect, it, vi } from "vitest";
import { render } from "./render.js";
import { Composer } from "../src/components/Composer.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { MessageItem } from "../src/components/MessageItem.js";
import { ToastProvider } from "../src/components/Toast.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";
import { QUEUED } from "./sendAnswers.js";

/**
 * User groups in a conversation (J13): offered after `@` with how many people
 * each holds, sent as Slack's token, drawn as a chip that lists its people,
 * and marking a message that names a group the reader is in.
 */
const person = (id: string, handle: string, displayName: string, role: User["role"] = "member") =>
  ({
    id,
    handle,
    displayName,
    role,
    canInvite: true,
    statusText: "",
    statusEmoji: "",
    isBot: false,
    deactivated: false,
    dndUntil: null,
    createdAt: 0,
  }) satisfies User;

const sam = person("U_SAM", "sam", "Sam Rivera");
const priya = person("U_PRIYA", "priya", "Priya Shah");
const design: UserGroup = {
  id: "G_DESIGN",
  handle: "design",
  name: "Design",
  description: "Everyone who draws",
  memberIds: [sam.id, priya.id],
};
const writers: UserGroup = {
  id: "G_WRITERS",
  handle: "writers",
  name: "Writers",
  description: "",
  memberIds: [priya.id],
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

const message = (text: string, id = "M_1"): Message => ({
  id,
  channelId: general.id,
  userId: priya.id,
  text,
  threadRootId: null,
  broadcast: false,
  seq: 1,
  createdAt: 0,
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  previews: [],
  actions: [],
});

const platform: Platform = {
  kind: "web",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};

function renderWith(
  children: React.ReactNode,
  self: User = sam,
  drafts: Record<string, string> = {},
) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self,
    users: { [sam.id]: sam, [priya.id]: priya, [self.id]: self },
    channels: { [general.id]: general },
    memberships: { [general.id]: 0 },
    userGroups: { [design.id]: design, [writers.id]: writers },
    drafts,
    status: "online",
  });
  const send = vi.spyOn(client, "send").mockReturnValue(QUEUED);
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <ToastProvider>
          <ConfirmProvider>{children}</ConfirmProvider>
        </ToastProvider>
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  return { client, send, user: userEvent.setup() };
}

async function composer(self?: User, drafts?: Record<string, string>) {
  const rendered = renderWith(
    <Composer channelId={general.id} placeholder="Message #general" />,
    self,
    drafts,
  );
  const box = screen.getByRole("textbox", { name: "Message #general" }) as HTMLTextAreaElement;
  await waitFor(() => expect(box).toBeEnabled());
  return { ...rendered, box };
}

describe("a user group in the composer", () => {
  it("is offered after @ with how many people it holds, and sent as its token", async () => {
    const { box, send, user } = await composer();
    await user.type(box, "Review please @des");
    const option = screen.getByRole("option", { name: /@design/ });
    expect(option).toHaveTextContent("Design, 2 people");
    await user.keyboard("{Tab}");
    expect(box).toHaveValue("Review please @design ");
    await user.keyboard("{Enter}");
    expect(send.mock.lastCall?.[1]).toBe("Review please <!subteam^G_DESIGN|@design>");
  });

  it("shows a group in a draft by its handle now, keeping the token it was written with", async () => {
    const draft = "ask <!subteam^G_DESIGN|@old-name>";
    const { box, send, user } = await composer(sam, { [general.id]: draft });
    expect(box).toHaveValue("ask @design");
    await user.click(box);
    await user.keyboard("{Enter}");
    expect(send.mock.lastCall?.[1]).toBe(draft);
  });

  it("is not offered to a guest", async () => {
    const guest = person("U_GUEST", "guest-1", "Visitor", "guest");
    const { box, user } = await composer(guest);
    await user.type(box, "@");
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    expect(screen.queryByRole("option", { name: /@design|@writers/ })).not.toBeInTheDocument();
  });
});

describe("a user group in a message", () => {
  it("marks a message that names a group the reader is in now, and not another", () => {
    renderWith(
      <main>
        <MessageItem message={message("ask <!subteam^G_DESIGN|@design>")} compact={false} />
        <MessageItem
          message={message("ask <!subteam^G_WRITERS|@writers>", "M_2")}
          compact={false}
        />
      </main>,
    );
    const [mine, theirs] = screen.getAllByRole("article");
    expect(mine).toHaveClass("bg-mention");
    expect(theirs).not.toHaveClass("bg-mention");
  });

  it("opens the list of who is in it from its chip", async () => {
    const { user } = renderWith(
      <main>
        <MessageItem message={message("ask <!subteam^G_DESIGN|@design>")} compact={false} />
      </main>,
    );
    await user.click(screen.getByRole("button", { name: "@design" }));
    const list = await screen.findByRole("dialog", { name: "Who is in @design" });
    expect(within(list).getByText("Design")).toBeInTheDocument();
    expect(within(list).getByText("@design, 2 people")).toBeInTheDocument();
    expect(within(list).getByText("Priya Shah")).toBeInTheDocument();
    expect(within(list).getByText("Sam Rivera")).toBeInTheDocument();
  });
});
