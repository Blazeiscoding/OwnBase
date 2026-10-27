import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountDialog } from "../src/components/AccountDialog.js";
import { Composer } from "../src/components/Composer.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";

/**
 * What Enter does is a saved choice. One that is saved but cannot be read is
 * not one that was never made: taken for absent, a saved "new line" became
 * the first-use default, and Enter sent a message still being written (Q04).
 */
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

// jsdom lays nothing out, so it has no scrolling to do.
Element.prototype.scrollIntoView ??= () => {};

afterEach(() => vi.restoreAllMocks());

/**
 * Storage as the browser's is: a read that fails is refused when asked for
 * strictly, and otherwise answered as though nothing were saved.
 */
function device(saved: unknown) {
  const state = { saved, refused: false };
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T,>(name: string, options?: { strict?: boolean }) => {
        if (name !== "composer-preferences") return null;
        if (state.refused) {
          if (options?.strict) throw new Error("refused");
          return null;
        }
        return state.saved as T | null;
      },
      set: async (name: string, value: unknown) => {
        if (name === "composer-preferences") state.saved = value;
      },
    },
    notify: () => {},
  };
  return { state, platform };
}

function workspace() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam },
    channels: { [design.id]: design },
    status: "online",
  });
  return client;
}

async function renderComposer(platform: Platform) {
  const client = workspace();
  const send = vi.spyOn(client, "send").mockImplementation(() => true);
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <Composer channelId={design.id} placeholder="Message #design" />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message #design" });
  await waitFor(() => expect(box).toBeEnabled());
  return { send, box };
}

describe("what Enter does in the composer", () => {
  it("stays a new line when the saved choice cannot be read", async () => {
    const user = userEvent.setup();
    const { state, platform } = device({ enterSends: false });
    state.refused = true;
    const { send, box } = await renderComposer(platform);

    await user.type(box, "not finished");
    await user.keyboard("{Enter}");

    expect(send).not.toHaveBeenCalled();
    expect(box).toHaveValue("not finished\n");
  });

  it("stays a new line when what is saved is not a choice at all", async () => {
    const user = userEvent.setup();
    const { platform } = device({ enterSends: "yes" });
    const { send, box } = await renderComposer(platform);

    await user.type(box, "not finished");
    await user.keyboard("{Enter}");

    expect(send).not.toHaveBeenCalled();
    expect(box).toHaveValue("not finished\n");
  });

  it("sends when no choice was ever made, as it always has", async () => {
    const user = userEvent.setup();
    const { platform } = device(null);
    const { send, box } = await renderComposer(platform);

    await user.type(box, "hello");
    await user.keyboard("{Enter}");

    expect(send).toHaveBeenCalledOnce();
  });
});

describe("the Composing settings", () => {
  function renderSettings(platform: Platform) {
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={workspace()}>
          <AccountDialog onClose={() => {}} onSignedOut={() => {}} section="composing" />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const dialog = within(screen.getByRole("dialog", { name: "Account settings" }));
    return { dialog, choice: () => dialog.getByRole("combobox", { name: "When I press Enter" }) };
  }

  it("says the choice could not be read, and reads it when asked to try again", async () => {
    const user = userEvent.setup();
    const { state, platform } = device({ enterSends: true });
    state.refused = true;
    const { dialog, choice } = renderSettings(platform);

    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "Could not load your preference. Enter inserts a new line until you choose again.",
    );
    expect(choice()).toHaveValue("newline");

    // Still refused: asking again says the same, and changes nothing.
    await user.click(dialog.getByRole("button", { name: "Try again" }));
    expect(await dialog.findByRole("alert")).toBeInTheDocument();
    expect(choice()).toHaveValue("newline");

    state.refused = false;
    await user.click(dialog.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(choice()).toHaveValue("send"));
    expect(dialog.queryByRole("alert")).toBeNull();
  });

  it("takes a new choice in place of one it could not read", async () => {
    const user = userEvent.setup();
    const { state, platform } = device({ enterSends: false });
    state.refused = true;
    const { dialog, choice } = renderSettings(platform);
    await dialog.findByRole("alert");

    await user.selectOptions(choice(), "send");
    await waitFor(() => expect(state.saved).toEqual({ enterSends: true }));
    await waitFor(() => expect(dialog.queryByRole("alert")).toBeNull());
    expect(choice()).toHaveValue("send");
  });
});
