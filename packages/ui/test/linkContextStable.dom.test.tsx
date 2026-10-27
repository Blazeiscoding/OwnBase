import { Profiler, type ProfilerOnRenderCallback } from "react";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, User } from "@ownbase/protocol";
import { ClientContext } from "../src/context.js";
import { MessageItem } from "../src/components/MessageItem.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
import { ShareableServerProvider, useShareableServer } from "../src/components/ShareableServer.js";
import type { HostingStatus, Platform } from "../src/platform.js";

/**
 * The address links are built on changes rarely; the hosting status it is
 * read from changes with every connection and backup. Message rows, under
 * the real link provider, render again only when a link would change
 * (REV-03). Each row sits in its own Profiler, as in the OPT-05 row tests.
 */
const ROWS = 30;
const sam: User = {
  id: "U0",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "owner",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};
const general: Channel = {
  id: "C_GENERAL",
  type: "public",
  name: "general",
  topic: "",
  description: "",
  creatorId: "U0",
  archived: false,
  createdAt: 0,
  memberIds: ["U0"],
};
const hostingHere: HostingStatus = {
  running: true,
  phase: "running",
  port: 8543,
  lanUrls: ["http://192.168.1.20:8543"],
  connected: 1,
};

function rows(): Message[] {
  return Array.from({ length: ROWS }, (_, i) => ({
    id: `M${String(i).padStart(3, "0")}`,
    channelId: "C_GENERAL",
    userId: "U0",
    // A link into this workspace, which rows rewrite to the shareable address.
    text: `see <http://127.0.0.1:8543/#/c/C_GENERAL/M${i}|message ${i}>`,
    threadRootId: null,
    broadcast: false,
    seq: i + 1,
    createdAt: i * 60_000,
    editedAt: null,
    nonce: null,
    replyCount: 0,
    reactions: [],
    files: [],
    pinned: false,
    actions: [],
  }));
}

function setup() {
  const client = new WorkspaceClient("http://127.0.0.1:8543", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { U0: sam },
    channels: { C_GENERAL: general },
    memberships: { C_GENERAL: ROWS },
    status: "connecting",
  });
  let push!: (status: HostingStatus) => void;
  const platform = {
    kind: "desktop",
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
    hosting: {
      status: async () => hostingHere,
      start: vi.fn(),
      stop: vi.fn(),
      subscribe: (listener: (status: HostingStatus) => void) => {
        push = listener;
        return () => {};
      },
    },
  } as unknown as Platform;
  function Link() {
    return <span data-testid="link">{useShareableServer().serverUrl}</span>;
  }
  const rendered = new Set<string>();
  const onRender: ProfilerOnRenderCallback = (id) => void rendered.add(id);
  render(
    <ToastProvider>
      <ConfirmProvider>
        <ClientContext.Provider value={client}>
          <ShareableServerProvider platform={platform}>
            <Link />
            {rows().map((message) => (
              <Profiler key={message.id} id={message.id} onRender={onRender}>
                <MessageItem message={message} compact={false} />
              </Profiler>
            ))}
          </ShareableServerProvider>
        </ClientContext.Provider>
      </ConfirmProvider>
    </ToastProvider>,
  );
  /** The rows that render for one hosting status. */
  const renderedBy = (status: HostingStatus) => {
    rendered.clear();
    act(() => push(status));
    return rendered.size;
  };
  return { renderedBy };
}

describe("message rows under the link provider (REV-03)", () => {
  it("render no row when only the connected count or other hosting details change", async () => {
    const { renderedBy } = setup();
    expect(await screen.findByTestId("link")).toHaveTextContent("http://192.168.1.20:8543");
    for (let connected = 2; connected < 12; connected++)
      expect(renderedBy({ ...hostingHere, connected })).toBe(0);
    expect(renderedBy({ ...hostingHere, startsOnLaunch: true, inviteOnly: true })).toBe(0);
  });

  it("render every row when the address links carry changes", async () => {
    const { renderedBy } = setup();
    await screen.findByTestId("link");
    expect(renderedBy({ ...hostingHere, lanUrls: ["http://192.168.1.44:8543"] })).toBe(ROWS);
    expect(screen.getByTestId("link")).toHaveTextContent("http://192.168.1.44:8543");
    expect(
      renderedBy({
        ...hostingHere,
        openToAll: { phase: "open", url: "https://rocket.example.com" },
      }),
    ).toBe(ROWS);
    expect(screen.getByTestId("link")).toHaveTextContent("https://rocket.example.com");
  });
});
