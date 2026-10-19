import type { Ref, SelectHTMLAttributes } from "react";
import { Field, inputClass, type FieldLines } from "./TextField.js";

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size">, FieldLines {
  /** Classes added to the select itself, such as `font-mono`; widths go on `className`. */
  selectClassName?: string;
  ref?: Ref<HTMLSelectElement>;
}

/**
 * A labelled choice from a list, drawn as a text field of the same size is.
 * The label sits above the select rather than around it: a label wrapped
 * round a select holds every option's text too, so the field would be named
 * "Post as A new app Webhook" wherever a label is read as its text. A hint
 * and an error sit under it and are read with it, an error marks it invalid,
 * and its ref lets a form move focus to it. The options are its children.
 */
export function Select({
  label,
  hint,
  error,
  size = "regular",
  className,
  selectClassName,
  id,
  ref,
  "aria-describedby": describedBy,
  ...select
}: SelectProps) {
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      size={size}
      className={className}
      id={id}
      describedBy={describedBy}
    >
      {(wiring) => (
        <select {...select} {...wiring} ref={ref} className={inputClass(size, selectClassName)} />
      )}
    </Field>
  );
}
