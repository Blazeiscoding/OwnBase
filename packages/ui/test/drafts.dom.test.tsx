import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, ScheduledMessage, User } from "@ownbase/protocol";
import { ClientContext, OpenMessageContext, PlatformContext } from "../src/context.js";
import { DraftPersistence } from "../src/components/DraftPersistence.js";
import { DraftsPanel } from "../src/components/DraftsPanel.js";
import { MessageItem } from "../src/components/MessageItem.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
import { WorkspaceScreen } from "../src/screens/WorkspaceScreen.js";
import { draftPlace, listDrafts, readDraftTimes } from "../src/lib/drafts.js";
import { EDIT_REQUEST_MS, requestEdit } from "../src/lib/editRequest.js";
import { writeRoute } from "../src/lib/route.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/** Drafts (E5): every unsent draft on this device, newest first, opened where it was written. */
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
const room = (id: string, name: string): Channel => ({
  id,
  type: "public",
  name,
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
});
const general = room("C_GENERAL", "general");
const design = room("C_DESIGN", "design");
const dm: Channel = { ...room("C_DM", ""), type: "dm", memberIds: [sam.id, priya.id] };
const message = (id: string, text: string, userId = sam.id): Message => ({
  id,
  channelId: general.id,
  userId,
  text,
  threadRootId: null,
  broadcast: false,
  seq: 7,
  createdAt: Date.UTC(2026, 9, 21, 9, 30),
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  actions: [],
});
const release = message("M_RELEASE", "Ship the release notes");
const root = { ...message("M_ROOT", "Who has the Q3 numbers?", priya.id), seq: 6, replyCount: 1 };
const editDraft = JSON.stringify({ text: "Ship the release notes today", base: release.text });
const queued = {
  id: "S_STANDUP",
  channelId: design.id,
  userId: sam.id,
  text: "Standup moved to 10",
  threadRootId: null,
  fileIds: [],
  sendAt: Date.now() + 3_600_000,
  status: "queued",
  failureReason: null,
  attempts: 0,
  messageId: null,
} as unknown as ScheduledMessage;

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
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

/** Sam, with drafts kept on this device at the times given. */
function workspace(drafts: Record<string, string> = {}, times: Record<string, number> = {}) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam, [priya.id]: priya },
    channels: { [general.id]: general, [design.id]: design, [dm.id]: dm },
    memberships: { [general.id]: 9, [design.id]: 9, [dm.id]: 9 },
    status: "online",
    drafts,
    draftTimes: times,
  });
  return { client, user: userEvent.setup() };
}

