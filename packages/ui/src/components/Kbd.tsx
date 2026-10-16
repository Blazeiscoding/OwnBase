import type { ComponentProps } from "react";

/**
 * One key, drawn as a keycap: a raised face with a deeper lower edge. A
 * shortcut of several keys is several of these side by side, as the keyboard
 * shortcuts sheet shows them.
 */
export function Kbd({ className, ...key }: ComponentProps<"kbd">) {
  return (
    <kbd
      {...key}
      className={`inline-flex h-6 min-w-6 items-center justify-center rounded border border-b-2 border-edge bg-lifted px-1.5 font-mono text-[11px] text-ink${className ? ` ${className}` : ""}`}
    />
  );
}
