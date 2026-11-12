import type { AccountSection } from "./accountSections.js";

/** What each section of Account settings is called, in its list and its search results. */
export const SECTION_LABELS: Record<AccountSection, string> = {
  profile: "Profile",
  notifications: "Notifications",
  appearance: "Appearance",
  composing: "Composing",
  calls: "Voice & video",
  security: "Security",
  devices: "Devices",
  storage: "Storage",
  updates: "Updates",
};

export type SettingId =
  | "display-name"
  | "status"
  | "device-notifications"
  | "pause-notifications"
  | "notification-previews"
  | "theme"
  | "density"
  | "enter-key"
  | "microphone"
  | "speaker"
  | "noise-suppression"
  | "voice-processing"
  | "camera"
  | "join-muted"
  | "password"
  | "two-step"
  | "blocked-people"
  | "sign-out"
  | "devices"
  | "storage"
  | "updates";

/** A setting someone may look for. */
export interface Setting {
  /** The mark on the part of its section that holds it: see `settingMark`. */
  id: SettingId;
  section: AccountSection;
  /** Its name in the search results. */
  label: string;
  /** Other words people use for it. */
  words?: string;
}

/**
 * Marks the part of a section that holds a setting: the search scrolls to
 * it, puts focus on its first control and flashes it.
 */
export const settingMark = (id: SettingId) => ({ "data-setting": id });

/** The part of a page marked as holding a setting. */
export const settingOnPage = (page: ParentNode, id: SettingId) =>
  page.querySelector<HTMLElement>(`[data-setting="${id}"]`);

export const SETTINGS: readonly Setting[] = [
  { id: "display-name", section: "profile", label: "Display name", words: "name" },
  {
    id: "status",
    section: "profile",
    label: "Status",
    words: "emoji away meeting lunch clear after expire",
  },
  {
    id: "device-notifications",
    section: "notifications",
    label: "On this device",
    words: "browser permission desktop allow turn on",
  },
  {
    id: "pause-notifications",
    section: "notifications",
    label: "Pause notifications",
    words: "do not disturb dnd snooze quiet mute",
  },
  {
    id: "notification-previews",
    section: "notifications",
    label: "What notifications show",
    words: "preview privacy content message sender",
  },
  {
    id: "theme",
    section: "appearance",
    label: "Theme",
    words: "dark light onyx white mode colour color",
  },
  {
    id: "density",
    section: "appearance",
    label: "Density",
    words: "compact comfortable spacing size",
  },
  {
    id: "enter-key",
    section: "composing",
    label: "When I press Enter",
    words: "send new line shift keyboard writing messages",
  },
  { id: "microphone", section: "calls", label: "Microphone", words: "mic input audio" },
  { id: "speaker", section: "calls", label: "Speaker", words: "output audio headphones sound" },
  {
    id: "noise-suppression",
    section: "calls",
    label: "Noise suppression",
    words: "background noise filter",
  },
  {
    id: "voice-processing",
    section: "calls",
    label: "Voice processing",
    words: "echo gain cancellation",
  },
  { id: "camera", section: "calls", label: "Camera", words: "video webcam" },
  {
    id: "join-muted",
    section: "calls",
    label: "Join huddles with my microphone off",
    words: "muted mute huddle call joining",
  },
  { id: "password", section: "security", label: "Change password", words: "password" },
  {
    id: "two-step",
    section: "security",
    label: "Two-step sign-in",
    words: "2fa mfa two factor authenticator app code totp otp recovery codes verification",
  },
  {
    id: "blocked-people",
    section: "security",
    label: "Blocked people",
    words: "block unblock ignore hide person harassment",
  },
  { id: "sign-out", section: "security", label: "Sign out", words: "log out logout leave" },
  {
    id: "devices",
    section: "devices",
    label: "Signed-in devices",
    words: "sessions sign out remove",
  },
  {
    id: "storage",
    section: "storage",
    label: "Workspace attachment storage",
    words: "files uploads space limit disk",
  },
  {
    id: "updates",
    section: "updates",
    label: "Update automatically",
    words: "new version upgrade download install restart",
  },
];

const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * The settings a search finds: each word typed begins a word of a setting's
 * name, its other words or its section's name. Those whose name begins with
 * what was typed come first; the rest keep the order the sections show them.
 */
export function findSettings(query: string): Setting[] {
  const typed = wordsOf(query);
  if (typed.length === 0) return [];
  const found: { setting: Setting; rank: number }[] = [];
  for (const setting of SETTINGS) {
    const name = wordsOf(setting.label);
    const all = [
      ...name,
      ...wordsOf(setting.words ?? ""),
      ...wordsOf(SECTION_LABELS[setting.section]),
    ];
    if (!typed.every((word) => all.some((one) => one.startsWith(word)))) continue;
    const rank = setting.label.toLowerCase().startsWith(typed.join(" "))
      ? 0
      : name.some((one) => one.startsWith(typed[0]!))
        ? 1
        : 2;
    found.push({ setting, rank });
  }
  return found.sort((a, b) => a.rank - b.rank).map((entry) => entry.setting);
}