const tree = (client: WorkspaceClient, children: React.ReactNode) => (
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

const hour = 3_600_000;
const now = Date.now();
/** One of each kind, written an hour apart: the edit last, the conversation's first. */
const fourDrafts = () =>
  workspace(
    {
      [design.id]: "Notes from the review",
      [`${general.id}:M_ROOT`]: "Agreed, <@U_PRIYA> has the numbers",
      [`${general.id}:edit:${release.id}`]: editDraft,
      [`${design.id}:scheduled-edit:${queued.id}`]: JSON.stringify({ text: "Standup moved to 11" }),
    },
    {
      [design.id]: now - 4 * hour,
      [`${general.id}:M_ROOT`]: now - 3 * hour,
      [`${design.id}:scheduled-edit:${queued.id}`]: now - 2 * hour,
      [`${general.id}:edit:${release.id}`]: now - hour,
    },
  );

describe("what a draft key names", () => {
  it("reads a conversation's, a thread's, and unsaved edits", () => {
    expect(draftPlace("C1")).toEqual({ kind: "conversation", channelId: "C1" });
    expect(draftPlace("C1:M1")).toEqual({ kind: "thread", channelId: "C1", rootId: "M1" });
    expect(draftPlace("C1:edit:M1")).toEqual({ kind: "edit", channelId: "C1", messageId: "M1" });
    expect(draftPlace("C1:scheduled-edit:S1")).toEqual({
      kind: "scheduled-edit",
      channelId: "C1",
      scheduledId: "S1",
    });
    for (const unknown of ["", "C1:", ":M1", "C1::M1", "C1:other:M1", "C1:edit:M1:more"])
      expect(draftPlace(unknown)).toBeNull();
  });

  it("lists the newest first, those with no time last, and leaves out what it cannot show", () => {
    const channels = { [general.id]: general, [design.id]: design };
    const entries = listDrafts(
      {
        C_LEFT: "a conversation no longer here",
        [general.id]: "untimed, from an earlier version",
        [design.id]: "older",
        [`${general.id}:edit:M1`]: "an edit kept as plain text",
        [`${general.id}:edit:M2`]: JSON.stringify({ text: "  ", base: "x" }),
        [`${design.id}:scheduled-edit:S1`]: "not what a scheduled edit is kept as",
        [`${design.id}:M_ROOT:extra`]: "a key this version does not know",
      },
      { C_LEFT: 9, [design.id]: 1, [`${general.id}:edit:M1`]: 2 },
      channels,
    );
    expect(entries.map((e) => [e.key, e.text])).toEqual([
      [`${general.id}:edit:M1`, "an edit kept as plain text"],
      [design.id, "older"],
      [general.id, "untimed, from an earlier version"],
    ]);
  });

  it("reads stored times, keeping only what reads as one", () => {
    expect(readDraftTimes({ C1: 5, C2: "6", C3: Number.NaN, C4: null })).toEqual({ C1: 5 });
    for (const unreadable of [null, undefined, [5], "5", 5])
      expect(readDraftTimes(unreadable)).toEqual({});
  });
});

describe("the Drafts panel", () => {
  it("lists every draft across conversations, newest first, saying where and what", async () => {
    const { client } = fourDrafts();
    client.setDraft(dm.id, "See you at six");
    const { container } = render(
      tree(client, <DraftsPanel onClose={() => {}} onOpen={() => {}} />),
    );
    const list = screen.getByRole("list", { name: "Drafts on this device" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getAllByRole("button")[0]!.textContent)).toEqual([
      expect.stringMatching(/^Priya Shah.*See you at six$/),
      expect.stringMatching(/^Editing a message in #general.*Ship the release notes today$/),
      expect.stringMatching(/^Editing a scheduled message in #design.*Standup moved to 11$/),
      // A mention reads as the name, not its markup.
      expect.stringMatching(/^Thread in #general.*Agreed, @Priya Shah has the numbers$/),
      expect.stringMatching(/^#design.*Notes from the review$/),
    ]);
    expect(within(rows[1]!).getByRole("time")).toBeTruthy();
    expect(await accessibilityProblems(container)).toEqual([]);
  });

  it("opens each where it was being written", async () => {
    const { client, user } = fourDrafts();
    const onOpen = vi.fn();
    render(tree(client, <DraftsPanel onClose={() => {}} onOpen={onOpen} />));
    for (const name of [/^Editing a message/, /^Editing a scheduled/, /^Thread in/, /^#design/])
      await user.click(screen.getByRole("button", { name }));
    expect(onOpen.mock.calls.map(([place]) => place)).toEqual([
      { kind: "edit", channelId: general.id, messageId: release.id },
      { kind: "scheduled-edit", channelId: design.id, scheduledId: queued.id },
      { kind: "thread", channelId: general.id, rootId: "M_ROOT" },
      { kind: "conversation", channelId: design.id },
    ]);
  });

  it("deletes one at once, and Undo puts it back in its place", async () => {
    const { client, user } = fourDrafts();
    render(tree(client, <DraftsPanel onClose={() => {}} onOpen={() => {}} />));
    const thread = screen.getByRole("button", { name: /^Thread in/ }).closest("li")!;
    await user.click(within(thread).getByRole("button", { name: "Delete draft" }));
    expect(client.state.drafts[`${general.id}:M_ROOT`]).toBeUndefined();
    expect(screen.queryByRole("button", { name: /^Thread in/ })).toBeNull();

    await user.click(await screen.findByRole("button", { name: "Undo" }));
    expect(client.state.drafts[`${general.id}:M_ROOT`]).toBe("Agreed, <@U_PRIYA> has the numbers");
    expect(client.state.draftTimes[`${general.id}:M_ROOT`]).toBe(now - 3 * hour);
    const rows = within(screen.getByRole("list", { name: "Drafts on this device" })).getAllByRole(
      "listitem",
    );
    expect(within(rows[2]!).getAllByRole("button")[0]).toHaveAccessibleName(/^Thread in/);

    // Written there again since: Undo leaves the new words alone.
    const design = screen.getByRole("button", { name: /^#design/ }).closest("li")!;
    await user.click(within(design).getByRole("button", { name: "Delete draft" }));
    act(() => client.setDraft("C_DESIGN", "Started again"));
    const undo = await screen.findAllByRole("button", { name: "Undo" });
    await user.click(undo.at(-1)!);
    expect(client.state.drafts.C_DESIGN).toBe("Started again");
  });

  it("deletes one for a double-click, though the next row's Delete slides under it", async () => {
    const { client, user } = fourDrafts();
    const onOpen = vi.fn();
    render(tree(client, <DraftsPanel onClose={() => {}} onOpen={onOpen} />));
    const thread = screen.getByRole("button", { name: /^Thread in/ }).closest("li")!;
    await user.click(within(thread).getByRole("button", { name: "Delete draft" }));
    // Chromium counts the click that lands on the next row as the second of two.
    const next = screen.getByRole("button", { name: /^#design/ }).closest("li")!;
    fireEvent.click(within(next).getByRole("button", { name: "Delete draft" }), { detail: 2 });
    fireEvent.click(within(next).getByRole("button", { name: /^#design/ }), { detail: 2 });
    expect(client.state.drafts[design.id]).toBe("Notes from the review");
    expect(client.state.drafts[`${general.id}:M_ROOT`]).toBeUndefined();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("says when there are none", () => {
    const { client } = workspace();
    render(tree(client, <DraftsPanel onClose={() => {}} onOpen={() => {}} />));
    expect(screen.getByText(/^No drafts\./)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Drafts on this device" })).toBeNull();
  });
});

describe("opening a draft from the Drafts panel", () => {
  function screenWith(self = sam) {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    // A jump scrolls the message into view, which jsdom cannot.
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
      onTestFinished(() => void delete (Element.prototype as Partial<Element>).scrollIntoView);
    }
    const { client, user } = fourDrafts();
    client.store.setState({
      // Not counted or listed: a conversation this client no longer has.
      self,
      users: { [sam.id]: self, [priya.id]: priya },
      drafts: { ...client.state.drafts, C_LEFT: "From a channel since left" },
      timelines: {
        [general.id]: { items: [root, release], hasMore: false, hasMoreNewer: false, loaded: true },
      },
    });
    writeRoute(client.baseUrl, { channelId: general.id, threadRootId: null }, "replace");
    vi.spyOn(client, "loadTimeline").mockResolvedValue();
    vi.spyOn(client, "loadCommands").mockResolvedValue();
    vi.spyOn(client, "loadThread").mockResolvedValue();
    const jump = vi.spyOn(client, "jumpToMessage").mockResolvedValue(null);
    vi.spyOn(client.api, "listScheduled").mockResolvedValue({ scheduled: [queued] });
    render(
      tree(
        client,
        <WorkspaceScreen
          client={client}
          platform={platform}
          onLeaveWorkspace={() => {}}
          onSignedOut={() => {}}
        />,
      ),
    );
    return { client, user, jump };
  }
  async function openDrafts(user: ReturnType<typeof userEvent.setup>) {
    const row = await screen.findByRole("button", { name: /^Drafts/ }, { timeout: 3_000 });
    expect(within(row).getByRole("img", { name: "Unsent drafts" })).toHaveTextContent("4");
    await user.click(row);
    return screen.findByRole("complementary", { name: "Drafts" }, { timeout: 3_000 });
  }

  it("has a sidebar row only while there are drafts, or while the panel is open", async () => {
    const { client, user } = screenWith();
    act(() => client.hydrateDrafts({}));
    await screen.findByRole("button", { name: /^Jump to…/ }, { timeout: 3_000 });
    expect(screen.queryByRole("button", { name: /^Drafts/ })).toBeNull();
    act(() => client.setDraft(design.id, "Back to it"));
    const row = await screen.findByRole("button", { name: /^Drafts/ });
    await user.click(row);
    const panel = await screen.findByRole("complementary", { name: "Drafts" });
    // Deleting the last keeps the row, marked open, until the panel closes.
    await user.click(within(panel).getByRole("button", { name: "Delete draft" }));
    expect(within(panel).getByText(/^No drafts\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Drafts/ })).toHaveAttribute("aria-current", "true");
    await user.click(within(panel).getByRole("button", { name: "Close drafts" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Drafts/ })).toBeNull());
  });

  it("opens from the palette, and links to Scheduled", async () => {
    const { user } = screenWith();
    await user.click(await screen.findByRole("button", { name: /^Jump to…/ }, { timeout: 3_000 }));
    await user.type(await screen.findByRole("combobox"), "unsent");
    await user.click(screen.getByRole("option", { name: "Drafts, action" }));
    const panel = await screen.findByRole("complementary", { name: "Drafts" });
    expect(within(panel).queryByText("From a channel since left")).toBeNull();
    await user.click(within(panel).getByRole("button", { name: "Open scheduled messages" }));
    expect(await screen.findByRole("complementary", { name: "Scheduled messages" })).toBeTruthy();
  });

  it("has no link to Scheduled for a guest, who cannot schedule", async () => {
    const { user } = screenWith({ ...sam, role: "guest" });
    const panel = await openDrafts(user);
    expect(within(panel).getByRole("button", { name: /^#design/ })).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Open scheduled messages" })).toBeNull();
  });

  it("opens a conversation's draft in that conversation", async () => {
    const { user } = screenWith();
    await user.click(within(await openDrafts(user)).getByRole("button", { name: /^#design/ }));
    expect(await screen.findByRole("textbox", { name: "Message #design" })).toHaveValue(
      "Notes from the review",
    );
    expect(screen.queryByRole("complementary", { name: "Drafts" })).toBeNull();
  });

  it("opens a thread's draft in the thread", async () => {
    const { user } = screenWith();
    await user.click(within(await openDrafts(user)).getByRole("button", { name: /^Thread in/ }));
    const thread = await screen.findByRole("complementary", { name: "Thread" });
    expect(within(thread).getByRole("textbox", { name: "Reply…" })).toHaveValue(
      "Agreed, @Priya Shah has the numbers",
    );
  });

  it("opens an unsaved edit in the message's editor", async () => {
    const { user, jump } = screenWith();
    await user.click(
      within(await openDrafts(user)).getByRole("button", { name: /^Editing a message/ }),
    );
    expect(jump).toHaveBeenCalledWith(general.id, release.id);
    expect(await screen.findByRole("textbox", { name: "Edit message" })).toHaveValue(
      "Ship the release notes today",
    );
  });

  it("opens a scheduled message's unsaved edit in Scheduled", async () => {
    const { user } = screenWith();
    await user.click(
      within(await openDrafts(user)).getByRole("button", { name: /^Editing a scheduled/ }),
    );
    const scheduled = await screen.findByRole("complementary", { name: "Scheduled messages" });
    expect(
      await within(scheduled).findByRole("textbox", { name: "Edit scheduled text" }),
    ).toHaveValue("Standup moved to 11");
    // Opened once: put away, it stays away.
    await user.click(within(scheduled).getByRole("button", { name: "Discard edit" }));
    await act(() => Promise.resolve());
    expect(within(scheduled).queryByRole("textbox", { name: "Edit scheduled text" })).toBeNull();
  });
});

describe("an edit asked for from elsewhere", () => {
  it("opens the editor of a row on screen, or of one that appears soon after", async () => {
    const { client } = workspace({ [`${general.id}:edit:${release.id}`]: editDraft });
    render(tree(client, <MessageItem message={release} compact={false} />));
    act(() => requestEdit(release.id));
    expect(await screen.findByRole("textbox", { name: "Edit message" })).toHaveValue(
      "Ship the release notes today",
    );
    cleanup();

    act(() => requestEdit(release.id));
    render(tree(client, <MessageItem message={release} compact={false} />));
    expect(await screen.findByRole("textbox", { name: "Edit message" })).toBeTruthy();
  });

  it("lets go of a request whose row does not appear in time, and of one for someone else's message", async () => {
    vi.useFakeTimers({ now: 1_000, toFake: ["Date"] });
    const { client } = workspace();
    act(() => requestEdit(release.id));
    vi.setSystemTime(1_000 + EDIT_REQUEST_MS + 1);
    render(tree(client, <MessageItem message={release} compact={false} />));
    await act(() => Promise.resolve());
    expect(screen.queryByRole("textbox", { name: "Edit message" })).toBeNull();
    cleanup();

    const theirs = message("M_THEIRS", "Lunch at noon", priya.id);
    act(() => requestEdit(theirs.id));
    render(tree(client, <MessageItem message={theirs} compact={false} />));
    await act(() => Promise.resolve());
    expect(screen.queryByRole("textbox", { name: "Edit message" })).toBeNull();
  });
});

describe("draft times on this device", () => {
  const draftsKey = "drafts:http://127.0.0.1:9:U_SAM";
  const timesKey = "draft-times:http://127.0.0.1:9:U_SAM";
  function device(values: Map<string, unknown>): Platform {
    return {
      kind: "desktop",
      storage: {
        get: async <T,>(name: string) => (values.get(name) ?? null) as T | null,
        set: async (name: string, value: unknown) => void values.set(name, value),
      },
      notify: () => {},
    };
  }

  it("come back on restore, and are written beside the drafts this window writes", async () => {
    const values = new Map<string, unknown>([
      [draftsKey, { [general.id]: "kept", [design.id]: "also kept", C_OLD: "no time" }],
      [timesKey, { [general.id]: 1_000, [design.id]: 2_000, C_GONE: 3_000 }],
    ]);
    const { client } = workspace();
    const stored = device(values);
    render(
      <PlatformContext.Provider value={stored}>
        <ClientContext.Provider value={client}>
          <DraftPersistence platform={stored} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    await waitFor(() => expect(client.state.drafts[general.id]).toBe("kept"));
    expect(client.state.draftTimes).toEqual({ [general.id]: 1_000, [design.id]: 2_000 });

    act(() => {
      client.setDraft(general.id, "kept, and changed", 5_000);
      client.setDraft(design.id, "");
    });
    // Written after the pause drafts wait for, and the times after them.
    await waitFor(() => expect(values.get(timesKey)).toEqual({ [general.id]: 5_000 }), {
      timeout: 3_000,
    });
    expect(values.get(draftsKey)).toEqual({ [general.id]: "kept, and changed", C_OLD: "no time" });
  });

  it("leave the drafts to come back without them when they cannot be read", async () => {
    const values = new Map<string, unknown>([[draftsKey, { [general.id]: "kept" }]]);
    const stored = device(values);
    const get = stored.storage.get;
    stored.storage.get = async <T,>(name: string) => {
      if (name === timesKey) throw new Error("unreadable");
      return get<T>(name);
    };
    const { client } = workspace();
    render(
      <PlatformContext.Provider value={stored}>
        <ClientContext.Provider value={client}>
          <DraftPersistence platform={stored} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    await waitFor(() => expect(client.state.drafts[general.id]).toBe("kept"));
    expect(client.state.draftTimes).toEqual({});
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
