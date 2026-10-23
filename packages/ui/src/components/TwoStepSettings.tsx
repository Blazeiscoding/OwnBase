import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import { accountError } from "../lib/account.js";
import { useCopy } from "../lib/useCopy.js";
import { inputCls } from "./TextField.js";
import { QrCode } from "./QrCode.js";
import { Swap } from "./Motion.js";
import { buttonClass } from "./Button.js";

/** What needs the password first, and what its button says. */
const PASSWORD_FOR = {
  setup: "Continue",
  codes: "Make new codes",
  off: "Turn off two-step sign-in",
} as const;

type Stage =
  | { step: "idle" }
  | { step: "password"; purpose: keyof typeof PASSWORD_FOR }
  | { step: "scan"; secret: string; uri: string }
  | { step: "codes"; codes: string[] };

/** Recovery codes this few or fewer are worth replacing before they run out. */
const FEW_CODES = 3;

/**
 * Two-step sign-in in Account settings, under Security (E11): set up with the
 * password, a QR code or key for an authenticator app and a first code from
 * it, then recovery codes shown once; and, once on, new codes or turning it
 * off, each with the password.
 */
export function TwoStepSettings() {
  const client = useClient();
  const self = useWorkspace((s) => s.self);
  const workspaceName = useWorkspace((s) => s.workspaceName);
  const id = useId();
  const [status, setStatus] = useState<{ enabled: boolean; recoveryCodesLeft: number } | null>(
    null,
  );
  const [loadError, setLoadError] = useState(false);
  const [stage, setStage] = useState<Stage>({ step: "idle" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  const field = useRef<HTMLInputElement>(null);
  const codesPanel = useRef<HTMLDivElement>(null);
  const clipboard = useCopy();
  // Guests have no password, and apps no settings, so neither has this.
  const owned = !!self && self.role !== "guest" && !self.isBot;

  const load = useCallback(async () => {
    try {
      const result = await client.api.twoStep();
      if (!alive.current) return;
      setStatus(result);
      setLoadError(false);
    } catch {
      if (alive.current) setLoadError(true);
    }
  }, [client]);
  useEffect(() => {
    alive.current = true;
    if (owned) void load();
    return () => {
      alive.current = false;
    };
  }, [load, owned]);
  // Each step's field takes the cursor as the step shows, and the codes their panel.
  useEffect(() => (field.current ?? codesPanel.current)?.focus(), [stage]);

  function go(next: Stage) {
    setStage(next);
    setPassword("");
    setCode("");
    setError(null);
    setNotice(null);
  }

  async function withPassword(event: React.FormEvent) {
    event.preventDefault();
    if (stage.step !== "password" || busy) return;
    if (!password) {
      setError("Enter your current password.");
      field.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (stage.purpose === "setup") {
        const { secret, uri } = await client.api.startTwoStep(password);
        if (alive.current) go({ step: "scan", secret, uri });
      } else if (stage.purpose === "codes") {
        const { recoveryCodes } = await client.api.newRecoveryCodes(password);
        if (!alive.current) return;
        go({ step: "codes", codes: recoveryCodes });
        setStatus({ enabled: true, recoveryCodesLeft: recoveryCodes.length });
      } else {
        await client.api.disableTwoStep(password);
        if (!alive.current) return;
        go({ step: "idle" });
        setStatus({ enabled: false, recoveryCodesLeft: 0 });
        setNotice("Two-step sign-in is off. Your password alone signs you in.");
      }
    } catch (err) {
      if (alive.current) {
        setError(accountError(err));
        field.current?.focus();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function turnOn(event: React.FormEvent) {
    event.preventDefault();
    if (stage.step !== "scan" || busy) return;
    if (!code.trim()) {
      setError("Enter the code your authenticator app shows.");
      field.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { recoveryCodes } = await client.api.enableTwoStep(code.trim());
      if (!alive.current) return;
      go({ step: "codes", codes: recoveryCodes });
      setStatus({ enabled: true, recoveryCodesLeft: recoveryCodes.length });
    } catch (err) {
      if (!alive.current) return;
      setError(accountError(err));
      // A setup that took too long starts again from the password, saying why.
      if (err instanceof ApiError && err.code === "two_step_setup_expired") {
        setStage({ step: "password", purpose: "setup" });
        setCode("");
      } else field.current?.focus();
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  if (!owned) return null;
  const titleId = `${id}-title`;
  const codesText = stage.step === "codes" ? stage.codes.join("\n") : "";

  return (
    <section aria-labelledby={titleId} className="mt-6 border-t border-edge pt-5">
      <h3 id={titleId} className="font-semibold">
        Two-step sign-in
      </h3>
      <p className="mt-1 text-sm text-ink-dim">
        {status?.enabled
          ? "On. Each sign-in asks for a code from your authenticator app after your password."
          : "Ask for a code from an authenticator app on your phone after your password, each time you sign in."}
      </p>
      {loadError && (
        <p role="alert" className="mt-3 text-sm text-alert">
          Could not check two-step sign-in.{" "}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => void load()}
          >
            Try again
          </button>
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-online">
          {notice}
        </p>
      )}

      {stage.step === "idle" && status && (
        <>
          {status.enabled && (
            <p
              className={`mt-3 text-sm ${status.recoveryCodesLeft <= FEW_CODES ? "text-alert" : "text-ink-dim"}`}
            >
              {status.recoveryCodesLeft === 0
                ? "You have no recovery codes left. Make new ones so you can still sign in without your phone."
                : `${status.recoveryCodesLeft} ${status.recoveryCodesLeft === 1 ? "recovery code" : "recovery codes"} left.`}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {status.enabled ? (
              <>
                <button
                  type="button"
                  className={buttonClass("secondary")}
                  onClick={() => go({ step: "password", purpose: "codes" })}
                >
                  New recovery codes
                </button>
                <button
                  type="button"
                  className={buttonClass("secondary")}
                  onClick={() => go({ step: "password", purpose: "off" })}
                >
                  Turn off
                </button>
              </>
            ) : (
              <button
                type="button"
                className={buttonClass("primary")}
                onClick={() => go({ step: "password", purpose: "setup" })}
              >
                Set up two-step sign-in
              </button>
            )}
          </div>
        </>
      )}

      {stage.step === "password" && (
        <form noValidate onSubmit={(event) => void withPassword(event)} className="mt-3 space-y-3">
          <p className="text-sm text-ink-dim">
            {stage.purpose === "setup"
              ? "First your password, to show it is you."
              : stage.purpose === "codes"
                ? "Your old recovery codes stop working once the new ones are made."
                : "Without it, your password alone signs you in."}
          </p>
          <label className="block text-sm" htmlFor={`${id}-password`}>
            Current password
          </label>
          <input
            id={`${id}-password`}
            ref={field}
            className={inputCls}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            maxLength={256}
            readOnly={busy}
          />
          {error && (
            <p role="alert" className="text-sm text-alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className={buttonClass("primary")}
              aria-disabled={busy || undefined}
            >
              <Swap text>{busy ? "Checking…" : PASSWORD_FOR[stage.purpose]}</Swap>
            </button>
            <button
              type="button"
              className={buttonClass("secondary")}
              disabled={busy}
              onClick={() => go({ step: "idle" })}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {stage.step === "scan" && (
        <form noValidate onSubmit={(event) => void turnOn(event)} className="mt-3 space-y-4">
          <div className="flex flex-wrap items-start gap-4">
            <QrCode value={stage.uri} label="QR code for your authenticator app" size={148} />
            <div className="min-w-0 flex-1 basis-56 text-sm text-ink-dim">
              <p>
                Scan this with an authenticator app, such as Google Authenticator, Microsoft
                Authenticator or 1Password. It shows the code under &ldquo;{workspaceName} on
                Tandem&rdquo;.
              </p>
              <p className="mt-3">Cannot scan it? Enter this key in the app instead:</p>
              <p className="mt-1 select-all break-all font-mono text-[13px] text-ink">
                {stage.secret.match(/.{1,4}/g)!.join(" ")}
              </p>
              <button
                type="button"
                className="mt-1 text-[13px] underline underline-offset-2 hover:text-ink"
                onClick={() => void clipboard.copy(stage.secret, "key")}
              >
                <Swap text>{clipboard.label("Copy key", "Copied", "Copy failed", "key")}</Swap>
              </button>
            </div>
          </div>
          <div>
            <label className="block text-sm" htmlFor={`${id}-code`}>
              Code from the app
            </label>
            <input
              id={`${id}-code`}
              ref={field}
              className={`${inputCls} mt-1 max-w-48 font-mono tracking-widest`}
              inputMode="numeric"
              autoComplete="one-time-code"
              spellCheck={false}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              maxLength={16}
              readOnly={busy}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className={buttonClass("primary")}
              aria-disabled={busy || undefined}
            >
              <Swap text>{busy ? "Checking…" : "Turn on"}</Swap>
            </button>
            <button
              type="button"
              className={buttonClass("secondary")}
              disabled={busy}
              onClick={() => go({ step: "idle" })}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {stage.step === "codes" && (
        <div
          ref={codesPanel}
          tabIndex={-1}
          className="mt-3 rounded-xl border border-edge bg-ground p-4 outline-none"
        >
          <h4 className="text-sm font-semibold">Save your recovery codes</h4>
          <p className="mt-1 text-sm text-ink-dim">
            Each one signs you in once if you lose your phone. Keep them somewhere safe, such as a
            password manager. They are not shown again.
          </p>
          <ul
            aria-label="Recovery codes"
            className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm sm:grid-cols-3"
          >
            {stage.codes.map((recovery) => (
              <li key={recovery} className="select-all">
                {recovery}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass("secondary")}
              onClick={() => void clipboard.copy(codesText, "codes")}
            >
              <Swap text>
                {clipboard.label(
                  "Copy codes",
                  "Copied",
                  "Copy failed. Select them instead",
                  "codes",
                )}
              </Swap>
            </button>
            <button
              type="button"
              className={buttonClass("secondary")}
              onClick={() =>
                saveCodes(
                  `Recovery codes for @${self.handle} in ${workspaceName} on Tandem.\nEach one signs you in once, in place of a code from your authenticator app.\n\n${codesText}\n`,
                )
              }
            >
              Save as a file
            </button>
            <button
              type="button"
              className={buttonClass("primary")}
              onClick={() => go({ step: "idle" })}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Hands the codes to the browser or desktop app as a text file; nothing is sent anywhere. */
function saveCodes(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "tandem-recovery-codes.txt";
  a.click();
  // Long enough for the download to have read it, in every browser.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
