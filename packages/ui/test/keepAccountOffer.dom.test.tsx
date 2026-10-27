import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient, type PendingMessage } from "@ownbase/client-core";
import type { Channel, Message, User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { Sidebar } from "../src/components/Sidebar.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * UX-44: a guest is offered Keep this account in the sidebar once they have
 * posted, never before, once per account on this device, and never as a member.
 */
const person = (id: string, role: User["role"]): User => ({
  id,
  handle: id.toLowerCase(),
  displayName: "Vic",
  role,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});

const general: Channel = {
  id: "C_GENERAL",
  type: "public",
  name: "general",
  topic: "",
  description: "",
  creatorId: "U_OWNER",
  archived: false,
  createdAt: 0,
};

const message = (id: string, userId: string, threadRootId: string | null = null): Message => ({
  id,
  channelId: general.id,
  userId,
  text: "hello",
  threadRootId,
  broadcast: false,
  seq: 1,
  createdAt: 0,
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  actions: [],
});

const timeline = (items: Message[]) => ({
  [general.id]: { items, hasMore: false, hasMoreNewer: false, loaded: true },
});

const OFFER = { name: "You're a guest for a day" };

afterEach(() => vi.restoreAllMocks());

/** Each workspace its own, since an offer put away stays away for the page. */
let workspaces = 0;
const slot = (workspaceId: string) => `local:v1:${workspaceId}:U_G:keep-account-offer`;

function storage(options: { values?: Map<string, unknown>; failGet?: boolean; failSet?: boolean }) {
  const values = options.values ?? new Map<string, unknown>();
  const get = vi.fn(async (name: string, _options?: { strict?: boolean }) => {
    if (options.failGet) throw new Error("storage is unavailable");
    return values.get(name) ?? null;
  });
  const set = vi.fn(async (name: string, value: unknown) => {
    if (options.failSet) throw new Error("storage is full");
    values.set(name, value);
  });
  const platform: Platform = {
    kind: "web",
    storage: { get: get as Platform["storage"]["get"], set },
    notify: () => {},
  };
  return { platform, values, get, set };
}

function sidebar(
  options: {
    role?: User["role"];
    messages?: Message[];
    workspaceId?: string;
    values?: Map<string, unknown>;
    failGet?: boolean;
    failSet?: boolean;
  } = {},
) {
  const workspaceId = options.workspaceId ?? `W_${++workspaces}`;
  const stored = storage(options);
  const self = person("U_G", options.role ?? "guest");
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self,
    workspaceId,
    users: { [self.id]: self },
    channels: { [general.id]: general },
    memberships: { [general.id]: 0 },
    timelines: timeline(options.messages ?? [message("M_1", "U_OWNER")]),
    status: "online",
  });
  const onCreateAccount = vi.fn();
  const noop = () => {};
  const view = render(
    <PlatformContext.Provider value={stored.platform}>
      <ClientContext.Provider value={client}>
        <Sidebar
          activeChannelId={general.id}
          onSelect={noop}
          onBrowseChannels={noop}
          onNewChannel={noop}
          onNewDm={noop}
          onFriends={noop}
          onSearch={noop}
          onSaved={noop}
          onActivity={noop}
          onThreads={noop}
          onInvite={noop}
          onSwitchWorkspace={noop}
          onEditProfile={noop}
          onAccountSettings={noop}
          onCreateAccount={onCreateAccount}
          connectionLabel={null}
        />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  return { ...stored, client, workspaceId, onCreateAccount, view, user: userEvent.setup() };
}

