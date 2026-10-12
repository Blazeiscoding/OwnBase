import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Channel, User } from "@slackoss/protocol";
import { describe, expect, it, vi } from "vitest";
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

function renderComposer(enterSends: boolean) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam },
    channels: { [design.id]: design },
    status: "online",
  });
  const send = vi.spyOn(client, "send").mockImplementation(() => true);
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T,>(name: string) =>
        (name === "composer-preferences" ? { enterSends } : null) as T | null,
      set: async () => {},
    },
    notify: () => {},
  };
  const { container } = render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <Composer channelId={design.id} placeholder="Message #design" />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const filePicker = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!filePicker) throw new Error("Composer file picker is missing");
  return { filePicker, send };
}

describe.each([
  { enterSends: true, shortcut: "Enter", hint: "Enter to send" },
  { enterSends: false, shortcut: "Ctrl/Cmd+Enter", hint: "Ctrl/Cmd+Enter to send" },
])("composer tooltips with enterSends=$enterSends", ({ enterSends, shortcut, hint }) => {
  it("shows keyboard hints without native titles and preserves the three actions", async () => {
    const user = userEvent.setup();
    const { filePicker, send } = renderComposer(enterSends);
    const textbox = screen.getByRole("textbox", { name: "Message #design" });
    await waitFor(() => expect(textbox).toBeEnabled());
    await user.type(textbox, "A draft");
    await screen.findByText(hint, { exact: false });

    const attach = screen.getByRole("button", { name: "Attach a file" });
    const later = screen.getByRole("button", { name: "Send later" });
    const sendButton = screen.getByRole("button", { name: "Send message" });
    for (const button of [attach, later, sendButton]) expect(button).not.toHaveAttribute("title");

    await user.tab();
    expect(attach).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Attach a file");
    expect(attach).toHaveAccessibleDescription("Attach a file");

    // Formatting and emoji sit between attaching and sending, in reading order.
    await user.tab();
    expect(screen.getByRole("button", { name: "Formatting" })).toHaveFocus();
    // jsdom applies no stylesheet, so the folded formatting buttons still take
    // a Tab here; a browser skips them, which the browser tests check.
    const emoji = screen.getByRole("button", { name: "Insert emoji" });
    for (let i = 0; i < 8 && document.activeElement !== emoji; i++) await user.tab();
    expect(emoji).toHaveFocus();
    await user.tab();
    expect(later).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Send later");
    expect(later).toHaveAccessibleDescription("Send later");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(later).toHaveFocus();
    expect(textbox).toHaveValue("A draft");

    await user.tab();
    expect(sendButton).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveTextContent(`Send message. Shortcut: ${shortcut}`);
    expect(sendButton).toHaveAccessibleDescription(`Send message. Shortcut: ${shortcut}`);

    const pickerClick = vi.spyOn(filePicker, "click").mockImplementation(() => undefined);
    await user.click(attach);
    expect(pickerClick).toHaveBeenCalledOnce();
    await user.click(later);
    expect(await screen.findByRole("button", { name: "Schedule message" })).toBeVisible();
    await user.click(sendButton);
    expect(send).toHaveBeenCalledWith(design.id, "A draft", {
      threadRootId: undefined,
      files: [],
      alsoSendToChannel: false,
      onQueued: expect.any(Function),
    });
    expect(textbox).toHaveValue("");
  });
});
