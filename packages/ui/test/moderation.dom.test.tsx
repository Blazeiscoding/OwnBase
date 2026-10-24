import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@slackoss/client-core";
import type { Channel, HuddleRing, Message, ReportedMessage, User } from "@slackoss/protocol";
import { ClientContext, OpenMessageContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";
import { MessageItem } from "../src/components/MessageItem.js";
import { ProfileDialog } from "../src/components/ProfileDialog.js";
import { Sidebar } from "../src/components/Sidebar.js";
import { IncomingCall } from "../src/components/IncomingCall.js";
import { BlockedComposer, BlockedPeople } from "../src/components/Blocking.js";
import { ReportsDialog } from "../src/components/ReportsDialog.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
import { accessibilityProblems } from "./accessibility.js";

vi.mock("../src/lib/callPreferences.js", async (original) => ({
  ...(await original<typeof import("../src/lib/callPreferences.js")>()),
  useCallPreferences: () => ({ joinHuddle: vi.fn(), devices: {} }),
}));
vi.mock("../src/lib/ringTone.js", () => ({ startRingTone: () => () => {} }));

/**
 * Blocking and reporting in the app (E12): a blocked person's messages fold
 * away, their DM leaves the sidebar, their rings stay silent, and they are
 * blocked and unblocked from their card or Account settings; a message is
 * reported from its menu, and admins settle reports in their own dialog.
 */
const person = (id: string, displayName: string, over: Partial<User> = {}): User => ({
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
  ...over,
});
const sam = person("U_SAM", "Sam Rivera", { role: "owner" });
const maya = person("U_MAYA", "Maya Chen");
const lee = person("U_LEE", "Lee Park");
const room = (id: string, type: Channel["type"], name: string, memberIds?: string[]): Channel => ({
  id,
  type,
  name,
  topic: "",
  description: "",
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
  ...(memberIds ? { memberIds } : {}),
});
const general = room("C_GENERAL", "public", "general");
const withMaya = room("C_MAYA", "dm", "", ["U_SAM", "U_MAYA"]);
const withLee = room("C_LEE", "dm", "", ["U_SAM", "U_LEE"]);
const group = room("C_GROUP", "group_dm", "", ["U_SAM", "U_MAYA", "U_LEE"]);
const message = (over: Partial<Message> = {}): Message => ({
  id: "M_1",
  channelId: "C_GENERAL",
  userId: "U_MAYA",
  text: "You will regret that.",
  threadRootId: null,
  broadcast: false,
  seq: 7,
  createdAt: Date.UTC(2026, 9, 24, 9, 30),
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

const clients: WorkspaceClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
});

/** A client over Sam's workspace; `blocked` null is a server that neither blocks nor takes reports. */
function workspace(blocked: string[] | null = [], self: User = sam) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({
    self,
    users: { U_SAM: sam, U_MAYA: maya, U_LEE: lee },
    channels: { C_GENERAL: general, C_MAYA: withMaya, C_LEE: withLee, C_GROUP: group },
    memberships: { C_GENERAL: 0, C_MAYA: 0, C_LEE: 0, C_GROUP: 0 },
    channelLastSeq: { C_GENERAL: 0, C_MAYA: 4, C_LEE: 0, C_GROUP: 0 },
    status: "online",
    workspaceName: "Rocket Team",
    blocked,
    openReports: self.role === "member" ? null : 0,
  });
  const shown = (ui: React.ReactNode) =>
    render(
      <ToastProvider>
        <ConfirmProvider>
          <PlatformContext.Provider value={platform}>
            <ClientContext.Provider value={client}>
              <OpenMessageContext.Provider value={vi.fn()}>{ui}</OpenMessageContext.Provider>
            </ClientContext.Provider>
          </PlatformContext.Provider>
        </ConfirmProvider>
      </ToastProvider>,
    );
  return { client, shown, user: userEvent.setup() };
}

