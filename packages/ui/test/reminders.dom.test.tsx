import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, Reminder, ReminderItem, User } from "@ownbase/protocol";
import { ClientContext, OpenMessageContext, PlatformContext } from "../src/context.js";
import { ActivityPanel } from "../src/components/ActivityPanel.js";
import { MessageItem } from "../src/components/MessageItem.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
import { WorkspaceScreen } from "../src/screens/WorkspaceScreen.js";
import { writeRoute } from "../src/lib/route.js";
import type { Platform } from "../src/platform.js";

/** Reminders (E4): set from a message, listed in Activity, counted and told. */
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
const message = (id: string, text: string): Message => ({
  id,
  channelId: general.id,
  userId: priya.id,
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
const reminder = (messageId: string, remindAt: number, dueAt: number | null): Reminder => ({
  id: `R_${messageId}`,
  messageId,
  channelId: general.id,
  threadRootId: null,
  remindAt,
  dueAt,
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
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** A client whose server answers reminders as the real one does. */
function workspace(reminders: Record<string, Reminder> | null = {}) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam, [priya.id]: priya },
    channels: { [general.id]: general },
    memberships: { [general.id]: 9 },
    status: "online",
    activityThreads: true,
    reminders,
  });
  const setReminder = vi
    .spyOn(client.api, "setReminder")
    .mockImplementation(async (messageId, at) => ({ reminder: reminder(messageId, at, null) }));
  const cancelReminder = vi.spyOn(client.api, "cancelReminder").mockResolvedValue({ ok: true });
  return { client, setReminder, cancelReminder, user: userEvent.setup() };
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

async function moreActions(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "More actions" }));
  const menu = await screen.findByRole("menu", { name: "More actions" });
  return {
    menu,
    items: within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  };
}

describe("a reminder from a message's menu", () => {
  const invoice = message("M_INVOICE", "Send the invoice by Friday");

  it("is set from a preset, then can be changed or cancelled", async () => {
    const { client, setReminder, cancelReminder, user } = workspace();
    render(tree(client, <MessageItem message={invoice} compact={false} />));

    const { menu } = await moreActions(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Remind me about this…" }));
    const popover = await screen.findByRole("dialog", { name: "Remind me" });
    const before = Date.now();
    await user.click(within(popover).getByRole("button", { name: /^In 1 hour/ }));
    expect(setReminder).toHaveBeenCalledOnce();
    const [id, at] = setReminder.mock.calls[0]!;
    expect(id).toBe(invoice.id);
    expect(at).toBeGreaterThanOrEqual(before + 3_600_000 - 1_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect(await screen.findByText(/^Reminder set for /)).toBeVisible();

    const again = await moreActions(user);
    expect(again.items).toEqual(expect.arrayContaining(["Change reminder…", "Cancel reminder"]));
    expect(again.items).not.toContain("Remind me about this…");
    await user.click(within(again.menu).getByRole("menuitem", { name: "Cancel reminder" }));
    expect(cancelReminder).toHaveBeenCalledWith(invoice.id);
    await waitFor(() => expect(client.state.reminders?.[invoice.id]).toBeUndefined());
  });

  it("takes a chosen time, and says so when that time has passed", async () => {
    const { client, setReminder, user } = workspace();
    render(tree(client, <MessageItem message={invoice} compact={false} />));
    const { menu } = await moreActions(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Remind me about this…" }));
    const field = await screen.findByLabelText("Choose a date and time");

    fireEvent.change(field, { target: { value: "2001-01-05T09:00" } });
    await user.click(screen.getByRole("button", { name: /^Remind me .*2001 at / }));
    expect(field).toHaveAccessibleDescription("Choose a date and time in the future.");
    expect(setReminder).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: "2099-03-02T08:15" } });
    await user.click(screen.getByRole("button", { name: /^Remind me .*2099 at / }));
    expect(setReminder).toHaveBeenCalledWith(invoice.id, new Date("2099-03-02T08:15").getTime());
  });

  it("is marked done from the menu once due", async () => {
    const { client, cancelReminder, user } = workspace({
      [invoice.id]: reminder(invoice.id, 1, 2),
    });
    render(tree(client, <MessageItem message={invoice} compact={false} />));
    const { menu, items } = await moreActions(user);
    expect(items).toEqual(expect.arrayContaining(["Change reminder…", "Mark reminder done"]));
    await user.click(within(menu).getByRole("menuitem", { name: "Mark reminder done" }));
    expect(cancelReminder).toHaveBeenCalledWith(invoice.id);
  });

  it("says so, with a way to try again, when the server refuses", async () => {
    const { client, setReminder, user } = workspace();
    setReminder.mockRejectedValueOnce(new Error("offline"));
    render(tree(client, <MessageItem message={invoice} compact={false} />));
    const { menu } = await moreActions(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Remind me about this…" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Remind me" })).getByRole("button", {
        name: /^In 20 minutes/,
      }),
    );
    expect(await screen.findByText("Could not set that reminder.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(setReminder).toHaveBeenCalledTimes(2));
    expect(setReminder.mock.calls[1]![1]).toBe(setReminder.mock.calls[0]![1]);
  });

  it("is offered on the touch menu too", async () => {
    const { client, user } = workspace();
    render(tree(client, <MessageItem message={invoice} compact={false} />));
    await user.click(screen.getByRole("button", { name: "Actions for message from Priya Shah" }));
    const menu = screen.getByRole("menu", { name: "Actions for message from Priya Shah" });
    expect(within(menu).getByRole("menuitem", { name: "Remind me about this…" })).toBeVisible();
  });

  it("is not offered where the server keeps no reminders", async () => {
    const { client, user } = workspace(null);
    render(tree(client, <MessageItem message={invoice} compact={false} />));
    expect((await moreActions(user)).items).not.toContain("Remind me about this…");
  });
});

