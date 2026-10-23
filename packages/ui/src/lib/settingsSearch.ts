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
};

/** A setting someone may look for. */
export interface Setting {
  section: AccountSection;
  /**
   * Its name as its section shows it, on a heading, a group or a field, so
   * the search can go to it there.
   */
  label: string;
  /** Other words people use for it. */
  words?: string;
}

export const SETTINGS: readonly Setting[] = [
  { section: "profile", label: "Display name", words: "name" },
  { section: "profile", label: "Status", words: "emoji away meeting lunch clear after expire" },
  {
    section: "notifications",
    label: "On this device",
    words: "browser permission desktop allow turn on",
  },
  {
    section: "notifications",
    label: "Pause notifications",
    words: "do not disturb dnd snooze quiet mute",
  },
  {
    section: "notifications",
    label: "What notifications show",
    words: "preview privacy content message sender",
  },
  { section: "appearance", label: "Theme", words: "dark light onyx white mode colour color" },
  { section: "appearance", label: "Density", words: "compact comfortable spacing size" },
  {
    section: "composing",
    label: "When I press Enter",
    words: "send new line shift keyboard writing messages",
  },
  { section: "calls", label: "Microphone", words: "mic input audio" },
  { section: "calls", label: "Speaker", words: "output audio headphones sound" },
  { section: "calls", label: "Noise suppression", words: "background noise filter" },
  { section: "calls", label: "Voice processing", words: "echo gain cancellation" },
  { section: "calls", label: "Camera", words: "video webcam" },
  {
    section: "calls",
    label: "Join huddles with my microphone off",
    words: "muted mute huddle call joining",
  },
  { section: "security", label: "Change password", words: "password" },
  {
    section: "security",
    label: "Two-step sign-in",
    words: "2fa mfa two factor authenticator app code totp otp recovery codes verification",
  },
  { section: "security", label: "Sign out", words: "log out logout leave" },
  { section: "devices", label: "Signed-in devices", words: "sessions sign out remove" },
  {
    section: "storage",
    label: "Workspace attachment storage",
    words: "files uploads space limit disk",
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