describe("a message from someone blocked", () => {
  it("folds away until shown, keeping its place, and comes back as they are unblocked", async () => {
    const { client, shown, user } = workspace(["U_MAYA"]);
    const view = shown(<MessageItem message={message()} compact={false} />);
    const folded = screen.getByRole("article", { name: "Message from someone you blocked" });
    expect(folded).toHaveAttribute("data-message-id", "M_1");
    expect(screen.queryByText("You will regret that.")).toBeNull();
    expect(await accessibilityProblems(view.container)).toEqual([]);
    await user.click(within(folded).getByRole("button", { name: "Show" }));
    expect(screen.getByText("You will regret that.")).toBeVisible();

    cleanup();
    shown(<MessageItem message={message({ id: "M_2" })} compact={false} />);
    expect(screen.queryByText("You will regret that.")).toBeNull();
    act(() => client.store.setState({ blocked: [] }));
    expect(screen.getByText("You will regret that.")).toBeVisible();
  });
});

describe("reporting a message", () => {
  const openReport = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "Actions for message from Maya Chen" }));
    await user.click(screen.getByRole("menuitem", { name: "Report message…" }));
    return screen.findByRole("dialog", { name: "Report message" });
  };

  it("asks why, sends it with a note, and says the admins will look", async () => {
    const { client, shown, user } = workspace();
    const sent = vi.spyOn(client.api, "reportMessage").mockResolvedValue({ ok: true });
    shown(<MessageItem message={message()} compact={false} />);
    const dialog = within(await openReport(user));
    expect(dialog.getByText(/Maya Chen is not told/)).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "Send report" }));
    expect(dialog.getByRole("alert")).toHaveTextContent("Choose what is wrong with it.");
    expect(dialog.getByRole("radio", { name: /^Spam/ })).toHaveFocus();
    expect(sent).not.toHaveBeenCalled();
    expect(await accessibilityProblems(screen.getByRole("dialog"))).toEqual([]);

    await user.click(dialog.getByRole("radio", { name: /^Harassment or bullying/ }));
    await user.type(dialog.getByLabelText(/Anything to add/), "Third time this week");
    await user.click(dialog.getByRole("button", { name: "Send report" }));
    expect(sent).toHaveBeenCalledWith("M_1", "harassment", "Third time this week");
    expect(
      await screen.findByText("Reported. The workspace's admins will look at it."),
    ).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Report message" })).toBeNull();
  });

  it("stays open and says so when the report did not go", async () => {
    const { client, shown, user } = workspace();
    vi.spyOn(client.api, "reportMessage").mockRejectedValue(new ApiError(404, "message_not_found"));
    shown(<MessageItem message={message()} compact={false} />);
    const dialog = within(await openReport(user));
    await user.click(dialog.getByRole("radio", { name: /^Spam/ }));
    await user.click(dialog.getByRole("button", { name: "Send report" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "That message is gone, so there is nothing to report.",
    );
  });

  it("is not offered for your own message, or by a server that takes no reports", async () => {
    const own = workspace();
    own.shown(<MessageItem message={message({ userId: "U_SAM" })} compact={false} />);
    await own.user.click(
      screen.getByRole("button", { name: "Actions for message from Sam Rivera" }),
    );
    expect(screen.queryByRole("menuitem", { name: "Report message…" })).toBeNull();
    cleanup();

    const older = workspace(null);
    older.shown(<MessageItem message={message()} compact={false} />);
    await older.user.click(
      screen.getByRole("button", { name: "Actions for message from Maya Chen" }),
    );
    expect(screen.queryByRole("menuitem", { name: "Report message…" })).toBeNull();
  });
});

