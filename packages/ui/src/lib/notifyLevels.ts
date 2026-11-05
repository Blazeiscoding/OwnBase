import type { NotifyLevel } from "@ownbase/protocol";

/**
 * What each notification level is called, for the account's default in
 * Settings and for a conversation of its own in its details, so both read
 * the same. A direct message counts as a mention.
 */
export const NOTIFY_LEVELS: { value: NotifyLevel; label: string; hint: string }[] = [
  { value: "all", label: "Every message", hint: "Whenever anyone posts." },
  {
    value: "mentions",
    label: "Direct messages and mentions",
    hint: "When someone writes to you directly or @-mentions you.",
  },
  { value: "nothing", label: "Nothing", hint: "No notifications at all." },
];

/** A level's name, as the lists above call it. */
export function notifyLevelLabel(level: NotifyLevel): string {
  return NOTIFY_LEVELS.find((l) => l.value === level)?.label ?? level;
}
