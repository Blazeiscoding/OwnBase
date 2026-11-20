import { useRef, useState } from "react";
import { commandName } from "../lib/appTemplates.js";
import { ApiError, type AppDetail } from "@ownbase/client-core";
import { useClient } from "../context.js";
import { failureText } from "../lib/failure.js";
import { TextField } from "./TextField.js";
import { reason, rowButton } from "./appParts.js";

export function CommandList({ app, onChanged }: { app: AppDetail; onChanged: () => void }) {
  const client = useClient();
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  /** What is missing, said under each field once the form is sent. */
  const [problems, setProblems] = useState<{ command?: string; url?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const commandField = useRef<HTMLInputElement>(null);
  const urlField = useRef<HTMLInputElement>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const byUrl = app.receive === "url";
    const found = {
      command: commandName(command) ? undefined : "Name the command, such as /deploy.",
      url: !byUrl || url.trim() ? undefined : "Give the address your service answers on.",
    };
    setProblems(found);
    if (found.command || found.url) {
      (found.command ? commandField : urlField).current?.focus();
      return;
    }
    setBusy(true);
    const added = await client.apps.createCommand(app.id, {
      command: command.trim(),
      ...(byUrl ? { url: url.trim() } : {}),
      description: description.trim(),
    });
    setBusy(false);
    if (added instanceof ApiError) {
      setError(
        added.code === "network_error"
          ? "Could not add the command. Check your connection and try again."
          : added.code === "invalid_request"
            ? "Use letters, digits, - and _ in the command, and an http or https address."
            : reason(added),
      );
      return;
    }
    setCommand("");
    setUrl("");
    setDescription("");
    onChanged();
  }

  async function remove(c: AppDetail["commands"][number]) {
    setError(null);
    const failed = await client.apps.removeCommand(c.id);
    if (failed) {
      setError(failureText(`Could not remove /${c.command}.`, failed));
      return;
    }
    onChanged();
  }

  return (
    <>
      <ul className="space-y-1">
        {app.commands.map((c) => (
          <li key={c.id} className="flex items-baseline gap-2 text-[12px]">
            <span className="font-mono text-copper">/{c.command}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
              {c.url || "Over its connection"}
            </span>
            <button onClick={() => void remove(c)} className="text-ink-faint hover:text-alert">
              Remove
            </button>
          </li>
        ))}
      </ul>
      {/* Never off until filled in: sent empty, it says what is missing. */}
      <form
        onSubmit={(e) => void add(e)}
        noValidate
        className="mt-1.5 flex flex-wrap items-start gap-2"
      >
        <TextField
          ref={commandField}
          size="small"
          label="Command"
          error={problems.command}
          value={command}
          onChange={(e) => {
            setCommand(e.target.value);
            setProblems((found) => ({ ...found, command: undefined }));
          }}
          placeholder="/deploy"
          spellCheck={false}
          autoCapitalize="none"
          className="w-28 shrink-0"
        />
        {app.receive === "url" && (
          <TextField
            ref={urlField}
            size="small"
            label="Request URL"
            error={problems.url}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setProblems((found) => ({ ...found, url: undefined }));
            }}
            placeholder="https://bot.example.com/deploy"
            inputMode="url"
            spellCheck={false}
            autoCapitalize="none"
            className="min-w-0 flex-1 basis-48"
          />
        )}
        <TextField
          size="small"
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What it does"
          className="min-w-0 flex-1 basis-32"
        />
        <button type="submit" aria-disabled={busy || undefined} className={rowButton}>
          {busy ? "Adding…" : "Add"}
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-1 text-[11px] text-alert">
          {error}
        </p>
      )}
    </>
  );
}
