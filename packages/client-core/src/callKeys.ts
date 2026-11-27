/**
 * The keys that work a call (K16): mute, deafen, and push to talk. One key
 * each, written as "Mod+Shift+Space": modifiers, then the key as the
 * browser's `KeyboardEvent.code` names it, so it means the same place on every
 * keyboard layout. The window matches it against key presses, and the desktop
 * app turns it into an Electron accelerator for keys that work in any app.
 */

export {
  CALL_KEY_ACTIONS,
  DEFAULT_CALL_KEYS,
  DEFAULT_RELEASE_MS,
  RELEASE_DELAYS_MS,
  callKeysOf,
} from "./callKeyChoices.js";
export type { CallKeyAction, CallKeys, HeldCallKeys } from "./callKeyChoices.js";

/** Keys other than letters and digits, by code, as people and Electron name them. */
const NAMED: Record<string, { label: string; accelerator: string }> = {
  Space: { label: "Space", accelerator: "Space" },
  Backquote: { label: "`", accelerator: "`" },
  Minus: { label: "-", accelerator: "-" },
  Equal: { label: "=", accelerator: "=" },
  BracketLeft: { label: "[", accelerator: "[" },
  BracketRight: { label: "]", accelerator: "]" },
  Backslash: { label: "\\", accelerator: "\\" },
  Semicolon: { label: ";", accelerator: ";" },
  Quote: { label: "'", accelerator: "'" },
  Comma: { label: ",", accelerator: "," },
  Period: { label: ".", accelerator: "." },
  Slash: { label: "/", accelerator: "/" },
  Insert: { label: "Insert", accelerator: "Insert" },
  Delete: { label: "Delete", accelerator: "Delete" },
  Home: { label: "Home", accelerator: "Home" },
  End: { label: "End", accelerator: "End" },
  PageUp: { label: "PgUp", accelerator: "PageUp" },
  PageDown: { label: "PgDn", accelerator: "PageDown" },
  ArrowUp: { label: "↑", accelerator: "Up" },
  ArrowDown: { label: "↓", accelerator: "Down" },
  ArrowLeft: { label: "←", accelerator: "Left" },
  ArrowRight: { label: "→", accelerator: "Right" },
};

function keyOf(code: string): { label: string; accelerator: string } | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return { label: letter[1]!, accelerator: letter[1]! };
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return { label: digit[1]!, accelerator: digit[1]! };
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return { label: code, accelerator: code };
  return NAMED[code] ?? null;
}

const isFunctionKey = (code: string) => /^F\d+$/.test(code);

export interface ParsedCallKey {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  code: string;
}

/**
 * A key as written, or null for one that is not a call key: a function key
 * alone, or any listed key with Ctrl (⌘ on a Mac) or Alt held, so that a key
 * pressed while typing a message types it rather than muting.
 */
export function parseCallKey(combo: unknown): ParsedCallKey | null {
  if (typeof combo !== "string" || combo.length > 40) return null;
  const parts = combo.split("+");
  const code = parts.pop()!;
  const mods = new Set(parts);
  if (mods.size !== parts.length || [...mods].some((m) => !["Mod", "Alt", "Shift"].includes(m)))
    return null;
  // Written in one order, so two ways of writing a key are never two keys.
  const order = ["Mod", "Alt", "Shift"].filter((m) => mods.has(m));
  if (order.join("+") !== parts.join("+")) return null;
  if (!keyOf(code)) return null;
  const parsed = { mod: mods.has("Mod"), alt: mods.has("Alt"), shift: mods.has("Shift"), code };
  if (!parsed.mod && !parsed.alt && !isFunctionKey(code)) return null;
  return parsed;
}

function write({ mod, alt, shift, code }: ParsedCallKey): string {
  return [mod && "Mod", alt && "Alt", shift && "Shift", code].filter(Boolean).join("+");
}

/** The pressed keys as a call key, or null for a press that cannot be one. */
export function callKeyFromEvent(event: {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  const combo = write({
    mod: event.ctrlKey || event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
    code: event.code,
  });
  return parseCallKey(combo) ? combo : null;
}

/** Whether a key press is this call key, with exactly its modifiers held. */
export function matchesCallKey(
  combo: string,
  event: { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
): boolean {
  const key = parseCallKey(combo);
  return (
    !!key &&
    event.code === key.code &&
    (event.ctrlKey || event.metaKey) === key.mod &&
    event.altKey === key.alt &&
    event.shiftKey === key.shift
  );
}

/**
 * Whether letting go of this key ends a press of the call key: the key itself,
 * or one of the modifiers it needs.
 */
export function releasesCallKey(combo: string, event: { key: string; code: string }): boolean {
  const key = parseCallKey(combo);
  if (!key) return false;
  if (event.code === key.code) return true;
  return (
    (key.mod && (event.key === "Control" || event.key === "Meta")) ||
    (key.alt && event.key === "Alt") ||
    (key.shift && event.key === "Shift")
  );
}

/** The key as `shortcutLabel` reads it: "Mod+Shift+D". */
export function callKeyCombo(combo: string): string {
  const key = parseCallKey(combo);
  if (!key) return combo;
  return [key.mod && "Mod", key.alt && "Alt", key.shift && "Shift", keyOf(key.code)!.label]
    .filter(Boolean)
    .join("+");
}

/** The key as Electron's globalShortcut takes it, or null for one that is not a call key. */
export function callKeyAccelerator(combo: unknown): string | null {
  const key = parseCallKey(combo);
  if (!key) return null;
  return [
    key.mod && "CommandOrControl",
    key.alt && "Alt",
    key.shift && "Shift",
    keyOf(key.code)!.accelerator,
  ]
    .filter(Boolean)
    .join("+");
}
