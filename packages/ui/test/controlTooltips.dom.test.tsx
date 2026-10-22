import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient, type HuddlePeer } from "@slackoss/client-core";
import type { Channel, User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { FormattingToolbar } from "../src/components/FormattingToolbar.js";
import { HuddleButton } from "../src/components/HuddleBar.js";
import { HuddleStage } from "../src/components/HuddleStage.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

// jsdom has no media pipeline: a video only needs somewhere to put a stream.
beforeAll(() => {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
});

const person = (id: string, displayName: string): User => ({
  id,
  handle: displayName.split(" ")[0]!.toLowerCase(),
  displayName,
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});

const general: Channel = {
  id: "C_GENERAL",
  type: "public",
  name: "general",
  topic: "",
  description: "",
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
};

const peer = (userId: string, media: Partial<HuddlePeer> = {}): HuddlePeer => ({
  userId,
  audioStream: null,
  cameraStream: null,
  screenStream: null,
  connected: true,
  micMuted: false,
  speaking: false,
  ...media,
});

function client() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  const sam = person("U_SAM", "Sam Rivera");
  client.store.setState({
    self: sam,
    users: { U_SAM: sam, U_PRIYA: person("U_PRIYA", "Priya Shah") },
    channels: { C_GENERAL: general },
    status: "online",
  });
  return client;
}

/** Tab to a control, and read the hint it shows and how it is described. */
async function tabTo(user: ReturnType<typeof userEvent.setup>, control: HTMLElement) {
  for (let presses = 0; presses < 20 && document.activeElement !== control; presses++) {
    await user.tab();
  }
  expect(control).toHaveFocus();
  return screen.getByRole("tooltip");
}

