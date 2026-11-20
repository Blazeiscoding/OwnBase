import { Fragment, useRef, useState } from "react";
import {
  APP_EVENT_TYPES,
  APP_SCOPES,
  type AppEventType,
  type AppScope,
  type EventSubscription,
  type ID,
} from "@ownbase/protocol";
import { type AppDetail } from "@ownbase/client-core";
import { useClient } from "../context.js";
import { failureText } from "../lib/failure.js";
import { TextField } from "./TextField.js";
import { reason, rowButton } from "./appParts.js";
import { missingScopes } from "./AppScopes.js";

/**
 * How an endpoint's queue is doing, in the terms an administrator has to act
 * on: work still waiting, work given up on, and events that never got queued
 * because the endpoint was too far behind to hold them.
 */
function DeliveryStatus({ delivery }: { delivery: EventSubscription["delivery"] }) {
  if (!delivery) return null;
  const { pending, failed, retrying, dropped, lastError } = delivery;
  if (pending === 0 && failed === 0 && dropped === 0 && retrying === 0) return null;
  const parts = [
    pending > 0 ? `${pending} waiting` : null,
    retrying > 0 ? `${retrying} to retry once the app catches up` : null,
    failed > 0 ? `${failed} given up on` : null,
    dropped > 0 ? `${dropped} dropped because the app fell behind` : null,
    failed > 0 && lastError ? lastError : null,
  ].filter(Boolean);
  const bad = failed > 0 || dropped > 0;
  return (
    <p
      role={bad ? "alert" : "status"}
      title={lastError ?? undefined}
      className={`truncate ${bad ? "text-alert" : "text-ink-faint"}`}
    >
      {parts.join(" · ")}
    </p>
  );
}

export function SubscriptionList({ app, onChanged }: { app: AppDetail; onChanged: () => void }) {
  const client = useClient();
  const [url, setUrl] = useState("");
  const [types, setTypes] = useState<AppEventType[]>([]);
  /** What is wrong with the address, said under it. */
  const [urlProblem, setUrlProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState<ID | null>(null);
  const urlField = useRef<HTMLInputElement>(null);

  /** Gives the app the scopes a subscription is waiting on. */
  async function allow(missing: AppScope[]) {
    setError(null);
    const failed = await client.apps.setScopes(
      app.id,
      APP_SCOPES.filter((scope) => app.scopes.includes(scope) || missing.includes(scope)),
    );
    if (failed) setError(failureText("Could not allow those.", failed, "Try again."));
    else onChanged();
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const byUrl = app.receive === "url";
    if (byUrl && !url.trim()) {
      setUrlProblem("Give the address that receives events.");
      urlField.current?.focus();
      return;
    }
    setUrlProblem(null);
    setBusy(true);
    const failed = await client.apps.subscribe(
      app.id,
      byUrl ? { url: url.trim(), eventTypes: types } : { eventTypes: types },
    );
    setBusy(false);
    if (!failed) {
      setUrl("");
      setTypes([]);
      onChanged();
    } else if (failed.code === "network_error") {
      setError("Could not subscribe. Check your connection and try again.");
    } else {
      // The server refused the address: it did not answer, or answered wrongly.
      setUrlProblem(reason(failed));
      urlField.current?.focus();
    }
  }

  async function retry(subscriptionId: ID) {
    setRetrying(subscriptionId);
    setError(null);
    if (await client.apps.retrySubscription(subscriptionId))
      setError("Could not retry those deliveries.");
    else onChanged();
    setRetrying(null);
  }

  async function remove(subscriptionId: ID) {
    setError(null);
    const failed = await client.apps.removeSubscription(subscriptionId);
    if (failed) setError(failureText("Could not remove the subscription.", failed));
    else onChanged();
  }

  return (
    <>
      <ul className="space-y-1">
        {app.subscriptions.map((sub) => (
          <li key={sub.id} className="text-[12px]">
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
                {sub.url || "Over its connection"}
              </span>
              <span className="shrink-0 text-[11px] text-ink-dim">
                {sub.eventTypes.length > 0 ? `${sub.eventTypes.length} types` : "all events"}
              </span>
              {(sub.delivery?.failed ?? 0) > 0 && (
                <button
                  disabled={retrying === sub.id}
                  onClick={() => void retry(sub.id)}
                  className="text-copper hover:underline disabled:opacity-40"
                >
                  {retrying === sub.id ? "Retrying…" : "Retry failed"}
                </button>
              )}
              <button
                onClick={() => void remove(sub.id)}
                className="text-ink-faint hover:text-alert"
              >
                Remove
              </button>
            </div>
            <DeliveryStatus delivery={sub.delivery} />
            {missingScopes(app, sub).length > 0 && (
              <p className="text-[11px] text-ink-faint">
                Not sent without{" "}
                {missingScopes(app, sub).map((scope, i) => (
                  <Fragment key={scope}>
                    {i > 0 && ", "}
                    <code className="font-mono">{scope}</code>
                  </Fragment>
                ))}
                .{" "}
                <button
                  type="button"
                  onClick={() => void allow(missingScopes(app, sub))}
                  className="text-copper hover:underline"
                >
                  Allow {missingScopes(app, sub).length === 1 ? "it" : "them"}
                </button>
              </p>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => void add(e)} noValidate className="mt-1.5">
        <div className="flex items-start gap-2">
          {app.receive === "url" && (
            <TextField
              ref={urlField}
              size="small"
              label="Request URL"
              error={urlProblem}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setUrlProblem(null);
              }}
              placeholder="https://bot.example.com/events"
              inputMode="url"
              spellCheck={false}
              autoCapitalize="none"
              className="min-w-0 flex-1"
            />
          )}
          <button
            type="submit"
            aria-disabled={busy || undefined}
            // With no labelled field beside it, nothing to line up with.
            className={app.receive === "url" ? rowButton : rowButton.replace("mt-5 ", "")}
          >
            {busy ? (app.receive === "url" ? "Verifying…" : "Subscribing…") : "Subscribe"}
          </button>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {APP_EVENT_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() =>
                setTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))
              }
              className={`rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors ${
                types.includes(t)
                  ? "border-copper text-copper"
                  : "border-edge text-ink-faint hover:text-ink"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-ink-faint">
          With none selected, the app gets every event.{" "}
          {app.receive === "url" ? (
            <>
              The URL must answer the <code className="font-mono">url_verification</code>{" "}
              check.{" "}
            </>
          ) : (
            "They arrive over its connection. "
          )}
          The app only gets events from channels it has been added to.
        </p>
      </form>
      {error && (
        <p role="alert" className="mt-1 text-[11px] text-alert">
          {error}
        </p>
      )}
    </>
  );
}
