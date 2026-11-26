/**
 * The call keys and push to talk as they are chosen and kept (K16), apart
 * from callKeys.ts, which reads and matches them: reading the choices is on
 * the first screen, and a module the first screen uses ships whole with it.
 */

export type CallKeyAction = "mute" | "deafen" | "talk";

export type CallKeys = Record<CallKeyAction, string>;

/** The keys the desktop app holds for a call: push to talk's only while it is chosen. */
export type HeldCallKeys = Omit<CallKeys, "talk"> & { talk: string | null };

export const CALL_KEY_ACTIONS: readonly CallKeyAction[] = ["mute", "deafen", "talk"];

/**
 * Mute keeps Slack's key, deafen takes Discord's, and push to talk is two
 * modifiers and the space bar, which no common Windows app uses and a hand
 * can hold down while it talks.
 */
export const DEFAULT_CALL_KEYS: CallKeys = {
  mute: "Mod+Shift+Space",
  deafen: "Mod+Shift+KeyD",
  talk: "Mod+Alt+Space",
};

/** How long the microphone stays on after the push-to-talk key is let go, unless chosen. */
export const DEFAULT_RELEASE_MS = 200;
export const RELEASE_DELAYS_MS = [0, 100, 200, 500, 1000] as const;

/**
 * Each of the keys as kept, a missing one, or one not written as a key, as its
 * default. Checked only for its shape, since the whole table of keys is not
 * worth its bytes on the first screen: a key that is not a call key never
 * matches, and settings offer to change it.
 */
export function callKeysOf(saved: unknown): CallKeys {
  const record = saved && typeof saved === "object" ? (saved as Record<string, unknown>) : {};
  const keys = { ...DEFAULT_CALL_KEYS };
  for (const action of CALL_KEY_ACTIONS) {
    const value = record[action];
    if (typeof value === "string" && /^(?:(?:Mod|Alt|Shift)\+){0,3}\w{1,12}$/.test(value))
      keys[action] = value;
  }
  return keys;
}
