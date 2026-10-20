import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient, previewImageKey } from "@slackoss/client-core";
import type { Channel, LinkPreview, Message, User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { MessageItem } from "../src/components/MessageItem.js";
import { ToastProvider } from "../src/components/Toast.js";
import { WorkspaceSettings } from "../src/components/WorkspaceSettings.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/** Link previews (E2): the cards under a message, and turning them off. */
const person = (id: string, displayName: string, role: User["role"] = "member"): User => ({
  id,
  handle: displayName.split(" ")[0]!.toLowerCase(),
  displayName,
  role,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});
const sam = person("U_SAM", "Sam Rivera", "owner");
const priya = person("U_PRIYA", "Priya Shah");
const general: Channel = {
  id: "C_GENERAL",
  type: "public",
  name: "general",
  topic: "",
  description: "",
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
};
const platform: Platform = {
  kind: "web",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};
const launch: LinkPreview = {
  id: "P_LAUNCH",
  url: "https://news.example/launch",
  title: "Launch day",
  description: "Everything ships at noon.",
  siteName: "Example News",
  image: { width: 1200, height: 630 },
};
const docs: LinkPreview = {
  id: "P_DOCS",
  url: "https://docs.example/plan",
  title: "The plan",
  description: "",
  siteName: "Docs",
  image: { width: 64, height: 64 },
};
const message = (over: Partial<Message> = {}): Message => ({
  id: "M_1",
  channelId: "C_GENERAL",
  userId: "U_PRIYA",
  text: "Read https://news.example/launch and https://docs.example/plan",
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
  previews: [launch, docs],
  ...over,
});

const clients: WorkspaceClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
});

function workspace(self: User, state: { linkPreviews?: boolean | null } = {}) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({
    self,
    users: { U_SAM: sam, U_PRIYA: priya },
    channels: { C_GENERAL: general },
    memberships: { C_GENERAL: 0 },
    status: "online",
    workspaceName: "Rocket Team",
    workspaceSettings: true,
    accessPolicy: "account_required",
    linkPreviews: state.linkPreviews === undefined ? true : state.linkPreviews,
  });
  return client;
}

function shown(item: Message, self: User = sam) {
  const client = workspace(self);
  const images = vi.spyOn(client.files, "get").mockImplementation(async (key) => `blob:${key}`);
  vi.spyOn(client.files, "peek").mockImplementation((key) => `blob:${key}`);
  render(
    <ToastProvider>
      <ConfirmProvider>
        <ClientContext.Provider value={client}>
          <main>
            <MessageItem message={item} compact={false} />
          </main>
        </ClientContext.Provider>
      </ConfirmProvider>
    </ToastProvider>,
  );
  return { client, images, user: userEvent.setup() };
}

describe("a message's link previews", () => {
  it("show each page's site, title as a link, description and picture, from the server", async () => {
    const { images } = shown(message());
    const row = screen.getByRole("article", { name: "Message from Priya Shah" });
    const title = within(row).getByRole("link", { name: "Launch day" });
    expect(title).toHaveAttribute("href", "https://news.example/launch");
    expect(title).toHaveAttribute("target", "_blank");
    expect(title).toHaveAttribute("rel", "noreferrer");
    expect(within(row).getByText("Example News")).toBeVisible();
    expect(within(row).getByText("Everything ships at noon.")).toBeVisible();
    expect(within(row).getByRole("link", { name: "The plan" })).toBeVisible();
    await waitFor(() => expect(images).toHaveBeenCalledWith(previewImageKey("P_LAUNCH")));
    expect(images).toHaveBeenCalledWith(previewImageKey("P_DOCS"));
    const pictures = row.querySelectorAll("img");
    expect([...pictures].map((img) => img.getAttribute("src"))).toEqual([
      "blob:preview:P_LAUNCH",
      "blob:preview:P_DOCS",
    ]);
    // The wide picture's room is kept before it loads, so nothing jumps.
    expect(pictures[0]!.parentElement!.style.aspectRatio).toBe("1200 / 630");
    expect(await accessibilityProblems(document.body)).toEqual([]);
  });

  it("can be removed by their sender only", async () => {
    shown(message());
    expect(screen.queryByRole("button", { name: /Remove the preview/ })).toBeNull();
    cleanup();

    const { client, user } = shown(message(), priya);
    const remove = vi.spyOn(client, "removeLinkPreview").mockResolvedValue();
    await user.click(screen.getByRole("button", { name: "Remove the preview of Launch day" }));
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ id: "M_1" }), "P_LAUNCH");
  });

  it("says so when a removal is refused", async () => {
    const { client, user } = shown(message(), priya);
    vi.spyOn(client, "removeLinkPreview").mockRejectedValue(new Error("offline"));
    await user.click(screen.getByRole("button", { name: "Remove the preview of The plan" }));
    expect(await screen.findByText("The preview was not removed. Try again.")).toBeVisible();
  });

  it("make a link only of a web address, and show nothing for a message without them", () => {
    shown(
      message({
        previews: [{ ...launch, url: "javascript:alert(1)", image: null }],
      }),
    );
    expect(screen.queryByRole("link", { name: "Launch day" })).toBeNull();
    expect(screen.getByText("Launch day")).toBeVisible();
    cleanup();
    shown(message({ previews: undefined }));
    expect(screen.queryByText("Example News")).toBeNull();
  });
});

describe("turning link previews off", () => {
  function settings(state: { linkPreviews?: boolean | null } = {}) {
    const client = workspace(sam, state);
    const change = vi
      .spyOn(client.api, "setLinkPreviews")
      .mockImplementation(async (enabled) => ({ enabled }));
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <ConfirmProvider>
            <WorkspaceSettings onClose={() => {}} />
          </ConfirmProvider>
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Workspace settings" });
    return { client, change, dialog, user: userEvent.setup() };
  }

  it("is a choice in General, saved as soon as it changes", async () => {
    const { client, change, dialog, user } = settings();
    const box = within(dialog).getByRole("checkbox", {
      name: /Show a preview of web pages linked in messages/,
    });
    expect(box).toBeChecked();
    await user.click(box);
    expect(change).toHaveBeenCalledWith(false);
    await waitFor(() => expect(client.state.linkPreviews).toBe(false));
    expect(box).not.toBeChecked();
    expect(await within(dialog).findByText("Saved")).toBeVisible();
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("says why when the server refuses, and keeps what it had", async () => {
    const { change, dialog, user } = settings();
    change.mockRejectedValue(new ApiError(403, "admin_only", "Admins only"));
    const box = within(dialog).getByRole("checkbox", {
      name: /Show a preview of web pages linked in messages/,
    });
    await user.click(box);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Only the workspace's owner and admins can change link previews.",
    );
    expect(box).toBeChecked();
  });

  it("is not offered by a server without previews", () => {
    const { dialog } = settings({ linkPreviews: null });
    expect(within(dialog).queryByText("Link previews")).toBeNull();
  });
});
