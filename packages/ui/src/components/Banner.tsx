import { Fragment, useRef, useState, type ReactNode } from "react";

/**
 * A row in the one place for banners, under the conversation's header
 * (UX-25): what happened, and what can be done about it. The screen shows
 * one at a time, the most pressing.
 */
export function Banner(props: {
  tone: "alert" | "status";
  children: ReactNode;
  /** Buttons at its end, such as Retry or Dismiss. */
  actions?: ReactNode;
}) {
  return (
    <div
      role={props.tone}
      className={`flex shrink-0 items-center gap-3 border-b px-5 py-2 text-sm ${
        props.tone === "alert"
          ? "border-alert/30 bg-alert/[0.04] text-ink"
          : "border-edge text-ink-faint"
      }`}
    >
      <span className="min-w-0 flex-1">{props.children}</span>
      {props.actions && <span className="flex shrink-0 items-center gap-3">{props.actions}</span>}
    </div>
  );
}

/**
 * One entry in the banner place: a banner that is on show whenever it is
 * given, or one that says whether it is on show, such as a notice that waits
 * for storage to answer. Nothing when it has nothing to say.
 */
export type QueuedBanner = ReactNode | ((onShowing: (showing: boolean) => void) => ReactNode);

/**
 * The place for banners: one at a time, in the order given, so each is drawn
 * only while none before it is on show (UX-25).
 */
export function BannerQueue({ banners }: { banners: readonly QueuedBanner[] }) {
  const [showing, setShowing] = useState<readonly boolean[]>([]);
  // One for each place, kept, so a banner's effects do not run again on every draw.
  const reporters = useRef<((showing: boolean) => void)[]>([]);
  const reporter = (place: number) =>
    (reporters.current[place] ??= (on) =>
      setShowing((was) => (was[place] === on ? was : Object.assign([...was], { [place]: on }))));
  const drawn: ReactNode[] = [];
  for (const [place, banner] of banners.entries()) {
    if (!banner) continue;
    if (typeof banner !== "function") {
      drawn.push(<Fragment key={place}>{banner}</Fragment>);
      break;
    }
    drawn.push(<Fragment key={place}>{banner(reporter(place))}</Fragment>);
    if (showing[place]) break;
  }
  return <>{drawn}</>;
}

/** A banner's action: words that underline on hover, as a link would. */
export function BannerAction(props: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="font-medium text-ink underline decoration-ink-faint/60 hover:decoration-ink"
    >
      {props.children}
    </button>
  );
}
