import { useRef, useState } from "react";
import { WORKSPACE_NAME_MAX } from "@ownbase/protocol";
import { type Platform } from "../platform.js";
import { formatDay, formatTime } from "../lib/format.js";
import { isImeKey } from "../lib/textInput.js";
import { inputClass } from "./TextField.js";
import { buttonClass } from "./Button.js";

export type Hosting = NonNullable<Platform["hosting"]>;

/** What Manage hosting is waiting on, which keeps it from starting anything else. */
export type HostingBusy =
  | "starting"
  | "stopping"
  | "opening"
  | "closing"
  | "policy"
  | "address"
  | "backing-up"
  | "removing"
  | "restoring"
  | "renaming"
  | null;

/** What the last backup, rename or removal did, said in the dialog until another starts. */
export type HostNote = { ok: boolean; text: string };

/**
 * What did not happen when OwnBase opened, shown whether or not anything
 * hosts now. A workspace can be live on this network while its public address
 * failed to reopen, and that is exactly the failure a host would otherwise
 * never see. It stays until that part recovers or the host dismisses it.
 */
export function LaunchProblem(props: {
  hosting: Hosting;
  message: string | undefined;
  /** Tries the part that failed again, when this dialog can. */
  onRetry: (() => void) | null;
  disabled: boolean;
  className?: string;
  onError: (text: string | null) => void;
}) {
  const dismiss = props.hosting.dismissLaunchError;
  const [saving, setSaving] = useState(false);
  if (!props.message) return null;
  return (
    <div role="alert" className={`text-sm ${props.className ?? ""}`}>
      <p className="text-alert">{props.message}</p>
      <div className="mt-1 flex flex-wrap gap-3">
        {props.onRetry && (
          <button
            type="button"
            disabled={props.disabled || saving}
            className={linkBtnCls}
            onClick={props.onRetry}
          >
            Try again
          </button>
        )}
        <button
          type="button"
          disabled={props.disabled || saving}
          className={linkBtnCls}
          onClick={() => {
            setSaving(true);
            props.onError(null);
            dismiss().then(
              () => setSaving(false),
              () => {
                setSaving(false);
                props.onError("That message could not be dismissed. Try again.");
              },
            );
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** A small action written as a link, beside what it acts on. */
export const linkBtnCls =
  "whitespace-nowrap text-xs font-medium text-ink underline decoration-ink-faint/60 underline-offset-2 hover:decoration-ink disabled:opacity-40";

/**
 * Renames one hosted workspace where it is shown. Only the name changes: its
 * folder and everything in it stay where they are. Escape calls off the
 * rename rather than closing the dialog. Save always answers: with no name it
 * asks for one, and with the name it has already it just closes the form, as
 * there is nothing to save.
 */
export function RenameForm(props: {
  folder: string;
  name: string;
  /** Something else is under way, so the name cannot be saved yet. */
  blocked: boolean;
  saving: boolean;
  /** Resolves to why the name was refused, or null once it is saved. */
  onSave: (name: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(props.name);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const errorId = `rename-error-${props.folder}`;
  const waiting = props.saving || props.blocked;
  return (
    <form
      aria-label={`Rename ${props.name}`}
      noValidate
      className="min-w-0 flex-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (waiting) return;
        if (!draft.trim()) {
          setError("Give the workspace a name.");
          field.current?.focus();
        } else if (draft.trim() === props.name) props.onCancel();
        else
          void props.onSave(draft).then((refusal) => {
            setError(refusal);
            if (refusal) field.current?.focus();
          });
      }}
    >
      <div className="flex gap-2">
        <input
          ref={field}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- Rename swaps the line for this field, which takes focus in its place
          autoFocus
          aria-label={`New name for ${props.name}`}
          maxLength={WORKSPACE_NAME_MAX}
          value={draft}
          // Read-only rather than disabled while saving, so focus stays here.
          readOnly={props.saving}
          aria-invalid={!!error}
          aria-errormessage={error ? errorId : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || isImeKey(event.nativeEvent)) return;
            event.preventDefault();
            props.onCancel();
          }}
          className={inputClass("regular", "min-w-0 flex-1")}
        />
        <button
          type="submit"
          aria-disabled={waiting || undefined}
          className={buttonClass("secondary", "shrink-0")}
        >
          {props.saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          disabled={props.saving}
          onClick={props.onCancel}
          className={buttonClass("quiet", "shrink-0")}
        >
          Cancel
        </button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-xs text-alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** "today, 3:04 PM" or "Monday, September 22, 3:04 PM". */
export function backedUpWhen(at: number): string {
  const day = formatDay(at);
  return `${day === "Today" || day === "Yesterday" ? day.toLowerCase() : day}, ${formatTime(at)}`;
}
