import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { usePlatform } from "../context.js";
import type { Platform } from "../platform.js";

/**
 * How much a message notification shows (IMP-03): the message, only who sent
 * it and where, or nothing but that something arrived, for a screen others
 * can see.
 */
export type NotificationPreview = "full" | "sender" | "none";

export const NOTIFICATION_PREVIEWS: readonly {
  id: NotificationPreview;
  label: string;
  example: string;
}[] = [
  {
    id: "full",
    label: "The message",
    example: "Priya Shah in #design: The launch moves to Friday",
  },
  { id: "sender", label: "Only who sent it", example: "Priya Shah in #design: New message" },
  { id: "none", label: "Nothing about it", example: "New message" },
];

/** What a notification says under each choice. */
export function notificationContent(
  preview: NotificationPreview,
  message: { from: string; channelName?: string; body: string },
): { title: string; body: string } {
  if (preview === "none") return { title: "New message", body: "Open Tandem to read it." };
  const title = `${message.from}${message.channelName ? ` in #${message.channelName}` : ""}`;
  return { title, body: preview === "full" ? message.body : "New message" };
}

/**
 * What a reminder come due says under each choice (E4): that it is one, and
 * then as much of its message as a message's notification would show.
 */
export function reminderContent(
  preview: NotificationPreview,
  message: { from: string; channelName?: string; body: string },
): { title: string; body: string } {
  if (preview === "none") return { title: "Reminder", body: "Open Tandem to see it." };
  const title = `Reminder: ${message.from}${message.channelName ? ` in #${message.channelName}` : ""}`;
  return { title, body: preview === "full" ? message.body : "About a message" };
}

/**
 * What a direct message's huddle ringing says while the window is behind
 * something else (E10): who is calling, and with whom in a group; under
 * "Nothing about it", only that a huddle is ringing.
 */
export function ringContent(
  preview: NotificationPreview,
  ring: { from: string; group?: string },
): { title: string; body: string } {
  if (preview === "none") return { title: "Incoming huddle", body: "Open Tandem to answer it." };
  return {
    title: `${ring.from} is calling`,
    body: ring.group ? `Huddle with ${ring.group}` : "Huddle with you",
  };
}

/**
 * What one notification for several missed messages says under each choice:
 * how many and where, then who sent them. Nothing about it names nobody and
 * no conversation.
 */
export function catchUpContent(
  preview: NotificationPreview,
  missed: { count: number; conversations: number; channelName?: string; senders: string },
): { title: string; body: string } {
  const count = `${missed.count} new messages`;
  if (preview === "none") return { title: count, body: "Open Tandem to read them." };
  const where =
    missed.conversations > 1
      ? ` in ${missed.conversations} conversations`
      : missed.channelName
        ? ` in #${missed.channelName}`
        : "";
  return { title: `${count}${where}`, body: `From ${missed.senders}` };
}

/** One account on one server: the choice is per workspace, not per device. */
export function previewAccount(serverUrl: string, userId: string): string {
  return `${serverUrl.replace(/\/+$/, "")} ${userId}`;
}

interface Previews {
  byAccount: Record<string, NotificationPreview>;
  loaded: boolean;
  /** The saved choices could not be read, so none of them is known. */
  unreadable: boolean;
  /** Some saved choice was damaged, so some account's choice is not known. */
  damaged: boolean;
  saving: boolean;
  error: string | null;
  /** Resolves true once the choice is kept; false when it was not, or another was being kept. */
  setPreview: (account: string, preview: NotificationPreview) => Promise<boolean>;
}

const KEY = "notification-previews";
/**
 * Saved for accounts whose choice was lost to damaged storage: they show
 * nothing until someone chooses again, rather than everything (F02). No
 * account is named this, since every account name has a space in it.
 */
const UNKNOWN = "*";
const UNREADABLE =
  "Could not read your choice, so notifications show nothing about messages until you choose again.";
const isPreview = (value: unknown): value is NotificationPreview =>
  value === "full" || value === "sender" || value === "none";
const stores = new WeakMap<Platform, ReturnType<typeof createPreviews>>();

/**
 * The choices a saved value holds, or null when it is not a map of them. A
 * choice that is not one of the three is not known either, so it is read as
 * the most private one and reported, never as the default of showing all.
 */
