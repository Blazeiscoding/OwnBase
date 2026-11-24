import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { render } from "./render.js";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { FileMeta, User } from "@ownbase/protocol";
import { ClientContext } from "../src/context.js";
import { Lightbox } from "../src/components/Attachments.js";

/** A message's pictures, stepped through in the image viewer as Slack and Discord do. */
const picture = (id: string, name: string): FileMeta =>
  ({ id: `01HZZZZZZZZZZZZZZZZZZZZZ${id}`, name, mime: "image/png", size: 4 }) as FileMeta;
const first = picture("A1", "before.png");
const second = picture("A2", "after.png");
const third = picture("A3", "detail.png");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const priya = {
  id: "U_PRIYA",
  handle: "priya",
  displayName: "Priya Natarajan",
  role: "member",
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
} as User;

function open(
  file: FileMeta,
  gallery?: FileMeta[],
  context: { from?: { userId: string; at: number }; onOpenMessage?: () => void } = {},
) {
  const { createObjectURL, revokeObjectURL } = URL;
  onTestFinished(() => void Object.assign(URL, { createObjectURL, revokeObjectURL }));
  let made = 0;
  URL.createObjectURL = vi.fn(() => `blob:test/${made++}`);
  URL.revokeObjectURL = vi.fn();
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  vi.spyOn(client.api, "fetchFile").mockResolvedValue(new Blob(["png!"]));
  client.store.setState({ users: { [priya.id]: priya } });
  const onClose = vi.fn();
  render(
    <ClientContext.Provider value={client}>
      <Lightbox file={file} gallery={gallery} onClose={onClose} {...context} />
    </ClientContext.Provider>,
  );
  return { onClose };
}

describe("the image viewer", () => {
  it("puts the name and its buttons on a solid bar, readable over the dimmed page in either theme", async () => {
    open(first);
    const bar = (await screen.findByRole("button", { name: "Save" })).parentElement!;
    expect(bar).toHaveTextContent("before.png");
    // The theme's own surface, so White's dark text never sits on the black backdrop.
    expect(bar).toHaveClass("bg-raised");
    expect(bar.className).not.toMatch(/bg-[a-z-]+\/\d/);
  });

  it("steps through a message's pictures from the one opened, round from the last", async () => {
    const user = userEvent.setup();
    open(second, [first, second, third]);
    expect(await screen.findByRole("img", { name: "after.png" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Image after.png, 2 of 3" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Next image" }));
    expect(await screen.findByRole("img", { name: "detail.png" })).toBeTruthy();
    // On from the last is the first again: the arrow never goes dead under focus.
    await user.click(screen.getByRole("button", { name: "Next image" }));
    expect(await screen.findByRole("img", { name: "before.png" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next image" })).toHaveFocus();

    // The keys work wherever focus is in the viewer.
    screen.getByRole("button", { name: "Close" }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(await screen.findByRole("img", { name: "detail.png" })).toBeTruthy();
    expect(screen.getByText("3 of 3")).toBeTruthy();
  });

  // The desktop app and the browser both take this road: an anchor with a
  // download name. In the desktop app that opens the Save dialog with the name
  // filled in, and the window says "Saved" once the file is written.
  it("saves the picture on show, under its own name, even one that cannot be previewed", async () => {
    const user = userEvent.setup();
    const saved: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push({ href: this.href, download: this.download });
    });
    open(first, [first, second]);
    expect(await screen.findByRole("img", { name: "before.png" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Next image" }));
    const shown = await screen.findByRole("img", { name: "after.png" });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saved).toEqual([{ href: "blob:test/1", download: "after.png" }]);

    // A picture the browser cannot draw is still the file someone sent.
    shown.dispatchEvent(new Event("error"));
    expect(
      await screen.findByText(
        "This image cannot be previewed. You can still save the original file.",
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saved).toEqual([
      { href: "blob:test/1", download: "after.png" },
      { href: "blob:test/1", download: "after.png" },
    ]);
  });

  it("says who shared it and when, and opens the message it came in", async () => {
    const user = userEvent.setup();
    const at = new Date(2026, 10, 24, 9, 30).getTime();
    const onOpenMessage = vi.fn();
    const { onClose } = open(first, undefined, { from: { userId: priya.id, at }, onOpenMessage });
    const bar = (await screen.findByRole("button", { name: "Save" })).parentElement!;
    expect(bar).toHaveTextContent("Priya Natarajan");
    expect(bar).toHaveTextContent(/9:30/);
    await user.click(screen.getByRole("button", { name: "Open in conversation" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onOpenMessage).toHaveBeenCalledOnce();
  });

  it("offers no way to the message when it is opened from that message", async () => {
    open(first, undefined, { from: { userId: priya.id, at: 0 } });
    await screen.findByRole("button", { name: "Save" });
    expect(screen.queryByRole("button", { name: "Open in conversation" })).toBeNull();
  });

  it("shows one picture alone, with no arrows", async () => {
    open(first, [first]);
    expect(await screen.findByRole("img", { name: "before.png" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next image" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Image before.png" })).toBeTruthy();
  });
});
