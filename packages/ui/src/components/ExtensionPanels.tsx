import { useEffect, useId, useRef, useState } from "react";
import type { SettingsField, SettingsPanel } from "@ownbase/protocol";
import { ApiError } from "@ownbase/client-core";
import { useClient } from "../context.js";
import { useSaved } from "../lib/savedNote.js";
import { buttonClass } from "./Button.js";
import { Icon } from "./Icon.js";
import { TextField } from "./TextField.js";

/**
 * Settings the server's extensions add (P9), such as single sign-on in the
 * Enterprise edition. The server says what each panel holds; this draws it
 * as any settings form, and saves it where the panel says. A server without
 * any, or from before them, has none, so nothing is offered.
 */
export function useExtensionPanels(enabled: boolean) {
  const client = useClient();
  const [panels, setPanels] = useState<SettingsPanel[]>([]);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    client.api.extensionSettings().then(
      (result) => {
        if (!stop) setPanels(result.panels);
      },
      // An older server has no such route; one that fails is asked again next time.
      () => {},
    );
    return () => {
      stop = true;
    };
  }, [client, enabled, version]);
  return { panels, reload: () => setVersion((v) => v + 1) };
}

export function ExtensionPanels({
  panels,
  onSaved,
}: {
  panels: SettingsPanel[];
  onSaved: () => void;
}) {
  return (
    <>
      {panels.map((panel) => (
        // What the server says now replaces what was typed, once it is saved.
        <ExtensionPanelForm key={JSON.stringify(panel)} panel={panel} onSaved={onSaved} />
      ))}
    </>
  );
}

type Values = Record<string, string | boolean>;

function ExtensionPanelForm({ panel, onSaved }: { panel: SettingsPanel; onSaved: () => void }) {
  const client = useClient();
  const saved = useSaved();
  const id = useId();
  const [values, setValues] = useState<Values>(() =>
    Object.fromEntries(panel.fields.map((f) => [f.key, f.value])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const set = (key: string, value: string | boolean) =>
    setValues((current) => ({ ...current, [key]: value }));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    // A secret left empty keeps the one saved.
    const sent = Object.fromEntries(
      panel.fields
        .filter((f) => !(f.kind === "secret" && values[f.key] === ""))
        .map((f) => [f.key, values[f.key]!]),
    );
    try {
      await client.api.saveExtensionSettings(panel.save, sent);
      if (!alive.current) return;
      saved();
      onSaved();
    } catch (err) {
      if (!alive.current) return;
      setError(
        err instanceof ApiError && err.message && err.message !== err.code
          ? err.message
          : "Nothing was saved. Check your connection and try again.",
      );
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="mb-8">
      <h4 id={`${id}-title`} className="mb-1.5 text-[13px] font-medium text-ink-dim">
        {panel.title}
      </h4>
      <p className="text-sm text-ink-dim">{panel.description}</p>
      {panel.problem && (
        <p
          role="note"
          className="mt-3 flex items-start gap-2 rounded-lg border border-edge bg-raised p-3 text-sm text-ink-dim"
        >
          <Icon name="alert" size={14} className="mt-0.5 shrink-0 text-copper" />
          <span>{panel.problem}</span>
        </p>
      )}
      {panel.status && <p className="mt-3 text-sm text-ink">{panel.status}</p>}
      <form noValidate onSubmit={(event) => void save(event)} className="mt-4 space-y-4">
        {panel.fields.map((field) => (
          <PanelField key={field.key} field={field} value={values[field.key]!} onChange={set} />
        ))}
        {error && (
          <p role="alert" className="text-sm text-alert">
            {error}
          </p>
        )}
        <button type="submit" className={buttonClass("primary")} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
    </section>
  );
}

function PanelField({
  field,
  value,
  onChange,
}: {
  field: SettingsField;
  value: string | boolean;
  onChange: (key: string, value: string | boolean) => void;
}) {
  const id = useId();
  if (field.kind === "toggle")
    return (
      <div>
        <label className="flex items-center gap-2 text-sm text-ink" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(field.key, event.target.checked)}
            aria-describedby={field.help ? `${id}-help` : undefined}
          />
          {field.label}
        </label>
        {field.help && (
          <p id={`${id}-help`} className="ml-6 mt-1 text-[12px] text-ink-faint">
            {field.help}
          </p>
        )}
      </div>
    );
  return (
    <TextField
      label={field.label}
      hint={
        field.kind === "secret" && field.isSet
          ? `Saved. Leave it empty to keep it, or enter a new one.${field.help ? ` ${field.help}` : ""}`
          : field.help
      }
      type={field.kind === "secret" ? "password" : "text"}
      inputMode={field.kind === "url" ? "url" : undefined}
      autoComplete={field.kind === "secret" ? "new-password" : "off"}
      spellCheck={false}
      placeholder={field.placeholder}
      value={value as string}
      onChange={(event) => onChange(field.key, event.target.value)}
    />
  );
}
