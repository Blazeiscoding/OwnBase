import { createContext, useContext, useEffect, useRef } from "react";
import { useOptionalConfirm } from "../components/Confirm.js";

/**
 * What closing a dialog would lose, asked about before it goes: changes not
 * saved yet, or something shown once, such as recovery codes.
 */
export interface DismissGuard {
  title: string;
  body: string;
  /** The button that closes anyway; "Discard" when not given. */
  confirmLabel?: string;
}

type Entry = { current: DismissGuard | null };

/** The guards of one dialog, and the way to close it that asks them first. */
export interface GuardRegistry {
  entries: Set<Entry>;
  /** Runs `go` at once with nothing to lose, else once its person agrees. */
  ask: (go: () => void) => void;
}

export const GuardContext = createContext<GuardRegistry | null>(null);

/** A dialog's guards, made once; `Modal` makes its own unless given one. */
export function useGuardRegistry(): GuardRegistry {
  const confirm = useOptionalConfirm();
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  const registry = useRef<GuardRegistry | null>(null);
  if (!registry.current) {
    const entries = new Set<Entry>();
    let asking = false;
    registry.current = {
      entries,
      ask(go) {
        const guard = [...entries].map((entry) => entry.current).find(Boolean);
        const ask = confirmRef.current;
        if (!guard || !ask) return go();
        // A second Escape while the question is up is the question's.
        if (asking) return;
        asking = true;
        void ask({
          title: guard.title,
          body: guard.body,
          confirmLabel: guard.confirmLabel ?? "Discard",
          destructive: true,
        }).then((sure) => {
          asking = false;
          if (sure) go();
        });
      },
    };
  }
  return registry.current;
}

/**
 * Asks before the dialog this is in closes, or its settings go to another
 * section, for as long as `guard` is set.
 */
export function useDismissGuard(guard: DismissGuard | null): void {
  const registry = useContext(GuardContext);
  const entry = useRef<DismissGuard | null>(guard);
  entry.current = guard;
  useEffect(() => {
    if (!registry) return;
    registry.entries.add(entry);
    return () => {
      registry.entries.delete(entry);
    };
  }, [registry]);
}

/** Asks "Discard changes?" before its dialog closes while `dirty`. Renders nothing. */
export function UnsavedGuard({ dirty, what = "changes" }: { dirty: boolean; what?: string }) {
  useDismissGuard(
    dirty
      ? {
          title: `Discard ${what}?`,
          body: "What you changed here is not saved yet.",
          confirmLabel: "Discard",
        }
      : null,
  );
  return null;
}
