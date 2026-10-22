import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Channel, SharedFile, User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";
import { FilesPanel } from "../src/components/FilesPanel.js";
import { Sidebar } from "../src/components/Sidebar.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * The file browser (E7): it lists what the server says, narrows by kind,
 * person, conversation and name, reads more, opens a picture, saves a
 * document, goes to the message, and is offered only where the server lists files.
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
const room = (id: string, name: string): Channel => ({
  id,
  type: "public",
  name,
  topic: "",
  description: "",
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
});
const sam = person("U_SAM", "Sam Rivera");
const priya = person("U_PRIYA", "Priya Shah");
const general = room("C_GENERAL", "general");
const design = room("C_DESIGN", "design");
const at = Date.UTC(2026, 9, 22, 9, 30);
const shared = (
  id: string,
  name: string,
  mime: string,
  over: Partial<SharedFile> = {},
): SharedFile => ({
  file: { id, name, mime, size: 2048, width: null, height: null },
  messageId: `M_${id}`,
  channelId: "C_DESIGN",
  threadRootId: null,
  userId: "U_PRIYA",
  sharedAt: at,
  ...over,
});
const mock = shared("F_MOCK", "mockup.png", "image/png");
const brief = shared("F_BRIEF", "brief.pdf", "application/pdf", {
  userId: "U_SAM",
  channelId: "C_GENERAL",
});

const clients: WorkspaceClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
});

function opened(pages: { files: SharedFile[]; nextCursor: string | null }[] = []) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({
    self: sam,
    users: { U_SAM: sam, U_PRIYA: priya },
    channels: { C_GENERAL: general, C_DESIGN: design },
    memberships: { C_GENERAL: 0, C_DESIGN: 0 },
    status: "online",
    sharedFiles: true,
  });
  const list = vi
    .spyOn(client.api, "listSharedFiles")
    .mockImplementation(async () => pages.shift() ?? { files: [mock, brief], nextCursor: null });
  vi.spyOn(client.files, "get").mockResolvedValue("blob:file");
  vi.spyOn(client.files, "peek").mockReturnValue("blob:file");
  const onJump = vi.fn();
  const platform: Platform = {
    kind: "web",
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
  };
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <FilesPanel onClose={vi.fn()} onJump={onJump} />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  return { client, list, onJump, user: userEvent.setup() };
}

const panel = () => screen.getByRole("complementary", { name: "Files" });
const rows = () =>
  within(screen.getByRole("list", { name: "Files" }))
    .queryAllByRole("button", { name: /^(Open|Download) / })
    .map((button) => button.getAttribute("aria-label"));

