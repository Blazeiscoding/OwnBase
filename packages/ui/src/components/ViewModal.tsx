import { useEffect, useRef, useState } from "react";
import type { ModalField, ModalView } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { Dialog, DialogScroll, inputCls } from "./Dialog.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { buttonClass } from "./Button.js";

/**
 * A form an app asked for. The answers go straight back to that app, so this
 * deliberately looks like part of the app's message rather than part of the
 * workspace: nothing here is stored, and closing it tells the app nothing.
 */
export function ViewModal() {
  const view = useWorkspace((s) => s.modal);
  // The newest form replaces the old one, with independent answers and results.
  return view ? <AppForm key={view.id} view={view} /> : null;
}

function AppForm({ view }: { view: ModalView }) {
  const client = useClient();
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set by a refused submission, so the first field the app refused takes focus. */
  const showError = useRef(false);
  const alive = useRef(true);
  const submitting = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!showError.current) return;
    showError.current = false;
    const refused = view.fields.find((field) => errors[field.blockId]);
    if (refused) document.getElementById(fieldId(refused))?.focus();
  }, [errors, view]);

  // Keyed by block as well: an action id need only be unique within its block,
  // and two fields sharing one would otherwise share a value.
  const valueOf = (field: ModalField) => values[fieldId(field)] ?? field.initialValue;
  const setValue = (field: ModalField, value: string) =>
    setValues((v) => ({ ...v, [fieldId(field)]: value }));

  function close() {
    alive.current = false;
    client.dismissModal(view.id);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!alive.current || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setMessage(null);
    // Nested the way the app will read it back: block id, then action id.
    const payload: Record<string, Record<string, string>> = {};
    for (const field of view.fields) {
      payload[field.blockId] = { ...payload[field.blockId], [field.actionId]: valueOf(field) };
    }
    try {
      const result = await client.submitModal(payload, view.id);
      if (!alive.current) return;
      if (result.ok) {
        setValues({});
        setErrors({});
      } else {
        showError.current = true;
        setErrors(result.errors ?? {});
        setMessage(result.message ?? null);
      }
    } catch {
      if (alive.current) setMessage("That did not go through.");
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return (
    <Dialog title={view.title} onClose={close} width={520} ownScroll>
      {/* An app decides how many fields there are; the buttons stay in sight
          under however many that is. */}
      <form onSubmit={submit} className="flex min-h-0 flex-col">
        <DialogScroll>
          {view.text && (
            <div className="mb-4 text-sm text-ink-dim">
              <Mrkdwn text={view.text} users={users} channels={channels} />
            </div>
          )}

          <div className="space-y-3.5">
            {view.fields.map((field) => {
              const id = fieldId(field);
              const error = errors[field.blockId];
              // The error replaces the hint on screen, and so in what is read.
              const described = error ? `${id}-error` : field.hint ? `${id}-hint` : undefined;
              const shared = {
                id,
                "aria-describedby": described,
                "aria-invalid": error ? true : undefined,
                "aria-required": !field.optional,
              };
              return (
                <div key={id}>
                  <label htmlFor={id} className="mb-1 block text-[13px] font-medium">
                    {field.label}
                    {field.optional && (
                      <span className="ml-1.5 text-[11px] font-normal text-ink-faint">
                        optional
                      </span>
                    )}
                  </label>

                  {field.type === "select" ? (
                    <select
                      {...shared}
                      value={valueOf(field)}
                      onChange={(e) => setValue(field, e.target.value)}
                      className={inputCls}
                    >
                      <option value="">{field.placeholder || "Choose one…"}</option>
                      {field.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.text}
                        </option>
                      ))}
                    </select>
                  ) : field.type === "textarea" ? (
                    <textarea
                      {...shared}
                      value={valueOf(field)}
                      placeholder={field.placeholder}
                      rows={4}
                      onChange={(e) => setValue(field, e.target.value)}
                      className={`${inputCls} resize-y`}
                    />
                  ) : (
                    <input
                      {...shared}
                      value={valueOf(field)}
                      placeholder={field.placeholder}
                      onChange={(e) => setValue(field, e.target.value)}
                      className={inputCls}
                    />
                  )}

                  {field.hint && !error && (
                    <p id={`${id}-hint`} className="mt-1 text-[11px] text-ink-faint">
                      {field.hint}
                    </p>
                  )}
                  {error && (
                    <p id={`${id}-error`} role="alert" className="mt-1 text-[11px] text-alert">
                      {error}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {message && (
            <p role="alert" className="mt-3 text-[12px] text-alert">
              {message}
            </p>
          )}
        </DialogScroll>
        <div className="dialog-foot flex justify-end gap-2">
          <button
            type="button"
            onClick={close}
            className="rounded-lg border border-edge px-4 py-2.5 text-sm text-ink-dim transition-colors hover:border-ink-faint hover:text-ink"
          >
            {view.closeLabel}
          </button>
          <button type="submit" disabled={busy} className={buttonClass("primary")}>
            {busy ? "Sending…" : view.submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** A field's element id, and the key its value is kept under. */
function fieldId(field: ModalField) {
  return `${field.blockId}.${field.actionId}`;
}
