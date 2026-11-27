import { describe, expect, it } from "vitest";
import { CallKeyHolder, type Shortcuts } from "../src/main/callKeys.js";

/** globalShortcut as the system answers it: a key another app holds cannot be had. */
function system(othersHold: string[] = []) {
  const held = new Map<string, () => void>();
  const shortcuts: Shortcuts = {
    register(accelerator, callback) {
      if (othersHold.includes(accelerator) || held.has(accelerator)) return false;
      held.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) {
      held.delete(accelerator);
    },
  };
  const pressed: string[] = [];
  const taken: string[][] = [];
  const holder = new CallKeyHolder(
    shortcuts,
    (action) => pressed.push(action),
    (list) => taken.push(list),
  );
  return { holder, held, othersHold, pressed, taken };
}

const KEYS = { mute: "Mod+Shift+Space", deafen: "Mod+Shift+KeyD", talk: "Mod+Alt+Space" };

describe("the call keys while another app is in front (K16)", () => {
  it("holds them only while the window is behind another app, and only in a call", () => {
    const { holder, held, pressed } = system();
    expect(holder.set(KEYS, true)).toEqual([]);
    // In front, the window hears the keys itself.
    expect([...held.keys()]).toEqual([]);

    holder.blur();
    expect([...held.keys()]).toEqual([
      "CommandOrControl+Shift+Space",
      "CommandOrControl+Shift+D",
      "CommandOrControl+Alt+Space",
    ]);
    held.get("CommandOrControl+Shift+D")!();
    expect(pressed).toEqual(["deafen"]);

    holder.focus();
    expect(held.size).toBe(0);
    holder.blur();
    holder.set(null, false);
    expect(held.size).toBe(0);
    holder.blur();
    expect(held.size).toBe(0);
  });

  it("leaves push to talk's key alone unless push to talk is chosen", () => {
    const { holder, held } = system();
    holder.set({ ...KEYS, talk: null }, false);
    expect([...held.keys()]).toEqual(["CommandOrControl+Shift+Space", "CommandOrControl+Shift+D"]);
  });

  it("says at once which keys another app holds, and again when that changes", () => {
    const { holder, othersHold, taken } = system(["CommandOrControl+Shift+D"]);
    expect(holder.set(KEYS, true)).toEqual(["deafen"]);
    holder.blur();
    expect(taken).toEqual([]);

    holder.focus();
    othersHold.push("CommandOrControl+Alt+Space");
    holder.blur();
    expect(taken).toEqual([["deafen", "talk"]]);
  });

  it("lets go of the old keys when the keys change", () => {
    const { holder, held } = system();
    holder.set(KEYS, false);
    holder.set({ ...KEYS, mute: "F9" }, false);
    expect(held.has("CommandOrControl+Shift+Space")).toBe(false);
    expect(held.has("F9")).toBe(true);
  });

  it("refuses keys the window could not have chosen", () => {
    const { holder } = system();
    expect(() => holder.set({ ...KEYS, mute: "KeyM" }, true)).toThrow();
    expect(() => holder.set({ ...KEYS, deafen: KEYS.mute }, true)).toThrow();
    expect(() => holder.set("Mod+KeyM", true)).toThrow();
  });
});
