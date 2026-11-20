import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import type { ServerInfo, SignInMethod } from "@ownbase/protocol";
import { Api, ApiError } from "@ownbase/client-core";
import type { Platform, SavedServer } from "../platform.js";
import { Icon } from "../components/Icon.js";
import { host } from "../lib/connection.js";
import { useWorkspaceIconUrl } from "../lib/workspaceIcon.js";
import { WorkspaceIcon } from "../components/WorkspaceIcon.js";
import { buttonClass } from "../components/Button.js";
import { inputClass } from "../components/TextField.js";
import { useTabs } from "../lib/useTabs.js";
import { Swap, useChanges } from "../components/Motion.js";
import { beginSingleSignOn, redeemSingleSignOn } from "../lib/singleSignOn.js";
import type { SignedOutFrom } from "../lib/signOut.js";

/** How a sign-in came about, where it matters to what opens next. */
export interface Connected {
  /** This account was just created as the workspace's first, so its owner. */
  founded?: boolean;
}

/** What the sign-in form says when the workspace ended the sign-in it replaces. */
export function endedNote(ended: SignedOutFrom): string {
  const name = ended.workspaceName || host(ended.url);
  return ended.handle.startsWith("guest-")
    ? `Your guest visit to ${name} has ended. Join again to carry on.`
    : `You were signed out of ${name}, perhaps from another device. Sign in again to carry on. Your drafts are kept.`;
}

