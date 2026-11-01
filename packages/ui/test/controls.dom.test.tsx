import { describe, expect, it, vi } from "vitest";
import { cleanup, act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient, type HuddleState } from "@ownbase/client-core";
import type { Channel, Message, User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { webPlatform } from "../src/platform.js";
import { HuddleBar } from "../src/components/HuddleBar.js";
import { MessageItem } from "../src/components/MessageItem.js";
import { Sidebar } from "../src/components/Sidebar.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
import { accessibilityProblems } from "./accessibility.js";

/** Where call preferences are kept, as in the app. */
const platform = webPlatform();

/** Emoji and pictographs, which used to stand in for the drawn icons. */
const PICTOGRAPH = /\p{Extended_Pictographic}/u;

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

/** A workspace client that never connects, holding the replica a test gives it. */
function offlineClient() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { U_SAM: sam, U_PRIYA: priya },
    status: "online",
    workspaceName: "Rocket Team",
  });
  return client;
}

describe("the huddle bar", () => {
  function huddleBar(state: Partial<HuddleState> = {}) {
    const client = offlineClient();
    client.store.setState({
      channels: { C_GENERAL: room("C_GENERAL", "public", "general") },
      huddle: {
        channelId: "C_GENERAL",
        micMuted: false,
        cameraOn: false,
        sharingScreen: false,
        localCameraStream: null,
        localScreenStream: null,
        speaking: false,
        micLost: false,
        peers: [
          {
            userId: "U_PRIYA",
            audioStream: null,
            cameraStream: null,
            screenStream: null,
            connected: true,
            micMuted: true,
            speaking: false,
          },
        ],
        ...state,
      },
    });
    const calls = {
      mic: vi.spyOn(client, "toggleMic").mockImplementation(() => {}),
      leave: vi.spyOn(client, "leaveHuddle").mockImplementation(() => {}),
    };
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <HuddleBar />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    return { client, calls, user: userEvent.setup() };
  }

  it("says the call goes on while the connection to the workspace is down", () => {
    const { client } = huddleBar();
    const line = /connection to the workspace dropped/;
    expect(screen.queryByText(line)).toBeNull();
    act(() => client.store.setState({ status: "reconnecting" }));
    expect(
      screen.getByText(
        "The connection to the workspace dropped. You stay in the call while it comes back.",
      ),
    ).toHaveAttribute("role", "status");
    act(() => client.store.setState({ status: "online" }));
    expect(screen.queryByText(line)).toBeNull();
  });

  it("says who it cannot connect to, once it has tried long enough, and offers why", async () => {
    const { client, user } = huddleBar();
    const onShowCallLog = vi.fn();
    const stuck = (trouble: "needs_relay" | null) =>
      act(() =>
        client.store.setState((s) => ({
          huddle: {
            ...s.huddle!,
            peers: [{ ...s.huddle!.peers[0]!, connected: false, micMuted: false, trouble }],
          },
        })),
      );
    cleanup();
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <HuddleBar onShowCallLog={onShowCallLog} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    stuck(null);
    const status = within(screen.getByRole("region", { name: "Active huddle" })).getByRole(
      "status",
    );
    expect(status).toHaveTextContent("With Priya Shah · Connecting…");
    expect(screen.queryByRole("button", { name: "Why? See the call log" })).toBeNull();
    stuck("needs_relay");
    expect(status).toHaveTextContent("Can't connect to Priya Shah · Trying again");
    await user.click(screen.getByRole("button", { name: "Why? See the call log" }));
    expect(onShowCallLog).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Everyone in the huddle (2)" }));
    expect(screen.getByRole("listitem", { name: "Priya Shah, can't connect" })).toBeVisible();
  });

  it("names each control for what it controls, and says whether it is on without renaming it", () => {
    const { client } = huddleBar();
    const controls = screen.getByRole("group", { name: "Huddle controls" });
    const toggles = ["Mute microphone", "Camera", "Share screen"];
    for (const name of toggles)
      expect(within(controls).getByRole("button", { name, pressed: false })).toBeInTheDocument();
    const mute = within(controls).getByRole("button", { name: "Mute microphone" });
    const camera = within(controls).getByRole("button", { name: "Camera" });
    const share = within(controls).getByRole("button", { name: "Share screen" });
    for (const control of [mute, camera, share]) expect(control).not.toHaveAttribute("title");
    act(() => mute.focus());
    expect(mute).toHaveAccessibleDescription("Mute. Shortcut: Ctrl Shift Space");
    act(() => camera.focus());
    expect(camera).toHaveAccessibleDescription("Turn your camera on");

    act(() =>
      client.store.setState((s) => ({
        huddle: { ...s.huddle!, micMuted: true, cameraOn: true, sharingScreen: true },
      })),
    );
    // A screen reader hears the same control, now pressed, not a different one.
    for (const name of toggles)
      expect(within(controls).getByRole("button", { name, pressed: true })).toBeInTheDocument();
    act(() => mute.focus());
    expect(mute).toHaveAccessibleDescription("Unmute. Shortcut: Ctrl Shift Space");
    // Each device menu opens from a small arrow of its own beside its toggle.
    expect(
      within(controls)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label") ?? b.textContent),
    ).toEqual([
      "Mute microphone",
      "Microphone and speaker",
      "Camera",
      "Camera options",
      "Share screen",
      "Leave",
    ]);
  });

  it("says who is in the huddle, and offers Leave in words", async () => {
    const { calls, user } = huddleBar();
    const region = screen.getByRole("region", { name: "Active huddle" });
    expect(within(region).getByRole("status")).toHaveTextContent(/^With Priya Shah$/);
    expect(await accessibilityProblems(region)).toEqual([]);

    // The faces are too small to tell people apart, so they open everyone by name.
    const everyone = within(region).getByRole("button", { name: "Everyone in the huddle (2)" });
    await user.click(everyone);
    expect(everyone).toHaveAttribute("aria-expanded", "true");
    const roster = screen.getByRole("dialog", { name: "Everyone in the huddle" });
    const people = within(roster).getByRole("list", { name: "In the huddle" });
    expect(
      within(people)
        .getAllByRole("listitem")
        .map((row) => row.getAttribute("aria-label")),
    ).toEqual(["You", "Priya Shah, muted"]);
    expect(await accessibilityProblems(roster)).toEqual([]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Everyone in the huddle" })).toBeNull();

    await user.click(within(region).getByRole("button", { name: "Mute microphone" }));
    expect(calls.mic).toHaveBeenCalledOnce();
    await user.click(within(region).getByRole("button", { name: "Leave" }));
    expect(calls.leave).toHaveBeenCalledOnce();
    expect(region).not.toHaveTextContent(PICTOGRAPH);
    expect(await accessibilityProblems(region)).toEqual([]);
  });
});

/** Chooses one of a message's less frequent actions, from its More actions menu. */
async function choose(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getAllByRole("button", { name: "More actions" })[0]!);
  await user.click(screen.getByRole("menuitem", { name }));
}

