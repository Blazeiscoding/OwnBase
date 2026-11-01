import { useComposerPreferences } from "../lib/composerPreferences.js";
import { useState } from "react";
import { Dialog, DialogScroll } from "./Dialog.js";
import { inputCls } from "./TextField.js";
import { Kbd } from "./Kbd.js";
import { isApple, modKey } from "../lib/shortcuts.js";

/** The key held for shortcuts, as this keyboard labels it: ⌘ on a Mac, Ctrl elsewhere. */
const MOD = modKey();
/** Option on a Mac, Alt elsewhere. */
const ALT = isApple() ? "⌥" : "Alt";

/** What Enter does depends on the preference in Account settings, so the list follows it. */
function writingKeys(enterSends: boolean): [string, string][] {
  return enterSends
    ? [
        ["Enter", "Send"],
        ["Shift Enter", "New line"],
        [`${MOD} Enter`, "Send, even with a suggestion open"],
      ]
    : [
        [`${MOD} Enter`, "Send"],
        ["Enter", "New line"],
      ];
}

const groups = (
  enterSends: boolean,
): { title: string; items: [string, string][]; note?: string }[] => [
  {
    title: "Getting around",
    items: [
      [`${MOD} K`, "Jump to a channel or person"],
      [`${MOD} F`, "Search this conversation"],
      [`${ALT} ↑`, "Previous conversation in the sidebar"],
      [`${ALT} ↓`, "Next conversation in the sidebar"],
      [`${ALT} Shift ↑`, "Previous unread conversation"],
      [`${ALT} Shift ↓`, "Next unread conversation"],
      ["Shift Esc", "Mark everything as read"],
      ["Esc", "Close the open panel or dialog"],
      [`${MOD} /`, "Show this list"],
    ],
  },
  {
    title: "Writing",
    note: "Choose what Enter does in Account settings.",
    items: [
      ...writingKeys(enterSends),
      [`${MOD} B`, "Bold selected text"],
      [`${MOD} I`, "Italic selected text"],
      [`${MOD} Shift X`, "Strikethrough selected text"],
      [`${MOD} E`, "Inline code"],
      [`${MOD} Shift 8`, "Bulleted list"],
      [`${MOD} Shift 7`, "Numbered list"],
      ["↑", "Edit your last message, from an empty box"],
      ["@", "Mention someone"],
      [":", "Add an emoji by name, as :rocket"],
      [`${MOD} V`, "Paste an image straight in"],
    ],
  },
  {
    title: "Messages",
    note: "The list of messages is one Tab stop; these work once it has focus.",
    items: [
      ["↑", "Previous message"],
      ["↓", "Next message"],
      ["Home", "First message"],
      ["End", "Last message"],
      ["Enter", "Into the message's actions"],
      ["Esc", "Back out to the message, or cancel an edit"],
    ],
  },
];

/** A shortcut matches when every word typed is in its keys or what it does. */
function matches(query: string, keys: string, what: string): boolean {
  const haystack = `${keys} ${what}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { enterSends } = useComposerPreferences();
  const [query, setQuery] = useState("");
  const shown = groups(enterSends)
    .map((group) => ({
      ...group,
      items: group.items.filter(([keys, what]) => matches(query, keys, what)),
    }))
    .filter((group) => group.items.length > 0);
  // Laid out as Linear's shortcut gallery is: what it does first, read down the
  // left, and its keys as keycaps lined up on the right.
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} width={500} ownScroll>
      <label className="block shrink-0 px-6 pb-3 text-sm">
        <span className="sr-only">Find a shortcut</span>
        <input
          type="search"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a shortcut"
          className={inputCls}
        />
      </label>
      {/* Nothing in the sheet takes focus, so the sheet does. The keys that
          scroll then scroll it, in every browser. */}
      <DialogScroll tabIndex={0} role="group" aria-label="Shortcuts">
        <p role="status" className="mb-2 text-sm text-ink-faint empty:hidden">
          {shown.length === 0 ? "No shortcut matches. Try another word." : ""}
        </p>
        <div className="space-y-5">
          {shown.map((group) => (
            <section key={group.title}>
              <h3 className="mb-2 text-[13px] font-semibold text-ink">{group.title}</h3>
              <ul className="divide-y divide-edge overflow-hidden rounded-xl border border-edge">
                {group.items.map(([keys, what]) => (
                  <li
                    key={keys}
                    className="flex min-h-9 items-center justify-between gap-4 px-3 py-1 text-sm"
                  >
                    <span className="text-ink-dim">{what}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {keys.split(" ").map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
              {group.note && <p className="mt-2 text-xs text-ink-faint">{group.note}</p>}
            </section>
          ))}
        </div>
      </DialogScroll>
    </Dialog>
  );
}
