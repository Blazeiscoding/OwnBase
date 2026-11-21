import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { CustomEmoji, User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { CustomEmojiDialog } from "../src/components/CustomEmojiDialog.js";
import { CustomEmojiHost } from "../src/components/CustomEmojiHost.js";
import { WorkspaceSettings } from "../src/components/WorkspaceSettings.js";
import type { Platform } from "../src/platform.js";

/** The Custom emoji window (J12): adding, the list, and removing with a question first. */
const person = (id: string, displayName: string, role: User["role"]): User => ({
  id,
  handle: id.toLowerCase(),
  displayName,
  role,
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});
const platform: Platform = {
  kind: "web",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};
const emoji = (id: string, name: string, createdBy: string): CustomEmoji =>
  ({ id, name, createdBy, createdAt: 0 }) as CustomEmoji;

const clients: WorkspaceClient[] = [];
afterEach(() => {
  // Unmount before the globals go: vitest runs these hooks in reverse.
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function workspace(role: User["role"], adminsOnly = false) {
  const self = person("U_SAM", "Sam Rivera", role);
  const other = person("U_ALEX", "Alex Kim", "member");
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({
    self,
    users: { [self.id]: self, [other.id]: other },
    status: "online",
    workspaceName: "Rocket Team",
    emojiAddingAdminsOnly: adminsOnly,
    customEmoji: {
      mine: emoji("E_MINE", "mine", self.id),
      shipit: emoji("E_SHIP", "shipit", other.id),
    },
  });
  vi.spyOn(client.emojiPictures, "peek").mockReturnValue("blob:emoji");
  vi.spyOn(client.emojiPictures, "load").mockResolvedValue("blob:emoji");
  return client;
}

function open(role: User["role"] = "member", adminsOnly = false) {
  const client = workspace(role, adminsOnly);
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <ConfirmProvider>
          <CustomEmojiDialog onClose={() => {}} />
        </ConfirmProvider>
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const dialog = screen.getByRole("dialog", { name: "Custom emoji" });
  return { client, dialog, user: userEvent.setup() };
}

/** Chooses a file in the window's hidden file field, as the system's picker would. */
function choose(dialog: HTMLElement, file: File) {
  const input = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [file] } });
}

/** A picture the browser can open: jsdom draws none, so its size is stubbed. */
function pictures() {
  vi.stubGlobal("createImageBitmap", async () => ({ width: 64, height: 64, close() {} }));
  URL.createObjectURL ??= () => "";
  URL.revokeObjectURL ??= () => {};
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:chosen");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
}
const png = (name: string) => new File([new Uint8Array(8)], name, { type: "image/png" });

describe("removing a custom emoji (E1)", () => {
  it("asks first, naming what it does to messages, and says when it is done", async () => {
    const { client, dialog, user } = open("admin");
    const remove = vi.spyOn(client.api, "removeCustomEmoji").mockResolvedValue({ ok: true });

    await user.click(within(dialog).getByRole("button", { name: "Remove :shipit:" }));
    let question = await screen.findByRole("dialog", { name: "Remove :shipit:?" });
    expect(question).toHaveTextContent(
      "Messages and reactions that use it will show :shipit: as text. This can't be undone.",
    );
    await user.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(remove).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Remove :shipit:" }));
    question = await screen.findByRole("dialog", { name: "Remove :shipit:?" });
    await user.click(within(question).getByRole("button", { name: "Remove emoji" }));
    expect(remove).toHaveBeenCalledWith("E_SHIP");
    await waitFor(() =>
      expect(within(dialog).getByRole("status")).toHaveTextContent(":shipit: was removed."),
    );
    expect(within(dialog).queryByText(":shipit:")).toBeNull();
  });

  it("shows Remove on a row only while it is pointed at or focused, and always on a touchscreen (E9)", () => {
    const { dialog } = open("admin");
    const remove = within(dialog).getByRole("button", { name: "Remove :shipit:" });
    expect(remove).toHaveClass(
      "opacity-0",
      "group-hover/row:opacity-100",
      "group-focus-within/row:opacity-100",
      "[@media(hover:none)]:opacity-100",
    );
  });
});