describe("Activity's reminders", () => {
  const due = message("M_DUE", "Renew the certificate");
  const later = message("M_LATER", "Book the venue");
  const items: ReminderItem[] = [
    { reminder: reminder(due.id, Date.now() - 60_000, Date.now() - 50_000), message: due },
    { reminder: reminder(later.id, Date.now() + 3_600_000, null), message: later },
  ];

  function activity(reminders: Record<string, Reminder> | null) {
    const setup = workspace(reminders);
    vi.spyOn(setup.client.api, "activity").mockResolvedValue({ messages: [], nextCursor: null });
    const list = vi
      .spyOn(setup.client.api, "listReminders")
      .mockResolvedValue({ reminders: items });
    const onJump = vi.fn();
    render(tree(setup.client, <ActivityPanel onClose={() => {}} onJump={onJump} />));
    return { ...setup, list, onJump };
  }

  it("says from All that some are due, and lists them before those waiting", async () => {
    const { user } = activity({
      [due.id]: items[0]!.reminder,
      [later.id]: items[1]!.reminder,
    });
    const tab = screen.getByRole("tab", { name: "Reminders, 1 due" });
    expect(tab).toHaveAttribute("aria-selected", "false");
    await user.click(screen.getByRole("button", { name: "1 reminder is due" }));
    expect(tab).toHaveAttribute("aria-selected", "true");

    const dueSection = await screen.findByRole("region", { name: "Due" });
    expect(within(dueSection).getByText("Renew the certificate")).toBeVisible();
    const upcoming = screen.getByRole("region", { name: "Upcoming" });
    expect(within(upcoming).getByText("Book the venue")).toBeVisible();
  });

  it("marks one done, changes or cancels another, and opens a message", async () => {
    const { user, cancelReminder, setReminder, onJump } = activity({
      [due.id]: items[0]!.reminder,
      [later.id]: items[1]!.reminder,
    });
    await user.click(screen.getByRole("tab", { name: "Reminders, 1 due" }));
    const dueSection = await screen.findByRole("region", { name: "Due" });
    const upcoming = screen.getByRole("region", { name: "Upcoming" });

    await user.click(within(dueSection).getByRole("button", { name: "Mark done" }));
    expect(cancelReminder).toHaveBeenLastCalledWith(due.id);
    await user.click(within(upcoming).getByRole("button", { name: "Cancel reminder" }));
    expect(cancelReminder).toHaveBeenLastCalledWith(later.id);

    await user.click(within(upcoming).getByRole("button", { name: "Change reminder" }));
    const popover = await screen.findByRole("dialog", { name: "Remind me" });
    await user.click(within(popover).getByRole("button", { name: /^In 3 hours/ }));
    expect(setReminder).toHaveBeenLastCalledWith(later.id, expect.any(Number));

    await user.click(within(upcoming).getByText("Book the venue"));
    expect(onJump).toHaveBeenCalledWith(general.id, later.id);
  });

  it("finishes one for a double-click, though the next row's button slides under it", async () => {
    const { user, cancelReminder, onJump } = activity({
      [due.id]: items[0]!.reminder,
      [later.id]: items[1]!.reminder,
    });
    await user.click(screen.getByRole("tab", { name: "Reminders, 1 due" }));
    const dueSection = await screen.findByRole("region", { name: "Due" });
    const upcoming = screen.getByRole("region", { name: "Upcoming" });
    await user.click(within(dueSection).getByRole("button", { name: "Mark done" }));
    // Chromium counts the click that lands on the next row as the second of two.
    for (const name of ["Cancel reminder", /Book the venue/])
      fireEvent.click(within(upcoming).getByRole("button", { name }), { detail: 2 });
    expect(cancelReminder).toHaveBeenCalledExactlyOnceWith(due.id);
    expect(onJump).not.toHaveBeenCalled();
  });

  it("reads the list again when a reminder changes on another device", async () => {
    const { client, list } = activity({ [later.id]: items[1]!.reminder });
    await userEvent.setup().click(screen.getByRole("tab", { name: "Reminders" }));
    await waitFor(() => expect(list).toHaveBeenCalledOnce());
    act(() =>
      client.store.setState({ reminders: { [later.id]: { ...items[1]!.reminder, remindAt: 5 } } }),
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("has no Reminders tab where the server keeps none", () => {
    activity(null);
    expect(screen.queryByRole("tab", { name: /Reminders/ })).toBeNull();
  });
});

describe("a reminder come due", () => {
  function screenWith(reminders: Record<string, Reminder>, self = sam, phone = false) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: phone && query.includes("max-width"),
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const { client } = workspace(reminders);
    client.store.setState({ self, users: { [sam.id]: self, [priya.id]: priya } });
    writeRoute(client.baseUrl, { channelId: general.id, threadRootId: null }, "replace");
    vi.spyOn(client, "loadTimeline").mockResolvedValue();
    vi.spyOn(client, "loadCommands").mockResolvedValue();
    const notify = vi.fn();
    const shown: Platform = { ...platform, notify };
    render(
      <PlatformContext.Provider value={shown}>
        <ClientContext.Provider value={client}>
          <WorkspaceScreen
            client={client}
            platform={shown}
            onLeaveWorkspace={() => {}}
            onSignedOut={() => {}}
          />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    return { client, notify };
  }
  const invoice = message("M_INVOICE", "Send the invoice by Friday");

  it("counts on Activity's badge, in the sidebar and in the phone's bar", async () => {
    screenWith({ [invoice.id]: reminder(invoice.id, 1, 2) });
    expect(
      await screen.findByRole("img", { name: "Due reminders" }, { timeout: 3_000 }),
    ).toHaveTextContent("1");
    cleanup();

    screenWith({ [invoice.id]: reminder(invoice.id, 1, 2) }, sam, true);
    const bar = await screen.findByRole(
      "navigation",
      { name: "Main navigation" },
      { timeout: 3_000 },
    );
    expect(within(bar).getByRole("button", { name: "Activity" })).toHaveAccessibleDescription(
      "1 reminder due",
    );
  });

  it("raises a notification, but not during Do Not Disturb", async () => {
    const { client, notify } = screenWith({});
    await screen.findByRole("button", { name: /Activity/ }, { timeout: 3_000 });
    act(() => client.onReminderDue?.(reminder(invoice.id, 1, 2), invoice));
    expect(notify).toHaveBeenCalledWith(
      "Reminder: Priya Shah in #general",
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({ tag: expect.stringContaining("reminder") }),
    );
    cleanup();

    const quiet = screenWith({}, { ...sam, dndUntil: Date.now() + 3_600_000 });
    await screen.findByRole("button", { name: /Activity/ }, { timeout: 3_000 });
    act(() => quiet.client.onReminderDue?.(reminder(invoice.id, 1, 2), invoice));
    expect(quiet.notify).not.toHaveBeenCalled();
  });
});
