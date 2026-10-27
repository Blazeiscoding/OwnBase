import { useId, useState, type FormEvent } from "react";
import { SIDEBAR_SECTION_NAME_MAX } from "@ownbase/protocol";
import { buttonClass } from "./Button.js";
import { Dialog } from "./Dialog.js";
import { inputCls } from "./TextField.js";

/**
 * Names a sidebar section (E8): a new one, or one being renamed. Waits for the
 * server, so the window stays open with the reason if it refuses.
 */
export function SectionNameDialog({
  title,
  submitLabel,
  initial = "",
  onSubmit,
  onClose,
}: {
  title: string;
  submitLabel: string;
  initial?: string;
  /** Resolves with a problem to show, or null once the server has the name. */
  onSubmit: (name: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fieldId = useId();
  const problemId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setProblem("Give the section a name.");
      return;
    }
    setBusy(true);
    const refused = await onSubmit(name.trim());
    setBusy(false);
    if (refused) setProblem(refused);
    else onClose();
  }

  return (
    <Dialog title={title} onClose={onClose} width={400}>
      <form noValidate onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor={fieldId} className="mb-1.5 block text-[13px] font-medium text-ink-dim">
            Name
          </label>
          <input
            id={fieldId}
            autoFocus
            value={name}
            maxLength={SIDEBAR_SECTION_NAME_MAX}
            placeholder="Projects, Clients, Reading…"
            onChange={(event) => {
              setName(event.target.value);
              setProblem(null);
            }}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? problemId : undefined}
            className={inputCls}
          />
          {problem && (
            <p id={problemId} role="alert" className="mt-1.5 text-xs text-alert">
              {problem}
            </p>
          )}
        </div>
        <div className="dialog-foot flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass("secondary")}>
            Cancel
          </button>
          <button type="submit" disabled={busy} className={buttonClass("primary")}>
            {busy ? "Saving…" : submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
