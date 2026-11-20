import { useEffect, useRef, useState } from "react";
import {
  APP_EVENT_TYPES,
  APP_SCOPES,
  eventScopes,
  type AppScope,
  type EventSubscription,
} from "@ownbase/protocol";
import { type AppDetail } from "@ownbase/client-core";
import { useClient } from "../context.js";
import { failureText } from "../lib/failure.js";
import { Icon } from "./Icon.js";

/** Each scope in the words an administrator decides on. */
const SCOPE_WORDS: Record<AppScope, string> = {
  "chat:write": "Post where it has been added",
  "chat:write.public": "Post in any public channel",
  "channels:history": "Messages in public channels it is in",
  "groups:history": "Messages in private channels it is in",
  "im:history": "Its direct messages",
  "mpim:history": "Group messages it is in",
  "channels:read": "Public channels, and who joins them",
  "groups:read": "Private channels it is in, and who joins them",
  "reactions:read": "Reactions",
  "pins:read": "Pins",
  "users:read": "People joining, and changes to profiles",
};
const POST_SCOPES: readonly AppScope[] = ["chat:write", "chat:write.public"];
const READ_SCOPES = APP_SCOPES.filter((scope) => !POST_SCOPES.includes(scope));

/** What a list of scopes comes to, short enough for a closed disclosure. */
export function scopeSummary(scopes: readonly AppScope[]): string {
  const posts = scopes.includes("chat:write.public")
    ? "posts in any public channel"
    : scopes.includes("chat:write")
      ? "posts where it has been added"
      : "cannot post";
  const reads = READ_SCOPES.filter((scope) => scopes.includes(scope)).length;
  return `${posts}, ${reads === 0 ? "is sent no events" : `is sent ${reads} of ${READ_SCOPES.length} kinds of event`}`;
}

/**
 * What an app may do (E18c), by Slack's scope names beside plain words: an
 * app's own instructions name the scopes it needs, and an administrator
 * decides in words. Posting is a method; the rest decide which events reach
 * its subscriptions.
 */
export function ScopePicker(props: {
  scopes: readonly AppScope[];
  onChange: (scopes: AppScope[]) => void;
  disabled?: boolean;
}) {
  const toggle = (scope: AppScope, on: boolean) =>
    props.onChange(APP_SCOPES.filter((s) => (s === scope ? on : props.scopes.includes(s))));
  const group = (title: string, scopes: readonly AppScope[]) => (
    <fieldset className="min-w-0">
      <legend className="mb-0.5 text-[11px] font-medium text-ink-faint">{title}</legend>
      <div className="grid gap-x-3 sm:grid-cols-2">
        {scopes.map((scope) => (
          <label
            key={scope}
            className="flex cursor-pointer items-start gap-2 rounded py-0.5 text-[12px] text-ink-dim has-[:disabled]:cursor-default has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-copper"
          >
            <input
              type="checkbox"
              checked={props.scopes.includes(scope)}
              disabled={props.disabled}
              onChange={(e) => toggle(scope, e.target.checked)}
              className="mt-0.5 size-3.5 shrink-0 accent-[var(--color-copper)]"
            />
            <span className="min-w-0">
              {SCOPE_WORDS[scope]}{" "}
              <code className="font-mono text-[10px] text-ink-faint">{scope}</code>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
  return (
    <div className="space-y-1.5">
      {group("Post", POST_SCOPES)}
      {group("Be sent events about", READ_SCOPES)}
    </div>
  );
}

/**
 * An app's scopes, saved as they are ticked. Its tokens hold the new list
 * from their next call. A change that does not go through is taken back on
 * screen, so what is ticked is what the server holds.
 */
export function AppScopes({ app, onChanged }: { app: AppDetail; onChanged: () => void }) {
  const client = useClient();
  const [shown, setShown] = useState<AppScope[]>(app.scopes);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(0);
  // A list loaded again, or changed from a subscription's Allow, wins.
  useEffect(() => setShown(app.scopes), [app.scopes]);

  async function change(next: AppScope[]) {
    const before = shown;
    setShown(next);
    setError(null);
    const attempt = ++saving.current;
    const failed = await client.apps.setScopes(app.id, next);
    if (!failed) onChanged();
    else if (attempt === saving.current) {
      setShown(before);
      setError(failureText("Could not change what it may do.", failed, "Try again."));
    }
  }

  const summary = scopeSummary(shown);
  return (
    <>
      {/* Closed to one line, so a list of apps stays a list. */}
      <details className="group rounded-lg border border-edge">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-[12px] text-ink-dim hover:text-ink">
          <Icon
            name="chevronDown"
            size={12}
            className="shrink-0 transition-transform group-open:rotate-180"
          />
          <span className="min-w-0">{summary.charAt(0).toUpperCase() + summary.slice(1)}</span>
        </summary>
        <div className="border-t border-edge px-2.5 py-2">
          <ScopePicker scopes={shown} onChange={(next) => void change(next)} />
        </div>
      </details>
      {error && (
        <p role="alert" className="mt-1 text-[11px] text-alert">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * The scopes a subscription's events need that its app has not been given.
 * Those events are not sent, which an administrator should not have to find
 * out from a quiet endpoint.
 */
export function missingScopes(app: AppDetail, sub: EventSubscription): AppScope[] {
  const types = sub.eventTypes.length > 0 ? sub.eventTypes : APP_EVENT_TYPES;
  const needed = new Set(types.flatMap((type) => eventScopes(type)));
  return APP_SCOPES.filter((scope) => needed.has(scope) && !app.scopes.includes(scope));
}
