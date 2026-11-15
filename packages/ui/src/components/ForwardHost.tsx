import { createContext, lazy, useContext, useMemo, useState, type ReactNode } from "react";
import type { ID } from "@ownbase/protocol";
import type { ForwardSource } from "@ownbase/client-core";
import { LazyDialog } from "./LazyView.js";

// Kept out of the entry until someone forwards a message.
const ForwardDialog = lazy(() =>
  import("./ForwardDialog.js").then((module) => ({ default: module.ForwardDialog })),
);

interface Forwarding {
  open: (rowId: ID, source: ForwardSource) => void;
  /** The row whose Forward is open, which keeps its toolbar for focus to return to. */
  rowId: ID | null;
}

const ForwardContext = createContext<Forwarding | null>(null);

/**
 * Opens Forward message for a message row. Null where nothing hosts the
 * dialog, and then the row offers no Forward.
 */
export function useForward(): Forwarding | null {
  return useContext(ForwardContext);
}

/**
 * Holds the Forward dialog above the message rows. A row leaves the list when
 * someone deletes its message, and the dialog, with the words written in it,
 * must not leave with it.
 */
export function ForwardHost({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<{ rowId: ID; source: ForwardSource } | null>(null);
  const rowId = open?.rowId ?? null;
  const value = useMemo(
    () => ({ open: (row: ID, source: ForwardSource) => setOpen({ rowId: row, source }), rowId }),
    [rowId],
  );
  return (
    <ForwardContext.Provider value={value}>
      {children}
      {open && (
        <LazyDialog loading="Loading Forward message" onClose={() => setOpen(null)}>
          <ForwardDialog source={open.source} onClose={() => setOpen(null)} />
        </LazyDialog>
      )}
    </ForwardContext.Provider>
  );
}
