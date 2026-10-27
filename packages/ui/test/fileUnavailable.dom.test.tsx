import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ApiError, WorkspaceClient } from "@ownbase/client-core";
import type { FileMeta, Message, ServerToClient } from "@ownbase/protocol";
import { ClientContext } from "../src/context.js";
import { Lightbox } from "../src/components/Attachments.js";

/** An open image whose message is deleted, or whose conversation is lost, says so (F07). */
const file: FileMeta = {
  id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
  name: "plan.png",
  mime: "image/png",
  size: 4,
} as FileMeta;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("an open image that is taken away (F07)", () => {
  function objectUrls() {
    const urls = new Set<string>();
    // jsdom has neither; the browser's are what the cache uses.
    const { createObjectURL, revokeObjectURL } = URL;
    onTestFinished(() => {
      Object.assign(URL, { createObjectURL, revokeObjectURL });
    });
    let made = 0;
    URL.createObjectURL = vi.fn(() => {
      const url = `blob:test/${made++}`;
      urls.add(url);
      return url;
    });
    URL.revokeObjectURL = vi.fn((url: string) => void urls.delete(url));
    return urls;
  }

  function open(client: WorkspaceClient) {
    render(
      <ClientContext.Provider value={client}>
        <Lightbox file={file} onClose={() => {}} />
      </ClientContext.Provider>,
    );
  }

  it("stops showing a file the server now refuses, and says it is unavailable", async () => {
    const urls = objectUrls();
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    const fetchFile = vi.spyOn(client.api, "fetchFile").mockResolvedValue(new Blob(["png!"]));
    open(client);
    expect(await screen.findByRole("img", { name: "plan.png" })).toBeTruthy();

    // Deleted: asked again, the server says it is not there.
    fetchFile.mockRejectedValue(new ApiError(404, "file_not_found"));
    act(() => client.files.invalidate(file.id));
    expect(screen.queryByRole("img", { name: "plan.png" })).toBeNull();
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /unavailable or you no longer have access/i,
    );
    expect(urls.size).toBe(0);
  });

  it("shows a file again that was only perhaps taken away, and is still readable", async () => {
    objectUrls();
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    const fetchFile = vi.spyOn(client.api, "fetchFile").mockResolvedValue(new Blob(["png!"]));
    open(client);
    expect(await screen.findByRole("img", { name: "plan.png" })).toBeTruthy();

    // A file whose conversation was not known goes with any lost access.
    act(() => client.files.invalidateChannel("C_ELSEWHERE"));
    expect(await screen.findByRole("img", { name: "plan.png" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchFile).toHaveBeenCalledTimes(2);
  });

  it("removes an open reply image when retention removes its thread, even after history eviction", async () => {
    const urls = objectUrls();
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    onTestFinished(() => client.destroy());
    const reply: Message = {
      id: "M_REPLY",
      channelId: "C1",
      userId: "U1",
      text: "Plan",
      threadRootId: "M_ROOT",
      broadcast: false,
      seq: 1,
      createdAt: 0,
      editedAt: null,
      nonce: null,
      replyCount: 0,
      reactions: [],
      files: [file],
      pinned: false,
      actions: [],
    };
    client.store.setState({ threads: { M_ROOT: [reply] } });
    const fetchFile = vi.spyOn(client.api, "fetchFile").mockResolvedValue(new Blob(["png!"]));
    open(client);
    expect(await screen.findByRole("img", { name: "plan.png" })).toBeVisible();
    expect(urls.size).toBe(1);

    // The cache remembers the owner after its bounded history has been evicted.
    client.store.setState({ threads: {} });
    fetchFile.mockRejectedValue(new ApiError(404, "file_not_found"));
    const connection = client as unknown as { handleServerMessage(message: ServerToClient): void };
    act(() =>
      connection.handleServerMessage({
        type: "event",
        envelope: {
          seq: 2,
          event: { type: "history.removed", channelId: "C1", rootIds: ["M_ROOT"] },
        },
      }),
    );
    expect(screen.queryByRole("img", { name: "plan.png" })).toBeNull();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /unavailable or you no longer have access/i,
    );
    expect(urls.size).toBe(0);
    expect(client.files.peek(file.id)).toBeUndefined();
  });
});
