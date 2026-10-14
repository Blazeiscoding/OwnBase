import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Channel, Message, User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { WorkspaceScreen } from "../src/screens/WorkspaceScreen.js";
import { writeRoute } from "../src/lib/route.js";
import type { Platform } from "../src/platform.js";

/**
 * The header's search box needs no Enter: the first thing typed opens search
 * with the typing carried on in the dialog's field, where results follow it.
 */
const owner: User = {
  id: "U_OWNER",
  handle: "owner",
  displayName: "Owner",
  role: "owner",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};
const room = (id: string, name: string): Channel => ({
  id,
  type: "public",
  name,
  topic: "",
  description: "",
  creatorId: owner.id,
  archived: false,
  createdAt: 0,
});
const general = room("C_GENERAL", "general");
const design = room("C_DESIGN", "design");
const found = {
  id: "M_FOUND",
  channelId: design.id,
  userId: owner.id,
  text: "The mockups are ready",
  seq: 4,
  createdAt: Date.UTC(2026, 8, 20, 10, 0),
  editedAt: null,
  threadRootId: null,
  replyCount: 0,
  lastReplyAt: null,
  reactions: [],
  files: [],
  pinned: false,
} as unknown as Message;

const clients: WorkspaceClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

async function workspace() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("max-width"),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const client = new WorkspaceClient("http://127.0.0.1:9", "synthetic-test-token");
  clients.push(client);
  client.store.setState({
    self: owner,
    users: { [owner.id]: owner },
    workspaceId: "W_SEARCH",
    channels: { [general.id]: general, [design.id]: design },
    memberships: { [general.id]: 0, [design.id]: 0 },
    status: "online",
  });
  writeRoute(client.baseUrl, { channelId: general.id, threadRootId: null }, "replace");
  vi.spyOn(client, "loadTimeline").mockResolvedValue();
  vi.spyOn(client, "loadCommands").mockResolvedValue();
  const search = vi
    .spyOn(client.api, "search")
    .mockResolvedValue({ messages: [found], nextCursor: null });
  const platform: Platform = {
    kind: "web",
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
  };
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <WorkspaceScreen
          client={client}
          platform={platform}
          onLeaveWorkspace={() => {}}
          onSignedOut={() => {}}
        />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  // The screen checks the saved access before it shows the workspace.
  const header = await screen.findByRole(
    "searchbox",
    { name: "Search messages" },
    { timeout: 3_000 },
  );
  return { client, search, header };
}

const searchDialog = () => screen.findByRole("dialog", { name: "Search messages" });

// First in the file on purpose: only here has search not been downloaded yet.
describe("search opened before it has downloaded", () => {
  it("keeps what is typed in it when the download lands", async () => {
    const user = userEvent.setup();
    const { client } = await workspace();
    await user.keyboard("{Control>}f{/Control}");
    // The download is still out, so this is the stand-in.
    expect(screen.getByRole("dialog", { name: "Loading search" })).toBeInTheDocument();
    const box = within(await searchDialog()).getByRole("textbox", { name: "Search messages" });
    await user.type(box, "mock");

    // The screen draws itself again, now with search downloaded.
    const launch = room("C_LAUNCH", "launch");
    act(() =>
      client.store.setState((s) => ({
        channels: { ...s.channels, [launch.id]: launch },
        memberships: { ...s.memberships, [launch.id]: 0 },
      })),
    );
    await screen.findAllByText("launch");
    expect(within(await searchDialog()).getByRole("textbox", { name: "Search messages" })).toBe(
      box,
    );
    expect(box).toHaveValue("mock");
  });
});

describe("the header's search box", () => {
  it("carries typing on in search, which follows it without Enter", async () => {
    const user = userEvent.setup();
    const { header, search } = await workspace();
    await user.type(header, "mock");

    const dialog = await searchDialog();
    const box = within(dialog).getByRole("textbox", { name: "Search messages" });
    expect(box).toHaveValue("mock");
    expect(box).toHaveFocus();
    await within(dialog).findByText(/are ready/);
    // One question, once typing paused, and not kept as a recent search:
    // nobody settled on it.
    expect(search.mock.calls.map((call) => call[0])).toEqual(["mock"]);
    expect(within(dialog).queryByRole("list", { name: "Recent searches" })).toBeNull();

    // It goes on following the typing.
    await user.keyboard("ups");
    await waitFor(() => expect(search).toHaveBeenLastCalledWith("mockups", 30, expect.anything()));

    // Closed, focus is back in an empty box, to start another.
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Search messages" })).toBeNull(),
    );
    expect(header).toHaveFocus();
    expect(header).toHaveValue("");
  });

  it("waits for a word an input method is putting together", async () => {
    const { header } = await workspace();
    header.focus();
    fireEvent.compositionStart(header);
    fireEvent.input(header, { target: { value: "もっく" }, isComposing: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("dialog", { name: "Search messages" })).toBeNull();
    expect(header).toHaveValue("もっく");

    fireEvent.compositionEnd(header);
    const box = within(await searchDialog()).getByRole("textbox", { name: "Search messages" });
    expect(box).toHaveValue("もっく");
  });

  it("opens nothing for spaces alone", async () => {
    const user = userEvent.setup();
    const { header } = await workspace();
    await user.type(header, "  ");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("dialog", { name: "Search messages" })).toBeNull();
    expect(header).toHaveValue("  ");
  });
});
