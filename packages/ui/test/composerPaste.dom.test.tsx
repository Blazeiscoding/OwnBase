import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { describe, expect, it } from "vitest";
import { Composer } from "../src/components/Composer.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";

/**
 * Pasting into the composer (UX-04). A clipboard holding a file is pasted as
 * the file, even when it holds text too, as a copy from an office app does: a
 * picture of the selection beside its text. The composer says the text was
 * left out, so it does not go missing unremarked.
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

async function composer() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam },
    channels: { [design.id]: design },
    status: "online",
  });
  const platform: Platform = {
    kind: "web",
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
  };
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <Composer channelId={design.id} placeholder="Message #design" />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message #design" });
  await waitFor(() => expect(box).toBeEnabled());
  return box;
}

const picture = () => new File([new Uint8Array(64)], "image.png", { type: "image/png" });

/** A clipboard as a paste event carries it: its files, its items and its text. */
function clipboard(opts: { files?: File[]; items?: File[]; text?: string }) {
  return {
    files: opts.files ?? [],
    items: (opts.items ?? []).map((file) => ({ kind: "file", getAsFile: () => file })),
    getData: (type: string) => (type === "text/plain" ? (opts.text ?? "") : ""),
  };
}

describe("pasting into the composer", () => {
  it("attaches the picture an office copy carries, says its text was left out, and pastes none of it", async () => {
    const box = await composer();
    const pasted = fireEvent.paste(box, {
      clipboardData: clipboard({ files: [picture()], text: "Q3 revenue\t1.2m" }),
    });
    expect(pasted).toBe(false);
    expect(await screen.findByText("image.png")).toBeVisible();
    expect(box).toHaveValue("");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The clipboard's file was attached; the text copied with it was not pasted.",
    );
  });

  it("attaches a screenshot without a word about text it never had", async () => {
    const box = await composer();
    fireEvent.paste(box, { clipboardData: clipboard({ files: [picture()] }) });
    expect(await screen.findByText("image.png")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("finds a picture offered only as a clipboard item", async () => {
    const box = await composer();
    const pasted = fireEvent.paste(box, { clipboardData: clipboard({ items: [picture()] }) });
    expect(pasted).toBe(false);
    expect(await screen.findByText("image.png")).toBeVisible();
  });

  it("leaves plain text to paste as text", async () => {
    const box = await composer();
    const pasted = fireEvent.paste(box, { clipboardData: clipboard({ text: "just words" }) });
    // Not prevented: the browser pastes it into the box as usual.
    expect(pasted).toBe(true);
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
