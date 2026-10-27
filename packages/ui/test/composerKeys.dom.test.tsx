import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "../src/components/Composer.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";

/**
 * The composer's keyboard and formatting: which key sends under each setting,
 * an input method's Enter never sending, formatting leaving the words
 * selected, and what a scheduled send says when the workspace is full.
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

async function renderComposer(enterSends = true, threadRootId?: string) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam },
    channels: { [design.id]: design },
    status: "online",
  });
  const send = vi.spyOn(client, "send").mockImplementation(() => true);
  const values = new Map<string, unknown>();
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T,>(name: string) =>
        (name === "composer-preferences" ? { enterSends } : (values.get(name) ?? null)) as T | null,
      set: async (name: string, value: unknown) => void values.set(name, value),
    },
    notify: () => {},
  };
  const { container } = render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <Composer channelId={design.id} threadRootId={threadRootId} placeholder="Message #design" />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message #design" });
  await waitFor(() => expect(box).toBeEnabled());
  const filePicker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  return { client, send, box, filePicker };
}

const selected = (box: HTMLTextAreaElement) =>
  box.value.slice(box.selectionStart, box.selectionEnd);

describe("formatting in the composer", () => {
  it("wraps the selected words and leaves them selected, so a second style wraps the same words", async () => {
    const user = userEvent.setup();
    const { box } = await renderComposer();
    await user.type(box, "ship it today");
    box.setSelectionRange(5, 7);

    await user.click(screen.getByRole("button", { name: "Bold" }));
    expect(box).toHaveValue("ship *it* today");
    expect(selected(box)).toBe("it");
    expect(box).toHaveFocus();

    await user.keyboard("{Control>}i{/Control}");
    expect(box).toHaveValue("ship *_it_* today");
    expect(selected(box)).toBe("it");

    // The same style again takes it off.
    await user.click(screen.getByRole("button", { name: "Italic" }));
    expect(box).toHaveValue("ship *it* today");
    expect(selected(box)).toBe("it");
  });

  it("puts a placeholder in, selected, when nothing is selected", async () => {
    const user = userEvent.setup();
    const { box } = await renderComposer();
    await user.type(box, "see ");
    await user.click(screen.getByRole("button", { name: "Inline code" }));
    expect(box).toHaveValue("see `text`");
    expect(selected(box)).toBe("text");
  });

  it("makes the selected lines a list, of either kind, and plain lines again", async () => {
    const user = userEvent.setup();
    const { box } = await renderComposer();
    await user.type(box, "milk{Shift>}{Enter}{/Shift}eggs{Shift>}{Enter}{/Shift}bread");
    box.setSelectionRange(0, box.value.length);

    await user.keyboard("{Control>}{Shift>}8{/Shift}{/Control}");
    expect(box).toHaveValue("- milk\n- eggs\n- bread");
    expect(selected(box)).toBe("- milk\n- eggs\n- bread");
    expect(box).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Numbered list" }));
    expect(box).toHaveValue("1. milk\n2. eggs\n3. bread");

    // The same list again takes it off.
    await user.keyboard("{Control>}{Shift>}7{/Shift}{/Control}");
    expect(box).toHaveValue("milk\neggs\nbread");
  });

  it("starts a list on an empty line, ready to type", async () => {
    const user = userEvent.setup();
    const { box } = await renderComposer();
    await user.click(box);
    await user.keyboard("{Control>}{Shift>}7{/Shift}{/Control}");
    await user.type(box, "first");
    expect(box).toHaveValue("1. first");
  });
});

describe.each([
  { enterSends: true, sendKey: "{Enter}", newLineKey: "{Shift>}{Enter}{/Shift}" },
  { enterSends: false, sendKey: "{Control>}{Enter}{/Control}", newLineKey: "{Enter}" },
])("sending with enterSends=$enterSends", ({ enterSends, sendKey, newLineKey }) => {
  it("starts a new line with one key and sends with the other", async () => {
    const user = userEvent.setup();
    const { send, box } = await renderComposer(enterSends);
    await user.type(box, "first line");
    await user.keyboard(newLineKey);
    await user.type(box, "second line");
    expect(send).not.toHaveBeenCalled();
    expect(box).toHaveValue("first line\nsecond line");

    await user.keyboard(sendKey);
    expect(send).toHaveBeenCalledWith(design.id, "first line\nsecond line", {
      threadRootId: undefined,
      files: [],
      alsoSendToChannel: false,
      onQueued: expect.any(Function),
    });
    expect(box).toHaveValue("");
  });

  it("starts a new line of code inside an unclosed code block, and sends once it is closed", async () => {
    const user = userEvent.setup();
    const { send, box } = await renderComposer(enterSends);
    await user.type(box, "```");
    await user.keyboard(enterSends ? "{Enter}" : newLineKey);
    await user.type(box, "npm test");
    await user.keyboard(enterSends ? "{Enter}" : newLineKey);
    expect(send).not.toHaveBeenCalled();
    await user.type(box, "```");
    await user.keyboard(sendKey);
    expect(send).toHaveBeenCalledWith(design.id, "```\nnpm test\n```", expect.anything());
  });

  it("sends from inside a code block with Ctrl+Enter", async () => {
    const user = userEvent.setup();
    const { send, box } = await renderComposer(enterSends);
    await user.type(box, "```still open");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(send).toHaveBeenCalledWith(design.id, "```still open", expect.anything());
  });

  it("never sends on the Enter an input method uses to choose a character", async () => {
    const { send, box } = await renderComposer(enterSends);
    fireEvent.change(box, { target: { value: "にほんご" } });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229, ctrlKey: true });
    expect(send).not.toHaveBeenCalled();
    expect(box).toHaveValue("にほんご");
  });
});

describe("a scheduled send that cannot upload its files", () => {
  it("says the workspace is full and keeps the draft and its file", async () => {
    const user = userEvent.setup();
    const { client, box, filePicker } = await renderComposer();
    vi.spyOn(client.api, "uploadFile").mockRejectedValue(
      new ApiError(507, "storage_quota_exceeded"),
    );
    const schedule = vi.spyOn(client.api, "scheduleMessage");
    await user.type(box, "The quarterly numbers");
    await user.upload(filePicker, new File(["1,2,3"], "numbers.csv", { type: "text/csv" }));
    expect(screen.getByText("numbers.csv")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Send later" }));
    fireEvent.change(await screen.findByLabelText("Choose a date and time"), {
      target: { value: "2099-01-05T09:00" },
    });
    await user.click(screen.getByRole("button", { name: /^Schedule for .*2099 at / }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Workspace attachment storage is full. Your draft is kept. Ask the host to free space or raise the limit, then retry.",
    );
    expect(schedule).not.toHaveBeenCalled();
    expect(box).toHaveValue("The quarterly numbers");
    expect(screen.getByText("numbers.csv")).toBeVisible();
  });
});

describe("a send the outbox cannot take", () => {
  it("keeps the words in the composer and says why, then sends once there is room", async () => {
    const user = userEvent.setup();
    const { client, send, box } = await renderComposer();
    const full = vi.spyOn(client, "outboxFull").mockReturnValue(true);
    send.mockImplementation(() => false);
    await user.type(box, "one more thing{Enter}");
    expect(send).toHaveBeenCalledOnce();
    expect(box).toHaveValue("one more thing");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "50 messages are already waiting to send. Once they go, or you discard some, this one can be sent.",
    );

    full.mockReturnValue(false);
    send.mockImplementation(() => true);
    await user.keyboard("{Enter}");
    expect(send).toHaveBeenLastCalledWith(design.id, "one more thing", expect.anything());
    expect(box).toHaveValue("");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("scheduling a reply that is also for the channel", () => {
  async function scheduleReply(alsoToChannel: boolean) {
    const user = userEvent.setup();
    const { client, box } = await renderComposer(true, "M_ROOT");
    const schedule = vi
      .spyOn(client.api, "scheduleMessage")
      .mockImplementation(async (channelId, body) => ({
        scheduled: {
          id: "S1",
          channelId,
          userId: sam.id,
          text: body.text,
          threadRootId: body.threadRootId ?? null,
          broadcast: body.alsoSendToChannel === true,
          fileIds: [],
          sendAt: body.sendAt,
          createdAt: 0,
          status: "queued",
          failureReason: null,
          attempts: 0,
          messageId: null,
        },
      }));
    await user.type(box, "Friday it is");
    const checkbox = screen.getByRole("checkbox", { name: "Also send to channel" });
    if (alsoToChannel) await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "Send later" }));
    fireEvent.change(await screen.findByLabelText("Choose a date and time"), {
      target: { value: "2099-01-05T09:00" },
    });
    await user.click(screen.getByRole("button", { name: /^Schedule for .*2099 at / }));
    await waitFor(() => expect(schedule).toHaveBeenCalledOnce());
    return { body: schedule.mock.calls[0]![1], checkbox, box };
  }

  it("carries the choice in the request, then clears it as sending does", async () => {
    const { body, checkbox, box } = await scheduleReply(true);
    expect(body).toMatchObject({ threadRootId: "M_ROOT", alsoSendToChannel: true });
    await waitFor(() => expect(box).toHaveValue(""));
    expect(checkbox).not.toBeChecked();
  });

  it("leaves it out when the reply is only for the thread", async () => {
    const { body } = await scheduleReply(false);
    expect(body.threadRootId).toBe("M_ROOT");
    expect(body).not.toHaveProperty("alsoSendToChannel");
  });
});

describe("a scheduled send past the queue's limit", () => {
  it("says so in the server's words, keeps the draft, and leaves nothing to confirm", async () => {
    const user = userEvent.setup();
    const { client, box } = await renderComposer();
    const schedule = vi
      .spyOn(client.api, "scheduleMessage")
      .mockRejectedValue(
        new ApiError(
          409,
          "scheduled_limit",
          "You already have 200 messages waiting to be sent. Send or cancel some before scheduling more.",
        ),
      );
    await user.type(box, "One more for Friday");
    await user.click(screen.getByRole("button", { name: "Send later" }));
    fireEvent.change(await screen.findByLabelText("Choose a date and time"), {
      target: { value: "2099-01-05T09:00" },
    });
    await user.click(screen.getByRole("button", { name: /^Schedule for .*2099 at / }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You already have 200 messages waiting to be sent. Send or cancel some before scheduling more. Your draft is kept.",
    );
    expect(schedule).toHaveBeenCalledOnce();
    expect(box).toHaveValue("One more for Friday");
    expect(screen.queryByRole("button", { name: "Retry confirmation" })).toBeNull();
  });
});

describe("Send later's own date and time", () => {
  it("says under the field what Schedule needs, rather than waiting greyed out", async () => {
    const user = userEvent.setup();
    const { client, box } = await renderComposer();
    const schedule = vi.spyOn(client.api, "scheduleMessage");
    await user.type(box, "See you Monday");
    await user.click(screen.getByRole("button", { name: "Send later" }));
    const field = await screen.findByLabelText("Choose a date and time");
    const button = screen.getByRole("button", { name: "Schedule message" });

    // Pressed with nothing chosen, it asks for a time and puts focus there.
    expect(button).toBeEnabled();
    await user.click(button);
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("Choose a date and time.");

    // A time already past is said there too, and nothing is scheduled.
    fireEvent.change(field, { target: { value: "2001-01-05T09:00" } });
    expect(field).not.toHaveAttribute("aria-invalid");
    await user.click(screen.getByRole("button", { name: /^Schedule for .*2001 at / }));
    expect(field).toHaveAccessibleDescription("Choose a date and time in the future.");
    expect(schedule).not.toHaveBeenCalled();
    expect(box).toHaveValue("See you Monday");
  });
});
