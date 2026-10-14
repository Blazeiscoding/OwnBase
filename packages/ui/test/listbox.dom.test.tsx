import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Channel, User } from "@slackoss/protocol";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "../src/components/Composer.js";
import { ReactionPicker } from "../src/components/ReactionPicker.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";
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
const sadia = person("U_SADIA", "sadia", "Sadia Khan");

const design: Channel = {
  id: "C_DESIGN",
  type: "public",
  name: "design",
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
  memberIds: [sam.id, sadia.id],
};

const platform: Platform = {
  kind: "web",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};

async function renderComposer(extraUsers: User[] = []) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: Object.fromEntries([sam, sadia, ...extraUsers].map((person) => [person.id, person])),
    channels: {
      [design.id]: {
        ...design,
        memberIds: [...(design.memberIds ?? []), ...extraUsers.map((person) => person.id)],
      },
    },
    commands: [
      {
        command: "remind",
        description: "Set a reminder",
        usageHint: "[what] [when]",
        builtin: true,
      },
      { command: "rename", description: "Rename this channel", usageHint: "[name]", builtin: true },
    ],
    status: "online",
  });
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <Composer channelId={design.id} placeholder="Message #design" />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const box = screen.getByRole("textbox", { name: "Message #design" });
  await waitFor(() => expect(box).toBeEnabled());
  return { box, client, user: userEvent.setup() };
}

/** The option a text box points at, which is what a screen reader reads. */
function pointedAt(box: HTMLElement) {
  const id = box.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
}