export function AuthCard(props: {
  url: string;
  info: ServerInfo;
  savedHandle?: string;
  /** Why this form is back: the workspace ended the sign-in before it. */
  endedNote?: string;
  presetInviteCode?: string;
  presetClaimCode?: string;
  presetSsoCode?: string;
  platform: Pick<Platform, "kind">;
  onBack: () => void;
  onConnected: (server: SavedServer, how?: Connected) => void;
}) {
  const hasUsers = props.info.userCount > 0;
  const isFirstUser = !hasUsers;
  // Anyone may see it before signing in, as they see the workspace's name.
  const icon = useWorkspaceIconUrl(props.url, props.info.iconVersion);
  const guestAllowed = hasUsers && props.info.accessPolicy === "guest_allowed";
  const modes = guestAllowed ? GUEST_MODES : MODES;
  // An empty workspace has nothing to sign in to, even if we remember a handle
  // here, and someone arriving with an invite has no account to sign in with.
  // Where guests are welcome, joining as one comes first, unless this device
  // remembers an account here.
  const [mode, setMode] = useState<Mode>(
    isFirstUser || props.presetInviteCode
      ? "register"
      : guestAllowed && !(props.savedHandle && !props.savedHandle.startsWith("guest-"))
        ? "guest"
        : "login",
  );
  const [handle, setHandle] = useState(props.savedHandle ?? "");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState(props.presetInviteCode ?? "");
  // A claim link brings its code: kept for an empty workspace only, where
  // it is asked for, and shown so the person sees what they are using.
  const [claimCode, setClaimCode] = useState(isFirstUser ? (props.presetClaimCode ?? "") : "");
  const [requiresClaim, setRequiresClaim] = useState(!!props.info.requiresClaim);
  // An admin can make the workspace invite-only while this page is open: the
  // refusal then brings the code's field, which the page did not show.
  const [requiresInvite, setRequiresInvite] = useState(!!props.info.requiresInvite);
  const [error, setError] = useState<string | null>(null);
  // A form that was refused shakes its head. Each new refusal shakes it again:
  // one that replaces another takes the twin animation, which starts afresh.
  const refusals = useChanges(error);
  const shake = error ? (refusals % 2 ? "animate-shake" : "animate-shake-again") : "";
  const [busy, setBusy] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);
  /**
   * Which attempt is current. An answer to an older one, or one that comes
   * after the card is gone, is not acted on: going back or leaving means the
   * person no longer wants it.
   */
  const attempt = useRef(0);
  useEffect(
    () => () => {
      attempt.current = -1;
    },
    [],
  );
  /**
   * Set when the password just used was issued by someone else — an admin
   * reset, or host recovery. The workspace is closed to this account until it
   * chooses its own, so the card asks for one instead of going in.
   */
  const [mustReplace, setMustReplace] = useState<{ token: string; current: string } | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  /**
   * Set when the password was right for an account with two-step sign-in
   * (E11): the card asks for a code from its authenticator app, or one of its
   * recovery codes, before going in.
   */
  const [secondStep, setSecondStep] = useState<{ challenge: string } | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [answer, setAnswer] = useState("");
  /** Signed in with a recovery code: how many are left is said before going in. */
  const [recoveryNote, setRecoveryNote] = useState<{ server: SavedServer; left: number } | null>(
    null,
  );
  const id = useId();
  const { platform } = props;
  // Ways in besides a password (P9), and whether passwords are the owner's alone.
  const ssoMethods = hasUsers ? (props.info.signIn?.methods ?? []) : [];
  const ownerPasswordsOnly = props.info.signIn?.passwords === "owner_only";
  /** The desktop app sent the person to their browser to sign in there. */
  const [ssoAway, setSsoAway] = useState(false);

  // A remembered username leaves only the password to type.
  const focusFirst = useEffectEvent(() => {
    const password = mode === "login" && handle ? document.getElementById(`${id}-password`) : null;
    (password ?? firstField.current)?.focus();
  });
  useEffect(() => focusFirst(), []);

  // Back from single sign-on with a code: it signs in with the secret this
  // device began with, so a code someone else passed on signs nobody in.
  const signedInWith = useEffectEvent((url: string, token: string, handle: string) =>
    props.onConnected({
      url,
      token,
      workspaceName: props.info.workspaceName,
      handle,
      lastUsedAt: Date.now(),
    }),
  );
  useEffect(() => {
    const code = props.presetSsoCode;
    if (!code) return;
    let gone = false;
    setBusy(true);
    redeemSingleSignOn(props.url, code).then(
      (result) => {
        if (!gone) signedInWith(props.url, result.token, result.user.handle);
      },
      (err: unknown) => {
        if (gone) return;
        // Its own failures are written for people; anything else is said here.
        setError(
          err instanceof ApiError || !(err instanceof Error) || !err.message
            ? errorMessage(err, "login")
            : err.message,
        );
        setBusy(false);
      },
    );
    return () => {
      gone = true;
    };
  }, [props.presetSsoCode, props.url]);

  async function signInWith(method: SignInMethod) {
    setError(null);
    try {
      await beginSingleSignOn(platform, props.url, method);
      if (platform.kind === "desktop") setSsoAway(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  const tabs = useTabs({
    label: "Account",
    tabs: modes,
    selected: mode,
    onSelect(next, how) {
      setMode(next);
      // A click is a choice of form, so the cursor goes to its first field,
      // which both forms share. The arrow keys leave focus on the tabs, as in
      // any tab list.
      if (how === "click") firstField.current?.focus();
    },
  });

  /**
   * What is missing or malformed, said before asking the server, with focus
   * on the field to fix. The button stays enabled: one that silently refuses
   * gives no reason, and a keyboard cannot even reach it.
   */
  function problem(): { text: string; field: "name" | "handle" | "password" } | null {
    if (mode === "guest")
      return displayName.trim()
        ? null
        : { text: "Enter the name everyone will see.", field: "name" };
    const name = handle.trim().toLowerCase();
    if (!name)
      return {
        text: mode === "login" ? "Enter your username." : "Choose a username.",
        field: "handle",
      };
    if (mode === "register" && !/^[a-z0-9][a-z0-9._-]{1,31}$/.test(name))
      return {
        text: "Usernames are 2 to 32 lowercase letters or numbers, and may use . _ or -.",
        field: "handle",
      };
    if (!password) return { text: "Enter your password.", field: "password" };
    if (mode === "register" && password.length < 8)
      return { text: "Use at least 8 characters for your password.", field: "password" };
    return null;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const missing = problem();
    if (missing) {
      setError(missing.text);
      document
        .getElementById(`${id}-${missing.field === "name" ? "guest-name" : missing.field}`)
        ?.focus();
      return;
    }
    setBusy(true);
    const api = new Api(props.url);
    const ticket = ++attempt.current;
    try {
      const result =
        mode === "guest"
          ? await api.joinAsGuest(displayName.trim())
          : mode === "login"
            ? await api.login({ handle: handle.trim().toLowerCase(), password })
            : await api.register({
                handle: handle.trim().toLowerCase(),
                displayName: displayName.trim() || handle.trim(),
                password,
                ...(inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}),
                ...(claimCode.trim() ? { claimCode: claimCode.trim() } : {}),
              });
      if (ticket !== attempt.current) return;
      if ("twoStep" in result) {
        setSecondStep({ challenge: result.twoStep.challenge });
        setUseRecovery(false);
        setAnswer("");
        setBusy(false);
        return;
      }
      if ("mustChangePassword" in result && result.mustChangePassword) {
        setMustReplace({ token: result.token, current: password });
        setBusy(false);
        return;
      }
      props.onConnected(
        {
          url: props.url,
          token: result.token,
          workspaceName: props.info.workspaceName,
          handle: result.user.handle,
          lastUsedAt: Date.now(),
        },
        // The first account owns the workspace: it was made just now (UX-42).
        { founded: mode === "register" && result.user.role === "owner" },
      );
    } catch (err) {
      if (ticket !== attempt.current) return;
      if (err instanceof ApiError && err.code === "claim_required") setRequiresClaim(true);
      if (err instanceof ApiError && err.code === "invite_required") setRequiresInvite(true);
      setError(errorMessage(err, mode, { inviteCode: !!inviteCode.trim() }));
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!secondStep) return;
    setError(null);
    const typed = answer.trim();
    if (!typed) {
      setError(
        useRecovery ? "Enter one of your recovery codes." : "Enter the code your app shows.",
      );
      document.getElementById(`${id}-answer`)?.focus();
      return;
    }
    setBusy(true);
    const ticket = ++attempt.current;
    try {
      const result = await new Api(props.url).signInSecondStep({
        challenge: secondStep.challenge,
        ...(useRecovery ? { recoveryCode: typed } : { code: typed }),
      });
      if (ticket !== attempt.current) return;
      setSecondStep(null);
      if (result.mustChangePassword) {
        setMustReplace({ token: result.token, current: password });
        setBusy(false);
        return;
      }
      const server: SavedServer = {
        url: props.url,
        token: result.token,
        workspaceName: props.info.workspaceName,
        handle: result.user.handle,
        lastUsedAt: Date.now(),
      };
      if (useRecovery) {
        setRecoveryNote({ server, left: result.recoveryCodesLeft });
        setBusy(false);
        return;
      }
      props.onConnected(server);
    } catch (err) {
      if (ticket !== attempt.current) return;
      // Too long, or too many wrong codes: back to the password, which is asked again.
      if (err instanceof ApiError && err.code === "two_step_expired") {
        setSecondStep(null);
        setPassword("");
      }
      setError(errorMessage(err, "login"));
      setBusy(false);
    }
  }

  async function replacePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!mustReplace) return;
    setError(null);
    if (newPassword.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Those two do not match.");
      return;
    }
    if (newPassword === mustReplace.current) {
      setError("Choose something other than the password you were given.");
      return;
    }
    setBusy(true);
    const ticket = ++attempt.current;
    try {
      const api = new Api(props.url, mustReplace.token);
      await api.changePassword(mustReplace.current, newPassword);
      if (ticket !== attempt.current) return;
      props.onConnected({
        url: props.url,
        token: mustReplace.token,
        workspaceName: props.info.workspaceName,
        handle: handle.trim().toLowerCase(),
        lastUsedAt: Date.now(),
      });
    } catch (err) {
      if (ticket !== attempt.current) return;
      setError(errorMessage(err, "login"));
      setBusy(false);
    }
  }

  const fieldCls = inputClass("large");
  const labelCls = "mb-1.5 block text-[13px] font-medium text-ink-dim";
  const hintCls = "mt-1.5 text-xs text-ink-faint";
  const submitCls = buttonClass("primary", "h-10 w-full rounded-xl");

  return (
    <div className="card-warm sign-in-card overflow-hidden rounded-3xl p-6 sm:p-7">
      <div className="mb-6 flex flex-col items-center text-center">
        <WorkspaceIcon
          name={props.info.workspaceName}
          src={icon}
          size={56}
          className="rounded-2xl text-xl shadow-[0_8px_20px_-12px_rgb(0_0_0/0.5)]"
        />
        <h1 className="mt-4 font-brand text-2xl font-semibold tracking-tight">
          {props.info.workspaceName}
        </h1>
        <p className="mt-1 text-[13px] text-ink-faint">
          <span className="font-mono text-[12px]">{props.url.replace(/^https?:\/\//, "")}</span> ·{" "}
          {props.info.userCount === 0
            ? "No members yet"
            : `${props.info.userCount} ${props.info.userCount === 1 ? "member" : "members"}`}
        </p>
      </div>

      {mustReplace ? (
        <>
          <p className="mb-4 rounded-xl border border-edge bg-ink/[0.04] px-3.5 py-3 text-sm text-ink-dim">
            Someone else set that password for you. Choose your own to finish signing in. The
            workspace stays closed until you do.
          </p>
          <form onSubmit={(e) => void replacePassword(e)} className={`space-y-4 ${shake}`}>
            <div>
              <label className={labelCls} htmlFor={`${id}-new-password`}>
                New password
              </label>
              <input
                id={`${id}-new-password`}
                // eslint-disable-next-line jsx-a11y/no-autofocus -- this step replaces the sign-in form, and its field takes focus in its place
                autoFocus
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                aria-describedby={`${id}-new-password-hint`}
                className={fieldCls}
              />
              <p id={`${id}-new-password-hint`} className={hintCls}>
                At least 8 characters.
              </p>
            </div>
            <div>
              <label className={labelCls} htmlFor={`${id}-confirm-password`}>
                Confirm new password
              </label>
              <input
                id={`${id}-confirm-password`}
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={fieldCls}
              />
            </div>
            {error && (
              <p role="alert" className="animate-text-in text-sm text-alert">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy} className={submitCls}>
              <Swap text>{busy ? "Saving…" : "Set password and continue"}</Swap>
            </button>
          </form>
        </>
      ) : recoveryNote ? (
        <>
          <p
            role="status"
            className="mb-4 rounded-xl border border-edge bg-ink/[0.04] px-3.5 py-3 text-sm text-ink-dim"
          >
            You signed in with a recovery code.{" "}
            {recoveryNote.left === 0
              ? "It was your last one."
              : `You have ${recoveryNote.left} left, and each works once.`}{" "}
            If your phone is gone, make new codes or set up your authenticator app again in Account
            settings, under Security.
          </p>
          <button
            type="button"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- this step replaces the sign-in form, and its one button takes focus in its place
            autoFocus
            className={submitCls}
            onClick={() => props.onConnected(recoveryNote.server)}
          >
            Continue
          </button>
        </>
      ) : secondStep ? (
        <>
          <p className="mb-4 rounded-xl border border-edge bg-ink/[0.04] px-3.5 py-3 text-sm text-ink-dim">
            {useRecovery
              ? "Enter one of the recovery codes you saved when you set up two-step sign-in."
              : "This account has two-step sign-in. Enter the 6-digit code your authenticator app shows."}
          </p>
          <form onSubmit={(e) => void verify(e)} noValidate className={`space-y-4 ${shake}`}>
            <div>
              <label className={labelCls} htmlFor={`${id}-answer`}>
                {useRecovery ? "Recovery code" : "Code"}
              </label>
              <input
                id={`${id}-answer`}
                key={useRecovery ? "recovery" : "code"}
                // eslint-disable-next-line jsx-a11y/no-autofocus -- this step replaces the sign-in form, and its field takes focus in its place
                autoFocus
                inputMode={useRecovery ? "text" : "numeric"}
                autoComplete={useRecovery ? "off" : "one-time-code"}
                spellCheck={false}
                autoCapitalize="none"
                maxLength={useRecovery ? 32 : 16}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                className={`${fieldCls} font-mono tracking-widest`}
              />
            </div>
            {error && (
              <p role="alert" className="animate-text-in text-sm text-alert">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy} className={submitCls}>
              <Swap text>{busy ? "Checking…" : "Sign in"}</Swap>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setUseRecovery((value) => !value);
                setAnswer("");
                setError(null);
              }}
              className="w-full text-center text-[13px] text-ink-dim underline-offset-2 transition-colors hover:text-ink hover:underline"
            >
              {useRecovery ? "Use a code from your app instead" : "Use a recovery code instead"}
            </button>
          </form>
        </>
      ) : (
        <>
          {props.endedNote && !isFirstUser && (
            <p
              role="status"
              className="mb-5 flex items-start gap-2.5 rounded-xl border border-edge bg-ink/[0.04] px-3.5 py-3 text-sm text-ink-dim"
            >
              <Icon name="info" size={16} className="mt-0.5 shrink-0 text-ink-faint" />
              <span>{props.endedNote}</span>
            </p>
          )}
          {isFirstUser && (
            <p className="mb-5 flex items-start gap-2.5 rounded-xl border border-edge bg-ink/[0.04] px-3.5 py-3 text-sm text-ink-dim">
              <Icon name="info" size={16} className="mt-0.5 shrink-0 text-ink-faint" />
              <span>This workspace is brand new. The first account becomes its owner.</span>
            </p>
          )}

          {ssoMethods.length > 0 && (
            <div className="mb-5">
              <div className="space-y-2">
                {ssoMethods.map((method) => (
                  <button
                    key={method.id}
                    type="button"
                    disabled={busy}
                    className={buttonClass("secondary", "h-10 w-full rounded-xl")}
                    onClick={() => void signInWith(method)}
                  >
                    <Icon name="lock" size={14} />
                    Sign in with {method.name}
                  </button>
                ))}
              </div>
              {(ssoAway || (props.presetSsoCode && busy)) && (
                <p role="status" className="mt-2 text-[13px] text-ink-dim">
                  {props.presetSsoCode && busy
                    ? "Signing you in…"
                    : "Finish signing in in your browser. OwnBase opens again when you are done."}
                </p>
              )}
              {ownerPasswordsOnly && (
                <p className="mt-2 text-[13px] text-ink-faint">
                  Passwords here sign in only the workspace's owner.
                </p>
              )}
              <div
                aria-hidden="true"
                className="mt-5 flex items-center gap-3 text-[12px] text-ink-faint"
              >
                <span className="h-px flex-1 bg-edge" />
                or
                <span className="h-px flex-1 bg-edge" />
              </div>
            </div>
          )}

          {hasUsers && (
            <div
              {...tabs.listProps}
              className="relative mb-5 flex gap-1 rounded-xl border border-edge bg-ground p-1"
            >
              {/* One thumb that slides to the chosen form, rather than one that blinks across. */}
              <span
                aria-hidden="true"
                className="segment-thumb"
                style={
                  {
                    "--segments": modes.length,
                    "--segment": Math.max(0, (modes as readonly Mode[]).indexOf(mode)),
                  } as React.CSSProperties
                }
              />
              {modes.map((m) => (
                <button
                  key={m}
                  {...tabs.tabProps(m)}
                  className={`relative flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                    mode === m ? "text-ink" : "text-ink-faint hover:text-ink"
                  }`}
                >
                  {MODE_LABELS[m]}
                </button>
              ))}
            </div>
          )}

          <div {...(hasUsers ? tabs.panelProps : {})}>
            {mode === "guest" ? (
              <form onSubmit={(e) => void submit(e)} noValidate className={`space-y-4 ${shake}`}>
                <div>
                  <label className={labelCls} htmlFor={`${id}-guest-name`}>
                    Display name
                  </label>
                  <input
                    id={`${id}-guest-name`}
                    ref={firstField}
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    autoComplete="nickname"
                    maxLength={80}
                    aria-describedby={`${id}-guest-name-hint`}
                    className={fieldCls}
                  />
                  <p id={`${id}-guest-name-hint`} className={hintCls}>
                    What everyone sees. As a guest you can read and post in public channels for a
                    day. Creating an account is optional.
                  </p>
                </div>
                {error && (
                  <p role="alert" className="animate-text-in text-sm text-alert">
                    {error}
                  </p>
                )}
                <button type="submit" disabled={busy} className={submitCls}>
                  <Swap text>{busy ? "Joining…" : "Join as guest"}</Swap>
                </button>
              </form>
            ) : (
              <form onSubmit={(e) => void submit(e)} noValidate className={`space-y-4 ${shake}`}>
                <div>
                  <label className={labelCls} htmlFor={`${id}-handle`}>
                    Username
                  </label>
                  <input
                    id={`${id}-handle`}
                    ref={firstField}
                    value={handle}
                    onChange={(e) => setHandle(e.target.value)}
                    autoComplete="username"
                    spellCheck={false}
                    autoCapitalize="none"
                    aria-describedby={mode === "register" ? `${id}-handle-hint` : undefined}
                    className={fieldCls}
                  />
                  {mode === "register" && (
                    <p id={`${id}-handle-hint`} className={hintCls}>
                      Lowercase letters and numbers, such as maya or sam.r
                    </p>
                  )}
                </div>
                {mode === "register" && (
                  <div>
                    <label className={labelCls} htmlFor={`${id}-display-name`}>
                      Display name
                    </label>
                    <input
                      id={`${id}-display-name`}
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      autoComplete="nickname"
                      aria-describedby={`${id}-display-name-hint`}
                      className={fieldCls}
                    />
                    <p id={`${id}-display-name-hint`} className={hintCls}>
                      What everyone sees. Left empty, it is your username.
                    </p>
                  </div>
                )}
                <div>
                  <label className={labelCls} htmlFor={`${id}-password`}>
                    Password
                  </label>
                  <input
                    id={`${id}-password`}
                    type="password"
                    autoComplete={mode === "register" ? "new-password" : "current-password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-describedby={mode === "register" ? `${id}-password-hint` : undefined}
                    className={fieldCls}
                  />
                  {mode === "register" && (
                    <p id={`${id}-password-hint`} className={hintCls}>
                      At least 8 characters.
                    </p>
                  )}
                </div>
                {mode === "register" && !isFirstUser && requiresInvite && (
                  <div>
                    <label className={labelCls} htmlFor={`${id}-invite-code`}>
                      Invite code
                    </label>
                    <input
                      id={`${id}-invite-code`}
                      value={inviteCode}
                      onChange={(e) => setInviteCode(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      aria-describedby={`${id}-invite-code-hint`}
                      className={`${fieldCls} font-mono`}
                    />
                    <p id={`${id}-invite-code-hint`} className={hintCls}>
                      Whoever invited you has it. You need one to create an account here.
                    </p>
                  </div>
                )}
                {mode === "register" && requiresClaim && (
                  <div>
                    <label className={labelCls} htmlFor="workspace-claim-code">
                      Workspace claim code
                    </label>
                    <input
                      id="workspace-claim-code"
                      type="password"
                      autoComplete="off"
                      value={claimCode}
                      onChange={(e) => setClaimCode(e.target.value)}
                      placeholder="Claim code from the host"
                      aria-describedby="workspace-claim-help"
                      spellCheck={false}
                      className={`${fieldCls} font-mono`}
                    />
                    <p id="workspace-claim-help" className="mt-1 text-xs text-ink-dim">
                      {props.presetClaimCode && claimCode === props.presetClaimCode
                        ? "Filled in from your link. It makes this account the workspace's owner."
                        : "The person who started this workspace was shown a claim code. Enter it here to become the owner."}
                    </p>
                  </div>
                )}
                {error && (
                  <p role="alert" className="animate-text-in text-sm text-alert">
                    {error}
                  </p>
                )}
                <button type="submit" disabled={busy} className={submitCls}>
                  <Swap text>
                    {busy
                      ? "Connecting…"
                      : mode === "login"
                        ? "Sign in"
                        : // Nobody to join yet: the first account sets it up.
                          isFirstUser
                          ? "Create workspace"
                          : "Join workspace"}
                  </Swap>
                </button>
              </form>
            )}
          </div>
        </>
      )}
      {/* Clerk's footer band, out to the card's edges: the way back, and where what you write is kept. */}
      <div className="-mx-6 -mb-6 mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-[var(--card-edge)] bg-ink/[0.03] px-6 py-3.5 sm:-mx-7 sm:-mb-7 sm:px-7">
        <button
          onClick={props.onBack}
          className="flex items-center gap-1.5 text-[13px] text-ink-dim transition-colors hover:text-ink"
        >
          <Icon name="arrow" size={13} style={{ transform: "rotate(180deg)" }} />
          All workspaces
        </button>
        <span className="flex items-center gap-1.5 text-[12px] text-ink-faint">
          <Icon name="lock" size={12} />
          Messages and files stay on this server
        </span>
      </div>
    </div>
  );
}

const MODES = ["login", "register"] as const;
const GUEST_MODES = ["guest", "login", "register"] as const;
type Mode = (typeof GUEST_MODES)[number];
const MODE_LABELS: Record<Mode, string> = {
  guest: "Join as guest",
  login: "Sign in",
  register: "Create account",
};

function errorMessage(err: unknown, mode: Mode, sent: { inviteCode?: boolean } = {}): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "guest_access_off":
        return "This workspace no longer lets guests in. Sign in or create an account instead.";
      case "guests_full":
        return "Too many guests are here right now. Try again later, or create an account.";
      case "workspace_unclaimed":
        return "This workspace has no owner yet, so guests cannot join it.";
      case "invalid_credentials":
        return "Wrong username or password.";
      case "account_deactivated":
        return "This account is deactivated. Ask an admin of the workspace to reactivate it.";
      case "handle_taken":
        return "That username is taken. Did you mean to sign in?";
      case "invite_required":
        // A code that was good when the link was sent can be withdrawn, used
        // up or run out meanwhile; the server does not say which.
        return sent.inviteCode
          ? "That invite code no longer works. It may have been withdrawn, used up or run out. Ask whoever invited you for a new one."
          : "This workspace needs an invite code to join. Ask whoever invited you for one.";
      case "claim_required":
        return "Enter the workspace claim code shown on the host. The code you entered was not accepted.";
      case "sso_required":
        return mode === "register"
          ? "New accounts here are made through the workspace's single sign-on. Use its button above."
          : "This workspace signs people in with its single sign-on. Use its button above.";
      case "invalid_request":
        return mode === "guest"
          ? "Enter a display name of up to 80 characters."
          : mode === "register"
            ? "Usernames are lowercase letters and digits; passwords need 8+ characters."
            : "Check the username and password.";
      case "too_many_requests":
        return "Too many tries for now. Wait a minute, then try again.";
      default:
        break;
    }
    // The server answered, so it was reached: say what it said where it said something.
    if (err.message && err.message !== err.code) return err.message;
    if (err.status >= 500)
      return "The workspace's server ran into a problem. Try again in a moment, and tell whoever runs it if it keeps happening.";
    return "The workspace's server turned that down. Try again, or ask whoever runs it.";
  }
  // No answer came: the request failed on the way, or waited too long.
  if (err instanceof DOMException && err.name === "TimeoutError")
    return "The server took too long to answer. Check the address and your connection, then try again.";
  return "Could not reach the server. Check the address and try again.";
}