describe("message actions", () => {
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
    replyCount: 0,
    reactions: [],
    files: [],
    pinned: true,
    actions: [],
  };

  function messageItem() {
    const client = offlineClient();
    const deleteMessage = vi.spyOn(client.api, "deleteMessage").mockResolvedValue({ ok: true });
    client.store.setState({
      channels: { C_GENERAL: room("C_GENERAL", "public", "general") },
      saved: { M_1: true },
    });
    render(
      <ToastProvider>
        <ConfirmProvider>
          <PlatformContext.Provider value={platform}>
            <ClientContext.Provider value={client}>
              <MessageItem message={message} compact={false} onOpenThread={vi.fn()} />
            </ClientContext.Provider>
          </PlatformContext.Provider>
        </ConfirmProvider>
      </ToastProvider>,
    );
    return { client, deleteMessage };
  }

  it("names every action, since each one shows only an icon", async () => {
    messageItem();
    const profile = screen.getByRole("button", { name: "View Sam Rivera's profile" });
    expect(profile).not.toHaveAttribute("title");
    act(() => profile.focus());
    expect(profile).toHaveAccessibleDescription("View Sam Rivera's profile");
    const toolbar = screen.getByRole("button", { name: "Reply in thread" }).parentElement!;
    // What a message is answered with most stays in sight; the rest is one menu away.
    // With the key that does the same on a focused message, where there is one.
    const shortcuts: Record<string, string> = {
      "Add a reaction": "R",
      "Reply in thread": "T",
      "Remove from Saved": "A",
      "Edit message": "E",
    };
    const named = [
      "Add a reaction",
      "Reply in thread",
      "Remove from Saved",
      "Edit message",
      "More actions",
    ];
    for (const name of named) {
      const action = within(toolbar).getByRole("button", { name });
      act(() => action.focus());
      expect(action).toHaveAccessibleDescription(
        shortcuts[name] ? `${name}. Shortcut: ${shortcuts[name]}` : name,
      );
      expect(action).not.toHaveAttribute("title");
    }
    // The rest are the quick reactions, which are emoji on purpose.
    const reactions = within(toolbar)
      .getAllByRole("button")
      .filter((button) => PICTOGRAPH.test(button.textContent ?? ""));
    expect(reactions).toHaveLength(3);
    expect(within(toolbar).getAllByRole("button")).toHaveLength(named.length + reactions.length);
    expect(await accessibilityProblems(toolbar)).toEqual([]);

    await userEvent.setup().click(within(toolbar).getByRole("button", { name: "More actions" }));
    expect(
      within(screen.getByRole("menu", { name: "More actions" }))
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Copy link to message",
      // Each with its key as a keycap after the name.
      "Mark unread from this messageU",
      "Unpin from channelP",
      "Delete messageDelete",
    ]);
  });

  it("says a message is pinned or saved in words, without an emoji in front", () => {
    messageItem();
    // An exact match: "📌 Pinned to this channel" would not be found.
    expect(screen.getByText("Pinned to this channel")).toBeInTheDocument();
    expect(screen.getByText("Saved for later")).toBeInTheDocument();
  });

  it("deletes only after the shared confirmation is accepted", async () => {
    const user = userEvent.setup();
    const { deleteMessage } = messageItem();
    await choose(user, "Delete message");

    const question = screen.getByRole("dialog", { name: "Delete this message?" });
    expect(question).toHaveTextContent(/Everyone in the conversation stops seeing it/);
    expect(deleteMessage).not.toHaveBeenCalled();
    await user.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(deleteMessage).not.toHaveBeenCalled();

    await choose(user, "Delete message");
    await user.click(
      within(screen.getByRole("dialog", { name: "Delete this message?" })).getByRole("button", {
        name: "Delete",
      }),
    );
    expect(deleteMessage).toHaveBeenCalledWith("M_1");
  });

  it("keeps a failed deletion usable and says what happened", async () => {
    const user = userEvent.setup();
    const { deleteMessage } = messageItem();
    deleteMessage.mockRejectedValueOnce(new Error("offline"));

    await choose(user, "Delete message");
    await user.click(
      within(screen.getByRole("dialog", { name: "Delete this message?" })).getByRole("button", {
        name: "Delete",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Could not confirm whether the message was deleted/,
    );
    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: "Delete message" })).toBeEnabled();
  });

  it("says so when an optimistic toggle comes back undone, and offers it again", async () => {
    const user = userEvent.setup();
    const { client } = messageItem();
    const unpin = vi
      .spyOn(client.api, "unpinMessage")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ok: true });

    // The pin flips back on its own. Without the notice that revert is the
    // only sign anything happened, and the toolbar that started it is gone.
    await choose(user, "Unpin from channel");
    expect(await screen.findByText("Could not unpin that message.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(unpin).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Could not unpin that message.")).not.toBeInTheDocument();
  });
});

