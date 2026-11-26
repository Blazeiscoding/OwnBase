import {
  CALL_KEY_ACTIONS,
  callKeyAccelerator,
  type CallKeyAction,
} from "@ownbase/client-core/callKeys";

/** What this uses of Electron's globalShortcut, so a test can stand in for it. */
export interface Shortcuts {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/**
 * The call keys while another app is in front (K16), as Discord's keybinds.
 *
 * A key globalShortcut holds is taken from every app, this window included,
 * and globalShortcut says only that it was pressed, never that it was let go.
 * So the keys are held only while the window is in a call and not in front.
 * In front, the window hears them itself, push to talk's key coming up
 * included; behind, push to talk's key starts talking and a second press
 * stops it.
 */
export class CallKeyHolder {
  /** Each key's accelerator, while in a call. */
  private keys = new Map<CallKeyAction, string>();
  private held = new Set<CallKeyAction>();
  private taken: CallKeyAction[] = [];
  private focused = true;

  constructor(
    private readonly shortcuts: Shortcuts,
    private readonly onPress: (action: CallKeyAction) => void,
    private readonly onTaken: (taken: CallKeyAction[]) => void,
  ) {}

  /**
   * The keys for the call the window is in, or null once it has left; gives
   * back the ones another app holds. Each is tried at once, in front or not,
   * so the window can say straight away which will not work.
   */
  set(keys: unknown, focused: boolean): CallKeyAction[] {
    const next = acceleratorsOf(keys);
    this.releaseAll();
    this.keys = next;
    this.focused = focused;
    this.holdAll();
    this.taken = this.missing();
    if (focused) this.releaseAll();
    return [...this.taken];
  }

  /** The window came to the front, and hears the keys itself. */
  focus(): void {
    this.focused = true;
    this.releaseAll();
  }

  /** Another app came to the front. */
  blur(): void {
    this.focused = false;
    this.holdAll();
    const taken = this.missing();
    if (taken.join() === this.taken.join()) return;
    this.taken = taken;
    this.onTaken([...taken]);
  }

  private holdAll(): void {
    for (const [action, accelerator] of this.keys) {
      if (this.held.has(action)) continue;
      let ok = false;
      try {
        ok = this.shortcuts.register(accelerator, () => this.onPress(action));
      } catch {
        // Electron throws for an accelerator this system cannot hold.
      }
      if (ok) this.held.add(action);
    }
  }

  private releaseAll(): void {
    for (const action of this.held) this.shortcuts.unregister(this.keys.get(action)!);
    this.held.clear();
  }

  private missing(): CallKeyAction[] {
    return [...this.keys.keys()].filter((action) => !this.held.has(action));
  }
}

/** The keys as accelerators; throws for anything the window could not have chosen. */
function acceleratorsOf(keys: unknown): Map<CallKeyAction, string> {
  const accelerators = new Map<CallKeyAction, string>();
  if (keys === null) return accelerators;
  if (typeof keys !== "object") throw new Error("Not call keys.");
  for (const action of CALL_KEY_ACTIONS) {
    const value = (keys as Record<string, unknown>)[action];
    // Push to talk's key is held only while push to talk is chosen.
    if (action === "talk" && value === null) continue;
    const accelerator = callKeyAccelerator(value);
    if (!accelerator) throw new Error("Not a call key.");
    accelerators.set(action, accelerator);
  }
  if (new Set(accelerators.values()).size !== accelerators.size)
    throw new Error("Two call keys are the same.");
  return accelerators;
}
