import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { Composer } from "../src/components/Composer.js";
import { workspaceStorageKey } from "../src/lib/workspaceStorage.js";
import type { Platform } from "../src/platform.js";

const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

const design: Channel = {
  id: "C_DESIGN",
  type: "public",
  name: "design",
  topic: "",
  description: "",
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
  memberIds: ["U_SAM"],
};

/**
 * The composer for #design, on a device that kept a scheduling request from
 * before the app last closed: the request may or may not have reached the server.
 */
function composerWithSaved(request: unknown) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { U_SAM: sam },
    channels: { C_DESIGN: design },
    status: "online",
  });
  const key = workspaceStorageKey(client.baseUrl, null, sam.id, "schedule-request", design.id)!;
  const saved = new Map<string, unknown>([[key.key, request]]);
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T,>(name: string) => (saved.get(name) ?? null) as T | null,
      set: async (name, value) => {
        saved.set(name, value);
      },
    },
    notify: () => {},
  };
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <Composer channelId={design.id} placeholder="Message #design" />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
}

describe("a scheduling request kept from before the app closed", () => {
  it("is offered for confirmation, with its text back in the composer", async () => {
    composerWithSaved({
      text: "Ship the release notes",
      nonce: "test-nonce-not-a-credential",
      sendAt: Date.now() + 60 * 60 * 1000,
    });
    expect(await screen.findByText(/A scheduling request needs confirmation/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry confirmation" })).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveValue("Ship the release notes");
  });

  it("is refused, keeping the draft, when it is not a request this app could have made", async () => {
    // It carries a nonce, so only the request schema can tell it apart.
    composerWithSaved({ text: 42, nonce: "test-nonce-not-a-credential", sendAt: "soon" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not read the saved scheduling request. Your draft is kept; check Scheduled before sending it again.",
    );
    expect(screen.queryByText(/A scheduling request needs confirmation/)).toBeNull();
  });
});
