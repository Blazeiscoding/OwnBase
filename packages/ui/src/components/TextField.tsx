import { useId, type InputHTMLAttributes, type ReactNode, type Ref } from "react";
import { Icon } from "./Icon.js";

export type FieldSize = "small" | "regular" | "large";

/** What every size shares: a hairline that warms under the pointer, and red when it is wrong. */
const FRAME =
  "w-full border border-edge outline-none placeholder:text-ink-faint hover:border-ink-faint/40 aria-invalid:border-alert";
/** A soft ring in the accent around the field being filled in. */
const FOCUS =
  "transition-colors focus:border-copper/70 focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-copper)_14%,transparent)]";

/**
 * Each size is a whole set rather than a base with changes on top, because
 * two utilities for the same property are settled by Tailwind's order, not by
 * which comes last in the class list.
 */
const SIZES: Record<FieldSize, string> = {
  // A row of fields inside a card, such as an app's commands. The card is the
  // page colour, so the field takes the raised one to stand out from it.
  small: `${FRAME} ${FOCUS} h-8 min-w-0 rounded-lg bg-raised px-2.5 text-[13px]`,
  // Dialogs and settings.
  regular: `${FRAME} ${FOCUS} rounded-lg bg-ground px-3 py-2 text-sm`,
  // The sign-in card: taller and rounder, and lit from above while in use.
  large: `${FRAME} field-spot h-10 rounded-xl bg-ground px-3.5 text-sm focus:border-copper`,
};

/** The classes for a text field of this size, with any the caller adds that do not clash. */
export function inputClass(size: FieldSize = "regular", extra?: string): string {
  return extra ? `${SIZES[size]} ${extra}` : SIZES[size];
}

/**
 * A regular field's classes, for an input, textarea or select drawn by hand.
 * New forms use TextField, which brings its label, hint and error with it.
 */
export const inputCls = inputClass();

const LABEL: Record<FieldSize, string> = {
  small: "mb-1 block text-[12px] font-medium leading-4 text-ink-dim",
  regular: "mb-1.5 block text-[13px] font-medium text-ink-dim",
  large: "mb-1.5 block text-[13px] font-medium text-ink-dim",
};
const NOTE: Record<FieldSize, string> = {
  small: "mt-1 text-[11px]",
  regular: "mt-1.5 text-[12px]",
  large: "mt-1.5 text-[12px]",
};

function shown(value: ReactNode): boolean {
  return value !== undefined && value !== null && value !== false && value !== "";
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** Shown above the field, and its accessible name. */
  label: ReactNode;
  /** A line under the field on what to enter, read along with it. */
  hint?: ReactNode;
  /**
   * What is wrong with what was entered, set when the form is sent. It shows
   * under the field, is read with it, and marks it invalid.
   */
  error?: ReactNode;
  size?: FieldSize;
  /** Classes for the block holding the label, field and lines, for its place in a layout. */
  className?: string;
  /** Classes added to the field itself, such as `font-mono`; widths go on `className`. */
  inputClassName?: string;
  ref?: Ref<HTMLInputElement>;
}

/**
 * A labelled text field. The label is always shown, a hint and an error sit
 * under it and are read with it, and an error marks it invalid. Its ref lets
 * a form put the cursor in the first field with a problem.
 */
export function TextField({
  label,
  hint,
  error,
  size = "regular",
  className,
  inputClassName,
  id: givenId,
  ref,
  "aria-describedby": describedBy,
  ...input
}: TextFieldProps) {
  const ownId = useId();
  const id = givenId ?? ownId;
  const hasError = shown(error);
  const hasHint = shown(hint);
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const described =
    [hasError && errorId, hasHint && hintId, describedBy].filter(Boolean).join(" ") || undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className={LABEL[size]}>
        {label}
      </label>
      <input
        {...input}
        ref={ref}
        id={id}
        aria-invalid={hasError || undefined}
        aria-describedby={described}
        className={inputClass(size, inputClassName)}
      />
      {hasError && (
        <p id={errorId} role="alert" className={`${NOTE[size]} flex items-start gap-1 text-alert`}>
          <Icon name="alert" size={size === "small" ? 12 : 13} className="mt-px" />
          <span>{error}</span>
        </p>
      )}
      {hasHint && (
        <p id={hintId} className={`${NOTE[size]} text-ink-faint`}>
          {hint}
        </p>
      )}
    </div>
  );
}
