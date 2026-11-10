import { useId } from "react";
import { isImeKey } from "../lib/textInput.js";
import { Icon } from "./Icon.js";
import { Modal } from "./Modal.js";

/** Jump to's frame, the same while it loads as after, so the one gives way to the other unseen. */
export const SWITCHER_FRAME = {
  title: "Jump to",
  backdropClassName: "flex items-start justify-center dialog-backdrop px-3 pt-[14vh]",
  className:
    "w-[560px] max-w-full dialog-surface overflow-hidden rounded-2xl border border-[var(--card-edge)] outline-none",
} as const;
export const SWITCHER_ROW = "flex items-center gap-3 border-b border-edge px-4";
export const SWITCHER_FIELD =
  "h-14 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-ink-faint";
export const SWITCHER_CLOSE =
  "-mr-1.5 flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink";
export const switcherPlaceholder = (actions: boolean) =>
  actions ? "Channel, person or action" : "Channel or person";

export interface EarlyTyping {
  query: string;
  entered: boolean;
}

/**
 * Jump to while its code is still on the way, which it can be in the first
 * moment after signing in. Ctrl+K and a name are typed in one go, so this
 * keeps what is typed, and an Enter, for the palette to take on when it comes.
 */
export function QuickSwitcherLoading(props: {
  typing: EarlyTyping;
  onTyping: (typing: EarlyTyping) => void;
  /** Whether the palette offers actions, which its placeholder text names. */
  actions: boolean;
  onClose: () => void;
}) {
  const status = useId();
  const { typing } = props;
  return (
    <Modal
      title={SWITCHER_FRAME.title}
      onClose={props.onClose}
      backdropClassName={SWITCHER_FRAME.backdropClassName}
      className={SWITCHER_FRAME.className}
    >
      <div className={SWITCHER_ROW}>
        <Icon name="search" size={18} className="text-ink-faint" />
        <input
          autoFocus
          aria-label="Channel or person"
          aria-describedby={status}
          value={typing.query}
          onChange={(e) => {
            // Enter has chosen; the palette goes with what it was pressed on.
            if (!typing.entered) props.onTyping({ query: e.target.value, entered: false });
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || isImeKey(e.nativeEvent)) return;
            e.preventDefault();
            props.onTyping({ ...typing, entered: true });
          }}
          placeholder={switcherPlaceholder(props.actions)}
          className={SWITCHER_FIELD}
        />
        <button type="button" aria-label="Close" onClick={props.onClose} className={SWITCHER_CLOSE}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <p id={status} role="status" className="px-4 py-3 text-sm text-ink-faint">
        <span className="text-shimmer" data-text="Loading…">
          Loading…
        </span>
      </p>
    </Modal>
  );
}
