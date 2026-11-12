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