/** Lets storage answer, so that nothing on show means nothing to show. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

describe("offering a guest to keep their account", () => {
  it("waits for the guest's first message to reach the server, then offers it without taking focus", async () => {
    const { client, get, values, workspaceId } = sidebar();
    await settle();
    expect(get).toHaveBeenCalledWith(slot(workspaceId), { strict: true });
    expect(screen.queryByRole("region", OFFER)).toBeNull();

    // Still sending: the server has not taken it yet.
    const browse = screen.getByRole("button", { name: "Browse channels" });
    act(() => browse.focus());
    const sending: PendingMessage = {
      nonce: "n1",
      channelId: general.id,
      threadRootId: null,
      text: "hello",
      userId: "U_G",
      createdAt: 0,
      failed: false,
      failureReason: null,
      attachments: [],
      uploadProgress: null,
    };
    act(() => client.store.setState({ pending: [sending] }));
    await settle();
    expect(screen.queryByRole("region", OFFER)).toBeNull();

    // The server's copy replaces it.
    act(() =>
      client.store.setState((s) => ({
        pending: [],
        timelines: timeline([...s.timelines[general.id]!.items, message("M_2", "U_G")]),
      })),
    );
    const offer = await screen.findByRole("region", OFFER);
    expect(offer).toHaveTextContent(
      /keeps your name and your messages, and gives you a place in private conversations/,
    );
    expect(screen.getByRole("button", { name: "Keep this account" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Not now" })).toBeEnabled();
    expect(browse).toHaveFocus();
    // Written down, so a reload offers it without finding the message again.
    await waitFor(() => expect(values.get(slot(workspaceId))).toEqual({ posted: true }));
    expect(await accessibilityProblems()).toEqual([]);
  });

  it("counts a reply in a thread as posting", async () => {
    const { client } = sidebar();
    await settle();
    expect(screen.queryByRole("region", OFFER)).toBeNull();
    act(() => client.store.setState({ threads: { M_1: [message("M_R", "U_G", "M_1")] } }));
    expect(await screen.findByRole("region", OFFER)).toBeVisible();
  });

  it("offers it to a guest who posted before, whether or not the message is loaded", async () => {
    // Posted before this offer existed: the message is in the replica.
    sidebar({ messages: [message("M_OLD", "U_G")] });
    expect(await screen.findByRole("region", OFFER)).toBeVisible();

    // Posted, then reloaded somewhere their message is not loaded.
    const workspaceId = `W_${++workspaces}`;
    sidebar({ workspaceId, values: new Map([[slot(workspaceId), { posted: true }]]) });
    await waitFor(() => expect(screen.getAllByRole("region", OFFER)).toHaveLength(2));
  });

  it("is never offered to a member", async () => {
    const { get } = sidebar({ role: "member", messages: [message("M_2", "U_G")] });
    await settle();
    expect(screen.queryByRole("region", OFFER)).toBeNull();
    expect(get).not.toHaveBeenCalledWith(expect.stringContaining("keep-account-offer"), {
      strict: true,
    });
  });

  it("is not offered when storage cannot say whether it was put away", async () => {
    sidebar({ messages: [message("M_2", "U_G")], failGet: true });
    await settle();
    expect(screen.queryByRole("region", OFFER)).toBeNull();
  });

  it("puts it away for good on Not now, handing focus to the account button", async () => {
    const { user, values, view, workspaceId } = sidebar({ messages: [message("M_2", "U_G")] });
    await screen.findByRole("region", OFFER);
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("region", OFFER)).toBeNull();
    expect(screen.getByRole("button", { name: /^Vic, Guest, your account$/ })).toHaveFocus();
    await waitFor(() =>
      expect(values.get(slot(workspaceId))).toEqual({ posted: true, closed: true }),
    );

    // Drawn again, as switching back to the workspace does.
    view.unmount();
    sidebar({ workspaceId, values, messages: [message("M_2", "U_G")] });
    await settle();
    expect(screen.queryByRole("region", OFFER)).toBeNull();

    // A reload: the page has forgotten, and what this device stored keeps it away.
    vi.resetModules();
    const fresh = await import("../src/components/KeepAccountOffer.js");
    const context = await import("../src/context.js");
    const { platform } = storage({ values });
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    client.store.setState({
      self: person("U_G", "guest"),
      workspaceId,
      timelines: timeline([message("M_2", "U_G")]),
    });
    const again = render(
      <context.PlatformContext.Provider value={platform}>
        <context.ClientContext.Provider value={client}>
          <fresh.KeepAccountOffer onKeep={() => {}} />
        </context.ClientContext.Provider>
      </context.PlatformContext.Provider>,
    );
    await settle();
    expect(again.container).toBeEmptyDOMElement();
    // The same module with nothing stored would offer it: the storage kept it away.
    values.delete(slot(workspaceId));
    again.unmount();
    render(
      <context.PlatformContext.Provider value={platform}>
        <context.ClientContext.Provider value={client}>
          <fresh.KeepAccountOffer onKeep={() => {}} />
        </context.ClientContext.Provider>
      </context.PlatformContext.Provider>,
    );
    expect(await screen.findByRole("region", OFFER)).toBeVisible();
  });

  it("stays away for this page when storage cannot save that it was put away", async () => {
    const { user, view, workspaceId, values } = sidebar({
      messages: [message("M_2", "U_G")],
      failSet: true,
    });
    await screen.findByRole("region", OFFER);
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("region", OFFER)).toBeNull();
    expect(values.has(slot(workspaceId))).toBe(false);
    view.unmount();
    sidebar({ workspaceId, messages: [message("M_2", "U_G")] });
    await settle();
    expect(screen.queryByRole("region", OFFER)).toBeNull();
  });

  it("opens the keep-account form from Keep this account, and does not come back", async () => {
    const { user, onCreateAccount, values, workspaceId } = sidebar({
      messages: [message("M_2", "U_G")],
    });
    await screen.findByRole("region", OFFER);
    await user.click(screen.getByRole("button", { name: "Keep this account" }));
    expect(onCreateAccount).toHaveBeenCalledOnce();
    expect(screen.queryByRole("region", OFFER)).toBeNull();
    await waitFor(() =>
      expect(values.get(slot(workspaceId))).toEqual({ posted: true, closed: true }),
    );
  });

  it("goes as soon as the guest becomes a member", async () => {
    const { client } = sidebar({ messages: [message("M_2", "U_G")] });
    await screen.findByRole("region", OFFER);
    act(() => client.store.setState({ self: person("U_G", "member") }));
    expect(screen.queryByRole("region", OFFER)).toBeNull();
  });
});
