/** The sections of Account settings, in the order its tabs show them. */
export const ACCOUNT_SECTIONS = [
  "profile",
  "notifications",
  "appearance",
  "composing",
  "calls",
  "security",
  "devices",
  "storage",
  /** The desktop app's own updates; not in the browser. */
  "updates",
] as const;
export type AccountSection = (typeof ACCOUNT_SECTIONS)[number];

export function isAccountSection(value: unknown): value is AccountSection {
  return (ACCOUNT_SECTIONS as readonly unknown[]).includes(value);
}

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

/**
 * Marks the part of a section that holds a setting: the search scrolls to
 * it, puts focus on its first control and flashes it.
 */
export const settingMark = (id: SettingId) => ({ "data-setting": id });
