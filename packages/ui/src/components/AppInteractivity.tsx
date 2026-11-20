import { useRef, useState } from "react";
import { type AppDetail } from "@ownbase/client-core";
import { useClient } from "../context.js";
import { TextField } from "./TextField.js";
import { reason, rowButton } from "./appParts.js";

/**
 * Where this app's button clicks go. One URL per app, like Slack's
 * interactivity request URL, and it has to answer the same verification
 * handshake a subscription does before it is accepted. Saving the same
 * address again checks it again.
 */
export function InteractivityUrl({ app, onChanged }: { app: AppDetail; onChanged: () => void }) {
  const client = useClient();
  const [url, setUrl] = useState(app.interactivityUrl);
  /** What is wrong with the address, said under it. */
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The address last saved from here, to say so while it is still the one in the field. */
  const [saved, setSaved] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setError(null);
    setSaved(null);
    const failed = await client.apps.setInteractivityUrl(app.id, url.trim());
    setBusy(false);
    if (!failed) {
      setSaved(url);
      onChanged();
    } else if (failed.code === "network_error") {
      setError("Could not save. Check your connection and try again.");
    } else {
      // The server refused the address: it did not answer, or answered wrongly.
      setProblem(reason(failed));
      field.current?.focus();
    }
  }

  return (
    <form onSubmit={(e) => void save(e)} noValidate>
      <div className="flex items-start gap-2">
        <TextField
          ref={field}
          size="small"
          label="Request URL"
          hint={
            <>
              When someone presses a button in this app&apos;s messages, the workspace sends
              Slack&apos;s <code className="font-mono">block_actions</code> payload here. Leave it
              empty to turn buttons off.
            </>
          }
          error={problem}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setProblem(null);
          }}
          placeholder="https://bot.example.com/interactions"
          inputMode="url"
          spellCheck={false}
          autoCapitalize="none"
          className="min-w-0 flex-1"
        />
        <button type="submit" aria-disabled={busy || undefined} className={rowButton}>
          {busy ? "Checking…" : "Save"}
        </button>
      </div>
      <p role="status" className="mt-1 text-[11px] text-ink-dim empty:hidden">
        {saved !== null && saved === url
          ? url.trim()
            ? "Saved and verified."
            : "Saved. Buttons are off."
          : ""}
      </p>
      {error && (
        <p role="alert" className="mt-1 text-[11px] text-alert">
          {error}
        </p>
      )}
    </form>
  );
}
