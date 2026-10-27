import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@ownbase/client-core";
import type { Message, User } from "@ownbase/protocol";
import { describe, expect, it, vi } from "vitest";
import { MessageEditor } from "../src/components/MessageEditor.js";
import { ClientContext } from "../src/context.js";

/**
 * Editing a message in place: what saving, cancelling and failing do to the
 * text being edited, and what happens when someone else edits it first.
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

const original: Message = {
  id: "M1",
  channelId: "C1",
  userId: sam.id,
  text: "Ship it on Friday",
  seq: 1,
  createdAt: 0,
  editedAt: null,
  threadRootId: null,
  replyCount: 0,
  lastReplyAt: null,
  reactions: [],
  files: [],
  pinned: false,
} as unknown as Message;

const draftKey = "C1:edit:M1";

/** The edit as kept between sessions. */
const kept = (client: WorkspaceClient) => {
  const value = client.state.drafts[draftKey];
  return value === undefined ? undefined : (JSON.parse(value) as { text: string; base: string });
};

function renderEditor(message = original) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: sam, users: { [sam.id]: sam }, status: "online" });
  const edit = vi
    .spyOn(client.api, "editMessage")
    .mockImplementation(async (_id, text) => ({ message: { ...message, text } }));
  const onClose = vi.fn();
  const view = render(
    <ClientContext.Provider value={client}>
      <MessageEditor message={message} onClose={onClose} />
    </ClientContext.Provider>,
  );
  const rerender = (next: Message) =>
    view.rerender(
      <ClientContext.Provider value={client}>
        <MessageEditor message={next} onClose={onClose} />
      </ClientContext.Provider>,
    );
  const box = screen.getByRole("textbox", { name: "Edit message" });
  return { client, edit, onClose, box, rerender };
}