describe("channel rows", () => {
  it("say which channel is private, muted or in a huddle, which their icons alone would not", async () => {
    const client = offlineClient();
    client.store.setState({
      channels: {
        C_GENERAL: room("C_GENERAL", "public", "general"),
        C_LEADS: room("C_LEADS", "private", "leads"),
      },
      memberships: { C_GENERAL: 0, C_LEADS: 0 },
      prefs: { C_LEADS: { notifyLevel: "all", muted: true } },
      huddles: { C_GENERAL: ["U_PRIYA"] },
    });
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <Sidebar
            activeChannelId={null}
            onSelect={vi.fn()}
            onBrowseChannels={vi.fn()}
            onNewChannel={vi.fn()}
            onNewDm={vi.fn()}
            onFriends={vi.fn()}
            onSearch={vi.fn()}
            onSaved={vi.fn()}
            onScheduled={vi.fn()}
            onActivity={vi.fn()}
            onThreads={vi.fn()}
            onEditProfile={vi.fn()}
            onInvite={vi.fn()}
            onSwitchWorkspace={vi.fn()}
            onAccountSettings={vi.fn()}
            connectionLabel={null}
          />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const nav = screen.getByRole("navigation", { name: "Workspace navigation" });
    // jsdom lays nothing out, so it does not put the spaces between flex items
    // that a browser does; the names are matched with and without them.
    expect(
      within(nav).getByRole("button", { name: /^Private channel ?leads ?Muted$/ }),
    ).toBeVisible();
    // A public channel's mark is a drawn #, so its name is the channel's alone.
    expect(
      within(nav).getByRole("button", { name: /^# ?general ?Huddle with Priya Shah$/ }),
    ).toBeVisible();
    expect(within(nav).getByRole("button", { name: "New channel" })).toBeVisible();
    expect(within(nav).getByRole("button", { name: "New message" })).toBeVisible();
    expect(nav).not.toHaveTextContent(PICTOGRAPH);
    expect(await accessibilityProblems(nav)).toEqual([]);
  });
});
