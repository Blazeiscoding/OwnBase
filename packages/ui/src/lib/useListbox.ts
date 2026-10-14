import { useEffect, useId, useRef, useState } from "react";
import type React from "react";

/**
 * A choice among suggestions that stays in a text box. The box keeps focus, so
 * typing goes on; the arrow keys move the choice, and a screen reader follows it
 * through `aria-activedescendant`. The quick switcher, the composer's
 * suggestions and both emoji choosers use it.
 *
 * Left, Right, Home and End are left to the box: they move the caret, and a
 * screen reader uses them to read back what was typed.
 */
export function useListbox(count: number) {
  const id = useId();
  const [chosen, setChosen] = useState(0);
  const active = count === 0 ? -1 : Math.min(chosen, count - 1);
  const optionId = (i: number) => `${id}-${i}`;
  // Only a keypress scrolls: a pointer already points at something visible.
  const moved = useRef(false);

  useEffect(() => {
    if (!moved.current || active < 0) return;
    moved.current = false;
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
  });

  const ownerProps = {
    "aria-autocomplete": "list" as const,
    "aria-controls": count > 0 ? id : undefined,
    "aria-activedescendant": active >= 0 ? optionId(active) : undefined,
  };

  return {
    id,
    /** The chosen option's index, or -1 when there are none. */
    active,
    choose: setChosen,
    /** Moves the choice on ArrowDown and ArrowUp, wrapping. Says whether it used the key. */
    move(event: React.KeyboardEvent) {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
      event.preventDefault();
      if (count === 0) return true;
      moved.current = true;
      const step = event.key === "ArrowDown" ? 1 : count - 1;
      setChosen((i) => (Math.min(i, count - 1) + step) % count);
      return true;
    },
    /** Moves the choice to one option, as a key does, so it scrolls into view. */
    moveTo(index: number) {
      if (count === 0) return;
      moved.current = true;
      setChosen(Math.max(0, Math.min(index, count - 1)));
    },
    /**
     * For a textarea, which stays a text box: a combobox is an input, and a text
     * box has no `aria-expanded`.
     */
    ownerProps,
    /** For an input, which becomes a combobox. */
    comboboxProps: { role: "combobox" as const, "aria-expanded": count > 0, ...ownerProps },
    listProps: { id, role: "listbox" as const },
    optionProps: (i: number) => ({
      id: optionId(i),
      role: "option" as const,
      "aria-selected": i === active,
      onMouseEnter: () => setChosen(i),
      // Keeps focus, and with it the caret, in the box.
      onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
    }),
  };
}