describe("the file browser", () => {
  it("lists the files shared, newest first, each with who, where and when", async () => {
    const { list } = opened();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(list).toHaveBeenCalledWith({}, undefined, expect.any(AbortSignal));
    expect(rows()).toEqual([
      expect.stringMatching(/^Open mockup\.png, 2\.0 KB, from Priya Shah in design, /),
      expect.stringMatching(/^Download brief\.pdf, 2\.0 KB, from Sam Rivera in general, /),
    ]);
    expect(panel()).toHaveTextContent("Priya Shah in design");
    expect(await accessibilityProblems(panel())).toEqual([]);
  });

  it("narrows by kind, person, conversation and name, and clears back", async () => {
    const { list, user } = opened([
      { files: [mock, brief], nextCursor: null },
      { files: [mock], nextCursor: null },
      { files: [mock], nextCursor: null },
      { files: [mock], nextCursor: null },
      { files: [], nextCursor: null },
    ]);
    await waitFor(() => expect(rows()).toHaveLength(2));

    await user.click(screen.getByRole("tab", { name: "Images" }));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({ kind: "image" }, undefined, expect.any(AbortSignal)),
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "From" }), "U_PRIYA");
    await user.selectOptions(screen.getByRole("combobox", { name: "In" }), "C_DESIGN");
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(
        { kind: "image", userId: "U_PRIYA", channelId: "C_DESIGN" },
        undefined,
        expect.any(AbortSignal),
      ),
    );
    // Typing settles before the list is asked again, once for the words.
    const calls = list.mock.calls.length;
    await user.type(screen.getByRole("searchbox", { name: "Search files by name" }), "  zebra ");
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(
        { kind: "image", userId: "U_PRIYA", channelId: "C_DESIGN", q: "zebra" },
        undefined,
        expect.any(AbortSignal),
      ),
    );
    expect(list.mock.calls.length).toBe(calls + 1);
    expect(await screen.findByText(/No files match/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({}, undefined, expect.any(AbortSignal)),
    );
    expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("combobox", { name: "From" })).toHaveValue("");
    expect(screen.getByRole("searchbox", { name: "Search files by name" })).toHaveValue("");
  });

  it("offers the conversations this person can read, and everyone", async () => {
    opened();
    await waitFor(() => expect(rows()).toHaveLength(2));
    const options = (name: string) =>
      within(screen.getByRole("combobox", { name }))
        .getAllByRole("option")
        .map((o) => o.textContent);
    expect(options("From")).toEqual(["Anyone", "Priya Shah", "Sam Rivera (you)"]);
    expect(options("In")).toEqual(["Anywhere", "design", "general"]);
  });

  it("reads the next page from where the last ended", async () => {
    const { list, user } = opened([
      { files: [mock], nextCursor: "M_F_MOCK:F_MOCK" },
      { files: [brief], nextCursor: null },
    ]);
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(list).toHaveBeenLastCalledWith({}, "M_F_MOCK:F_MOCK", expect.any(AbortSignal));
  });

  it("opens a picture in the viewer, saves anything else, and goes to the message", async () => {
    const { onJump, user } = opened();
    await waitFor(() => expect(rows()).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: /^Open mockup\.png/ }));
    expect(await screen.findByRole("dialog", { name: "Image mockup.png" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const saved = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await user.click(screen.getByRole("button", { name: /^Download brief\.pdf/ }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect((saved.mock.contexts[0] as HTMLAnchorElement).download).toBe("brief.pdf");

    await user.click(screen.getByRole("button", { name: "Show brief.pdf in conversation" }));
    expect(onJump).toHaveBeenCalledWith("C_GENERAL", "M_F_BRIEF");
  });

  it("says when nothing has been shared yet", async () => {
    opened([{ files: [], nextCursor: null }]);
    expect(await screen.findByText(/No files shared yet/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });
});

describe("the sidebar's Files row", () => {
  function sidebar(onFiles?: () => void) {
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    clients.push(client);
    client.store.setState({
      self: sam,
      users: { U_SAM: sam },
      channels: { C_GENERAL: general },
      memberships: { C_GENERAL: 0 },
      status: "online",
      workspaceName: "Rocket Team",
    });
    render(
      <ClientContext.Provider value={client}>
        <Sidebar
          activeChannelId={general.id}
          onSelect={vi.fn()}
          onBrowseChannels={vi.fn()}
          onNewChannel={vi.fn()}
          onNewDm={vi.fn()}
          onFriends={vi.fn()}
          onSearch={vi.fn()}
          onSaved={vi.fn()}
          onFiles={onFiles}
          openPanel="files"
          onActivity={vi.fn()}
          onThreads={vi.fn()}
          onEditProfile={vi.fn()}
          onInvite={vi.fn()}
          onChannelDetails={vi.fn()}
          onSwitchWorkspace={vi.fn()}
          onAccountSettings={vi.fn()}
          connectionLabel={null}
        />
      </ClientContext.Provider>,
    );
  }

  it("opens Files, and is there only where the server lists files", async () => {
    const onFiles = vi.fn();
    sidebar(onFiles);
    const row = screen.getByRole("button", { name: /^Files/ });
    await userEvent.setup().click(row);
    expect(onFiles).toHaveBeenCalled();
  });

  it("is left out where the server does not list files", () => {
    sidebar(undefined);
    expect(screen.queryByRole("button", { name: /^Files/ })).toBeNull();
  });
});
