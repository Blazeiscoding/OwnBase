import type { ReactNode } from "react";
import { Modal } from "./Modal.js";

/** Phones without a pointer get a sheet where anything else gets a dropdown. */
export const SHEET_QUERY = "(hover: none) and (max-width: 760px)";

/** Whether this screen is one that gets a sheet. Read once, as what opens decides how. */
export function wantsSheet(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(SHEET_QUERY).matches;
}

/** The surface of a card in a sheet: each part of what it holds floats on its own. */
export const sheetCard = "surface-float rounded-2xl";

/**
 * A sheet along the bottom of a phone's screen, in reach of a thumb: the
 * page dims behind it, it rises from below the edge, and it keeps clear of
 * the home indicator. What it holds is a column of cards (`sheetCard`), such
 * as a row of quick reactions above a menu's items. Built on the modal
 * layer, like a dialog: Escape or a press on the dimmed page closes it, the
 * page behind is inert while it is open, and focus goes back to whatever
 * opened it. Focus starts on the sheet itself unless something in it takes it.
 */
export function Sheet({
  label,
  onClose,
  children,
}: {
  /** Its accessible name, such as the menu's: "Actions for message from Hana". */
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal
      title={label}
      onClose={onClose}
      backdropClassName="animate-fade-in bg-black/40"
      className="fixed outline-none"
    >
      <div className="bottom-sheet fixed flex animate-sheet-in flex-col gap-2">{children}</div>
    </Modal>
  );
}