describe("compact controls explain themselves with the shared tooltip", () => {
  it("names each formatting button and its shortcut, and still formats", async () => {
    const user = userEvent.setup();
    const onFormat = vi.fn();
    const onList = vi.fn();
    const { container } = render(
      <FormattingToolbar
        onFormat={onFormat}
        onList={onList}
        onInsert={() => {}}
        preview={false}
        onTogglePreview={() => {}}
      />,
    );
    expect(container.querySelector("[title]")).toBeNull();

    const bold = screen.getByRole("button", { name: "Bold" });
    expect(await tabTo(user, bold)).toHaveTextContent("Bold. Shortcut: Ctrl/Cmd+B");
    expect(bold).toHaveAccessibleDescription("Bold. Shortcut: Ctrl/Cmd+B");

    const italic = screen.getByRole("button", { name: "Italic" });
    expect(await tabTo(user, italic)).toHaveTextContent("Italic. Shortcut: Ctrl/Cmd+I");

    // Strikethrough has no shortcut, so its hint claims none.
    const strike = screen.getByRole("button", { name: "Strikethrough" });
    expect(await tabTo(user, strike)).toHaveTextContent(/^Strikethrough$/);

    const code = screen.getByRole("button", { name: "Inline code" });
    expect(await tabTo(user, code)).toHaveTextContent("Inline code. Shortcut: Ctrl/Cmd+E");
    expect(await accessibilityProblems(container)).toEqual([]);

    await user.keyboard("{Enter}");
    expect(onFormat).toHaveBeenLastCalledWith("`", "text");
    await user.click(screen.getByRole("button", { name: "Code block" }));
    expect(onFormat).toHaveBeenLastCalledWith("```", "code", true);

    const bullets = screen.getByRole("button", { name: "Bulleted list" });
    expect(await tabTo(user, bullets)).toHaveTextContent(
      "Bulleted list. Shortcut: Ctrl/Cmd+Shift+8",
    );
    await user.keyboard("{Enter}");
    expect(onList).toHaveBeenLastCalledWith("bullets");
    const numbers = screen.getByRole("button", { name: "Numbered list" });
    expect(await tabTo(user, numbers)).toHaveTextContent(
      "Numbered list. Shortcut: Ctrl/Cmd+Shift+7",
    );
    await user.click(numbers);
    expect(onList).toHaveBeenLastCalledWith("numbers");
  });

  it("folds the formatting buttons behind one, which says what it shows and hides", async () => {
    const user = userEvent.setup();
    const onFormat = vi.fn();
    render(
      <FormattingToolbar
        onFormat={onFormat}
        onList={() => {}}
        onInsert={() => {}}
        preview={false}
        onTogglePreview={() => {}}
      />,
    );
    const toggle = screen.getByRole("button", { name: "Formatting" });
    const buttons = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(buttons).toContainElement(screen.getByRole("button", { name: "Bold" }));
    expect(buttons).toContainElement(screen.getByRole("button", { name: "Code block" }));
    // Emoji and Preview stay out of the fold.
    expect(buttons).not.toContainElement(screen.getByRole("button", { name: "Insert emoji" }));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(buttons).not.toHaveAttribute("data-expanded");

    expect(await tabTo(user, toggle)).toHaveTextContent("Formatting");
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(buttons).toHaveAttribute("data-expanded");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Hide formatting");
    await user.click(screen.getByRole("button", { name: "Italic" }));
    expect(onFormat).toHaveBeenCalledWith("_", "text");
  });

  it("keeps the emoji button's own focus return when its chooser closes", async () => {
    const user = userEvent.setup();
    render(
      <FormattingToolbar
        onFormat={() => {}}
        onList={() => {}}
        onInsert={() => {}}
        preview={false}
        onTogglePreview={() => {}}
      />,
    );
    const emoji = screen.getByRole("button", { name: "Insert emoji" });
    expect(await tabTo(user, emoji)).toHaveTextContent("Insert emoji");
    await user.keyboard("{Enter}");
    // The picker arrives on first use.
    expect(await screen.findByRole("combobox", { name: "Search emoji" })).toHaveFocus();
    await user.keyboard("{Escape}");
    // The chooser hands focus back through the ref the tooltip wraps.
    expect(emoji).toHaveFocus();
    expect(emoji).toHaveAttribute("aria-expanded", "false");
  });

  it("says what each huddle video control does now, without renaming it", async () => {
    const user = userEvent.setup();
    const c = client();
    c.store.setState({
      huddle: {
        channelId: "C_GENERAL",
        micMuted: false,
        cameraOn: false,
        sharingScreen: false,
        localCameraStream: null,
        localScreenStream: null,
        speaking: false,
        micLost: false,
        peers: [
          peer("U_PRIYA", { cameraStream: {} as MediaStream, screenStream: {} as MediaStream }),
        ],
      },
    });
    // Where how loud each person is to you is kept.
    const platform: Platform = {
      kind: "web",
      storage: { get: async () => null, set: async () => {} },
      notify: () => {},
    };
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={c}>
          <HuddleStage onHide={() => {}} chat={{ shown: true, onToggle: () => {} }} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const region = screen.getByRole("region", { name: "Huddle call" });
    expect(region.querySelector("[title]")).toBeNull();

    const grid = within(region).getByRole("button", { name: "Grid view" });
    expect(await tabTo(user, grid)).toHaveTextContent("Show everyone the same size");
    const chat = within(region).getByRole("button", { name: "Chat" });
    expect(await tabTo(user, chat)).toHaveTextContent("Hide the chat");
    expect(chat).toHaveAccessibleDescription("Hide the chat");

    const strip = within(region).getByRole("list", { name: "Everyone else" });
    const priya = within(strip).getByRole("button", { name: "Pin Priya Shah" });
    expect(await tabTo(user, priya)).toHaveTextContent("Show Priya Shah large");
    expect(await accessibilityProblems(region)).toEqual([]);

    await user.keyboard("{Enter}");
    const unpin = within(region).getByRole("button", { name: "Unpin Priya Shah" });
    act(() => unpin.focus());
    expect(screen.getByRole("tooltip")).toHaveTextContent("Unpin Priya Shah");
  });

  it("names the header's huddle button when its word is hidden on a narrow screen", async () => {
    const user = userEvent.setup();
    const c = client();
    // Where the choice to join muted is kept.
    const platform: Platform = {
      kind: "web",
      storage: { get: async () => null, set: async () => {} },
      notify: () => {},
    };
    const button = (
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={c}>
          <HuddleButton channelId="C_GENERAL" />
        </ClientContext.Provider>
      </PlatformContext.Provider>
    );
    const { rerender } = render(button);
    const start = screen.getByRole("button", { name: "Start a huddle" });
    expect(start).not.toHaveAttribute("title");
    expect(await tabTo(user, start)).toHaveTextContent("Start a huddle");

    act(() => c.store.setState({ huddles: { C_GENERAL: ["U_PRIYA"] } }));
    rerender(button);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Join the huddle with Priya Shah");
  });
});
