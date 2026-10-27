import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, ThreadFollow, User } from "@ownbase/protocol";
import { ClientContext, OpenMessageContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";
import { MessageItem } from "../src/components/MessageItem.js";
import { ThreadPanel } from "../src/components/ThreadPanel.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";

/** Muting a thread (E3): from its header, and from its first message in the channel. */
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
  id: "M_ROOT",
  channelId: general.id,
  userId: priya.id,
  text: "Who is taking the release?",
  threadRootId: null,
  broadcast: false,
  seq: 7,
  createdAt: Date.UTC(2026, 9, 21, 9, 30),
  editedAt: null,
  nonce: null,
  replyCount: 2,
  reactions: [],
  files: [],
  pinned: false,
  actions: [],
  ...over,
});

/** A client whose server answers a mute as the real one does. */
function workspace(threadMutes = true, following = true) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  const root = message();
  const follow: ThreadFollow = {
    rootId: root.id,
    channelId: general.id,
    following,
    lastReadSeq: 9,
    lastSeq: 9,
    revision: 1,
  };
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam, [priya.id]: priya },
    channels: { [general.id]: general },
    memberships: { [general.id]: 9 },
    status: "online",
    threadMutes,
    threadFollows: { [root.id]: follow },
    threadPages: {
      [root.id]: {
        channelId: general.id,
        root,
        hasMoreOlder: false,
        hasMoreNewer: false,
        loading: false,
        loaded: true,
        error: null,
      },
    },
    threads: { [root.id]: [] },
  });
  vi.spyOn(client, "loadThread").mockResolvedValue(undefined);
  const setThreadMute = vi
    .spyOn(client.api, "setThreadMute")
    .mockImplementation(async (rootId, muted) => ({
      state: {
        ...follow,
        rootId,
        following: muted ? false : client.state.threadFollows[rootId]!.following,
        revision: Date.now(),
        ...(muted ? { muted: true as const } : {}),
      },
    }));
  return { client, root, setThreadMute, user: userEvent.setup() };
}

const platform: Platform = {
  kind: "web",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};

function tree(client: WorkspaceClient, children: React.ReactNode) {
  return (
    <PlatformContext.Provider value={platform}>
      <ToastProvider>
        <ConfirmProvider>
          <ClientContext.Provider value={client}>
            <OpenMessageContext.Provider value={vi.fn()}>{children}</OpenMessageContext.Provider>
          </ClientContext.Provider>
        </ConfirmProvider>
      </ToastProvider>
    </PlatformContext.Provider>
  );
}

const wrap = (client: WorkspaceClient, children: React.ReactNode) => render(tree(client, children));

afterEach(() => vi.restoreAllMocks());

describe("muting a thread from its panel", () => {
  const panel = (client: WorkspaceClient, rootId: string) =>
    wrap(
      client,
      <ThreadPanel
        channelId={general.id}
        rootId={rootId}
        onClose={() => {}}
        onChannelClick={() => {}}
        onOpenProfile={() => {}}
      />,
    );

  it("mutes it, which unfollows it, and unmutes it again", async () => {
    const { client, root, setThreadMute, user } = workspace();
    panel(client, root.id);
    const toggle = screen.getByRole("button", { name: "Mute thread" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Following" })).toBeVisible();

    await user.click(toggle);
    expect(setThreadMute).toHaveBeenLastCalledWith(root.id, true);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Follow" })).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle);
    expect(setThreadMute).toHaveBeenLastCalledWith(root.id, false);
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    // The header has it, so the thread's first message there does not.
    await user.click(screen.getByRole("button", { name: "More actions" }));
    const menu = await screen.findByRole("menu", { name: "More actions" });
    expect(within(menu).queryByRole("menuitem", { name: "Mute thread" })).toBeNull();
  });

  it("is not offered by a server that cannot keep a mute", () => {
    const { client, root } = workspace(false);
    panel(client, root.id);
    expect(screen.getByRole("button", { name: "Following" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Mute thread" })).toBeNull();
  });
});

describe("muting a thread from its first message", () => {
  const actions = (user: ReturnType<typeof userEvent.setup>) => async () => {
    await user.click(screen.getByRole("button", { name: "More actions" }));
    const menu = await screen.findByRole("menu", { name: "More actions" });
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    return { menu, items };
  };

  it("mutes from More actions, marks the reply count, and offers to unmute", async () => {
    const { client, root, setThreadMute, user } = workspace();
    wrap(client, <MessageItem message={root} compact={false} />);
    const open = actions(user);

    const { menu, items } = await open();
    expect(items).toContain("Mute thread");
    await user.click(within(menu).getByRole("menuitem", { name: "Mute thread" }));
    expect(setThreadMute).toHaveBeenLastCalledWith(root.id, true);
    expect(screen.getByRole("button", { name: "2 replies, muted" })).toBeVisible();

    const again = await open();
    expect(again.items).toContain("Unmute thread");
    expect(again.items).not.toContain("Mute thread");
    await user.click(within(again.menu).getByRole("menuitem", { name: "Unmute thread" }));
    expect(setThreadMute).toHaveBeenLastCalledWith(root.id, false);
    expect(screen.getByRole("button", { name: "2 replies" })).toBeVisible();
  });

  it("offers it on the touch menu too, and not on a message without replies or a reply", async () => {
    const { client, root, user } = workspace();
    const { rerender } = wrap(client, <MessageItem message={root} compact={false} />);
    const touch = async () => {
      await user.click(screen.getByRole("button", { name: "Actions for message from Priya Shah" }));
      const menu = screen.getByRole("menu", { name: "Actions for message from Priya Shah" });
      const items = within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent);
      await user.keyboard("{Escape}");
      return items;
    };
    expect(await touch()).toContain("Mute thread");

    const quiet = message({ id: "M_QUIET", replyCount: 0 });
    rerender(tree(client, <MessageItem message={quiet} compact={false} />));
    expect(await touch()).not.toContain("Mute thread");
    // Muted, it can be unmuted from there whatever replies it has left.
    act(() =>
      client.store.setState((s) => ({
        threadFollows: {
          ...s.threadFollows,
          [quiet.id]: { ...s.threadFollows[root.id]!, rootId: quiet.id, muted: true },
        },
      })),
    );
    expect(await touch()).toContain("Unmute thread");
    const answer = message({ id: "M_ANSWER", threadRootId: root.id, replyCount: 0 });
    rerender(tree(client, <MessageItem message={answer} compact={false} />));
    expect(await touch()).not.toContain("Mute thread");
  });

  it("is not offered by a server that cannot keep a mute", async () => {
    const { client, root, user } = workspace(false);
    wrap(client, <MessageItem message={root} compact={false} />);
    const { items } = await actions(user)();
    expect(items).not.toContain("Mute thread");
  });
});