function readSaved(saved: unknown): {
  byAccount: Record<string, NotificationPreview>;
  damaged: boolean;
} | null {
  if (saved === null || saved === undefined) return { byAccount: {}, damaged: false };
  if (typeof saved !== "object" || Array.isArray(saved)) return null;
  const byAccount: Record<string, NotificationPreview> = {};
  let damaged = false;
  for (const [account, value] of Object.entries(saved)) {
    if (isPreview(value)) byAccount[account] = value;
    else {
      byAccount[account] = "none";
      damaged = true;
    }
  }
  return { byAccount, damaged };
}

function createPreviews(platform: Platform) {
  const unreadable = () =>
    store.setState({
      byAccount: {},
      loaded: true,
      unreadable: true,
      damaged: true,
      error: UNREADABLE,
    });
  const apply = (saved: unknown) => {
    const read = readSaved(saved);
    if (!read) return unreadable();
    store.setState({
      byAccount: read.byAccount,
      loaded: true,
      unreadable: false,
      damaged: read.damaged,
      error: read.damaged ? UNREADABLE : null,
    });
  };
  const store = createStore<Previews>(() => ({
    byAccount: {},
    loaded: false,
    unreadable: false,
    damaged: false,
    saving: false,
    error: null,
    setPreview: async (account, preview) => {
      const { loaded, saving, byAccount, damaged } = store.getState();
      if (!loaded || saving) return false;
      // Choosing again after saved choices were lost or damaged keeps every
      // account whose choice is not known private, rather than showing all.
      const changes: Record<string, string> = { [account]: preview };
      if (damaged) changes[UNKNOWN] = "none";
      store.setState({ saving: true, error: null });
      let stored: unknown;
      let saved = true;
      asking = true;
      try {
        if (platform.storage.mergeRecord) {
          // Only this account's choice is written, so another window's choice
          // for another account stands (F02).
          stored = await platform.storage.mergeRecord(KEY, changes);
        } else {
          stored = { ...byAccount, ...changes };
          await platform.storage.set(KEY, stored);
        }
      } catch {
        saved = false;
      }
      asking = false;
      if (crossed) await current();
      else if (saved) apply(stored);
      store.setState({
        saving: false,
        ...(saved ? {} : { error: "Could not save this choice. Please try again." }),
      });
      return saved;
    },
  }));
  /**
   * What another window stores and what this window is answered can arrive in
   * either order. An answer to something asked before another window's change
   * was heard may be older than that change, and the change may be older than
   * the answer. Shown as they came, the older could replace the newer: a
   * window went back to showing everything after another had chosen to show
   * nothing (Q03). So when the two cross, neither is shown, and the choices
   * are read again as they are stored now.
   */
  let asking = false;
  let crossed = false;
  async function current(): Promise<void> {
    for (;;) {
      crossed = false;
      asking = true;
      let saved: unknown;
      let read = true;
      try {
        // Strict: storage that cannot be read is not the same as no choice saved.
        saved = await platform.storage.get<unknown>(KEY, { strict: true });
      } catch {
        read = false;
      }
      asking = false;
      if (crossed) continue;
      return read ? apply(saved) : unreadable();
    }
  }
  void current();
  // Another window's choice takes effect here before the next notification,
  // a stricter one included (F02).
  platform.storage.watchRecord?.(KEY, (stored) => {
    if (asking) crossed = true;
    else apply(stored);
  });
  return store;
}

/** Every account's choice on this device, from the platform's storage. */
export function notificationPreviews(platform: Platform) {
  let store = stores.get(platform);
  if (!store) {
    store = createPreviews(platform);
    stores.set(platform, store);
  }
  return store;
}

export function useNotificationPreviews() {
  return useStore(notificationPreviews(usePlatform()));
}

/**
 * The choice in force for an account. Until the saved choice is read, or when
 * it cannot be, the most private one applies: catching up after starting can
 * notify at once, and must not show what someone chose to hide.
 */
export function previewFor(
  previews: Pick<Previews, "loaded" | "unreadable" | "byAccount">,
  account: string | null,
): NotificationPreview {
  if (!previews.loaded || (previews.unreadable && !(account && previews.byAccount[account])))
    return "none";
  return (account && previews.byAccount[account]) || previews.byAccount[UNKNOWN] || "full";
}
