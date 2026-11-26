import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { AccountDialog } from "../src/components/AccountDialog.js";
import { ActivityPanel } from "../src/components/ActivityPanel.js";
import { Mrkdwn } from "../src/components/Mrkdwn.js";
import { Navigation } from "../src/lib/navigation.js";
import { startNotifications } from "../src/lib/notifications.js";
import type { Platform } from "../src/platform.js";
import { render } from "./render.js";
import { accessibilityProblems } from "./accessibility.js";

/** Keyword alerts (K11): the list in Account settings, the mark in a message, the notification. */
const person = (id: string, displayName: string): User => ({
  id,
  handle: displayName.toLowerCase(),
  displayName,
  role: "member",
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});
const sam = person("U_SAM", "Sam");
const maya = person("U_MAYA", "Maya");
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

const clients: WorkspaceClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
});

function workspace(keywords: string[] = []) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam, [maya.id]: maya },
    channels: { [general.id]: general },
    memberships: { [general.id]: 0 },
    status: "online",
    keywords,
  });
  return client;
}

const platform = (notify: Platform["notify"] = () => {}): Platform => ({
  kind: "desktop",
  storage: { get: async () => null, set: async () => {} },
  notify,
});

function settings(client: WorkspaceClient) {
  vi.spyOn(client.api, "listSessions").mockResolvedValue({ sessions: [] });
  render(
    <PlatformContext.Provider value={platform()}>
      <ClientContext.Provider value={client}>
        <AccountDialog onClose={() => {}} section="notifications" />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  return screen.getByRole("region", { name: "My keywords" });
}

describe("My keywords in Account settings", () => {
  it("adds several at once, without repeats, and saves them for the account", async () => {
    const user = userEvent.setup();
    const client = workspace(["release"]);
    const setKeywords = vi
      .spyOn(client.api, "setKeywords")
      .mockImplementation(async (keywords) => ({ keywords }));
    const section = settings(client);
    expect(within(section).getByRole("list", { name: "Your keywords" })).toHaveTextContent(
      "release",
    );
    expect(await accessibilityProblems(section)).toEqual([]);

    const field = within(section).getByRole("textbox", { name: "Add keywords" });
    await user.type(field, " launch day, Release ,  ship it {Enter}");
    expect(setKeywords).toHaveBeenLastCalledWith(["release", "launch day", "ship it"]);
    await waitFor(() => expect(field).toHaveValue(""));
    const list = within(section).getByRole("list", { name: "Your keywords" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["release", "launch day", "ship it"]);

    await user.click(within(list).getByRole("button", { name: "Remove launch day" }));
    expect(setKeywords).toHaveBeenLastCalledWith(["release", "ship it"]);
    await waitFor(() =>
      expect(within(section).queryByRole("button", { name: "Remove launch day" })).toBeNull(),
    );
  });

  it("says what is wrong with what was typed, and sends nothing", async () => {
    const user = userEvent.setup();
    const client = workspace(["release"]);
    const setKeywords = vi.spyOn(client.api, "setKeywords");
    const section = settings(client);
    const field = within(section).getByRole("textbox", { name: "Add keywords" });
    const add = within(section).getByRole("button", { name: "Add" });

    await user.type(field, "RÉLEASE");
    await user.click(add);
    expect(within(section).getByRole("alert")).toHaveTextContent(
      "That keyword is on your list already.",
    );
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(/That keyword is on your list already/);

    await user.clear(field);
    await user.type(field, "?!");
    await user.click(add);
    expect(within(section).getByRole("alert")).toHaveTextContent(
      "“?!” has no letters or numbers, so no message could match it.",
    );
    expect(setKeywords).not.toHaveBeenCalled();
  });

  it("keeps the list as it was when the server refuses, and says so", async () => {
    const user = userEvent.setup();
    const client = workspace([]);
    vi.spyOn(client.api, "setKeywords").mockRejectedValue(new ApiError(503, "http_error"));
    const section = settings(client);
    expect(within(section).getByText("You have no keywords yet.")).toBeVisible();
    await user.type(within(section).getByRole("textbox", { name: "Add keywords" }), "launch");
    await user.click(within(section).getByRole("button", { name: "Add" }));
    expect(await within(section).findByRole("alert")).toHaveTextContent(
      /Your keywords were not saved/,
    );
    expect(within(section).getByRole("textbox", { name: "Add keywords" })).toHaveValue("launch");
    expect(within(section).getByText("You have no keywords yet.")).toBeVisible();
  });
});

describe("a keyword in a message", () => {
  it("is marked where it stands as a whole word, whatever its case or accents", () => {
    const client = workspace(["release", "launch day"]);
    const { container } = render(
      <ClientContext.Provider value={client}>
        <Mrkdwn text="The *Réléase* is out, released on launch  day." users={{}} channels={{}} />
      </ClientContext.Provider>,
    );
    expect([...container.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual([
      "Réléase",
      "launch  day",
    ]);
  });

  it("is marked in its row in Activity, so the row says why it is there", async () => {
    const user = userEvent.setup();
    const client = workspace(["release"]);
    const hit = {
      id: "M1",
      channelId: general.id,
      userId: maya.id,
      text: "The Release is out",
      seq: 1,
      threadRootId: null,
      createdAt: 0,
      editedAt: null,
      reactions: [],
      files: [],
    } as unknown as Message;
    vi.spyOn(client.api, "activity").mockResolvedValue({ messages: [hit], nextCursor: null });
    render(
      <ClientContext.Provider value={client}>
        <ActivityPanel onClose={() => {}} onJump={() => {}} onOpenChannel={() => {}} />
      </ClientContext.Provider>,
    );
    const panel = screen.getByRole("complementary", { name: "Activity" });
    await user.click(within(panel).getByRole("tab", { name: "Mentions" }));
    const row = await within(panel).findByRole("button", { name: /The Release is out/ });
    expect([...row.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["Release"]);
  });

  it("is not marked without keywords, or outside a workspace", () => {
    const { container } = render(<Mrkdwn text="The release is out" users={{}} channels={{}} />);
    expect(container.querySelector("mark")).toBeNull();
  });
});

describe("a keyword's notification", () => {
  it("names the keyword in its title", () => {
    const client = workspace(["release"]);
    const notify = vi.fn();
    const navigation = new Navigation(client, client.baseUrl, { channelId: null });
    const stop = startNotifications({
      client,
      navigation,
      platform: platform(notify),
      preview: () => "full",
      account: () => "sam@test",
      hear: () => {},
    });
    const message = {
      id: "M1",
      channelId: general.id,
      userId: maya.id,
      text: "The release is out",
      seq: 1,
      threadRootId: null,
      createdAt: 0,
      editedAt: null,
      reactions: [],
      files: [],
    } as unknown as Message;
    (client as unknown as { events: { emit: (...args: unknown[]) => void } }).events.emit(
      "message",
      message,
      { live: true },
    );
    expect(notify).toHaveBeenCalledWith(
      "Maya mentioned “release” in #general",
      "The release is out",
      expect.any(Function),
      expect.anything(),
    );
    stop();
  });
});
