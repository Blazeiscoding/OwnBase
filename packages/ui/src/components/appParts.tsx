import { useState } from "react";
import { useCopy } from "../lib/useCopy.js";
import { ApiError } from "@ownbase/client-core";
import { Swap } from "./Motion.js";

/** A secret with a copy button. Bot tokens are shown once; others can be re-read. */
export function SecretRow({
  label,
  value,
  once,
  onReplace,
}: {
  label: string;
  value: string;
  once?: boolean;
  /** Offered beside the copy button, for a secret that may have leaked. */
  onReplace?: () => void;
}) {
  const { copy, label: copyLabel, copied } = useCopy();
  const [shown, setShown] = useState(false);
  return (
    <div className="mt-2 rounded-lg border border-copper/40 bg-copper/10 p-2.5">
      <div className="mb-1 text-[12px] font-medium text-copper">
        {label}
        {once && " · shown once"}
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
          {once || shown ? value : "•".repeat(24)}
        </code>
        {!once && (
          <button
            onClick={() => setShown((v) => !v)}
            className="shrink-0 rounded px-2 py-1 text-[11px] text-ink-dim hover:bg-ink/[0.05] hover:text-ink"
          >
            {shown ? "Hide" : "Reveal"}
          </button>
        )}
        <button
          onClick={() => void copy(value)}
          className={`shrink-0 rounded px-2 py-1 text-[11px] hover:bg-ink/[0.05] hover:text-ink ${
            copied && !copied.ok ? "text-alert" : "text-ink-dim"
          }`}
        >
          <Swap text>{copyLabel("Copy", "Copied", "Copy failed")}</Swap>
        </button>
        {onReplace && (
          <button
            onClick={onReplace}
            className="shrink-0 rounded px-2 py-1 text-[11px] text-ink-dim hover:bg-ink/[0.05] hover:text-ink"
          >
            Replace
          </button>
        )}
      </div>
    </div>
  );
}

/** A row form's button, beside small fields and lined up with them under their labels. */
export const rowButton =
  "mt-5 h-8 shrink-0 rounded-lg border border-edge px-3 text-[12px] font-medium text-ink-dim transition-colors hover:border-ink-faint/50 hover:text-ink";

/**
 * The server's reason, as a sentence. A bare code ("name_taken") is not one,
 * so it is said in words instead of shown as it is.
 */
export function reason(err: ApiError): string {
  const text = err.message && err.message !== err.code ? err.message : "";
  if (!text || !/\s/.test(text)) {
    if (err.code === "name_taken") return "An app already has that name. Choose another.";
    if (err.status >= 500)
      return "The workspace's server ran into a problem. Try again in a moment.";
    return "The workspace turned that down. Check what you entered and try again.";
  }
  return text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? "" : ".");
}
