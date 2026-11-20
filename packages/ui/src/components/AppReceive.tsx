import { useState } from "react";
import type { AppReceive as Receive } from "@ownbase/protocol";
import { ApiError, type AppDetail } from "@ownbase/client-core";
import { useClient } from "../context.js";
import { failureText } from "../lib/failure.js";
import { useConfirm } from "./Confirm.js";

const CHOICES: { value: Receive; label: string; hint: string }[] = [
  {
    value: "url",
    label: "At its URLs",
    hint: "The workspace sends commands, events and button presses to addresses the app serves.",
  },
  {
    value: "socket",
    label: "Socket Mode",
    hint: "The app connects to the workspace and is sent everything over that connection. For an app with no public address.",
  },
];

/**
 * How an app is sent its commands, events and button presses (J14): posted
 * to its URLs, or over connections it opens with Slack's Socket Mode. On
 * Socket Mode, its app-level token and how many connections it has open.
 * The token itself is shown by the card, once, beside its other secrets.
 */
export function AppReceive({
  app,
  onChanged,
  onToken,
}: {
  app: AppDetail;
  onChanged: () => void;
  /** A new app-level token, which the server never returns again. */
  onToken: (token: string) => void;
}) {
  const client = useClient();
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function choose(receive: Receive) {
    if (busy || receive === app.receive) return;
    setBusy(true);
    setError(null);
    const failed = await client.apps.setReceive(app.id, receive);
    setBusy(false);
    if (failed) setError(failureText("Could not change how it receives.", failed, "Try again."));
    else onChanged();
  }

  async function makeToken() {
    if (
      app.hasAppToken &&
      !(await confirm({
        title: `Replace ${app.name}'s app-level token?`,
        body: "The current token stops working now, and the app's connections close. It cannot connect again until you give it the new one.",
        confirmLabel: "Replace",
        destructive: true,
      }))
    )
      return;
    setError(null);
    const token = await client.apps.replaceAppLevelToken(app.id);
    if (token instanceof ApiError) {
      setError(failureText("Could not make a token.", token, "Try again."));
      return;
    }
    onToken(token);
    onChanged();
  }

  async function takeTokenAway() {
    if (
      !(await confirm({
        title: `Take away ${app.name}'s app-level token?`,
        body: "Its connections close, and it cannot connect again until you make a new token.",
        confirmLabel: "Take it away",
        destructive: true,
      }))
    )
      return;
    setError(null);
    const failed = await client.apps.revokeAppLevelToken(app.id);
    if (failed) setError(failureText("Could not take the token away.", failed, "Try again."));
    else onChanged();
  }

  return (
    <>
      <div role="radiogroup" aria-label="How it receives" className="space-y-1.5">
        {CHOICES.map((choice) => (
          <label key={choice.value} className="flex items-start gap-2 text-[12px]">
            <input
              type="radio"
              name={`receive-${app.id}`}
              className="mt-0.5"
              checked={app.receive === choice.value}
              aria-disabled={busy || undefined}
              onChange={() => void choose(choice.value)}
            />
            <span>
              {choice.label}
              <span className="block text-[11px] text-ink-faint">{choice.hint}</span>
            </span>
          </label>
        ))}
      </div>
      {app.receive === "socket" && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-ink-dim">
            {app.sockets === 0
              ? "Not connected"
              : `${app.sockets} ${app.sockets === 1 ? "connection" : "connections"} open`}
          </span>
          <button
            type="button"
            onClick={() => void makeToken()}
            className="ml-auto rounded px-2 py-1 text-[11px] text-ink-faint transition-colors hover:text-ink"
          >
            {app.hasAppToken ? "New app-level token" : "Make app-level token"}
          </button>
          {app.hasAppToken && (
            <button
              type="button"
              onClick={() => void takeTokenAway()}
              className="rounded px-2 py-1 text-[11px] text-ink-faint transition-colors hover:text-alert"
            >
              Take token away
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-[11px] text-alert">
          {error}
        </p>
      )}
    </>
  );
}
