import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { ClientContext, OpenMessageContext, PlatformContext } from "../src/context.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
import { WorkspaceScreen } from "../src/screens/WorkspaceScreen.js";
import type { Platform } from "../src/platform.js";
import { AppNotices } from "./workspaceParts.js";

/** A link to one message, opened as the workspace starts (a browser's address, the desktop app's link). */
const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
  canInvite: true,
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
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
});
const general = room("C_GENERAL", "general");
const engineering = room("C_ENGINEERING", "engineering");

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

function openAt(
  target: { channelId: string; messageId: string },
  answer: () => Promise<string | null | undefined>,
) {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
    onTestFinished(() => void delete (Element.prototype as Partial<Element>).scrollIntoView);
  }
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam },
    channels: { [general.id]: general, [engineering.id]: engineering },
    memberships: { [general.id]: 9, [engineering.id]: 9 },
    status: "online",
  });
  const load = vi.spyOn(client, "loadTimeline").mockResolvedValue();
  vi.spyOn(client, "loadCommands").mockResolvedValue();
  const jump = vi.spyOn(client, "jumpToMessage").mockImplementation(answer);
  render(
    <PlatformContext.Provider value={platform}>
      <ToastProvider>
        <ConfirmProvider>
          <ClientContext.Provider value={client}>
            <OpenMessageContext.Provider value={vi.fn()}>
              <AppNotices>
                <WorkspaceScreen
                  client={client}
                  platform={platform}
                  initialTarget={target}
                  onLeaveWorkspace={() => {}}
                  onSignedOut={() => {}}
                />
              </AppNotices>
            </OpenMessageContext.Provider>
          </ClientContext.Provider>
        </ConfirmProvider>
      </ToastProvider>
    </PlatformContext.Provider>,
  );
  return { client, load, jump };
}

describe("a link to a message, opened as the workspace starts", () => {
  it("reads the conversation from its newest when the message is gone, and says so", async () => {
    const { load } = openAt({ channelId: engineering.id, messageId: "M_DELETED" }, () =>
      Promise.reject(Object.assign(new Error("not found"), { status: 404 })),
    );
    expect(
      await screen.findByText(/^Could not open this message\./, undefined, { timeout: 3_000 }),
    ).toBeTruthy();
    // The conversation was anchored on the message before the jump, and an
    // anchored timeline never reads its own history: it stayed a skeleton.
    await waitFor(() =>
      expect(load).toHaveBeenCalledWith(engineering.id, expect.objectContaining({ older: false })),
    );
    expect(screen.getByRole("textbox", { name: "Message #engineering" })).toBeTruthy();
  });

  it("leaves the conversation to the jump when the message is there", async () => {
    const { load, jump } = openAt({ channelId: engineering.id, messageId: "M_THERE" }, () =>
      Promise.resolve(null),
    );
    await waitFor(() => expect(jump).toHaveBeenCalledWith(engineering.id, "M_THERE"));
    await screen.findByRole("textbox", { name: "Message #engineering" });
    expect(screen.queryByText(/^Could not open this message\./)).toBeNull();
    expect(load).not.toHaveBeenCalledWith(
      engineering.id,
      expect.objectContaining({ older: false }),
    );
  });
});
