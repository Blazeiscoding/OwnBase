import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { Composer } from "../src/components/Composer.js";
import type { Platform } from "../src/platform.js";

/** Files dragged anywhere over the conversation are offered to its composer. */
const platform: Platform = {
  kind: "web",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};

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

function conversation(role: User["role"] = "member") {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  const self: User = {
    id: "U_SAM",
    handle: "sam",
    displayName: "Sam Rivera",
    role,
    statusText: "",
    statusEmoji: "",
    isBot: false,
    deactivated: false,
    dndUntil: null,
    createdAt: 0,
  };
  client.store.setState({
    self,
    users: { U_SAM: self },
    channels: { [general.id]: general },
    status: "online",
  });
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <main aria-label="Conversation">
          <p>Earlier messages</p>
          <Composer channelId={general.id} placeholder="Message #general" />
        </main>
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  return screen.getByRole("main");
}

const carrying = (files: File[]) => ({ dataTransfer: { types: ["Files"], files } });

describe("dropping files on a conversation", () => {
  it("takes them anywhere on it, says where they go, and attaches them", async () => {
    const main = conversation();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Message #general" })).toBeEnabled(),
    );
    const notes = new File(["hello"], "notes.txt", { type: "text/plain" });
    // Over the messages, well away from the box.
    fireEvent.dragEnter(screen.getByText("Earlier messages"), carrying([notes]));
    expect(screen.getByText("Drop to share in #general")).toBeInTheDocument();
    fireEvent.dragOver(main, carrying([notes]));
    fireEvent.drop(main, carrying([notes]));
    expect(screen.queryByText("Drop to share in #general")).toBeNull();
    expect(await screen.findByText("notes.txt")).toBeInTheDocument();
  });

  it("leaves text being dragged alone", () => {
    conversation();
    fireEvent.dragEnter(screen.getByText("Earlier messages"), {
      dataTransfer: { types: ["text/plain"], files: [] },
    });
    expect(screen.queryByText(/Drop to share/)).toBeNull();
  });

  it("tells a guest why nothing will attach", () => {
    conversation("guest");
    fireEvent.dragEnter(screen.getByText("Earlier messages"), carrying([]));
    expect(screen.getByText("Guests cannot attach files")).toBeInTheDocument();
  });
});
