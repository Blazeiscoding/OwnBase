import { useEffect, useId, useRef, useState } from "react";
import { EMAIL_MAX, PASSWORD_MAX, PASSWORD_MIN, isEmailAddress } from "@ownbase/protocol";
import { Api, ApiError } from "@ownbase/client-core";
import { buttonClass } from "../components/Button.js";
import { inputClass, TextField } from "../components/TextField.js";
import { Swap } from "../components/Motion.js";
import { emailLinkError } from "../lib/emailLinks.js";

const labelCls = "mb-1.5 block text-[13px] font-medium text-ink-dim";
const hintCls = "mt-1.5 text-xs text-ink-faint";
const headingCls = "text-base font-semibold text-ink";
const submitCls = buttonClass("primary", "h-10 w-full rounded-xl");
const quietCls =
  "w-full text-center text-[13px] text-ink-dim underline-offset-2 transition-colors hover:text-ink hover:underline";
const noteCls = "mb-4 rounded-xl border border-edge bg-ink/[0.04] px-3.5 py-3 text-sm text-ink-dim";

/**
 * "Forgot password" on the sign-in card (G10), where the workspace sends
 * email: an address, and then the same answer whether or not an account
 * here uses it, since the server says nothing either way.
 */
export function ForgotPasswordForm(props: { url: string; onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const typed = email.trim();
    if (!isEmailAddress(typed)) {
      setError("Enter the email address on your account, such as maya@example.com.");
      field.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await new Api(props.url).forgotPassword(typed);
      if (alive.current) setSentTo(typed);
    } catch (err) {
      if (!alive.current) return;
      setError(emailLinkError(err));
      field.current?.focus();
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  if (sentTo)
    return (
      <>
        <p role="status" className={noteCls}>
          If an account here uses {sentTo}, a link to set a new password is on its way to it. The
          link works for 30 minutes. If nothing arrives, check your spam folder, or ask an admin of
          the workspace to reset your password.
        </p>
        <button
          type="button"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- this step replaces the form, and its one button takes focus in its place
          autoFocus
          className={submitCls}
          onClick={props.onBack}
        >
          Back to sign in
        </button>
      </>
    );

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
      <h2 className={headingCls}>Reset your password</h2>
      <p className="text-sm text-ink-dim">
        If you added an email address in Account settings, enter it and a link to set a new password
        goes to it. If you didn't, ask an admin of this workspace to reset it.
      </p>
      <TextField
        ref={field}
        size="large"
        label="Email address"
        // eslint-disable-next-line jsx-a11y/no-autofocus -- this step replaces the sign-in form, and its field takes focus in its place
        autoFocus
        type="email"
        autoComplete="email"
        spellCheck={false}
        autoCapitalize="none"
        maxLength={EMAIL_MAX}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={error}
      />
      <button type="submit" disabled={busy} className={submitCls}>
        <Swap text>{busy ? "Sending…" : "Send link"}</Swap>
      </button>
      <button type="button" disabled={busy} onClick={props.onBack} className={quietCls}>
        Back to sign in
      </button>
    </form>
  );
}

/**
 * Choosing a new password from a mailed link (G10). The link works once; once
 * it is used, every device of the account is signed out and the person signs
 * in with the new password, two-step sign-in included. The link is checked as
 * the page opens, so one already used or too old says so before anyone types.
 */
export function NewPasswordForm(props: {
  url: string;
  token: string;
  onDone: (handle: string) => void;
  onBack: () => void;
  onForgot: () => void;
}) {
  const id = useId();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Undefined while the link is checked; true once it is known not to work. */
  const [gone, setGone] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    new Api(props.url).checkResetLink(props.token).then(
      () => alive.current && setGone(false),
      (err: unknown) =>
        // Only a server that says so: one that cannot be reached is told again on Set.
        alive.current && setGone(err instanceof ApiError && err.code === "email_link_gone"),
    );
    return () => {
      alive.current = false;
    };
  }, [props.url, props.token]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password.length < PASSWORD_MIN) {
      setError(`Use at least ${PASSWORD_MIN} characters.`);
      document.getElementById(`${id}-new`)?.focus();
      return;
    }
    if (password !== confirm) {
      setError("Those two do not match.");
      document.getElementById(`${id}-confirm`)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { handle } = await new Api(props.url).resetPasswordWithLink(props.token, password);
      if (alive.current) props.onDone(handle);
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiError && err.code === "email_link_gone") setGone(true);
      setError(emailLinkError(err));
      setBusy(false);
    }
  }

  if (gone === undefined)
    return (
      <p role="status" className="py-6 text-center text-sm text-ink-dim">
        Checking your link…
      </p>
    );

  if (gone)
    return (
      <div className="space-y-4">
        <p role="alert" className={noteCls}>
          This link was already used or is more than 30 minutes old. Send yourself a new one.
        </p>
        <button
          type="button"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- this step replaces the form, and its first button takes focus in its place
          autoFocus
          className={submitCls}
          onClick={props.onForgot}
        >
          Send a new link
        </button>
        <button
          type="button"
          className={buttonClass("secondary", "h-10 w-full rounded-xl")}
          onClick={props.onBack}
        >
          Back to sign in
        </button>
      </div>
    );

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
      <h2 className={headingCls}>Choose a new password</h2>
      <p className="text-sm text-ink-dim">Every device signed in to your account is signed out.</p>
      <div>
        <label className={labelCls} htmlFor={`${id}-new`}>
          New password
        </label>
        <input
          id={`${id}-new`}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- this form replaces the sign-in form, and its field takes focus in its place
          autoFocus
          type="password"
          autoComplete="new-password"
          maxLength={PASSWORD_MAX}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-describedby={`${id}-new-hint`}
          className={inputClass("large")}
        />
        <p id={`${id}-new-hint`} className={hintCls}>
          At least 8 characters.
        </p>
      </div>
      <div>
        <label className={labelCls} htmlFor={`${id}-confirm`}>
          Confirm new password
        </label>
        <input
          id={`${id}-confirm`}
          type="password"
          autoComplete="new-password"
          maxLength={PASSWORD_MAX}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={inputClass("large")}
        />
      </div>
      {error && (
        <p role="alert" className="animate-text-in text-sm text-alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy} className={submitCls}>
        <Swap text>{busy ? "Saving…" : "Set new password"}</Swap>
      </button>
    </form>
  );
}
