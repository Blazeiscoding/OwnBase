import { describe, expect, it } from "vitest";
import {
  DEFAULT_CALL_KEYS,
  callKeyAccelerator,
  callKeyCombo,
  callKeyFromEvent,
  callKeysOf,
  matchesCallKey,
  parseCallKey,
  releasesCallKey,
} from "../src/callKeys.js";

const press = (
  code: string,
  mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {},
) => ({
  code,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
});

describe("call keys (K16)", () => {
  it("takes a key with Ctrl, ⌘ or Alt held, or a function key alone, and no key that types", () => {
    expect(callKeyFromEvent(press("KeyD", { ctrl: true, shift: true }))).toBe("Mod+Shift+KeyD");
    expect(callKeyFromEvent(press("KeyD", { meta: true, shift: true }))).toBe("Mod+Shift+KeyD");
    expect(callKeyFromEvent(press("Backquote", { alt: true }))).toBe("Alt+Backquote");
    expect(callKeyFromEvent(press("F9"))).toBe("F9");
    expect(callKeyFromEvent(press("KeyD"))).toBeNull();
    expect(callKeyFromEvent(press("KeyD", { shift: true }))).toBeNull();
    expect(callKeyFromEvent(press("Space"))).toBeNull();
    // A modifier on its own is still being pressed, not a key.
    expect(callKeyFromEvent(press("ControlLeft", { ctrl: true }))).toBeNull();
    expect(callKeyFromEvent(press("Numpad5", { ctrl: true }))).toBeNull();
  });

  it("reads only keys written as it writes them", () => {
    expect(parseCallKey("Shift+Mod+KeyD")).toBeNull();
    expect(parseCallKey("Mod+Mod+KeyD")).toBeNull();
    expect(parseCallKey("Ctrl+KeyD")).toBeNull();
    expect(parseCallKey(42)).toBeNull();
    expect(parseCallKey("Mod+Alt+Shift+F24")).toEqual({
      mod: true,
      alt: true,
      shift: true,
      code: "F24",
    });
  });

  it("matches a press with exactly the key's modifiers", () => {
    expect(matchesCallKey("Mod+Shift+Space", press("Space", { ctrl: true, shift: true }))).toBe(
      true,
    );
    expect(
      matchesCallKey("Mod+Shift+Space", press("Space", { ctrl: true, shift: true, alt: true })),
    ).toBe(false);
    expect(matchesCallKey("Mod+Shift+Space", press("Space", { ctrl: true }))).toBe(false);
  });

  it("ends a held key when it, or a modifier it needs, is let go", () => {
    expect(releasesCallKey("Mod+Alt+Space", { key: " ", code: "Space" })).toBe(true);
    expect(releasesCallKey("Mod+Alt+Space", { key: "Control", code: "ControlLeft" })).toBe(true);
    expect(releasesCallKey("Mod+Alt+Space", { key: "Alt", code: "AltRight" })).toBe(true);
    expect(releasesCallKey("Mod+Alt+Space", { key: "Shift", code: "ShiftLeft" })).toBe(false);
  });

  it("names keys for people and for Electron", () => {
    expect(callKeyCombo("Mod+Shift+KeyD")).toBe("Mod+Shift+D");
    expect(callKeyCombo("Alt+Backquote")).toBe("Alt+`");
    expect(callKeyAccelerator("Mod+Shift+KeyD")).toBe("CommandOrControl+Shift+D");
    expect(callKeyAccelerator("Mod+Alt+Space")).toBe("CommandOrControl+Alt+Space");
    expect(callKeyAccelerator("Alt+ArrowUp")).toBe("Alt+Up");
    expect(callKeyAccelerator("F9")).toBe("F9");
    expect(callKeyAccelerator("KeyD")).toBeNull();
    expect(callKeyAccelerator("Mod+Shift+Escape")).toBeNull();
  });

  it("keeps a saved key and puts back the default for one missing or unreadable", () => {
    expect(callKeysOf(null)).toEqual(DEFAULT_CALL_KEYS);
    expect(callKeysOf({ mute: "F9", deafen: "KeyD", talk: 3 })).toEqual({
      ...DEFAULT_CALL_KEYS,
      mute: "F9",
    });
  });

  it("has defaults that are three different keys, each a call key", () => {
    const keys = Object.values(DEFAULT_CALL_KEYS);
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(callKeyAccelerator(key)).not.toBeNull();
  });
});
