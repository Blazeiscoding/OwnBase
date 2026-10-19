import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import type { IconName } from "./Icon.js";
import { EmptyAction, EmptyState, type EmptyStateAction } from "./EmptyState.js";

interface Props {
  /** A load is running. */
  loading?: boolean;
  /**
   * Nothing is on screen yet. A load then shows rows shaped like what is
   * coming; with content already showing, one line says what is refreshing.
   */
  placeholder?: boolean;
  /** What is loading, as the line and a screen reader say it: "Loading replies…". */
  loadingLabel: string;
  /** Set when the last load failed: what happened. */
  error?: ReactNode;
  /** Sends the load again. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Set when a finished load found nothing: what the list is for, and how to fill it. */
  empty?: ReactNode;
  /** One thing to do about an empty list, such as clearing a filter. */
  emptyAction?: EmptyStateAction;
  /** A mark for what the list holds, shown above an empty list's words. */
  emptyIcon?: IconName;
  className?: string;
}

/**
 * What a list says about itself above whatever it holds: loading, failed, or
 * empty, the last as an `EmptyState`. One element for the list's whole life, so a screen reader hears each
 * change in a region it is already watching, and so focus has somewhere to go
 * when Retry, or an empty list's action, is replaced by what it started.
 */
export function ListStatus(props: Props) {
  const root = useRef<HTMLDivElement>(null);
  const showEmpty = !props.loading && hasContent(props.empty);
  return (
    <div ref={root} tabIndex={-1} className={`outline-none ${props.className ?? ""}`}>
      {hasContent(props.error) && (
        <KeepsFocus home={root}>
          <p role="alert" className="py-3 text-sm text-ink-dim">
            {props.error}{" "}
            {props.onRetry && (
              <button
                type="button"
                // Not `disabled`: a focused button that becomes disabled drops
                // focus to the page. This one just waits for the running load.
                aria-disabled={props.loading || undefined}
                onClick={() => {
                  if (!props.loading) props.onRetry?.();
                }}
                className="font-medium text-ink underline decoration-ink-faint/60 hover:decoration-ink aria-disabled:opacity-40"
              >
                {props.retryLabel ?? "Retry"}
              </button>
            )}
          </p>
        </KeepsFocus>
      )}
      <div role="status">
        {props.loading ? (
          props.placeholder ? (
            <StandInRows label={props.loadingLabel} />
          ) : (
            <p className="flex items-center justify-center gap-2 py-2 text-sm text-ink-faint">
              <span
                aria-hidden="true"
                className="size-3 shrink-0 rounded-full border border-edge border-t-copper motion-safe:animate-spin"
              />
              <span className="text-shimmer" data-text={props.loadingLabel}>
                {props.loadingLabel}
              </span>
            </p>
          )
        ) : showEmpty ? (
          <EmptyState icon={props.emptyIcon}>{props.empty}</EmptyState>
        ) : null}
      </div>
      {/* Apart from the status, so what is read out as it changes is the words alone. */}
      {showEmpty && props.emptyAction && (
        <KeepsFocus home={root}>
          <EmptyAction action={props.emptyAction} icon={props.emptyIcon} />
        </KeepsFocus>
      )}
    </div>
  );
}

function hasContent(node: ReactNode): boolean {
  return node !== null && node !== undefined && node !== false && node !== "";
}

/** Widths for the stand-in rows' two lines, varied so they read as text. */
const STAND_INS = [
  ["32%", "88%"],
  ["24%", "64%"],
  ["40%", "76%"],
] as const;

/** Rows the shape of messages, for the moment before any have arrived. */
function StandInRows({ label }: { label: string }) {
  return (
    <div className="space-y-4 py-3">
      <span className="sr-only">{label}</span>
      {STAND_INS.map(([name, text]) => (
        <div key={name} aria-hidden="true" className="flex gap-2.5 motion-safe:animate-pulse">
          <div className="size-9 shrink-0 rounded-lg bg-lifted" />
          <div className="flex-1 space-y-2 pt-1">
            <div className="h-3 rounded bg-lifted" style={{ width: name }} />
            <div className="h-3 rounded bg-lifted" style={{ width: text }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * When what it wraps goes while holding focus, focus moves to `home` instead
 * of falling to the page. A layout cleanup runs while the wrapped content is
 * still in the document, so it can still tell where focus is.
 */
export function KeepsFocus({
  home,
  children,
}: {
  home: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const own = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = own.current;
    return () => {
      if (element?.contains(document.activeElement)) home.current?.focus({ preventScroll: true });
    };
  }, [home]);
  return <div ref={own}>{children}</div>;
}