describe("the composer's suggestions", () => {
  it("are options the text box points at, with nothing focusable inside them", async () => {
    const { box, client, user } = await renderComposer();
    const send = vi.spyOn(client, "send").mockReturnValue(true);
    await user.type(box, "Hi @sa");
    const mentions = screen.getByRole("listbox", { name: "Mentions" });
    const options = within(mentions).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Sam Rivera"),
      expect.stringContaining("Sadia Khan"),
    ]);
    // A button inside an option is announced twice, or not at all.
    expect(within(mentions).queryAllByRole("button")).toEqual([]);
    expect(box).toHaveAttribute("aria-controls", mentions.id);
    expect(pointedAt(box)).toBe(options[0]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowDown}");
    expect(pointedAt(box)).toBe(options[1]);
    await user.keyboard("{ArrowDown}");
    expect(pointedAt(box)).toBe(options[0]);
    await user.keyboard("{ArrowUp}");
    expect(pointedAt(box)).toBe(options[1]);
    expect(await accessibilityProblems(mentions.parentElement!)).toEqual([]);

    await user.keyboard("{Enter}");
    // The box reads as the name; what is sent names the person by id.
    expect(box).toHaveValue("Hi @Sadia Khan ");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(box).not.toHaveAttribute("aria-activedescendant");
    await user.type(box, "ready?{Enter}");
    expect(send).toHaveBeenCalledWith(design.id, `Hi <@${sadia.id}> ready?`, expect.anything());
  });

  it("take a click without taking focus from the text box", async () => {
    const { box, user } = await renderComposer();
    await user.type(box, "@sad");
    await user.click(screen.getByRole("option", { name: /Sadia Khan/ }));
    expect(box).toHaveValue("@Sadia Khan ");
    expect(box).toHaveFocus();
  });

  it("finds people by Japanese, Devanagari, Arabic, and combining-mark names beyond the first six", async () => {
    const fillers = Array.from({ length: 6 }, (_, i) =>
      person(`U_FILLER_${i}`, `filler${i}`, `Filler ${i}`),
    );
    const targets = [
      person("U_JAPANESE", "yamada", "山田 花子"),
      person("U_DEVANAGARI", "nanda", "नंदा देवी"),
      person("U_ARABIC", "aisha", "عائشة حسن"),
      person("U_ACCENT", "elodie", "Élodie Martin"),
    ];
    const { box, user } = await renderComposer([...fillers, ...targets]);
    await user.type(box, "@");
    expect(
      within(screen.getByRole("listbox", { name: "Mentions" })).getAllByRole("option"),
    ).toHaveLength(6);
    expect(screen.queryByRole("option", { name: /山田|नंदा|عائشة|Élodie/ })).toBeNull();

    for (const [query, target] of [
      ["山", targets[0]!],
      ["नं", targets[1]!],
      ["عائ", targets[2]!],
      ["e\u0301", targets[3]!],
    ] as const) {
      await user.clear(box);
      await user.type(box, `@${query}`);
      expect(screen.getByRole("option", { name: new RegExp(target.displayName) })).toBeVisible();
      await user.keyboard("{Tab}");
      expect(box).toHaveValue(`@${target.displayName} `);
    }
  });

  it("keeps Unicode mention discovery after paste and Backspace without changing ASCII broadcasts", async () => {
    const nanda = person("U_DEVANAGARI", "nanda", "नंदा देवी");
    const { box, user } = await renderComposer([nanda]);
    await user.click(box);
    await user.paste("@नंद");
    expect(screen.getByRole("option", { name: /नंदा देवी/ })).toBeVisible();
    await user.keyboard("{Backspace}");
    expect(box).toHaveValue("@नं");
    expect(screen.getByRole("option", { name: /नंदा देवी/ })).toBeVisible();
    await user.clear(box);
    await user.type(box, "@channel");
    await user.keyboard("{Tab}");
    expect(box).toHaveValue("@channel ");
    await user.clear(box);
    await user.type(box, "@sad");
    await user.keyboard("{Tab}");
    expect(box).toHaveValue("@Sadia Khan ");
  });

  it("offer commands the same way, and Tab completes the one chosen", async () => {
    const { box, user } = await renderComposer();
    await user.type(box, "/re");
    const commands = screen.getByRole("listbox", { name: "Commands" });
    const options = within(commands).getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(within(commands).queryAllByRole("button")).toEqual([]);
    expect(pointedAt(box)).toBe(options[0]);
    await user.keyboard("{ArrowDown}");
    expect(pointedAt(box)).toBe(options[1]);
    await user.keyboard("{Tab}");
    expect(box).toHaveValue("/rename ");
  });

  it("finish a word after a colon as an emoji, the closest first, and leave a time alone", async () => {
    const { box, client, user } = await renderComposer();
    const send = vi.spyOn(client, "send").mockReturnValue(true);
    await user.type(box, "Shipped :rock");
    // Every emoji arrives on first use, so the list waits for them.
    const emoji = await screen.findByRole("listbox", { name: "Emoji" });
    const options = within(emoji).getAllByRole("option");
    // The shortcode itself first, then those starting so: Slack's names.
    expect(options.slice(0, 2).map((option) => option.textContent)).toEqual([
      "🪨:rock:",
      "🚀:rocket:",
    ]);
    expect(pointedAt(box)).toBe(options[0]);
    await user.keyboard("{ArrowDown}");
    // Enter chooses the emoji rather than sending half a word.
    await user.keyboard("{Enter}");
    expect(box).toHaveValue("Shipped 🚀 ");
    expect(send).not.toHaveBeenCalled();

    await user.clear(box);
    await user.type(box, "at 10:30 :t");
    expect(screen.queryByRole("listbox", { name: "Emoji" })).not.toBeInTheDocument();
    await user.type(box, "h");
    // :thumbsup: is another name for :+1:; the common ones lead.
    expect(
      within(screen.getByRole("listbox", { name: "Emoji" }))
        .getAllByRole("option")
        .slice(0, 2)
        .map((option) => option.textContent),
    ).toEqual(["👍:+1:", "🤔:thinking_face:"]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Emoji" })).not.toBeInTheDocument();
    expect(box).toHaveValue("at 10:30 :th");
  });

  it("turn a shortcode typed out in full into its emoji, as Slack does, but not in code", async () => {
    const { box, user } = await renderComposer();
    await user.type(box, "Done :ta");
    await screen.findByRole("listbox", { name: "Emoji" });
    await user.type(box, "da: and `:tada:` and :not_an_emoji:");
    expect(box).toHaveValue("Done 🎉 and `:tada:` and :not_an_emoji:");
  });
});

