import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Api, ApiError, WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, ServerInfo, User } from "@ownbase/protocol";
import { ClientContext } from "../src/context.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
import { SavedPanel } from "../src/components/MessageListPanel.js";
import { MessageTimeline } from "../src/components/MessageTimeline.js";
import { JoinScreen } from "../src/screens/JoinScreen.js";
import { formatFull } from "../src/lib/format.js";
import type { Platform } from "../src/platform.js";

/**
 * Copy and dates (UX-05): sign-in says whether the server was reached at
 * all, lists give a time's whole date as its hint, and a direct message's
 * person is named once.
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
const sam = person("U_SAM", "Sam Rivera");
const omar = person("U_OMAR", "Omar Haddad");

const dm: Channel = {
  id: "D_OMAR",
  type: "dm",
  name: "",
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
  memberIds: [sam.id, omar.id],
};

const message = (id: string, userId: string, text: string, seq: number): Message => ({
  id,
  channelId: dm.id,
  userId,
  text,
  threadRootId: null,
  broadcast: false,
  seq,
  createdAt: new Date(2026, 9, 3, 15, 41).getTime(),
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  actions: [],
});

const clients: WorkspaceClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
});

function samsClient() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam, [omar.id]: omar },
    channels: { [dm.id]: dm },
    memberships: { [dm.id]: 0 },
    status: "online",
  });
  return client;
}

describe("signing in, when it does not work", () => {
  const info: ServerInfo = {
    app: "ownbase",
    protocolVersion: 1,
    serverVersion: "0.0.0-test",
    workspaceName: "Rocket Team",
    userCount: 4,
    requiresInvite: false,
    requiresClaim: false,
  };
  const platform: Platform = {
    kind: "web",
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
  };

  async function signInFailing(reason: unknown) {
    vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(info);
    vi.spyOn(Api.prototype, "login").mockRejectedValue(reason);
    render(
      <JoinScreen
        platform={platform}
        savedServers={[]}
        autoProbe="http://127.0.0.1:9"
        onConnected={() => {}}
        onForget={() => {}}
      />,
    );
    await screen.findByRole("heading", { name: "Rocket Team" });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Username"), "sam");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    return screen.findByRole("alert");
  }

  it("says the server could not be reached only when no answer came", async () => {
    expect(await signInFailing(new TypeError("Failed to fetch"))).toHaveTextContent(
      "Could not reach the server. Check the address and try again.",
    );
  });

  it("says the server took too long when the wait ran out", async () => {
    expect(
      await signInFailing(new DOMException("The operation timed out.", "TimeoutError")),
    ).toHaveTextContent(
      "The server took too long to answer. Check the address and your connection, then try again.",
    );
  });

  it("says too many tries were made when the server is rationing them", async () => {
    expect(
      await signInFailing(
        new ApiError(429, "too_many_requests", "That is more than this workspace allows."),
      ),
    ).toHaveTextContent("Too many tries for now. Wait a minute, then try again.");
  });

  it("repeats what the server said about a refusal it explained", async () => {
    expect(
      await signInFailing(new ApiError(403, "account_locked", "This account is locked.")),
    ).toHaveTextContent("This account is locked.");
  });

  it("says the server had a problem when it failed", async () => {
    expect(await signInFailing(new ApiError(503, "http_error"))).toHaveTextContent(
      "The workspace's server ran into a problem.",
    );
  });

  it("names a refusal the server did not explain", async () => {
    expect(await signInFailing(new ApiError(409, "not_now"))).toHaveTextContent(
      "The workspace's server turned that down (not_now).",
    );
  });
});

describe("a direct message in Saved", () => {
  it("names the person once, and gives the whole date as the time's hint", async () => {
    const client = samsClient();
    client.store.setState({ saved: { M1: true, M2: true } });
    vi.spyOn(client.api, "listSaved").mockResolvedValue({
      messages: [
        message("M1", omar.id, "Lunch at one?", 2),
        message("M2", sam.id, "See you there.", 1),
      ],
      nextCursor: null,
    });
    render(
      <ClientContext.Provider value={client}>
        <SavedPanel onClose={vi.fn()} onJump={vi.fn()} />
      </ClientContext.Provider>,
    );
    const panel = screen.getByRole("complementary", { name: "Saved" });
    const fromOmar = (await within(panel).findByText("Lunch at one?")).closest("li")!;
    // Omar wrote it, so the row names him as its author and the conversation once.
    expect(within(fromOmar).getAllByText("Omar Haddad")).toHaveLength(1);
    expect(within(fromOmar).getByText("Direct message")).toBeVisible();
    expect(fromOmar.querySelector("time")).toHaveAttribute(
      "title",
      formatFull(message("M1", omar.id, "", 2).createdAt),
    );
    // Sam's own message says whom it went to.
    const fromSam = within(panel).getByText("See you there.").closest("li")!;
    expect(within(fromSam).getByText("Omar Haddad")).toBeVisible();
    expect(within(fromSam).getByText("Sam Rivera")).toBeVisible();
  });
});

describe("the start of a direct message", () => {
  it("names the person in its heading only", async () => {
    const client = samsClient();
    vi.spyOn(client.api, "listMessages").mockResolvedValue({ messages: [], readThroughSeq: 0 });
    render(
      <ToastProvider>
        <ConfirmProvider>
          <ClientContext.Provider value={client}>
            <MessageTimeline
              channelId={dm.id}
              onOpenThread={vi.fn()}
              onChannelClick={vi.fn()}
              onOpenProfile={vi.fn()}
            />
          </ClientContext.Provider>
        </ConfirmProvider>
      </ToastProvider>,
    );
    const heading = await screen.findByRole("heading", { name: "Omar Haddad" });
    const intro = heading.parentElement!;
    await waitFor(() => expect(intro).toHaveTextContent("Your direct messages start here."));
    expect(within(intro).getAllByText(/Omar Haddad/)).toHaveLength(1);
  });
});
