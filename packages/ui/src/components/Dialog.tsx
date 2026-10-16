import type { ComponentProps } from "react";
import { Modal } from "./Modal.js";
import { Icon } from "./Icon.js";

interface Props {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  dismissible?: boolean;
  /** Id of the text a reader needs along with the title, such as a question's consequence. */
  describedBy?: string;
  /**
   * The content keeps part of itself in sight, such as a search field or the
   * buttons that finish it, and puts what scrolls in a `DialogScroll`.
   */
  ownScroll?: boolean;
}

/** Its name and its close button stay in sight; what is under them scrolls. */
export function Dialog({
  title,
  onClose,
  children,
  width = 440,
  dismissible = true,
  describedBy,
  ownScroll,
}: Props) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      dismissible={dismissible}
      describedBy={describedBy}
      backdropClassName="flex items-start justify-center dialog-backdrop px-3 pt-[12dvh] animate-fade-in"
      className="dialog-panel animate-pop-in rounded-2xl dialog-surface border border-[var(--card-edge)] outline-none"
      style={{ width }}
    >
      <div className="dialog-head">
        <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
        <button
          type="button"
          onClick={() => {
            if (dismissible) onClose();
          }}
          disabled={!dismissible}
          aria-label="Close"
          className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      {ownScroll ? children : <DialogScroll>{children}</DialogScroll>}
    </Modal>
  );
}

/** What scrolls in a dialog. Anything beside it in the dialog stays where it is. */
export function DialogScroll({ children, ...scroller }: ComponentProps<"div">) {
  return (
    <div className="dialog-frame">
      <div {...scroller} className="dialog-scroll">
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}