describe("blocking from someone's card", () => {
  it("asks first, then says they are blocked and offers to unblock", async () => {
    const { client, shown, user } = workspace();
    const setBlocked = vi.spyOn(client, "setBlocked").mockImplementation(async (id, blocked) => {
      client.store.setState({ blocked: blocked ? [id] : [] });
      return true;
    });
    shown(<ProfileDialog userId="U_MAYA" onClose={vi.fn()} onOpenDm={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Block Maya Chen" }));
    const asking = screen.getByRole("dialog", { name: "Block Maya Chen?" });
    expect(asking).toHaveTextContent(/They are not told/);
    await user.click(within(asking).getByRole("button", { name: "Cancel" }));
    expect(setBlocked).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Block Maya Chen" }));
    await user.click(screen.getByRole("button", { name: "Block" }));
    expect(setBlocked).toHaveBeenCalledWith("U_MAYA", true);
    expect(await screen.findByText(/You blocked Maya Chen/)).toBeVisible();
    // No friending someone blocked.
    expect(screen.queryByRole("button", { name: /friend/i })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Unblock Maya Chen" }));
    expect(setBlocked).toHaveBeenLastCalledWith("U_MAYA", false);
  });

  it("says when the block did not take, and is not offered by an older server", async () => {
    const { client, shown, user } = workspace();
    vi.spyOn(client, "setBlocked").mockResolvedValue(false);
    shown(<ProfileDialog userId="U_MAYA" onClose={vi.fn()} onOpenDm={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Block Maya Chen" }));
    await user.click(screen.getByRole("button", { name: "Block" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not block Maya Chen.");
    cleanup();
    workspace(null).shown(<ProfileDialog userId="U_MAYA" onClose={vi.fn()} onOpenDm={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Block Maya Chen" })).toBeNull();
  });
});

describe("a direct message with someone blocked", () => {
  function sidebar(blocked: string[]) {
    const { shown } = workspace(blocked);
    shown(
      <Sidebar
        activeChannelId="C_GENERAL"
        onSelect={vi.fn()}
        onBrowseChannels={vi.fn()}
        onNewChannel={vi.fn()}
        onNewDm={vi.fn()}
        onFriends={vi.fn()}
        onSearch={vi.fn()}
        onSaved={vi.fn()}
        onActivity={vi.fn()}
        onThreads={vi.fn()}
        onEditProfile={vi.fn()}
        onInvite={vi.fn()}
        onSwitchWorkspace={vi.fn()}
        onAccountSettings={vi.fn()}
        connectionLabel={null}
      />,
    );
    return screen.getByRole("navigation");
  }

  it("leaves the sidebar, its unread uncounted, while a group with them stays", () => {
    const conversation = (nav: HTMLElement, id: string) =>
      nav.querySelector(`[data-conversation="${id}"]`);
    const before = sidebar([]);
    expect(conversation(before, "C_MAYA")).not.toBeNull();
    // Maya's DM has a message unread.
    expect(within(before).getByRole("img", { name: "Unread conversations" })).toBeVisible();
    cleanup();
    const after = sidebar(["U_MAYA"]);
    expect(conversation(after, "C_MAYA")).toBeNull();
    expect(within(after).queryByRole("img", { name: "Unread conversations" })).toBeNull();
    expect(conversation(after, "C_LEE")).not.toBeNull();
    expect(conversation(after, "C_GROUP")).not.toBeNull();
  });

  it("offers Unblock in place of the composer", async () => {
    const { client, shown, user } = workspace(["U_MAYA"]);
    const setBlocked = vi.spyOn(client, "setBlocked").mockResolvedValue(false);
    shown(<BlockedComposer userId="U_MAYA" />);
    expect(screen.getByText(/You blocked Maya Chen/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Unblock" }));
    expect(setBlocked).toHaveBeenCalledWith("U_MAYA", false);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not unblock Maya Chen.");
  });

  it("never rings", () => {
    const ring: HuddleRing = {
      channelId: "C_MAYA",
      callerId: "U_MAYA",
      startedAt: 1,
      endsAt: 30_001,
      ringing: ["U_SAM"],
      answered: [],
      declined: [],
    };
    const { client, shown } = workspace(["U_MAYA"]);
    act(() => client.store.setState({ rings: { C_MAYA: ring } }));
    shown(<IncomingCall onOpen={vi.fn()} preview="full" tag="sam" />);
    expect(screen.queryByRole("region", { name: "Maya Chen is calling" })).toBeNull();
    act(() => client.store.setState({ blocked: [] }));
    expect(screen.getByRole("region", { name: "Maya Chen is calling" })).toBeVisible();
  });
});

describe("blocked people in Account settings", () => {
  it("lists them with Unblock, and says when there are none", async () => {
    const { client, shown, user } = workspace(["U_MAYA", "U_LEE"]);
    const setBlocked = vi.spyOn(client, "setBlocked").mockResolvedValue(true);
    shown(<BlockedPeople />);
    const list = screen.getByRole("list", { name: "Blocked people" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    await user.click(within(list).getByRole("button", { name: "Unblock Lee Park" }));
    expect(setBlocked).toHaveBeenCalledWith("U_LEE", false);
    act(() => client.store.setState({ blocked: [] }));
    expect(screen.getByText(/You have not blocked anyone/)).toBeVisible();
  });

  it("is not there on a server that does not block", () => {
    workspace(null).shown(<BlockedPeople />);
    expect(screen.queryByRole("heading", { name: "Blocked people" })).toBeNull();
  });
});

describe("the admins' reported messages", () => {
  const reported = (over: Partial<ReportedMessage> = {}): ReportedMessage => ({
    messageId: "M_1",
    authorId: "U_MAYA",
    message: message({ channelId: "C_MAYA" }),
    channel: withMaya,
    reports: [
      {
        id: "R1",
        reporterId: "U_LEE",
        reason: "harassment",
        note: "Not the first time",
        createdAt: 1,
      },
    ],
    ...over,
  });

  it("shows each with where it was, who reported it and why, and settles it", async () => {
    const { client, shown, user } = workspace();
    const list = vi.spyOn(client.api, "listReports").mockResolvedValue({ reports: [reported()] });
    const resolve = vi.spyOn(client.api, "resolveReport").mockResolvedValue({ ok: true });
    const view = shown(<ReportsDialog onClose={vi.fn()} />);
    const item = within(
      await screen.findByRole("listitem", {
        name: "Maya Chen's message in Direct message: Sam Rivera, Maya Chen",
      }),
    );
    expect(item.getByText("You will regret that.")).toBeVisible();
    expect(item.getByText(/Harassment or bullying/)).toBeVisible();
    expect(item.getByText(/Not the first time/)).toBeVisible();
    expect(await accessibilityProblems(view.container)).toEqual([]);

    await user.click(item.getByRole("button", { name: "Remove and deactivate Maya Chen" }));
    const asking = screen.getByRole("dialog", { name: "Remove it and deactivate Maya Chen?" });
    await user.click(within(asking).getByRole("button", { name: "Cancel" }));
    expect(resolve).not.toHaveBeenCalled();

    await user.click(item.getByRole("button", { name: "Dismiss" }));
    expect(resolve).toHaveBeenCalledWith("M_1", "dismiss");
    expect(await screen.findByText("Dismissed. The message stays.")).toBeVisible();
    expect(await screen.findByText(/Nothing is waiting/)).toBeVisible();
    // Asked again whenever the count moves, as when someone reports another.
    list.mockResolvedValue({
      reports: [
        reported({ messageId: "M_9", message: message({ id: "M_9", text: "Spam again" }) }),
      ],
    });
    act(() => client.store.setState({ openReports: 1 }));
    expect(await screen.findByText("Spam again")).toBeVisible();
  });

  it("offers no deactivation that would be refused: of oneself, the owner, or another admin", async () => {
    const ada = person("U_ADA", "Ada Admin", { role: "admin" });
    const odin = person("U_ODIN", "Odin Admin", { role: "admin" });
    const { client, shown } = workspace([], ada);
    act(() =>
      client.store.setState({ users: { ...client.state.users, U_ADA: ada, U_ODIN: odin } }),
    );
    const by = (id: string, authorId: string) =>
      reported({
        messageId: id,
        authorId,
        message: message({ id, userId: authorId }),
        channel: general,
      });
    vi.spyOn(client.api, "listReports").mockResolvedValue({
      reports: [by("M_A", "U_ADA"), by("M_S", "U_SAM"), by("M_O", "U_ODIN"), by("M_L", "U_LEE")],
    });
    shown(<ReportsDialog onClose={vi.fn()} />);
    for (const name of ["Ada Admin", "Sam Rivera", "Odin Admin"]) {
      const item = within(
        await screen.findByRole("listitem", { name: new RegExp(`^${name}'s message`) }),
      );
      expect(item.queryByRole("button", { name: /deactivate/i })).toBeNull();
    }
    const lee = within(screen.getByRole("listitem", { name: /^Lee Park's message/ }));
    expect(lee.getByRole("button", { name: "Remove and deactivate Lee Park" })).toBeVisible();
  });

  it("removes a message after asking, and offers no deactivation that would be refused", async () => {
    const { client, shown, user } = workspace();
    const admin = person("U_ADA", "Ada Admin", { role: "admin" });
    act(() => client.store.setState({ users: { ...client.state.users, U_ADA: admin } }));
    vi.spyOn(client.api, "listReports").mockResolvedValue({
      reports: [
        reported(),
        reported({
          messageId: "M_2",
          authorId: "U_SAM",
          message: message({ id: "M_2", userId: "U_SAM" }),
          channel: general,
        }),
        reported({ messageId: "M_3", authorId: "U_LEE", message: null, channel: general }),
      ],
    });
    const resolve = vi.spyOn(client.api, "resolveReport").mockResolvedValue({ ok: true });
    shown(<ReportsDialog onClose={vi.fn()} />);
    const own = within(
      await screen.findByRole("listitem", { name: /^Sam Rivera's message in #general/ }),
    );
    expect(own.queryByRole("button", { name: /deactivate/i })).toBeNull();
    const deleted = within(screen.getByRole("listitem", { name: /^Lee Park's message/ }));
    expect(deleted.getByText("Its author deleted it.")).toBeVisible();
    expect(deleted.queryByRole("button", { name: "Remove message" })).toBeNull();
    expect(deleted.getByRole("button", { name: "Deactivate Lee Park" })).toBeVisible();

    const theirs = within(screen.getByRole("listitem", { name: /^Maya Chen's message/ }));
    await user.click(theirs.getByRole("button", { name: "Remove message" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Remove this message?" })).getByRole("button", {
        name: "Remove",
      }),
    );
    expect(resolve).toHaveBeenCalledWith("M_1", "remove");
    expect(await screen.findByText("Maya Chen's message is removed.")).toBeVisible();
    expect(screen.queryByRole("listitem", { name: /^Maya Chen's message/ })).toBeNull();
  });

  it("says what went wrong when a report could not be settled", async () => {
    const { client, shown, user } = workspace();
    vi.spyOn(client.api, "listReports").mockResolvedValue({ reports: [reported()] });
    vi.spyOn(client.api, "resolveReport").mockRejectedValue(new ApiError(403, "admin_only"));
    shown(<ReportsDialog onClose={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You no longer have permission to manage accounts.",
    );
  });
});

describe("the workspace menu", () => {
  function menu(waiting: number | null, onReview?: () => void) {
    const { shown } = workspace();
    shown(
      <Sidebar
        activeChannelId="C_GENERAL"
        onSelect={vi.fn()}
        onBrowseChannels={vi.fn()}
        onNewChannel={vi.fn()}
        onNewDm={vi.fn()}
        onFriends={vi.fn()}
        onSearch={vi.fn()}
        onSaved={vi.fn()}
        onActivity={vi.fn()}
        onThreads={vi.fn()}
        onEditProfile={vi.fn()}
        onInvite={vi.fn()}
        onSwitchWorkspace={vi.fn()}
        onAccountSettings={vi.fn()}
        onManagePeople={vi.fn()}
        reportsWaiting={waiting}
        onReviewReports={onReview}
        connectionLabel={null}
      />,
    );
  }

  it("leads admins to reported messages, saying how many wait", async () => {
    const onReview = vi.fn();
    menu(2, onReview);
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", {
        name: "Rocket Team, workspace menu, 2 reported messages waiting",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: /^Reported messages/ }));
    expect(onReview).toHaveBeenCalled();
    cleanup();
    menu(null);
    await user.click(screen.getByRole("button", { name: "Rocket Team, workspace menu" }));
    expect(screen.queryByRole("menuitem", { name: /^Reported messages/ })).toBeNull();
  });
});