describe("choosing an emoji", () => {
  it("in the composer, from the search box with the arrow keys and Enter", async () => {
    const { box, user } = await renderComposer();
    await user.type(box, "Ship it ");
    await user.click(screen.getByRole("button", { name: "Insert emoji" }));
    // The picker arrives on first use.
    const search = await screen.findByRole("combobox", { name: "Search emoji" });
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute("aria-expanded", "true");
    await user.type(search, "smile");
    const emoji = within(screen.getByRole("listbox", { name: "Emoji" })).getAllByRole("option");
    expect(emoji.slice(0, 2).map((o) => o.getAttribute("aria-label"))).toEqual([
      "Grinning Face with Smiling Eyes",
      "Grinning Face with Sweat",
    ]);
    expect(pointedAt(search)).toBe(emoji[0]);
    // Right moves the caret in what was typed, until the arrows have gone into the grid.
    await user.keyboard("{ArrowRight}");
    expect(pointedAt(search)).toBe(emoji[0]);
    await user.keyboard("{ArrowDown}");
    expect(pointedAt(search)).toBe(emoji[9]);
    await user.keyboard("{ArrowRight}");
    expect(pointedAt(search)).toBe(emoji[10]);
    expect(
      await accessibilityProblems(screen.getByRole("group", { name: "Choose an emoji" })),
    ).toEqual([]);

    await user.keyboard("{Enter}");
    expect(box).toHaveValue(`Ship it ${emoji[10]!.textContent}`);
    expect(box).toHaveFocus();
    expect(screen.queryByRole("combobox", { name: "Search emoji" })).not.toBeInTheDocument();
  });

  it("closes when anything outside it is pressed, and stays open for a press inside", async () => {
    const { box, user } = await renderComposer();
    const button = screen.getByRole("button", { name: "Insert emoji" });
    const chooser = () => screen.queryByRole("group", { name: "Choose an emoji" });
    await user.click(button);
    await screen.findByRole("combobox", { name: "Search emoji" });
    await user.click(within(chooser()!).getByRole("button", { name: "Flags" }));
    await user.click(within(chooser()!).getByRole("button", { name: /^Skin tone/ }));
    expect(chooser()).toBeInTheDocument();
    // Its own button closes it, rather than a press outside closing it and the click opening it again.
    await user.click(button);
    expect(chooser()).not.toBeInTheDocument();

    await user.click(button);
    expect(chooser()).toBeInTheDocument();
    // Focus goes where the press put it.
    await user.click(box);
    expect(chooser()).not.toBeInTheDocument();
    expect(box).toHaveFocus();
    expect(button).toHaveAttribute("aria-expanded", "false");

    await user.click(button);
    expect(chooser()).toBeInTheDocument();
    await user.click(document.body);
    expect(chooser()).not.toBeInTheDocument();
  });

  it("says when nothing matches, and points at nothing", async () => {
    const { user } = await renderComposer();
    await user.click(screen.getByRole("button", { name: "Insert emoji" }));
    const search = screen.getByRole("combobox", { name: "Search emoji" });
    await user.type(search, "zzzz");
    expect(search).toHaveAttribute("aria-expanded", "false");
    expect(search).not.toHaveAttribute("aria-activedescendant");
    expect(screen.getByText("No emoji matched. Try another word.")).toBeVisible();
    // Enter with nothing chosen does nothing, rather than throwing.
    await user.keyboard("{Enter}");
    expect(search).toBeInTheDocument();
  });

  it("scrolls the choice into view when a key moves it, not when the pointer does", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    try {
      render(<ReactionPicker onPick={() => {}} onClose={() => {}} />);
      const user = userEvent.setup();
      const emoji = within(screen.getByRole("group", { name: "Frequently used" })).getAllByRole(
        "option",
      );
      await user.hover(emoji[3]!);
      expect(scrolled).not.toHaveBeenCalled();
      // Down is a row down: nine emoji on.
      await user.keyboard("{ArrowDown}");
      expect(scrolled).toHaveBeenCalledOnce();
      expect(scrolled.mock.contexts[0]).toBe(emoji[12]);
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it("as a reaction, from the keyboard", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<ReactionPicker onPick={onPick} onClose={onClose} />);
    const search = screen.getByRole("combobox", { name: "Search emoji" });
    expect(search).toHaveFocus();
    await userEvent.setup().type(search, "party{Enter}");
    expect(onPick).toHaveBeenCalledWith("🎉");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
