import { useEffect, useRef, type RefObject } from "react";
import { KeepsFocus } from "./ListStatus.js";

/** How far below the visible end the next page is asked for, so it is there on arrival. */
const AHEAD = "0px 0px 320px 0px";

/**
 * The end of a list read a page at a time (UX-08). As it comes into view it
 * asks for the next page, so scrolling simply goes on. It is also a button,
 * for a keyboard, a screen reader, or a browser without IntersectionObserver,
 * and it stays one element while it reads, so focus on it is not lost.
 */
export function LoadMore(props: {
  /** Another page is there to read. */
  more: boolean;
  /** It is being read. */
  loading: boolean;
  /** Reading it failed; the button reads "Try again", and nothing asks by itself. */
  failed: boolean;
  /** How many rows are shown, so the end is looked at again whenever that changes. */
  count: number;
  onMore: () => void;
  /** The element the list scrolls in. */
  scroller: RefObject<HTMLElement | null>;
}) {
  const home = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLButtonElement>(null);
  const ask = useRef(props.onMore);
  ask.current = props.onMore;
  const idle = props.more && !props.loading && !props.failed;

  // A new observer says at once whether the end is in view, so after each page
  // the next is asked for until the list fills the panel or ends.
  useEffect(() => {
    const target = end.current;
    if (!idle || !target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) ask.current();
      },
      { root: props.scroller.current, rootMargin: AHEAD },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [idle, props.count, props.scroller]);

  return (
    <div ref={home} tabIndex={-1} className="outline-none">
      {props.more && (
        <KeepsFocus home={home}>
          {props.failed && (
            <p role="alert" className="pt-2 text-center text-sm text-ink-dim">
              Could not load more.
            </p>
          )}
          <button
            ref={end}
            type="button"
            // Not `disabled`: a focused button that becomes disabled drops focus.
            aria-disabled={props.loading || undefined}
            onClick={() => {
              if (!props.loading) props.onMore();
            }}
            className="mx-auto my-2 flex h-8 items-center gap-2 rounded-full px-3.5 text-[12px] font-medium text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink aria-disabled:hover:bg-transparent"
          >
            {props.loading && (
              <span
                aria-hidden="true"
                className="size-3 shrink-0 rounded-full border border-edge border-t-copper motion-safe:animate-spin"
              />
            )}
            {props.loading ? "Loading more…" : props.failed ? "Try again" : "Show more"}
          </button>
        </KeepsFocus>
      )}
    </div>
  );
}
