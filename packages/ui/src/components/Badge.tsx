import type { ComponentProps } from "react";
import { CountBadge } from "./Motion.js";

export type BadgeTone = "quiet" | "mention";
export type BadgeSize = "small" | "regular";

/** Each a whole set, since two utilities for one property are settled by Tailwind's order. */
const COUNT: Record<BadgeSize, string> = {
  // Beside a row's name: Activity, Threads, a channel or a conversation.
  regular: "min-w-5 px-1.5 text-[11px] leading-[18px]",
  // On the corner of an icon, such as a tab in the phone's bar.
  small: "min-w-4 px-1 text-[10px] leading-4",
};

const TONE: Record<BadgeTone, { count: string; dot: string }> = {
  // Something unread that does not name you: there, but not loud.
  quiet: { count: "bg-ink/[0.08] font-semibold text-ink-dim", dot: "bg-ink" },
  // Discord's red (`badge-mention` in theme.css).
  mention: { count: "badge-mention font-semibold", dot: "badge-mention" },
};

export type BadgeProps = Omit<ComponentProps<"span">, "children" | "aria-label" | "role"> & {
  /** How many, or for a dot whether there is anything. Nothing is drawn at 0 or false. */
  count: number | boolean;
  /** Quiet for what is merely unread, the mention red for what names you. */
  tone?: BadgeTone;
  size?: BadgeSize;
  /** Only that there is something, without the number. */
  dot?: boolean;
  /** The most it shows as a number; above it, "99+" for 99. */
  max?: number;
  /**
   * What it says, in words, read in its place: "2 unread mentions in
   * general". Leave it out only where the control it sits on says it already,
   * in its name or its description; it is then hidden from a screen reader.
   */
  label?: string;
};

/**
 * A count or a dot that says something is waiting: unread messages,
 * mentions, new requests. Drawn as nothing at zero. It pops in when it
 * appears and its number rolls up when it changes; one there when the screen
 * was drawn is still. Where it sits, and the ring that sets it apart from an
 * icon under it, are the caller's, through `className`.
 */
export function Badge({
  count,
  tone = "mention",
  size = "regular",
  dot = false,
  max,
  label,
  className,
  ...span
}: BadgeProps) {
  const shape = dot
    ? `size-2 shrink-0 rounded-full ${TONE[tone].dot}`
    : `tabular shrink-0 rounded-full text-center ${COUNT[size]} ${TONE[tone].count}`;
  return (
    <CountBadge
      {...span}
      count={typeof count === "boolean" ? Number(count) : count}
      dot={dot}
      max={max}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={className ? `${shape} ${className}` : shape}
    />
  );
}
