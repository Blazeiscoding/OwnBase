import { useState } from "react";
import type { AppReceive as Receive } from "@ownbase/protocol";
import { ApiError, type AppDetail } from "@ownbase/client-core";
import { useClient } from "../context.js";
import { failureText } from "../lib/failure.js";
import { useConfirm } from "./Confirm.js";
import { buttonClass } from "./Button.js";

const CHOICES: { value: Receive; label: string; hint: string }[] = [
  {
    value: "url",
    label: "Request URLs",
    hint: "The workspace posts commands, events and button presses to web addresses your app serves.",
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
  /** The choice clicked, shown at once and kept until the reloaded app agrees. */
  const [choosing, setChoosing] = useState<Receive | null>(null);
  const [saving, setSaving] = useState(false);
  const shown = choosing ?? app.receive;
  if (choosing !== null && !saving && choosing === app.receive) setChoosing(null);

  async function choose(receive: Receive) {
    if (saving || receive === shown) return;
    setChoosing(receive);
    setSaving(true);
    setError(null);
    const failed = await client.apps.setReceive(app.id, receive);
    setSaving(false);
    if (failed) {
      setChoosing(null);
      setError(failureText("Could not change how it receives.", failed, "Try again."));
    } else onChanged();
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
              checked={shown === choice.value}
              aria-disabled={saving || undefined}
              onChange={() => void choose(choice.value)}
            />
            <span>
              {choice.label}
              <span className="block text-[11px] text-ink-faint">{choice.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <p role="status" className="text-[11px] text-ink-faint">
        {saving ? "Saving…" : ""}
      </p>
      {app.receive === "socket" && (
        <div className="mt-2 space-y-2 text-[12px]">
          <p role="status" className="flex items-center gap-1.5 text-ink-dim">
            <span
              aria-hidden="true"
              className={`size-2 shrink-0 rounded-full ${
                app.sockets > 0 ? "bg-online" : "border border-ink-faint"
              }`}
            />
            {app.sockets > 0 ? `Connected (${app.sockets})` : "Not connected"}
          </p>
          {app.hasAppToken ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void makeToken()}
                className="rounded px-2 py-1 text-[11px] text-ink-faint transition-colors hover:text-ink"
              >
                New app-level token
              </button>
              <button
                type="button"
                onClick={() => void takeTokenAway()}
                className="rounded px-2 py-1 text-[11px] text-ink-faint transition-colors hover:text-alert"
              >
                Take token away
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className="text-ink">The app needs an app-level token to connect.</p>
              <button
                type="button"
                onClick={() => void makeToken()}
                className={buttonClass("secondary")}
              >
                Make app-level token
              </button>
            </div>
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