describe("editing a message", () => {
  it("saves the trimmed text with Enter, closes, and forgets the draft", async () => {
    const user = userEvent.setup();
    const { client, edit, onClose, box } = renderEditor();
    expect(box).toHaveFocus();
    await user.clear(box);
    await user.type(box, "  Ship it on Monday  ");
    expect(kept(client)).toEqual({ text: "  Ship it on Monday  ", base: "Ship it on Friday" });
    await user.keyboard("{Enter}");
    // Saved over the words it started from, and only over those.
    expect(edit).toHaveBeenCalledWith("M1", "Ship it on Monday", "Ship it on Friday");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(client.state.drafts).not.toHaveProperty([draftKey]);
  });

  it("keeps nothing once the box is emptied, so the edit starts from the message again", async () => {
    const user = userEvent.setup();
    const { client, box } = renderEditor();
    await user.type(box, "!");
    expect(kept(client)?.text).toBe("Ship it on Friday!");
    await user.clear(box);
    expect(client.state.drafts).not.toHaveProperty([draftKey]);
  });

  it("closes without asking the server when nothing changed", async () => {
    const user = userEvent.setup();
    const { edit, onClose } = renderEditor();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(edit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("throws the edit away on Cancel or Escape, and Escape goes no further", async () => {
    const user = userEvent.setup();
    const { client, edit, onClose, box } = renderEditor();
    await user.type(box, " and Monday");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(client.state.drafts).not.toHaveProperty([draftKey]);
    expect(edit).not.toHaveBeenCalled();

    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    try {
      fireEvent.keyDown(box, { key: "Escape" });
    } finally {
      document.removeEventListener("keydown", outer);
    }
    expect(onClose).toHaveBeenCalledTimes(2);
    // A dialog around the message stays open.
    expect(outer).not.toHaveBeenCalled();
  });

  it("stays open with the text kept when saving fails, and saves on the next try", async () => {
    const user = userEvent.setup();
    const { client, edit, onClose, box } = renderEditor();
    edit.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await user.clear(box);
    await user.type(box, "Ship it on Monday{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save this edit. Your text is kept; try again when connected.",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(box).toHaveValue("Ship it on Monday");
    expect(kept(client)?.text).toBe("Ship it on Monday");

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(edit).toHaveBeenCalledTimes(2);
  });

  it("says when the message is gone, and keeps the edit", async () => {
    const user = userEvent.setup();
    const { edit, onClose, box } = renderEditor();
    edit.mockRejectedValueOnce(new ApiError(404, "message_not_found"));
    await user.type(box, "!{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This message is no longer available. Your unsaved edit is kept.",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(box).toHaveValue("Ship it on Friday!");
  });

  it("makes the line a bulleted list with Ctrl+Shift+8, the caret staying in its words", async () => {
    const user = userEvent.setup();
    const { box } = renderEditor();
    const field = box as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(5, 5);
    await user.keyboard("{Control>}{Shift>}8{/Shift}{/Control}");
    expect(field).toHaveValue("- Ship it on Friday");
    expect(field.selectionStart).toBe(7);
    expect(field.selectionEnd).toBe(7);
  });

  it("starts a new line inside an unclosed code block, and saves with Ctrl+Enter", async () => {
    const user = userEvent.setup();
    const { edit, onClose, box } = renderEditor();
    await user.clear(box);
    await user.type(box, "```{Enter}npm test{Enter}");
    expect(edit).not.toHaveBeenCalled();
    expect(box).toHaveValue("```\nnpm test\n");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(edit).toHaveBeenCalledWith("M1", "```\nnpm test", "Ship it on Friday");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("does not save while an input method is choosing a character", async () => {
    const { edit, onClose, box } = renderEditor();
    fireEvent.change(box, { target: { value: "金曜日に出荷" } });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    expect(edit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("picks up a draft kept as plain text before edits remembered their start", () => {
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    client.store.setState({ self: sam, users: { [sam.id]: sam } });
    client.setDraft(draftKey, "Half an edit");
    render(
      <ClientContext.Provider value={client}>
        <MessageEditor message={original} onClose={() => {}} />
      </ClientContext.Provider>,
    );
    expect(screen.getByRole("textbox", { name: "Edit message" })).toHaveValue("Half an edit");
  });
});

describe("a message changed by someone else while it is being edited", () => {
  it("says so, and Enter no longer saves over it without a choice", async () => {
    const user = userEvent.setup();
    const { edit, box, rerender } = renderEditor();
    await user.type(box, " (mine)");
    rerender({ ...original, text: "Ship it on Thursday" });

    expect(screen.getByRole("status")).toHaveTextContent(
      "This message changed while you were editing.",
    );
    // With the newer words in view, so the choice is not made blind.
    expect(screen.getByLabelText("Current message")).toHaveTextContent("Ship it on Thursday");
    await user.keyboard("{Enter}");
    expect(edit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save my version" })).toBeEnabled();
  });

  it("saves their own version when they choose to", async () => {
    const user = userEvent.setup();
    const { edit, onClose, box, rerender } = renderEditor();
    await user.type(box, " (mine)");
    rerender({ ...original, text: "Ship it on Thursday" });
    await user.click(screen.getByRole("button", { name: "Save my version" }));
    // Over the version they were told of, not over anything newer.
    expect(edit).toHaveBeenCalledWith("M1", "Ship it on Friday (mine)", "Ship it on Thursday");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("takes the current message instead, and carries on editing from it", async () => {
    const user = userEvent.setup();
    const { edit, box, rerender } = renderEditor();
    await user.type(box, " (mine)");
    rerender({ ...original, text: "Ship it on Thursday" });
    await user.click(screen.getByRole("button", { name: "Use the current message" }));

    expect(box).toHaveValue("Ship it on Thursday");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await user.type(box, " at noon{Enter}");
    expect(edit).toHaveBeenCalledWith("M1", "Ship it on Thursday at noon", "Ship it on Thursday");
  });
});

describe("an edit the server refuses because the message changed first", () => {
  it("keeps the text, says nothing was overwritten, and stays open", async () => {
    const user = userEvent.setup();
    const { client, edit, onClose, box, rerender } = renderEditor();
    edit.mockRejectedValueOnce(new ApiError(409, "message_changed"));
    await user.type(box, " (mine){Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This message changed before your edit was saved. Your text is kept; nothing was overwritten.",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(box).toHaveValue("Ship it on Friday (mine)");
    expect(kept(client)).toEqual({ text: "Ship it on Friday (mine)", base: "Ship it on Friday" });

    // The newer edit arrives, and the author chooses between the two.
    rerender({ ...original, text: "Ship it on Thursday" });
    expect(screen.getByRole("status")).toHaveTextContent(
      "This message changed while you were editing.",
    );
    await user.click(screen.getByRole("button", { name: "Save my version" }));
    expect(edit).toHaveBeenLastCalledWith("M1", "Ship it on Friday (mine)", "Ship it on Thursday");
  });

  it("is not a conflict when the change is this edit, saved though its answer was lost", async () => {
    const user = userEvent.setup();
    const { edit, onClose, box, rerender } = renderEditor();
    edit.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await user.clear(box);
    await user.type(box, "Ship it on Monday{Enter}");
    await screen.findByRole("alert");
    // It had gone through after all.
    rerender({ ...original, text: "Ship it on Monday" });
    expect(screen.queryByRole("status")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledOnce();
  });
});

describe("an edit picked up after a restart", () => {
  function reopen(value: string, message: Message) {
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    client.store.setState({ self: sam, users: { [sam.id]: sam }, status: "online" });
    client.setDraft(draftKey, value);
    const edit = vi
      .spyOn(client.api, "editMessage")
      .mockImplementation(async (_id, text) => ({ message: { ...message, text } }));
    render(
      <ClientContext.Provider value={client}>
        <MessageEditor message={message} onClose={() => {}} />
      </ClientContext.Provider>,
    );
    return { edit, box: screen.getByRole("textbox", { name: "Edit message" }) };
  }

  it("knows the message changed since it was started, though this window never saw the change", async () => {
    const user = userEvent.setup();
    const { edit, box } = reopen(
      JSON.stringify({ text: "Ship it on Friday (mine)", base: "Ship it on Friday" }),
      { ...original, text: "Ship it on Thursday" },
    );
    expect(box).toHaveValue("Ship it on Friday (mine)");
    expect(screen.getByRole("status")).toHaveTextContent(
      "This message changed while you were editing.",
    );
    await user.keyboard("{Enter}");
    expect(edit).not.toHaveBeenCalled();
  });

  it("saves as usual when the message is still what it started from", async () => {
    const user = userEvent.setup();
    const { edit } = reopen(
      JSON.stringify({ text: "Ship it on Monday", base: "Ship it on Friday" }),
      original,
    );
    expect(screen.queryByRole("status")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(edit).toHaveBeenCalledWith("M1", "Ship it on Monday", "Ship it on Friday");
  });
});
