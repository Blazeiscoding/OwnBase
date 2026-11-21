import { useCallback, useEffect, useId, useRef, useState } from "react";
import { isEmailAddress } from "@ownbase/protocol";
import { ApiError, selfMay } from "@ownbase/client-core";
import type { EmailAddressInfo } from "@ownbase/protocol";
import { useClient, useWorkspace } from "../context.js";
import { accountError } from "../lib/account.js";
import { settingMark } from "../lib/accountSections.js";
import { onEmailConfirmed } from "../lib/emailLinks.js";
import { TextField } from "./TextField.js";
import { Swap } from "./Motion.js";
import { buttonClass } from "./Button.js";
import { useConfirm } from "./Confirm.js";

/** Which field a mistake is about; null for one about neither. */
type Mistake = { field: "email" | "password" | null; text: string };

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
  const [mistake, setMistake] = useState<Mistake | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  const emailField = useRef<HTMLInputElement>(null);
  const passwordField = useRef<HTMLInputElement>(null);
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
    if (!owned) return;
    void load();
    // The link is often opened in another tab, app or device: coming back to
    // this window, or confirming it in this one, shows what it did.
    const again = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    const stop = onEmailConfirmed(again);
    return () => {
      alive.current = false;
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
      stop();
    };
  }, [load, owned]);
  useEffect(() => {
    if (editing) emailField.current?.focus();
  }, [editing]);

  if (!owned || !status) return null;

  function open() {
    setEditing(true);
    setEmail("");
    setPassword("");
    setMistake(null);
    setNotice(null);
  }

  function wrong(field: Mistake["field"], text: string) {
    setMistake({ field, text });
    (field === "password" ? passwordField : emailField).current?.focus();
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const typed = email.trim();
    if (!isEmailAddress(typed))
      return wrong("email", "Enter an email address, such as maya@example.com.");
    if (!password) return wrong("password", "Enter your password.");
    setBusy(true);
    setMistake(null);
    const failed = await client.account.setEmailAddress(typed, password);
    if (!alive.current) return;
    setBusy(false);
    if (failed) {
      if (failed.code === "invalid_credentials") wrong("password", "That is not your password.");
      else wrong(null, accountError(failed));
      return;
    }
    setEditing(false);
    setNotice(`A link is on its way to ${typed}. Open it to confirm the address.`);
    void load();
  }

  async function resend(to: string) {
    if (busy) return;
    setBusy(true);
    setMistake(null);
    setNotice(null);
    const failed = await client.account.resendEmailLink();
    if (!alive.current) return;
    setBusy(false);
    if (failed) setMistake({ field: null, text: accountError(failed) });
    else setNotice(`A new link is on its way to ${to}. Open it within 24 hours.`);
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
    setMistake(null);
    const failed = await client.account.removeEmailAddress();
    if (!alive.current) return;
    if (failed) {
      setMistake({ field: null, text: accountError(failed) });
      return;
    }
    setNotice("Your email address is removed.");
    void load();
  }

  const titleId = `${id}-title`;
  const general = mistake && mistake.field === null ? mistake.text : null;
  const waiting = status.pending;
  return (
    <section
      {...settingMark("email")}
      aria-labelledby={titleId}
      className="mt-6 border-t border-edge pt-5"
    >
      <h3 id={titleId} className="font-semibold">
        Email address
      </h3>
      {(status.email || !waiting) && (
        <p className="mt-1 text-sm text-ink-dim">
          {status.email
            ? `${status.email}. If you forget your password, a link to set a new one goes here. Only you see it.`
            : "Add one so that, if you forget your password, a link to set a new one can go to it. Only you see it."}
        </p>
      )}
      {waiting && !editing && !notice && (
        <p className={`${status.email ? "mt-3" : "mt-1"} text-sm text-ink-dim`}>
          {waiting} isn't confirmed yet. Open the link sent to it within 24 hours.
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-ink-dim">
          {notice}
        </p>
      )}
      {general && (
        <p role="alert" className="mt-3 text-sm text-alert">
          {general}
        </p>
      )}

      {!editing && (
        <div className="mt-3 flex flex-wrap gap-2">
          {waiting ? (
            <>
              <button
                type="button"
                className={buttonClass("secondary")}
                aria-disabled={busy || undefined}
                onClick={() => void resend(waiting)}
              >
                <Swap text>{busy ? "Sending…" : "Send the link again"}</Swap>
              </button>
              <button type="button" className={buttonClass("secondary")} onClick={open}>
                Use a different address
              </button>
            </>
          ) : (
            <button type="button" className={buttonClass("secondary")} onClick={open}>
              {status.email ? "Change address" : "Add email address"}
            </button>
          )}
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
          <TextField
            ref={emailField}
            label="New email address"
            type="email"
            autoComplete="email"
            spellCheck={false}
            autoCapitalize="none"
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            readOnly={busy}
            error={mistake?.field === "email" ? mistake.text : undefined}
          />
          <TextField
            ref={passwordField}
            label="Your password"
            hint="To check it's you."
            type="password"
            autoComplete="current-password"
            maxLength={256}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            readOnly={busy}
            error={mistake?.field === "password" ? mistake.text : undefined}
          />
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
