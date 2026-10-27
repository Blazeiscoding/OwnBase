import { act, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { describe, expect, it } from "vitest";
import { Composer } from "../src/components/Composer.js";
import { ClientContext, PlatformContext } from "../src/context.js";
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
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
  memberIds: [sam.id],
};

/**
 * A composer that asks for focus while its saved scheduling state is still
 * being read, which keeps it disabled. `load` finishes the read.
 */
function renderSlowComposer() {
  let finish!: () => void;
  const read = new Promise<null>((resolve) => (finish = () => resolve(null)));
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam },
    channels: { [design.id]: design },
    status: "online",
  });
  const platform: Platform = {
    kind: "web",
    storage: { get: async <T,>() => (await read) as T | null, set: async () => {} },
    notify: () => {},
  };
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <button>Search</button>
        <Composer channelId={design.id} placeholder="Message #design" autoFocus />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const box = screen.getByRole("textbox", { name: "Message #design" });
  return {
    box,
    load: async () => {
      await act(async () => finish());
      await waitFor(() => expect(box).toBeEnabled());
    },
  };
}

describe("a composer asked to take focus", () => {
  it("takes it once it can, rather than leaving focus nowhere", async () => {
    const { box, load } = renderSlowComposer();
    expect(box).toBeDisabled();
    expect(box).not.toHaveFocus();
    await load();
    expect(box).toHaveFocus();
  });

  it("takes it from the button that opened it, when focus is still there", async () => {
    // Pressed to open a thread, whose reply box then asks for focus.
    const opener = document.body.appendChild(document.createElement("button"));
    opener.textContent = "Reply in thread";
    opener.focus();
    try {
      const { box, load } = renderSlowComposer();
      expect(opener).toHaveFocus();
      await load();
      expect(box).toHaveFocus();
    } finally {
      opener.remove();
    }
  });

  it("leaves focus alone when somebody has moved on while it loaded", async () => {
    const { box, load } = renderSlowComposer();
    const search = screen.getByRole("button", { name: "Search" });
    search.focus();
    await load();
    expect(search).toHaveFocus();
    expect(box).not.toHaveFocus();
  });
});
