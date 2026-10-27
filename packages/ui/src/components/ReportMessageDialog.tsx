import { useId, useRef, useState } from "react";
import { ApiError } from "@ownbase/client-core";
import { REPORT_NOTE_MAX, type Message, type ReportReason } from "@ownbase/protocol";
import { useClient, useWorkspace } from "../context.js";
import { Dialog } from "./Dialog.js";
import { inputCls } from "./TextField.js";
import { buttonClass } from "./Button.js";
import { Swap } from "./Motion.js";
import { useToast } from "./Toast.js";
import { REPORT_REASON_LABELS } from "../lib/blocking.js";

/** What each reason covers, under its name. */
const REASONS: { value: ReportReason; hint: string }[] = [
  { value: "spam", hint: "Ads, scams or the same thing over and over." },
  { value: "harassment", hint: "Aimed at someone to hurt, threaten or shame them." },
  { value: "inappropriate", hint: "Hateful, explicit or otherwise out of place here." },
  { value: "other", hint: "Say what in the note below." },
];

/**
 * Reports a message to the workspace's admins (E12): what is wrong with it,
 * and anything to add. Its author is told nothing.
 */
export function ReportMessageDialog({
  message,
  onClose,
}: {
  message: Message;
  onClose: () => void;
}) {
  const client = useClient();
  const toast = useToast();
  const author = useWorkspace((s) => s.users[message.userId]);
  const id = useId();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!reason) {
      setError("Choose what is wrong with it.");
      first.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.api.reportMessage(message.id, reason, note);
      toast({ message: "Reported. The workspace's admins will look at it.", kind: "success" });
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "message_not_found"
          ? "That message is gone, so there is nothing to report."
          : "Your report was not sent. Check your connection and try again.",
      );
      setBusy(false);
    }
  }

  return (
    <Dialog title="Report message" onClose={onClose} describedBy={`${id}-about`}>
      <form noValidate onSubmit={(event) => void send(event)} className="space-y-4">
        <p id={`${id}-about`} className="text-sm text-ink-dim">
          The workspace&rsquo;s admins will see this message, who wrote it and your report.{" "}
          {author ? `${author.displayName} is` : "Its author is"} not told.
        </p>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">What is wrong with it?</legend>
          {REASONS.map((choice, index) => (
            <label
              key={choice.value}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-2.5 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-copper ${
                reason === choice.value
                  ? "border-ink/30 bg-ink/[0.04]"
                  : "border-edge hover:border-ink/20"
              }`}
            >
              <input
                ref={index === 0 ? first : undefined}
                type="radio"
                name={`${id}-reason`}
                value={choice.value}
                checked={reason === choice.value}
                onChange={() => {
                  setReason(choice.value);
                  setError(null);
                }}
                className="mt-1 accent-[var(--color-copper)]"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  {REPORT_REASON_LABELS[choice.value]}
                </span>
                <span className="block text-xs text-ink-faint">{choice.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div>
          <label className="mb-1.5 block text-sm font-medium" htmlFor={`${id}-note`}>
            Anything to add <span className="font-normal text-ink-faint">(optional)</span>
          </label>
          <textarea
            id={`${id}-note`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={REPORT_NOTE_MAX}
            rows={3}
            className={`${inputCls} resize-none`}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-alert">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={buttonClass("secondary")} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className={buttonClass("primary")}
            aria-disabled={busy || undefined}
          >
            <Swap text>{busy ? "Sending…" : "Send report"}</Swap>
          </button>
        </div>
      </form>
    </Dialog>
  );
}
