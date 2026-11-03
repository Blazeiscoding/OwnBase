import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { FileMeta } from "@ownbase/protocol";
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

function open(file: FileMeta, gallery?: FileMeta[]) {
  const { createObjectURL, revokeObjectURL } = URL;
  onTestFinished(() => void Object.assign(URL, { createObjectURL, revokeObjectURL }));
  let made = 0;
  URL.createObjectURL = vi.fn(() => `blob:test/${made++}`);
  URL.revokeObjectURL = vi.fn();
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  vi.spyOn(client.api, "fetchFile").mockResolvedValue(new Blob(["png!"]));
  render(
    <ClientContext.Provider value={client}>
      <Lightbox file={file} gallery={gallery} onClose={() => {}} />
    </ClientContext.Provider>,
  );
}

describe("the image viewer", () => {
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

  it("shows one picture alone, with no arrows", async () => {
    open(first, [first]);
    expect(await screen.findByRole("img", { name: "before.png" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next image" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Image before.png" })).toBeTruthy();
  });
});
