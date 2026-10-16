import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Icon, type IconName } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";

export type IconButtonSize = "small" | "regular";

const SIZES: Record<IconButtonSize, { box: string; icon: number }> = {
  // 24 px, the smallest target axe's target-size rule accepts: a card's or a chip's corner.
  small: { box: "size-6", icon: 14 },
  // 32 px: a dialog's, a panel's or a header's controls.
  regular: { box: "size-8", icon: 16 },
};

/**
 * Faint until pointed at; tinted while what it toggles is on or what it opens
 * is open. `icon-live` plays the motion of an icon drawn in parts.
 */
const BASE =
  "icon-live inline-flex shrink-0 items-center justify-center text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink disabled:opacity-40 aria-expanded:bg-ink/[0.08] aria-expanded:text-ink aria-pressed:bg-ink/[0.08] aria-pressed:text-ink";

/** Shown inside: one of Icon's drawings, or anything else that is not words. */
type Content = { icon: IconName; children?: never } | { icon?: never; children: ReactNode };

export type IconButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "children" | "title"
> &
  Content & {
    /** What it does, in a few words. It is both the accessible name and the tooltip. */
    label: string;
    /** The keyboard shortcut that does the same, shown in the tooltip. */
    keys?: string;
    size?: IconButtonSize;
    /** A circle, for one on a pill such as a chosen person's chip. Otherwise a rounded square. */
    round?: boolean;
    /** Where the tooltip would rather open. */
    tooltipSide?: "top" | "bottom" | "right";
    ref?: Ref<HTMLButtonElement>;
  };

/**
 * A button that shows only an icon. It cannot be written without a label,
 * which names it for a screen reader and shows as its tooltip on hover and
 * on keyboard focus. Unlike `Button` it is `type="button"` unless told
 * otherwise, since an icon rarely sends a form. `aria-pressed`,
 * `aria-expanded` and `aria-haspopup` pass through, and it tints while
 * pressed or expanded.
 */
export function IconButton({
  label,
  keys,
  icon,
  children,
  size = "regular",
  round = false,
  tooltipSide,
  className,
  type = "button",
  ref,
  ...button
}: IconButtonProps) {
  const { box, icon: iconSize } = SIZES[size];
  const shape = round ? "rounded-full" : size === "small" ? "rounded-md" : "rounded-lg";
  return (
    <Tooltip label={label} keys={keys} side={tooltipSide}>
      <button
        {...button}
        ref={ref}
        type={type}
        aria-label={label}
        className={`${BASE} ${box} ${shape}${className ? ` ${className}` : ""}`}
      >
        {icon ? <Icon name={icon} size={iconSize} /> : children}
      </button>
    </Tooltip>
  );
}