describe("the window for those who cannot add (E2)", () => {
  it("lists the workspace's emoji and keeps Remove on the ones they added", () => {
    const { dialog } = open("member", true);
    expect(within(dialog).queryByRole("button", { name: "Add emoji" })).toBeNull();
    expect(dialog).toHaveTextContent(
      "Only the workspace's owner and admins can add emoji here. You can still remove the ones you added.",
    );
    expect(within(dialog).getByRole("button", { name: "Remove :mine:" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Remove :shipit:" })).toBeNull();
  });
});

describe("adding a custom emoji", () => {
  it("leaves the name empty, with no example that reads as a value (E4)", () => {
    const { dialog } = open();
    expect(within(dialog).getByRole("textbox", { name: "Name" })).not.toHaveAttribute(
      "placeholder",
    );
  });

  it("says which pictures it takes and their limits (E8)", () => {
    const { dialog } = open();
    expect(dialog).toHaveTextContent(
      "PNG, GIF, WebP or JPEG. Large still pictures are made smaller. Animated GIFs must be under 256 KB.",
    );
  });

  it("ties a bad picture's problem to the picture, not the name (E5)", async () => {
    const { dialog } = open();
    choose(dialog, new File(["not a picture"], "notes.txt", { type: "text/plain" }));
    const problem = await within(dialog).findByRole("alert");
    expect(problem).toHaveTextContent("Choose a PNG, GIF, WebP or JPEG picture.");
    expect(within(dialog).getByRole("textbox", { name: "Name" })).not.toHaveAttribute(
      "aria-invalid",
    );
    const picture = within(dialog).getByRole("button", { name: "Choose a picture" });
    expect(picture).toHaveAccessibleDescription("Choose a PNG, GIF, WebP or JPEG picture.");
    expect(dialog.querySelector("[data-picture-problem]")).not.toBeNull();
  });

  it("ties a bad name's problem to the name, not the picture (E5)", async () => {
    pictures();
    const { dialog, user } = open();
    choose(dialog, png("Party.png"));
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await waitFor(() => expect(name).toHaveValue("party"));
    await user.clear(name);
    await user.type(name, "no spaces allowed");
    await user.click(within(dialog).getByRole("button", { name: "Add emoji" }));
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription(
      /A name has 1 to 32 lowercase letters, digits, dashes or underscores./,
    );
    expect(
      within(dialog).getByRole("button", { name: "Choose another picture" }),
    ).toHaveAccessibleDescription(/^PNG, GIF, WebP or JPEG\./);
  });

  it("says a name is taken before sending it (E6)", async () => {
    pictures();
    const { client, dialog, user } = open();
    const add = vi.spyOn(client.api, "addCustomEmoji");
    choose(dialog, png("shipit.png"));
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await waitFor(() => expect(name).toHaveValue("shipit"));
    await user.click(within(dialog).getByRole("button", { name: "Add emoji" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      ":shipit: is already in this workspace. Choose another name.",
    );
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(add).not.toHaveBeenCalled();
  });

  it("says what was added and how to use it, and marks the new row (E7)", async () => {
    pictures();
    const { client, dialog, user } = open();
    vi.spyOn(client.api, "addCustomEmoji").mockImplementation(async (name) => ({
      emoji: emoji("E_NEW", name, "U_SAM"),
    }));
    choose(dialog, png("Party Parrot.png"));
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await waitFor(() => expect(name).toHaveValue("party-parrot"));
    await user.click(within(dialog).getByRole("button", { name: "Add emoji" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("status")).toHaveTextContent(
        ":party-parrot: was added. Use it in any message or reaction.",
      ),
    );
    expect(within(dialog).getByRole("button", { name: "Choose a picture" })).toHaveFocus();
    const row = within(dialog).getByText(":party-parrot:").closest("li")!;
    expect(row).toHaveAttribute("data-just-added");
  });
});

describe("Workspace settings (E3)", () => {
  it("opens the Custom emoji window from Manage custom emoji", async () => {
    const client = workspace("owner");
    const user = userEvent.setup();
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <ConfirmProvider>
            <WorkspaceSettings onClose={() => {}} />
            <CustomEmojiHost />
          </ConfirmProvider>
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const settings = screen.getByRole("dialog", { name: "Workspace settings" });
    const manage = within(settings).getByRole("button", { name: "Manage custom emoji" });
    expect(manage.className).not.toContain("bg-copper ");
    await user.click(manage);
    expect(await screen.findByRole("dialog", { name: "Custom emoji" })).toBeInTheDocument();
  });
});
