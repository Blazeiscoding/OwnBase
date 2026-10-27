import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WorkspaceClient, type HuddlePeer, type HuddleState } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { WorkspaceScreen } from "../src/screens/WorkspaceScreen.js";
import { writeRoute } from "../src/lib/route.js";
import type { Platform } from "../src/platform.js";

/**
 * Where the call goes in the workspace, as Discord lays out a voice channel:
 * beside the chat where there is room for both, over it where there is not.
 */
const person = (id: string, displayName: string): User => ({
  id,
  handle: displayName.toLowerCase(),
  displayName,
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});
const owner = { ...person("U_OWNER", "Owner"), role: "owner" as const };
const maya = person("U_MAYA", "Maya");
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

const peer = (userId: string, media: Partial<HuddlePeer> = {}): HuddlePeer => ({
  userId,
  audioStream: null,
  cameraStream: null,
  screenStream: null,
  connected: true,
  micMuted: false,
  speaking: false,
  ...media,
});
const inCall = (media: Partial<HuddleState> = {}): HuddleState => ({
  channelId: general.id,
  micMuted: false,
  cameraOn: false,
  sharingScreen: false,
  localCameraStream: null,
  localScreenStream: null,
  speaking: false,
  micLost: false,
  peers: [peer(maya.id, { cameraStream: {} as MediaStream })],
  ...media,
});

// jsdom has no media pipeline: a video only needs somewhere to put a stream.
beforeAll(() => {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
});
const clients: WorkspaceClient[] = [];
afterEach(() => {
  // Unmount before the globals go: the setup file's cleanup runs after this hook.
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** The workspace on a desktop window, wide enough for the chat beside a call or not. */
async function workspace(roomForChat: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("1280px") ? roomForChat : !query.includes("max-width"),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const client = new WorkspaceClient("http://127.0.0.1:9", "synthetic-test-token");
  clients.push(client);
  client.store.setState({
    self: owner,
    users: { [owner.id]: owner, [maya.id]: maya },
    workspaceId: "W_CALL_VIEW",
    channels: { [general.id]: general, [design.id]: design },
    memberships: { [general.id]: 0, [design.id]: 0 },
    status: "online",
  });
  writeRoute(client.baseUrl, { channelId: general.id, threadRootId: null }, "replace");
  vi.spyOn(client, "loadTimeline").mockResolvedValue();
  vi.spyOn(client, "loadCommands").mockResolvedValue();
  vi.spyOn(client.api, "channelMembers").mockResolvedValue({ memberIds: [owner.id, maya.id] });
  vi.spyOn(client.api, "listPins").mockResolvedValue({ messages: [], nextCursor: null, total: 0 });
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
  await screen.findByRole("textbox", { name: "Message #general" }, { timeout: 3_000 });
  // Maya's camera is on as you join, which opens the call.
  act(() => client.store.setState({ huddle: inCall() }));
  const call = await screen.findByRole("region", { name: "Huddle call" }, { timeout: 3_000 });
  return { client, call, user: userEvent.setup() };
}

const composer = (channel = "general") =>
  screen.queryByRole("textbox", { name: `Message #${channel}` });

describe("the call in the workspace", () => {
  it("has the chat beside it on a wide window, and can put it away", async () => {
    const { call, user } = await workspace(true);
    expect(composer()).toBeVisible();
    expect(composer()!.closest("[inert]")).toBeNull();
    // The call has the controls, so the bar is not shown twice.
    expect(screen.queryByRole("region", { name: "Active huddle" })).toBeNull();

    await user.click(within(call).getByRole("button", { name: "Chat" }));
    // The call covers the chat, which waits underneath, out of reach.
    expect(composer()).toBeNull();
    expect(document.querySelector(".timeline-scroll")!.closest("[inert]")).not.toBeNull();
    await user.click(within(call).getByRole("button", { name: "Chat" }));
    expect(composer()).toBeVisible();
  });

  it("covers the chat on a narrower window, until you go back to it", async () => {
    const { call, user } = await workspace(false);
    expect(within(call).queryByRole("button", { name: "Chat" })).toBeNull();
    expect(composer()).toBeNull();

    await user.click(within(call).getByRole("button", { name: "Hide call" }));
    expect(screen.queryByRole("region", { name: "Huddle call" })).toBeNull();
    expect(composer()).toBeVisible();
    const bar = screen.getByRole("region", { name: "Active huddle" });
    await user.click(within(bar).getByRole("button", { name: "Show call" }));
    expect(await screen.findByRole("region", { name: "Huddle call" })).toBeVisible();
  });

  it("shows another conversation's chat when it is opened while the call covers the chat", async () => {
    const { user } = await workspace(false);
    const nav = screen.getByRole("navigation", { name: "Workspace navigation" });
    await user.click(within(nav).getByRole("button", { name: "# design" }));
    await waitFor(() => expect(composer("design")).toBeVisible());
    expect(screen.queryByRole("region", { name: "Huddle call" })).toBeNull();
    expect(screen.getByRole("region", { name: "Active huddle" })).toBeVisible();
  });
});
