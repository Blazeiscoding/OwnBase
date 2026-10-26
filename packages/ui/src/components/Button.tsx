import type { ButtonHTMLAttributes, Ref } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "quiet";

const VARIANTS: Record<ButtonVariant, string> = {
  // The one thing a dialog or form is for.
  primary:
    "btn-shape inline-flex h-9 items-center justify-center gap-2 bg-copper px-4 text-sm font-semibold text-ground shadow-[inset_0_1px_0_rgb(255_255_255/0.2)] transition-colors hover:bg-copper-deep disabled:opacity-40",
  // Everything else a dialog offers beside it.
  secondary:
    "btn-shape inline-flex h-9 items-center justify-center gap-2 border border-[var(--card-edge-hover)] px-3.5 text-sm font-medium text-ink transition-colors hover:border-copper/60 hover:bg-copper/[0.06] disabled:opacity-40",
  // Removing, revoking and signing out, when that is what is being confirmed.
  danger:
    "btn-shape inline-flex h-9 items-center justify-center gap-2 bg-alert px-4 text-sm font-semibold text-ground transition-colors hover:opacity-90 disabled:opacity-40",
  // Cancel, and actions that should not draw the eye.
  quiet:
    "inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-medium text-ink-dim transition-colors hover:bg-ink/[0.06] hover:text-ink disabled:opacity-40",
};

/** The classes for a button of this kind, with any the caller adds for layout. */
export function buttonClass(variant: ButtonVariant = "secondary", extra?: string): string {
  return extra ? `${VARIANTS[variant]} ${extra}` : VARIANTS[variant];
}

/**
 * OwnBase's button. It keeps a native button's default type, so one in a
 * form still submits it unless told `type="button"`.
 */
export function Button({
  variant = "secondary",
  className,
  ref,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  ref?: Ref<HTMLButtonElement>;
}) {
  return <button ref={ref} className={buttonClass(variant, className)} {...props} />;
}
