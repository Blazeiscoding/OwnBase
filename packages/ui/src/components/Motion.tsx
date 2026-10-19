import { useState, type ComponentProps, type ReactNode } from "react";

/**
 * How many times `value` has changed since this component was first drawn: 0
 * on that first draw. What was already there when a screen opened stays
 * still, and only what changes after it moves.
 */
export function useChanges(value: unknown): number {
  const [seen, setSeen] = useState({ value, changes: 0 });
  if (Object.is(seen.value, value)) return seen.changes;
  const next = { value, changes: seen.changes + 1 };
  setSeen(next);
  return next.changes;
}

/**
 * A count, drawn as nothing at zero. It pops in when it appears and its
 * number rolls up when it changes; one there when the screen was drawn is
 * still. It is always drawn, so it can tell those apart. A `dot` says only
 * that there is something, without the number, and above `max` it says
 * "99+" for 99. `Badge` draws the counts that say something is waiting.
 */
export function CountBadge({
  count,
  dot,
  max,
  className,
  ...span
}: { count: number; dot?: boolean; max?: number } & ComponentProps<"span">) {
  const appeared = useChanges(count > 0);
  const changed = useChanges(count);
  if (count <= 0) return null;
  return (
    <span {...span} className={`${className ?? ""} ${appeared ? "animate-badge-in" : ""}`}>
      {!dot && (
        <span key={changed} className={changed ? "inline-block animate-count-in" : undefined}>
          {max !== undefined && count > max ? `${max}+` : count}
        </span>
      )}
    </span>
  );
}

/**
 * Brings in the next page of something, such as another tab's panel, from
 * the side it is on: `from` above 0 is further along and comes in from the
 * right, below 0 is back and comes from the left. Called as the page is
 * chosen; the element stays while what is in it changes.
 */
export function stepIn(element: Element | null | undefined, from: number) {
  if (
    !from ||
    !element ||
    typeof element.animate !== "function" ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  )
    return;
  element.animate(
    [
      { opacity: 0, translate: `${Math.sign(from) * 8}px 0`, filter: "blur(3px)" },
      { opacity: 1, translate: "0 0", filter: "blur(0)" },
    ],
    { duration: 250, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  );
}

/**
 * Something that changes in place, such as an icon that turns into a tick, or
 * words saying what is happening now, as a copy button's "Copied". Each new
 * one grows, or with `text` rises, out of a blur where the last one was; the
 * first is drawn still.
 */
export function Swap({
  on,
  text,
  className = "inline-flex",
  children,
}: {
  /** What it shows: a change here is what swaps it. Words given alone are their own. */
  on?: unknown;
  text?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const changes = useChanges(on === undefined && typeof children === "string" ? children : on);
  return (
    <span
      key={changes}
      className={`${className} ${changes ? (text ? "animate-text-in" : "animate-swap-in") : ""}`}
    >
      {children}
    </span>
  );
}
