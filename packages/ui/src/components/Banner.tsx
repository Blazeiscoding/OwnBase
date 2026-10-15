import type { ReactNode } from "react";

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
