import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@slackoss/client-core";
import type { Channel, User } from "@slackoss/protocol";
import { ClientContext } from "../src/context.js";
import { NewChannelDialog, NewDmDialog } from "../src/components/dialogs.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Creating a channel and starting a conversation: the buttons stay usable and
 * say what is missing, rather than greying out without a reason.
 */
const person = (id: string, handle: string, displayName: string): User => ({
  id,
  handle,
  displayName,
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});

const channel = (name: string, type: Channel["type"] = "public"): Channel => ({
  id: `C_${name}`,
  type,
  name,
  topic: "",
  description: "",
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
});

function workspace() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  const sam = person("U_SAM", "sam", "Sam Rivera");
  client.store.setState({
    self: sam,
    users: {
      U_SAM: sam,
      U_ALEX: person("U_ALEX", "alex", "Alex Chen"),
      U_PRIYA: person("U_PRIYA", "priya", "Priya Natarajan"),
    },
    status: "online",
  });
  return client;
}

describe("a new channel", () => {
  it("says a name is missing, then creates the channel it previews", async () => {
    const user = userEvent.setup();
    const client = workspace();
    const create = vi.spyOn(client.api, "createChannel").mockImplementation(async (body) => ({
      channel: channel("name" in body ? body.name : "", body.type),
    }));
    const onCreated = vi.fn();
    render(
      <ClientContext.Provider value={client}>
        <NewChannelDialog onClose={() => {}} onCreated={onCreated} />
      </ClientContext.Provider>,
    );
    const dialog = screen.getByRole("dialog", { name: "New channel" });
    const name = within(dialog).getByLabelText("Name");
    await user.click(within(dialog).getByRole("button", { name: "Create channel" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Give the channel a name.");
    expect(name).toHaveFocus();
    expect(create).not.toHaveBeenCalled();

    await user.type(name, "Launch Week");
    expect(dialog).toHaveTextContent("It will be #launch-week.");
    await user.type(within(dialog).getByLabelText(/What is it for/), "Planning the launch");
    await user.click(within(dialog).getByRole("radio", { name: /Private/ }));
    expect(await accessibilityProblems(dialog)).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Create #launch-week" }));
    expect(create).toHaveBeenCalledWith({
      type: "private",
      name: "launch-week",
      description: "Planning the launch",
    });
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ name: "launch-week" }));
  });

  it("says when the name is taken, and keeps what was typed", async () => {
    const user = userEvent.setup();
    const client = workspace();
    vi.spyOn(client.api, "createChannel").mockRejectedValue(new ApiError(409, "name_taken"));
    render(
      <ClientContext.Provider value={client}>
        <NewChannelDialog onClose={() => {}} onCreated={vi.fn()} />
      </ClientContext.Provider>,
    );
    const name = screen.getByLabelText("Name");
    await user.type(name, "design{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "#design already exists. Choose another name.",
    );
    expect(name).toHaveValue("design");
    expect(screen.getByRole("button", { name: "Create #design" })).toBeEnabled();
  });
});

describe("a new message", () => {
  it("asks for someone to message, then opens the conversation with who was chosen", async () => {
    const user = userEvent.setup();
    const client = workspace();
    const openDm = vi.spyOn(client, "openDm").mockResolvedValue({
      ...channel("", "group_dm"),
      id: "G_TRIO",
    });
    const onOpen = vi.fn();
    render(
      <ClientContext.Provider value={client}>
        <NewDmDialog onClose={() => {}} onOpen={onOpen} />
      </ClientContext.Provider>,
    );
    const dialog = screen.getByRole("dialog", { name: "New message" });
    const to = within(dialog).getByLabelText("To");
    // Who it is to, and the button, stay in sight; the people between them scroll.
    const people = dialog.querySelector(".dialog-scroll")!;
    expect(people).toContainElement(within(dialog).getByRole("checkbox", { name: /Alex Chen/ }));
    expect(people).not.toContainElement(to);
    expect(people).not.toContainElement(
      within(dialog).getByRole("button", { name: "Start conversation" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Start conversation" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Choose at least one person to message.",
    );
    expect(to).toHaveFocus();

    await user.click(within(dialog).getByRole("checkbox", { name: /Priya Natarajan/ }));
    await user.click(within(dialog).getByRole("checkbox", { name: /Alex Chen/ }));
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(dialog).toHaveTextContent("2 of up to 8 chosen, plus you");
    // Backspace in the empty box takes back the last person chosen.
    await user.click(to);
    await user.keyboard("{Backspace}");
    expect(within(dialog).queryByRole("button", { name: "Remove Alex Chen" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Remove Priya Natarajan" })).toBeVisible();
    expect(await accessibilityProblems(dialog)).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "Start conversation" }));
    expect(openDm).toHaveBeenCalledWith(["U_PRIYA"]);
    expect(onOpen).toHaveBeenCalledWith("G_TRIO");
  });
});
