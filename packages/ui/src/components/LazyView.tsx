import { Suspense, type ReactNode } from "react";
import { Dialog } from "./Dialog.js";
import { ErrorBoundary } from "./ErrorBoundary.js";

/**
 * A side panel loaded on first use: says so while it loads, and offers a way
 * out if it cannot, since a failed download must not take the workspace with it.
 */
export function LazyPanel(props: { name: string; onClose: () => void; children: ReactNode }) {
  return (
    <ErrorBoundary
      fallback={
        <aside
          aria-label={`${props.name} unavailable`}
          className="w-[420px] max-w-full border-l border-edge p-5 text-sm"
        >
          <p role="alert">
            {props.name} could not load. Close it to keep chatting, or reload the app to try again.
          </p>
          <div className="mt-3 flex gap-4 font-medium text-ink">
            <button onClick={props.onClose}>Close {props.name.toLowerCase()}</button>
            <button onClick={() => window.location.reload()}>Reload app</button>
          </div>
        </aside>
      }
    >
      <Suspense
        fallback={
          <aside
            role="status"
            className="w-[380px] max-w-full border-l border-edge p-5 text-sm text-ink-faint"
          >
            <span className="text-shimmer" data-text={`Loading ${props.name.toLowerCase()}…`}>
              Loading {props.name.toLowerCase()}…
            </span>
            <button
              className="ml-3 font-medium text-ink-dim hover:text-ink"
              onClick={props.onClose}
            >
              Close
            </button>
          </aside>
        }
      >
        {props.children}
      </Suspense>
    </ErrorBoundary>
  );
}

/** A dialog loaded on first use, with the same promise as a panel. */
export function LazyDialog(props: { loading: string; onClose: () => void; children: ReactNode }) {
  return (
    <ErrorBoundary
      fallback={
        <Dialog title="This view could not load" onClose={props.onClose}>
          <p className="text-sm text-ink-dim">
            Close this view to keep chatting, or reload the app to try again.
          </p>
          <button
            className="mt-3 text-sm font-medium text-ink"
            onClick={() => window.location.reload()}
          >
            Reload app
          </button>
        </Dialog>
      }
    >
      <Suspense
        fallback={
          <Dialog title={props.loading} onClose={props.onClose}>
            <p role="status" className="text-sm text-ink-faint">
              <span className="text-shimmer" data-text="Opening this view…">
                Opening this view…
              </span>
            </p>
          </Dialog>
        }
      >
        {props.children}
      </Suspense>
    </ErrorBoundary>
  );
}
