import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError, selfMay } from "@ownbase/client-core";
import type { EmailAddressInfo } from "@ownbase/protocol";
import { useClient, useWorkspace } from "../context.js";
import { accountError } from "../lib/account.js";
import { inputCls } from "./TextField.js";
import { Swap } from "./Motion.js";
import { buttonClass } from "./Button.js";
import { useConfirm } from "./Confirm.js";

/**
 * The account's email address in Account settings, under Security (G10):
 * where a link to set a new password goes. Adding or changing it asks for the
 * password and mails a link, and the address counts once that is opened.
 * Nothing shows where the workspace sends no email, or for a guest.
 */
export function EmailSettings() {
  const client = useClient();
  const self = useWorkspace((s) => s.self);
  const confirm = useConfirm();
  const id = useId();
  /** Undefined until asked; null where the workspace sends no email. */
  const [status, setStatus] = useState<EmailAddressInfo | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  const field = useRef<HTMLInputElement>(null);
  // Guests have no password to set, so no address to get one back with.
  const owned = !!self && selfMay({ self }, "twoStep");

  const load = useCallback(async () => {
    const answer = await client.account.emailAddress();
    if (!alive.current) return;
    // A failed check shows nothing new, as where the workspace sends no email.
    // One that worked before is kept, and is asked again next time.
    if (answer instanceof ApiError) return;
    setStatus(answer);
  }, [client]);
  useEffect(() => {
    alive.current = true;
    if (owned) void load();
    return () => {
      alive.current = false;
    };
  }, [load, owned]);
  useEffect(() => {
    if (editing) field.current?.focus();
  }, [editing]);

  if (!owned || !status) return null;

  function open() {
    setEditing(true);
    setEmail("");
    setPassword("");
    setError(null);
    setNotice(null);
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const typed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed)) {
      setError("Enter an email address, such as maya@example.com.");
      field.current?.focus();
      return;
    }
    if (!password) {
      setError("Enter your current password.");
      document.getElementById(`${id}-password`)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const failed = await client.account.setEmailAddress(typed, password);
    if (!alive.current) return;
    setBusy(false);
    if (failed) {
      setError(accountError(failed));
      return;
    }
    setEditing(false);
    setNotice(`A link is on its way to ${typed}. Open it to confirm the address.`);
    void load();
  }

  async function remove() {
    const go = await confirm({
      title: "Remove your email address?",
      body: "If you forget your password, an admin of the workspace has to reset it for you.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!go) return;
    setError(null);
    const failed = await client.account.removeEmailAddress();
    if (!alive.current) return;
    if (failed) {
      setError(accountError(failed));
      return;
    }
    setNotice("Your email address is removed.");
    void load();
  }

  const titleId = `${id}-title`;
  return (
    <section aria-labelledby={titleId} className="mt-6 border-t border-edge pt-5">
      <h3 id={titleId} className="font-semibold">
        Email address
      </h3>
      <p className="mt-1 text-sm text-ink-dim">
        {status.email
          ? `${status.email}. If you forget your password, a link to set a new one goes here. Only you see it.`
          : "Add one so that, if you forget your password, a link to set a new one can go to it. Only you see it."}
      </p>
      {status.pending && !editing && (
        <p className="mt-3 text-sm text-ink-dim">
          Waiting for you to open the link sent to {status.pending}. It works for 24 hours.
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-online">
          {notice}
        </p>
      )}
      {error && !editing && (
        <p role="alert" className="mt-3 text-sm text-alert">
          {error}
        </p>
      )}

      {!editing && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={buttonClass("secondary")} onClick={open}>
            {status.email ? "Change address" : "Add email address"}
          </button>
          {status.email && (
            <button
              type="button"
              className={buttonClass("secondary")}
              onClick={() => void remove()}
            >
              Remove
            </button>
          )}
        </div>
      )}

      {editing && (
        <form noValidate onSubmit={(event) => void send(event)} className="mt-3 space-y-3">
          <label className="block text-sm" htmlFor={`${id}-email`}>
            New email address
          </label>
          <input
            id={`${id}-email`}
            ref={field}
            className={inputCls}
            type="email"
            autoComplete="email"
            spellCheck={false}
            autoCapitalize="none"
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            readOnly={busy}
          />
          <label className="block text-sm" htmlFor={`${id}-password`}>
            Current password
          </label>
          <input
            id={`${id}-password`}
            className={inputCls}
            type="password"
            autoComplete="current-password"
            maxLength={256}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            readOnly={busy}
          />
          {error && (
            <p role="alert" className="text-sm text-alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {/* Secondary: Security's one primary is Update password, above it. */}
            <button
              type="submit"
              className={buttonClass("secondary")}
              aria-disabled={busy || undefined}
            >
              <Swap text>{busy ? "Sending…" : "Send link"}</Swap>
            </button>
            <button
              type="button"
              className={buttonClass("secondary")}
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
