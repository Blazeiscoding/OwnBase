import { useEffect, useId, useRef, useState } from "react";
import type {
  SettingsAction,
  SettingsActionResult,
  SettingsField,
  SettingsPanel,
} from "@ownbase/protocol";
import { ApiError } from "@ownbase/client-core";
import { useClient, usePlatform } from "../context.js";
import { failureText } from "../lib/failure.js";
import { useSaved } from "../lib/savedNote.js";
import { UnsavedGuard, useDismissGuard } from "../lib/dismissGuard.js";
import { useCopy, wasCopied } from "../lib/useCopy.js";
import { buttonClass } from "./Button.js";
import { useConfirm } from "./Confirm.js";
import { Icon } from "./Icon.js";
import { Swap } from "./Motion.js";
import { TextField } from "./TextField.js";

/**
 * Settings the server's extensions add (P9), such as single sign-on in the
 * Enterprise edition. The server says what each panel holds; this draws it
 * as any settings form, and saves it where the panel says. A server without
 * any has none, so nothing is offered.
 */
export function useExtensionPanels(enabled: boolean) {
  const client = useClient();
  const [panels, setPanels] = useState<SettingsPanel[]>([]);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    void client.admin.extensionSettings().then((panels) => {
      // One that fails is asked again next time.
      if (!stop && !(panels instanceof ApiError)) setPanels(panels);
    });
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
  // A secret a button made, kept here: the panel is drawn again once the
  // server answers, and the secret must stay up until it is copied.
  const [revealed, setRevealed] = useState<{ panel: string; reveal: Reveal } | null>(null);
  return (
    <>
      {revealed && <RevealGuard value={revealed.reveal.value} />}
      {panels.map((panel) => (
        // What the server says now replaces what was typed, once it is saved.
        <ExtensionPanelForm
          key={JSON.stringify(panel)}
          panel={panel}
          onSaved={onSaved}
          revealed={revealed?.panel === panel.id ? revealed.reveal : null}
          onReveal={(reveal) => setRevealed(reveal ? { panel: panel.id, reveal } : null)}
        />
      ))}
    </>
  );
}

type Reveal = NonNullable<SettingsActionResult["reveal"]>;

/** A secret shown once: closing asks first while it has not been copied. */
function RevealGuard({ value }: { value: string }) {
  useDismissGuard(() =>
    wasCopied(value)
      ? null
      : {
          title: "Close before copying?",
          body: "You can see it only once. Copy it first if you have not already.",
          confirmLabel: "Close anyway",
        },
  );
  return null;
}

type Values = Record<string, string | boolean>;

function ExtensionPanelForm({
  panel,
  onSaved,
  revealed,
  onReveal,
}: {
  panel: SettingsPanel;
  onSaved: () => void;
  revealed: Reveal | null;
  onReveal: (reveal: Reveal | null) => void;
}) {
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
    const failed = await client.admin.saveExtensionSettings(panel.save!, sent);
    if (!alive.current) return;
    setBusy(false);
    if (failed) {
      setError(failureText("Nothing was saved.", failed, "Try again."));
      return;
    }
    saved();
    onSaved();
  }

  // Typed settings wait for Save, as the workspace's name does, so closing
  // with a change still here asks first. A secret typed is a change.
  const dirty = panel.fields.some((f) =>
    f.kind === "secret" ? values[f.key] !== "" : values[f.key] !== f.value,
  );
  return (
    <section aria-labelledby={`${id}-title`} className="mb-8">
      <UnsavedGuard dirty={dirty && !busy} what={`changes to ${panel.title}`} />
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
      {revealed && <Revealed reveal={revealed} />}
      {panel.save && panel.fields.length > 0 && (
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
      )}
      {panel.actions?.length ? (
        <PanelActions actions={panel.actions} onDone={onSaved} onReveal={onReveal} />
      ) : null}
    </section>
  );
}

/** A panel's buttons, each asked about first where it says, and what went wrong. */
function PanelActions({
  actions,
  onDone,
  onReveal,
}: {
  actions: SettingsAction[];
  onDone: () => void;
  onReveal: (reveal: Reveal | null) => void;
}) {
  const client = useClient();
  const platform = usePlatform();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function press(action: SettingsAction) {
    if (busy) return;
    if (
      action.confirm &&
      !(await confirm({
        title: action.confirm.title,
        body: action.confirm.text,
        confirmLabel: action.confirm.action,
        destructive: true,
      }))
    )
      return;
    setBusy(action.id);
    setError(null);
    const answer = await client.admin.runSettingsAction(action.path);
    if (answer instanceof ApiError) {
      setBusy(null);
      setError(failureText("Nothing was changed.", answer, "Try again."));
      return;
    }
    if (answer.download !== undefined) {
      try {
        if (!platform.downloadFile) throw new Error("This app cannot save downloads.");
        await platform.downloadFile(answer.download);
      } catch {
        setBusy(null);
        setError("The download did not start. Check your connection and try again.");
        return;
      }
    }
    setBusy(null);
    onReveal(answer.reveal ?? null);
    onDone();
  }

  return (
    <div className="mt-4">
      <div className="flex flex-wrap gap-2">
        {actions.map((action, at) => (
          <button
            key={action.id}
            type="button"
            className={buttonClass(at === 0 ? "secondary" : "quiet")}
            onClick={() => void press(action)}
            disabled={busy !== null}
          >
            {action.label}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** A secret a button made, shown this once with a way to copy it. */
function Revealed({ reveal }: { reveal: Reveal }) {
  const { copy, label, copied } = useCopy();
  return (
    <div className="mt-3 rounded-lg border border-copper/40 bg-copper/10 p-2.5">
      <div className="mb-1 text-[12px] font-medium text-copper">{reveal.label}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-ink">
          {reveal.value}
        </code>
        <button
          type="button"
          onClick={() => void copy(reveal.value)}
          className={`shrink-0 rounded px-2 py-1 text-[11px] hover:bg-ink/[0.05] hover:text-ink ${
            copied && !copied.ok ? "text-alert" : "text-ink-dim"
          }`}
        >
          <Swap text>{label("Copy", "Copied", "Copy failed")}</Swap>
        </button>
      </div>
      <p className="mt-1.5 text-[12px] text-ink-dim">{reveal.note}</p>
    </div>
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
          ? `Already saved. Leave this empty to keep it, or type a new one to replace it.${field.help ? ` ${field.help}` : ""}`
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
