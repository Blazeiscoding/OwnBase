import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";

/** One thing to do about an empty place, such as clearing a filter. */
export interface EmptyStateAction {
  label: string;
  run: () => void;
}

export interface EmptyStateProps {
  /** What the place is for and how to fill it, said while there is nothing in it. */
  children: ReactNode;
  /**
   * A mark for what the place holds, in a quiet tile above the words: a
   * side panel or a dialog's list. Without one, the words alone and quieter,
   * for a list that is one part of a larger view.
   */
  icon?: IconName;
  action?: EmptyStateAction;
  className?: string;
}

/**
 * What a place with nothing in it says: what it is for, how to fill it, and
 * at most one thing to do about it. Every empty list says it in one of these
 * two looks. `ListStatus` draws one for a list it loads; a list that is
 * already here, filtered to nothing, draws one itself.
 */
export function EmptyState({ children, icon, action, className }: EmptyStateProps) {
  return (
    <div className={className}>
      <EmptyWords icon={icon}>{children}</EmptyWords>
      {action && <EmptyAction action={action} icon={icon} />}
    </div>
  );
}

function EmptyWords({ children, icon }: { children: ReactNode; icon?: IconName }) {
  return icon ? (
    <div className="flex flex-col items-center px-6 pb-6 pt-12 text-center">
      <span
        aria-hidden="true"
        className="empty-tile mb-4 flex size-12 items-center justify-center rounded-2xl text-ink-dim"
      >
        <Icon name={icon} size={20} />
      </span>
      <p className="max-w-[17rem] text-sm leading-relaxed text-ink-dim">{children}</p>
    </div>
  ) : (
    <p className="px-2 py-6 text-center text-sm text-ink-faint">{children}</p>
  );
}

/**
 * The one thing to do, under the words. `ListStatus` draws it apart from its
 * status, so a screen reader hears the words change rather than the button.
 */
export function EmptyAction({ action, icon }: { action: EmptyStateAction; icon?: IconName }) {
  return (
    // Without a tile, the words' own padding is enough above it.
    <p className={`pb-6 text-center ${icon ? "" : "-mt-4"}`}>
      <button
        type="button"
        onClick={action.run}
        className="h-8 rounded-full border border-edge px-3.5 text-[13px] font-medium text-ink-dim transition-colors hover:border-ink-faint hover:text-ink"
      >
        {action.label}
      </button>
    </p>
  );
}
