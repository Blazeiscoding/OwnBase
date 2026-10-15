import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@slackoss/client-core";
import type { Channel, User } from "@slackoss/protocol";
import { ClientContext } from "../src/context.js";
import { ProfileDialog, ProfileForm } from "../src/components/ProfileDialog.js";
import { statusEnd, statusUntil } from "../src/lib/status.js";
import { accessibilityProblems } from "./accessibility.js";

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

const sam = person("U_SAM", "sam", "Sam Rivera");
const priya = person("U_PRIYA", "priya", "Priya Natarajan");

const dm: Channel = {
  id: "D_PRIYA",
  type: "dm",
  name: "",
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
  memberIds: [sam.id, priya.id],
};

/** A workspace client that never connects, holding Sam and Priya. */
function workspace() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam, [priya.id]: priya },
    status: "online",
  });
  return client;
}

describe("someone else's profile", () => {
  it("says a conversation did not open, and opens it on the next press", async () => {
    const user = userEvent.setup();
    const client = workspace();
    const openDm = vi
      .spyOn(client, "openDm")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(dm);
    const onOpenDm = vi.fn();
    render(
      <ClientContext.Provider value={client}>
        <ProfileDialog userId={priya.id} onClose={() => {}} onOpenDm={onOpenDm} />
      </ClientContext.Provider>,
    );
    const message = screen.getByRole("button", { name: "Message Priya Natarajan" });
    await user.click(message);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not open a conversation with Priya Natarajan. Check your connection and try again.",
    );
    expect(onOpenDm).not.toHaveBeenCalled();
    expect(message).toHaveFocus();
    expect(await accessibilityProblems(screen.getByRole("dialog", { name: "Profile" }))).toEqual(
      [],
    );

    await user.click(message);
    expect(openDm).toHaveBeenCalledTimes(2);
    expect(onOpenDm).toHaveBeenCalledWith(dm.id);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  /** A press on Message whose conversation opens only when the test says. */
  function slowDm(client: WorkspaceClient) {
    let open = () => {};
    vi.spyOn(client, "openDm").mockImplementation(
      () => new Promise<Channel>((resolve) => (open = () => resolve(dm))),
    );
    return () => open();
  }

  it("opens nothing once the card is closed, however late the conversation arrives (Q11)", async () => {
    const user = userEvent.setup();
    const client = workspace();
    const arrive = slowDm(client);
    const onOpenDm = vi.fn();
    const view = render(
      <ClientContext.Provider value={client}>
        <ProfileDialog userId={priya.id} onClose={() => {}} onOpenDm={onOpenDm} />
      </ClientContext.Provider>,
    );
    await user.click(screen.getByRole("button", { name: "Message Priya Natarajan" }));

    // Closed, and the reader has gone somewhere else.
    view.unmount();
    arrive();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onOpenDm).not.toHaveBeenCalled();
  });

  it("drops a press made for one person once the card shows another", async () => {
    const user = userEvent.setup();
    const client = workspace();
    const lee = person("U_LEE", "lee", "Lee Okafor");
    client.store.setState((s) => ({ users: { ...s.users, [lee.id]: lee } }));
    const arrive = slowDm(client);
    const onOpenDm = vi.fn();
    const card = (userId: string) => (
      <ClientContext.Provider value={client}>
        <ProfileDialog userId={userId} onClose={() => {}} onOpenDm={onOpenDm} />
      </ClientContext.Provider>
    );
    const view = render(card(priya.id));
    await user.click(screen.getByRole("button", { name: "Message Priya Natarajan" }));

    view.rerender(card(lee.id));
    arrive();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onOpenDm).not.toHaveBeenCalled();
    // And Lee's own button is not left waiting on Priya's press.
    expect(screen.getByRole("button", { name: "Message Lee Okafor" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });
});

describe("editing your own profile", () => {
  it("keeps what was typed when saving fails, and says so once it saves", async () => {
    const user = userEvent.setup();
    const client = workspace();
    const updateMe = vi
      .spyOn(client.api, "updateMe")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ user: { ...sam, statusText: "Heads down" } });
    render(
      <ClientContext.Provider value={client}>
        <ProfileForm />
      </ClientContext.Provider>,
    );
    const name = screen.getByRole("textbox", { name: "Display name" });
    const status = screen.getByRole("textbox", { name: "Status text" });
    await user.clear(name);
    await user.type(name, "Sam R.");
    await user.type(status, "Heads down");
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your profile was not saved. Check your connection and try again.",
    );
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(name).toHaveValue("Sam R.");
    expect(status).toHaveValue("Heads down");

    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(updateMe).toHaveBeenLastCalledWith({
      displayName: "Sam R.",
      statusEmoji: "",
      statusText: "Heads down",
      statusExpiresAt: null,
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Profile saved.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Changing it again takes the confirmation away until it is saved.
    await user.type(status, "!");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    await user.click(screen.getByRole("button", { name: /Heads down/ }));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("explains a refused profile and limits each field to what the server accepts", async () => {
    const user = userEvent.setup();
    const client = workspace();
    vi.spyOn(client.api, "updateMe").mockRejectedValueOnce(new ApiError(400, "invalid_request"));
    render(
      <ClientContext.Provider value={client}>
        <ProfileForm />
      </ClientContext.Provider>,
    );
    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveAttribute(
      "maxlength",
      "80",
    );
    expect(screen.getByRole("textbox", { name: "Status emoji" })).toHaveAttribute(
      "maxlength",
      "32",
    );
    expect(screen.getByRole("textbox", { name: "Status text" })).toHaveAttribute(
      "maxlength",
      "120",
    );
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A display name can be up to 80 characters and a status up to 120.",
    );
  });
});

describe("a status that clears itself", () => {
  it("says on someone's card when their status ends", () => {
    const client = workspace();
    const ends = Date.now() + 30 * 60_000;
    client.store.setState({
      users: {
        [sam.id]: sam,
        [priya.id]: {
          ...priya,
          statusEmoji: "💬",
          statusText: "In a meeting",
          statusExpiresAt: ends,
        },
      },
    });
    const { rerender } = render(
      <ClientContext.Provider value={client}>
        <ProfileDialog userId={priya.id} onClose={() => {}} onOpenDm={() => {}} />
      </ClientContext.Provider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Profile" });
    expect(dialog).toHaveTextContent(`In a meeting · ${statusUntil(ends)}`);

    // Cleared by the server at its time, it goes from the card with its end.
    client.store.setState({ users: { [sam.id]: sam, [priya.id]: priya } });
    rerender(
      <ClientContext.Provider value={client}>
        <ProfileDialog userId={priya.id} onClose={() => {}} onOpenDm={() => {}} />
      </ClientContext.Provider>,
    );
    expect(dialog).not.toHaveTextContent("In a meeting");
    expect(dialog).not.toHaveTextContent("until");
  });

  const saving = (client: WorkspaceClient) =>
    vi.spyOn(client.api, "updateMe").mockImplementation(async (body) => ({
      user: { ...sam, ...body },
    }));

  it("takes a preset's usual end, which Clear after can change", async () => {
    const user = userEvent.setup();
    const client = workspace();
    const updateMe = saving(client);
    render(
      <ClientContext.Provider value={client}>
        <ProfileForm />
      </ClientContext.Provider>,
    );
    // Nothing to clear before there is a status.
    expect(screen.queryByRole("combobox", { name: "Clear after" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Out for lunch/ }));
    const clearAfter = screen.getByRole("combobox", { name: "Clear after" });
    expect(clearAfter).toHaveValue("1h");
    expect(await accessibilityProblems()).toEqual([]);

    await user.selectOptions(clearAfter, "Today");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(updateMe).toHaveBeenLastCalledWith(
      expect.objectContaining({ statusText: "Out for lunch", statusExpiresAt: statusEnd("today") }),
    );

    await user.selectOptions(screen.getByRole("combobox", { name: "Clear after" }), "Don't clear");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(updateMe).toHaveBeenLastCalledWith(
      expect.objectContaining({ statusText: "Out for lunch", statusExpiresAt: null }),
    );
  });

  it("keeps the end a status was set with when saved again", async () => {
    const user = userEvent.setup();
    const client = workspace();
    const ends = Date.now() + 45 * 60_000;
    client.store.setState({
      self: { ...sam, statusEmoji: "💬", statusText: "In a meeting", statusExpiresAt: ends },
    });
    const updateMe = saving(client);
    render(
      <ClientContext.Provider value={client}>
        <ProfileForm />
      </ClientContext.Provider>,
    );
    const clearAfter = screen.getByRole("combobox", { name: "Clear after" });
    expect(clearAfter).toHaveValue("kept");
    expect(
      screen.getByRole("option", { name: `As set, ${statusUntil(ends)}` }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(updateMe).toHaveBeenLastCalledWith(
      expect.objectContaining({ statusText: "In a meeting", statusExpiresAt: ends }),
    );
  });
});

describe("statusEnd", () => {
  // Thursday 15 October 2026, 10:30 on this device's clock.
  const now = new Date(2026, 9, 15, 10, 30);
  it("counts minutes from now, and days to their last moment", () => {
    expect(statusEnd("never", now)).toBeNull();
    expect(statusEnd("30m", now)).toBe(now.getTime() + 30 * 60_000);
    expect(statusEnd("1h", now)).toBe(now.getTime() + 60 * 60_000);
    expect(statusEnd("today", now)).toBe(new Date(2026, 9, 16).getTime() - 1);
    // This week ends with Sunday, from any day of it.
    expect(statusEnd("week", now)).toBe(new Date(2026, 9, 19).getTime() - 1);
    expect(statusEnd("week", new Date(2026, 9, 18, 9))).toBe(new Date(2026, 9, 19).getTime() - 1);
    expect(statusEnd("week", new Date(2026, 9, 19, 9))).toBe(new Date(2026, 9, 26).getTime() - 1);
  });
});
