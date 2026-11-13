import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useDismissGuard } from "../lib/dismissGuard.js";
import { ApiError, selfMay } from "@ownbase/client-core";
import { useClient, useWorkspace } from "../context.js";
import { accountError } from "../lib/account.js";
import { useCopy } from "../lib/useCopy.js";
import { saveText } from "../lib/download.js";
import { settingMark } from "../lib/settingsSearch.js";
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
  // Guests have no password, so none of this either.
  const owned = !!self && selfMay({ self }, "twoStep");

  const load = useCallback(async () => {
    const status = await client.account.twoStep();
    if (!alive.current) return;
    if (status instanceof ApiError) {
      setLoadError(true);
      return;
    }
    setStatus(status);
    setLoadError(false);
  }, [client]);
  useEffect(() => {
    alive.current = true;
    if (owned) void load();
    return () => {
      alive.current = false;
    };
  }, [load, owned]);
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
    const { purpose } = stage;
    const answer =
      purpose === "setup"
        ? await client.account.startTwoStep(password)
        : purpose === "codes"
          ? await client.account.newRecoveryCodes(password)
          : await client.account.disableTwoStep(password);
    if (!alive.current) return;
    setBusy(false);
    if (answer instanceof ApiError) {
      setError(accountError(answer));
      field.current?.focus();
    } else if (Array.isArray(answer)) {
      go({ step: "codes", codes: answer });
      setStatus({ enabled: true, recoveryCodesLeft: answer.length });
    } else if (answer) {
      go({ step: "scan", secret: answer.secret, uri: answer.uri });
    } else {
      go({ step: "idle" });
      setStatus({ enabled: false, recoveryCodesLeft: 0 });
      setNotice("Two-step sign-in is off. Your password alone signs you in.");
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
    const codes = await client.account.enableTwoStep(code.trim());
    if (!alive.current) return;
    setBusy(false);
    if (!(codes instanceof ApiError)) {
      go({ step: "codes", codes });
      setStatus({ enabled: true, recoveryCodesLeft: codes.length });
      return;
    }
    setError(accountError(codes));
    // A setup that took too long starts again from the password, saying why.
    if (codes.code === "two_step_setup_expired") {
      setStage({ step: "password", purpose: "setup" });
      setCode("");
    } else field.current?.focus();
  }

  if (!owned) return null;
  const titleId = `${id}-title`;
  const codesText = stage.step === "codes" ? stage.codes.join("\n") : "";

  return (
    <section
      {...settingMark("two-step")}
      aria-labelledby={titleId}
      className="mt-6 border-t border-edge pt-5"
    >
      <h3 id={titleId} className="font-semibold">
        Two-step sign-in
      </h3>
      <p className="mt-1 text-sm text-ink-dim">
        {status?.enabled
          ? "On. Each sign-in asks for a code from your authenticator app after your password."
          : "When it is on, each sign-in asks for your password and then a code from an authenticator app on your phone."}
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
                // Secondary: Security's one primary is Update password, above it.
                className={buttonClass("secondary")}
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
              ? "Enter your password to show it is you."
              : stage.purpose === "codes"
                ? "Your old recovery codes stop working once the new ones are made."
                : "Once it is off, your password alone signs you in."}
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
                OwnBase&rdquo;.
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

      <CodesGuard shown={stage.step === "codes"} />
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
                saveText(
                  `Recovery codes for @${self.handle} in ${workspaceName} on OwnBase.\nEach one signs you in once, in place of a code from your authenticator app.\n\n${codesText}\n`,
                  "ownbase-recovery-codes.txt",
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

/** Recovery codes are shown once: closing before Done asks first. */
function CodesGuard({ shown }: { shown: boolean }) {
  useDismissGuard(
    shown
      ? {
          title: "Close without your recovery codes?",
          body: "They are not shown again. Copy them or save them as a file first, unless you already have.",
          confirmLabel: "Close anyway",
        }
      : null,
  );
  return null;
}
