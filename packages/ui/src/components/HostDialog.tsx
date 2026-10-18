import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  AutoBackup,
  HostedWorkspaces,
  HostingStart,
  RestoreInventory,
  HostingStatus,
  LastHosted,
  Platform,
} from "../platform.js";
import type { AccessPolicy } from "@slackoss/protocol";
import { useHostingStatus } from "../lib/hosting.js";
import { useCopy } from "../lib/useCopy.js";
import { formatDay, formatTime } from "../lib/format.js";
import { isImeKey } from "../lib/textInput.js";
import { useTabs } from "../lib/useTabs.js";
import { Dialog, DialogScroll } from "./Dialog.js";
import { inputClass, inputCls } from "./TextField.js";
import { Swap } from "./Motion.js";
import { buttonClass } from "./Button.js";
import { CallRelaySettings } from "./CallRelaySettings.js";
import { QrCode } from "./QrCode.js";

type Hosting = NonNullable<Platform["hosting"]>;

/** The parts of managing a running workspace, each a tab (UX-62). */
type Section = "overview" | "internet" | "backups" | "advanced";
const SECTION_NAMES: Record<Section, string> = {
  overview: "Overview",
  internet: "Share on the internet",
  backups: "Backups",
  advanced: "Advanced",
};

/**
 * Whether the running workspace starts when Tandem opens, and whether the
 * OS opens Tandem when someone signs in. With both on, a workspace comes
 * back by itself after the computer restarts.
 */
function StartWithComputer(props: {
  hosting: Hosting;
  folder: string;
  name: string;
  startsOnLaunch: boolean;
  /** The stable public address set up for hosting, if there is one. */
  publicAddress?: string;
  /** It is reopened when this workspace starts with Tandem. */
  reopensPublic: boolean;
  disabled: boolean;
  /** What went wrong saving a choice, or null to clear it. */
  onError: (text: string | null) => void;
}) {
  const setStart = props.hosting.setStartOnLaunch;
  const login = props.hosting.openAtLogin;
  const reopen = props.hosting.setReopenPublicOnLaunch;
  const [atLogin, setAtLogin] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  /** The choice just made, shown until the status agrees or saving fails. */
  const [chosen, setChosen] = useState<boolean | null>(null);
  const [reopenChosen, setReopenChosen] = useState<boolean | null>(null);
  useEffect(() => {
    if (chosen !== null && chosen === props.startsOnLaunch) setChosen(null);
  }, [chosen, props.startsOnLaunch]);
  useEffect(() => {
    if (reopenChosen !== null && reopenChosen === props.reopensPublic) setReopenChosen(null);
  }, [reopenChosen, props.reopensPublic]);
  useEffect(() => {
    if (!login) return;
    let alive = true;
    login.get().then(
      (value) => {
        if (alive) setAtLogin(value);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [login]);
  if (!setStart) return null;

  async function save(action: () => Promise<unknown>, undo: () => void) {
    setSaving(true);
    props.onError(null);
    try {
      await action();
    } catch (reason) {
      undo();
      props.onError(
        reason instanceof Error && reason.message
          ? reason.message
          : "That choice could not be saved. Try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <fieldset className="space-y-2" disabled={props.disabled || saving}>
      <legend className="mb-1 text-ink-dim">When this computer starts</legend>
      <label className="flex items-start gap-2 text-ink">
        <input
          type="checkbox"
          className="mt-1"
          checked={chosen ?? props.startsOnLaunch}
          onChange={(event) => {
            const start = event.target.checked;
            setChosen(start);
            void save(
              () => setStart(start ? props.folder : null),
              () => setChosen(null),
            );
          }}
        />
        <span>Start hosting {props.name} when Tandem opens</span>
      </label>
      {login && atLogin !== null && (
        <label className="flex items-start gap-2 text-ink">
          <input
            type="checkbox"
            className="mt-1"
            checked={atLogin}
            onChange={(event) => {
              const open = event.target.checked;
              setAtLogin(open);
              void save(
                async () => setAtLogin(await login.set(open)),
                () => setAtLogin(!open),
              );
            }}
          />
          <span>Open Tandem when you sign in to this computer</span>
        </label>
      )}
      {reopen && props.publicAddress && (
        <label className="flex items-start gap-2 text-ink">
          <input
            type="checkbox"
            className="mt-1"
            checked={reopenChosen ?? props.reopensPublic}
            disabled={!(chosen ?? props.startsOnLaunch)}
            onChange={(event) => {
              const next = event.target.checked;
              setReopenChosen(next);
              void save(
                () => reopen(next),
                () => setReopenChosen(null),
              );
            }}
          />
          <span>
            Also reopen {props.publicAddress} when {props.name} starts with Tandem, once it is
            checked to reach this workspace. New accounts need an invite.
          </span>
        </label>
      )}
      <p className="text-xs text-ink-faint">
        {atLogin === null
          ? `${props.name} starts once Tandem is opened.`
          : `With both on, ${props.name} is back for teammates once this computer restarts and someone signs in. Tandem then waits in the tray.`}
      </p>
    </fieldset>
  );
}

/**
 * What did not happen when Tandem opened, shown whether or not anything
 * hosts now. A workspace can be live on this network while its public address
 * failed to reopen, and that is exactly the failure a host would otherwise
 * never see. It stays until that part recovers or the host dismisses it.
 */
function LaunchProblem(props: {
  hosting: Hosting;
  message: string | undefined;
  /** Tries the part that failed again, when this dialog can. */
  onRetry: (() => void) | null;
  disabled: boolean;
  className?: string;
  onDismissed: () => void;
  onError: (text: string | null) => void;
}) {
  const dismiss = props.hosting.dismissLaunchError;
  const [saving, setSaving] = useState(false);
  if (!props.message) return null;
  return (
    <div role="alert" className={`text-sm ${props.className ?? ""}`}>
      <p className="text-alert">{props.message}</p>
      {(props.onRetry || dismiss) && (
        <div className="mt-1 flex flex-wrap gap-3">
          {props.onRetry && (
            <button
              type="button"
              disabled={props.disabled || saving}
              className={linkBtnCls}
              onClick={props.onRetry}
            >
              Try again
            </button>
          )}
          {dismiss && (
            <button
              type="button"
              disabled={props.disabled || saving}
              className={linkBtnCls}
              onClick={() => {
                setSaving(true);
                props.onError(null);
                dismiss().then(
                  () => {
                    setSaving(false);
                    props.onDismissed();
                  },
                  () => {
                    setSaving(false);
                    props.onError("That message could not be dismissed. Try again.");
                  },
                );
              }}
            >
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The same choices while nothing is running, so a workspace that fails to
 * start with Tandem can be taken off it, and Tandem off sign-in,
 * without having to start it first. Nothing here removes it from the list.
 */
function StartupWhileStopped(props: {
  hosting: Hosting;
  /** The workspace chosen to start with Tandem, if it is listed. */
  chosen: { folder: string; name: string } | null;
  /** Why starting with Tandem did not happen, if it did not. */
  launchError: string | undefined;
  disabled: boolean;
  onChanged: () => void;
  onError: (text: string | null) => void;
}) {
  const setStart = props.hosting.setStartOnLaunch;
  const login = props.hosting.openAtLogin;
  const [atLogin, setAtLogin] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!login) return;
    let alive = true;
    login.get().then(
      (value) => {
        if (alive) setAtLogin(value);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [login]);
  if (!setStart || (!props.chosen && !props.launchError && !atLogin)) return null;

  async function save(action: () => Promise<unknown>) {
    setSaving(true);
    props.onError(null);
    try {
      await action();
      props.onChanged();
    } catch (reason) {
      props.onError(
        reason instanceof Error && reason.message
          ? reason.message
          : "That choice could not be saved. Try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label="When this computer starts" className="mb-5 space-y-2 text-sm">
      <h3 className="text-[13px] font-semibold text-ink">When this computer starts</h3>
      {props.chosen ? (
        <p className="text-ink-dim">
          {props.chosen.name} starts hosting when Tandem opens.{" "}
          <button
            type="button"
            disabled={props.disabled || saving}
            className={linkBtnCls}
            onClick={() => void save(() => setStart(null))}
          >
            Don’t start {props.chosen.name} with Tandem
          </button>
        </p>
      ) : (
        props.launchError && (
          <p className="text-ink-dim">
            <button
              type="button"
              disabled={props.disabled || saving}
              className={linkBtnCls}
              onClick={() => void save(() => setStart(null))}
            >
              Start nothing when Tandem opens
            </button>
          </p>
        )
      )}
      {login && atLogin !== null && (
        <label className="flex items-start gap-2 text-ink">
          <input
            type="checkbox"
            className="mt-1"
            checked={atLogin}
            disabled={props.disabled || saving}
            onChange={(event) => {
              const open = event.target.checked;
              setAtLogin(open);
              void save(async () => {
                try {
                  setAtLogin(await login.set(open));
                } catch (reason) {
                  setAtLogin(!open);
                  throw reason;
                }
              });
            }}
          />
          <span>Open Tandem when you sign in to this computer</span>
        </label>
      )}
    </section>
  );
}

/** What a restored backup would bring back into use, in a sentence. */
function inventorySummary(inventory: RestoreInventory): string {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [
    count(inventory.sessions, "sign-in it still accepts", "sign-ins it still accepts"),
    count(inventory.scheduled.waiting, "scheduled message waiting", "scheduled messages waiting"),
    count(
      inventory.undeliveredEvents,
      "app event not yet delivered",
      "app events not yet delivered",
    ),
  ];
  const origins = inventory.appAddresses.map((a) => a.origin);
  if (origins.length > 0) parts.push(`apps it calls at ${origins.join(", ")}`);
  return `Put back in use, it brings ${parts.join(", ")}.`;
}

const KEEP_CHOICES = [3, 7, 14, 30];

/**
 * Backing the running workspace up by itself, every day or week, into a
 * folder the system asks for, keeping the newest few. The main process
 * chooses the folder; this only asks it to.
 */
function AutoBackupSettings(props: {
  hosting: Hosting;
  folder: string;
  name: string;
  schedule: AutoBackup | null;
  error: string | null;
  /** Restored and not yet back in use, so its schedule is not running. */
  held: boolean;
  disabled: boolean;
  /** What changed, or went wrong changing it; null clears what was said. */
  onNote: (note: { ok: boolean; text: string } | null) => void;
  onChanged: () => void;
}) {
  const setAutoBackup = props.hosting.setAutoBackup;
  const retryBackups = props.hosting.retryBackups;
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const schedule = props.schedule;
  // A restored copy being looked inside has nothing to back up by itself yet.
  if (!setAutoBackup || (props.held && !schedule)) return null;

  async function save(
    next: { everyDays: 1 | 7; keep: number } | null,
    chooseFolder: boolean,
    said: (result: AutoBackup | null) => string,
  ) {
    setSaving(true);
    props.onNote(null);
    try {
      const result = await setAutoBackup!(props.folder, next, chooseFolder);
      // No folder chosen: nothing changed, and nothing needs saying.
      if (result === undefined) return;
      props.onNote({ ok: true, text: said(result) });
      props.onChanged();
    } catch (reason) {
      props.onNote({
        ok: false,
        text:
          reason instanceof Error && reason.message
            ? reason.message
            : "The backup schedule could not be saved. Try again.",
      });
    } finally {
      setSaving(false);
    }
  }

  /** A failed backup is still due: this makes it now, rather than at the next check. */
  async function retry() {
    setRetrying(true);
    props.onNote(null);
    try {
      await retryBackups!();
    } finally {
      setRetrying(false);
      // Whether it failed again, and why, comes back with the list.
      props.onChanged();
    }
  }

  const often = (everyDays: 1 | 7) => (everyDays === 1 ? "every day" : "every week");
  return (
    <fieldset className="space-y-2" disabled={props.disabled || saving || retrying}>
      <legend className="mb-1 text-ink-dim">Automatic backups</legend>
      {schedule ? (
        <>
          {props.held ? (
            <p className="text-ink">
              {props.name} is not backed up by itself until it is back in use, and nothing already
              in <span className="break-all font-mono text-xs">{schedule.destination}</span> is
              removed. Then it is backed up {often(schedule.everyDays)}, keeping the newest{" "}
              {schedule.keep}.
            </p>
          ) : (
            <p className="text-ink">
              {props.name} is backed up {often(schedule.everyDays)}, keeping the newest{" "}
              {schedule.keep}, into{" "}
              <span className="break-all font-mono text-xs">{schedule.destination}</span>
            </p>
          )}
          {schedule.lastAt !== undefined && (
            <p className="text-xs text-ink-dim">
              Last backed up there {backedUpWhen(schedule.lastAt)}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-ink-dim">
              How often
              <select
                value={schedule.everyDays}
                onChange={(event) => {
                  const everyDays = Number(event.target.value) as 1 | 7;
                  void save(
                    { everyDays, keep: schedule.keep },
                    false,
                    () => `${props.name} will be backed up ${often(everyDays)}.`,
                  );
                }}
                className="rounded border border-edge bg-ground px-2 py-1 text-ink"
              >
                <option value={1}>Every day</option>
                <option value={7}>Every week</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-ink-dim">
              Keep
              <select
                value={schedule.keep}
                onChange={(event) => {
                  const keep = Number(event.target.value);
                  void save(
                    { everyDays: schedule.everyDays, keep },
                    false,
                    () => `The newest ${keep} backups of ${props.name} will be kept.`,
                  );
                }}
                className="rounded border border-edge bg-ground px-2 py-1 text-ink"
              >
                {[...new Set([...KEEP_CHOICES, schedule.keep])]
                  .sort((a, b) => a - b)
                  .map((keep) => (
                    <option key={keep} value={keep}>
                      {keep} backups
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              className={linkBtnCls}
              onClick={() =>
                void save(
                  { everyDays: schedule.everyDays, keep: schedule.keep },
                  true,
                  (result) => `${props.name} will be backed up into ${result?.destination}.`,
                )
              }
            >
              Choose another folder
            </button>
            <button
              type="button"
              className={linkBtnCls}
              onClick={() =>
                void save(
                  null,
                  false,
                  () =>
                    `${props.name} will no longer be backed up by itself. Backups already made stay where they are.`,
                )
              }
            >
              Turn off
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-xs text-ink-faint">
            Back {props.name} up by itself every day into a folder you choose, such as one on
            another drive, keeping the newest seven. Older ones there are removed.
          </p>
          <button
            type="button"
            className={buttonClass("secondary")}
            onClick={() =>
              void save(
                { everyDays: 1, keep: 7 },
                true,
                (result) =>
                  `${props.name} will be backed up every day into ${result?.destination}.`,
              )
            }
          >
            Back up automatically…
          </button>
        </>
      )}
      {props.error && (
        <div className="space-y-1">
          <p role="alert" className="text-sm text-alert">
            {props.error}
          </p>
          {/* Only removing older ones failed: the backup itself was made. */}
          {retryBackups && schedule && schedule.failure?.kind !== "cleanup" && !props.held && (
            <button type="button" className={linkBtnCls} onClick={() => void retry()}>
              {retrying ? "Trying again…" : "Try again"}
            </button>
          )}
        </div>
      )}
    </fieldset>
  );
}

/** A port as typed, or null when it is not one a workspace could use. */
function portValue(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * Changes the port a stopped workspace starts on, where it is listed.
 * Escape calls it off rather than closing the dialog. Save always answers:
 * a port that is not one says so, and the port it has already just closes
 * the form, as there is nothing to save.
 */
function PortForm(props: {
  folder: string;
  name: string;
  port: number;
  saving: boolean;
  /** Resolves to why the port was refused, or null once it is saved. */
  onSave: (port: number) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(String(props.port));
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const errorId = `port-error-${props.folder}`;
  return (
    <form
      aria-label={`Port for ${props.name}`}
      noValidate
      className="min-w-0 flex-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (props.saving) return;
        const port = portValue(draft);
        if (port === null) {
          setError("Choose a port from 1 to 65535.");
          field.current?.focus();
        } else if (port === props.port) props.onCancel();
        else
          void props.onSave(port).then((refusal) => {
            setError(refusal);
            if (refusal) field.current?.focus();
          });
      }}
    >
      <div className="flex gap-2">
        <div className="w-24 shrink-0">
          <input
            ref={field}
            autoFocus
            inputMode="numeric"
            aria-label={`New port for ${props.name}`}
            maxLength={5}
            value={draft}
            readOnly={props.saving}
            aria-invalid={!!error}
            aria-errormessage={error ? errorId : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || isImeKey(event.nativeEvent)) return;
              event.preventDefault();
              props.onCancel();
            }}
            className={inputClass("regular", "font-mono")}
          />
        </div>
        <button
          type="submit"
          aria-disabled={props.saving || undefined}
          className={buttonClass("secondary", "shrink-0")}
        >
          {props.saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          disabled={props.saving}
          onClick={props.onCancel}
          className={buttonClass("quiet", "shrink-0")}
        >
          Cancel
        </button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-xs text-alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** A small action written as a link, beside what it acts on. */
const linkBtnCls =
  "text-xs font-medium text-ink underline decoration-ink-faint/60 underline-offset-2 hover:decoration-ink disabled:opacity-40";

/**
 * Renames one hosted workspace where it is shown. Only the name changes: its
 * folder and everything in it stay where they are. Escape calls off the
 * rename rather than closing the dialog. Save always answers: with no name it
 * asks for one, and with the name it has already it just closes the form, as
 * there is nothing to save.
 */
function RenameForm(props: {
  folder: string;
  name: string;
  /** Something else is under way, so the name cannot be saved yet. */
  blocked: boolean;
  saving: boolean;
  /** Resolves to why the name was refused, or null once it is saved. */
  onSave: (name: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(props.name);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const errorId = `rename-error-${props.folder}`;
  const waiting = props.saving || props.blocked;
  return (
    <form
      aria-label={`Rename ${props.name}`}
      noValidate
      className="min-w-0 flex-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (waiting) return;
        if (!draft.trim()) {
          setError("Give the workspace a name.");
          field.current?.focus();
        } else if (draft.trim() === props.name) props.onCancel();
        else
          void props.onSave(draft).then((refusal) => {
            setError(refusal);
            if (refusal) field.current?.focus();
          });
      }}
    >
      <div className="flex gap-2">
        <input
          ref={field}
          autoFocus
          aria-label={`New name for ${props.name}`}
          maxLength={80}
          value={draft}
          // Read-only rather than disabled while saving, so focus stays here.
          readOnly={props.saving}
          aria-invalid={!!error}
          aria-errormessage={error ? errorId : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || isImeKey(event.nativeEvent)) return;
            event.preventDefault();
            props.onCancel();
          }}
          className={inputClass("regular", "min-w-0 flex-1")}
        />
        <button
          type="submit"
          aria-disabled={waiting || undefined}
          className={buttonClass("secondary", "shrink-0")}
        >
          {props.saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          disabled={props.saving}
          onClick={props.onCancel}
          className={buttonClass("quiet", "shrink-0")}
        >
          Cancel
        </button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-xs text-alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** Give recovery guidance without showing Electron's IPC wrapper or raw error details. */
function hostedListError(reason: unknown): string {
  // Electron prefixes errors from main-process IPC, so match the fixed
  // registry messages inside the wrapper rather than showing its raw text.
  const message = reason instanceof Error ? reason.message : "";
  if (message.includes("The hosted workspace list was saved by a newer version of Tandem."))
    return "The hosted workspace list was saved by a newer version of Tandem. Update Tandem to open it; the list was not changed.";
  if (message.includes("The hosted workspace list has a version this Tandem cannot read."))
    return "The hosted workspace list has a version this Tandem cannot read. Use a compatible version; the list was not changed.";
  if (message.includes("The hosted workspace list in settings is invalid."))
    return "The hosted workspace list in settings is invalid. Restore or repair the settings file before hosting; the list was not changed.";
  return "Could not read the list of workspaces hosted on this computer, so none can start. Check that Tandem’s settings file can be read, then open this again.";
}

/**
 * Every workspace hosted on this computer, read again whenever hosting
 * starts or stops. Null until read, and on an app with no list to read.
 */
function useHostedWorkspaces(hosting: Hosting, phase: string, revision: number) {
  const [hosted, setHosted] = useState<HostedWorkspaces | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!hosting.list) return;
    let alive = true;
    hosting
      .list()
      .then((value) => {
        if (!alive) return;
        setHosted(value);
        setFailed(null);
      })
      .catch((reason) => {
        if (alive) {
          setHosted(null);
          setFailed(hostedListError(reason));
        }
      });
    return () => {
      alive = false;
    };
  }, [hosting, phase, revision]);
  return { hosted, failed };
}

/** An address to give people, with a button that copies it. */
function AddressRow(props: {
  url: string;
  id: string;
  copyKey: string;
  copyLabel: ReturnType<typeof useCopy>["label"];
  onCopy: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span id={props.id} className="min-w-0 break-all font-mono text-ink">
        {props.url}
      </span>
      <button
        type="button"
        aria-describedby={props.id}
        onClick={props.onCopy}
        className="shrink-0 rounded px-2 py-1 text-xs text-ink-dim hover:bg-ink/[0.05] hover:text-ink"
      >
        <Swap text>{props.copyLabel("Copy", "Copied", "Copy failed", props.copyKey)}</Swap>
      </button>
    </div>
  );
}

/** "today, 3:04 PM" or "Monday, September 22, 3:04 PM". */
function backedUpWhen(at: number): string {
  const day = formatDay(at);
  return `${day === "Today" || day === "Yesterday" ? day.toLowerCase() : day}, ${formatTime(at)}`;
}

export function HostDialog(props: {
  hosting: Hosting;
  state: ReturnType<typeof useHostingStatus>;
  /** The hosted workspace is the one already on screen, so there is nothing to open. */
  viewingHosted?: boolean;
  onClose: () => void;
  onStarted: (status: HostingStatus) => void;
  /** Opens Invite people in the hosted workspace, which is on screen. */
  onInvite?: () => void;
}) {
  const { status, loading, error: statusError, refresh } = props.state;
  const [name, setName] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  /** The port for a new workspace, as typed. Empty for the usual one. */
  const [portText, setPortText] = useState("");
  const [busy, setBusy] = useState<
    | "starting"
    | "stopping"
    | "opening"
    | "closing"
    | "policy"
    | "address"
    | "backing-up"
    | "removing"
    | "restoring"
    | "renaming"
    | null
  >(null);
  const operationPending = useRef(false);
  const [section, setSection] = useState<Section>("overview");
  const [error, setError] = useState<{ message: string; tunnel?: boolean } | null>(null);
  /** Null while the saved address is shown; a string while it is being edited. */
  const [addressDraft, setAddressDraft] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  /** Save was pressed with the address already saved, which is said rather than saved again. */
  const [addressUnchanged, setAddressUnchanged] = useState(false);
  const addressField = useRef<HTMLInputElement>(null);
  // A public address is not authorization. Require an invite by default when
  // a previously LAN-only workspace is first put on the internet.
  const [requireInvite, setRequireInvite] = useState(true);
  /** Who may join once opened, chosen before opening; guests only when asked for. */
  const [openPolicy, setOpenPolicy] = useState<AccessPolicy>("invite_only");
  // An app without guest access says who may join with invites alone.
  const guestsSupported = !!props.hosting.setAccessPolicy;
  /** What the running workspace holds now, as acknowledged by it. */
  const livePolicy: AccessPolicy | undefined =
    status?.accessPolicy ??
    (status?.inviteOnly === undefined
      ? undefined
      : status.inviteOnly
        ? "invite_only"
        : "account_required");
  const { copy, label: copyLabel } = useCopy();
  const phase = status?.phase ?? (status?.running ? "running" : "stopped");
  const changing = phase === "starting" || phase === "stopping";
  const unavailable = loading || statusError || !status || changing || !!busy;
  const publicUrl = status?.openToAll?.phase === "open" ? status.openToAll.url : null;
  const externallyCarried = !!status?.publicAddress && !status.publicAddressManaged;
  const tunnelError = status?.publicAddressError ?? status?.openToAllError;
  const savedAddress = status?.publicAddressSetting ?? "";
  const addressValue = addressDraft ?? savedAddress;
  const addressDirty = addressDraft !== null && addressDraft.trim() !== savedAddress;

  // Opening management also refreshes shells without status subscriptions.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (status?.inviteOnly !== undefined) setRequireInvite(status.inviteOnly);
  }, [status?.inviteOnly]);

  const [listRevision, setListRevision] = useState(0);
  const { hosted, failed: listFailed } = useHostedWorkspaces(props.hosting, phase, listRevision);
  /** What the last backup or removal from the list did, until another starts. */
  const [backupNote, setBackupNote] = useState<{ ok: boolean; text: string } | null>(null);
  const backupFn = props.hosting.backup;
  const forgetFn = props.hosting.forget;
  const restoreFn = props.hosting.restore;
  /** The restored workspace whose "put back in use" question is showing. */
  const [activating, setActivating] = useState<string | null>(null);
  const renameFn = props.hosting.rename;
  const openFolderFn = props.hosting.openFolder;
  /** The folder of the workspace being renamed, while its form is open. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const setPortFn = props.hosting.setPort;
  /** The folder of the workspace whose port is being changed, while its form is open. */
  const [changingPort, setChangingPort] = useState<string | null>(null);
  const portReturn = useRef<string | null>(null);
  useEffect(() => {
    if (changingPort !== null || !portReturn.current) return;
    document.getElementById(`port-${portReturn.current}`)?.focus();
    portReturn.current = null;
  }, [changingPort]);

  async function savePort(folder: string, name: string, port: number): Promise<string | null> {
    if (!setPortFn || operationPending.current) return null;
    operationPending.current = true;
    setBusy("renaming");
    setBackupNote(null);
    try {
      await setPortFn(folder, port);
      portReturn.current = folder;
      setChangingPort(null);
      setBackupNote({ ok: true, text: `${name} will start on port ${port}.` });
      return null;
    } catch (reason) {
      return reason instanceof Error && reason.message
        ? reason.message
        : "The port could not be saved. Try again.";
    } finally {
      setListRevision((n) => n + 1);
      operationPending.current = false;
      setBusy(null);
    }
  }
  /** Whose Rename button gets focus back once the form closes. */
  const renameReturn = useRef<string | null>(null);

  useEffect(() => {
    if (renaming !== null || !renameReturn.current) return;
    document.getElementById(`rename-${renameReturn.current}`)?.focus();
    renameReturn.current = null;
  }, [renaming]);

  function closeRename() {
    renameReturn.current = renaming;
    setRenaming(null);
  }

  async function saveName(folder: string, previous: string, next: string): Promise<string | null> {
    if (!renameFn || operationPending.current) return null;
    operationPending.current = true;
    setBusy("renaming");
    setBackupNote(null);
    try {
      const done = await renameFn(folder, next);
      renameReturn.current = folder;
      setRenaming(null);
      setBackupNote({ ok: true, text: `Renamed ${previous} to ${done.name}.` });
      return null;
    } catch (reason) {
      // The main process says what is wrong with the name, or with the folder.
      return reason instanceof Error && reason.message
        ? reason.message
        : "The new name could not be saved. Try again.";
    } finally {
      setListRevision((n) => n + 1);
      void refresh();
      operationPending.current = false;
      setBusy(null);
    }
  }

  async function openFolder(folder: string) {
    if (!openFolderFn) return;
    setBackupNote(null);
    try {
      await openFolderFn(folder);
    } catch (reason) {
      setBackupNote({
        ok: false,
        text:
          reason instanceof Error && reason.message
            ? reason.message
            : "The folder could not be opened.",
      });
    }
  }

  async function restoreBackup() {
    if (!restoreFn || operationPending.current || unavailable) return;
    operationPending.current = true;
    setBusy("restoring");
    setBackupNote(null);
    try {
      const restored = await restoreFn();
      if (restored)
        setBackupNote({
          ok: true,
          text:
            `Restored ${restored.name}. Until you put it back in use, Look inside opens it on this computer only, sends nothing it had waiting and calls no app.` +
            (restored.inventory ? ` ${inventorySummary(restored.inventory)}` : ""),
        });
    } catch (reason) {
      const why = reason instanceof Error && reason.message ? ` ${reason.message}` : "";
      setBackupNote({ ok: false, text: `The backup was not restored.${why}` });
    } finally {
      setListRevision((n) => n + 1);
      operationPending.current = false;
      setBusy(null);
    }
  }

  async function removeMissing(folder: string, name: string) {
    if (!forgetFn || operationPending.current || unavailable) return;
    operationPending.current = true;
    setBusy("removing");
    setBackupNote(null);
    try {
      await forgetFn(folder);
    } catch (reason) {
      const why = reason instanceof Error && reason.message ? ` ${reason.message}` : "";
      setBackupNote({ ok: false, text: `${name} could not be removed from the list.${why}` });
    } finally {
      setListRevision((n) => n + 1);
      operationPending.current = false;
      setBusy(null);
    }
  }

  async function backUp(folder: string, name: string) {
    if (!backupFn || operationPending.current || unavailable) return;
    operationPending.current = true;
    setBusy("backing-up");
    setBackupNote(null);
    try {
      const made = await backupFn(folder);
      if (made) setBackupNote({ ok: true, text: `Backed up ${name} to ${made.path}` });
    } catch (reason) {
      const why = reason instanceof Error && reason.message ? ` ${reason.message}` : "";
      setBackupNote({ ok: false, text: `The backup of ${name} did not finish.${why}` });
    } finally {
      setListRevision((n) => n + 1);
      operationPending.current = false;
      setBusy(null);
    }
  }

  const backupStatus = backupNote && (
    <p
      role={backupNote.ok ? "status" : "alert"}
      className={`mb-3 break-words text-sm ${backupNote.ok ? "text-ink-dim" : "text-alert"}`}
    >
      {backupNote.text}
    </p>
  );

  const existing = hosted?.workspaces ?? [];
  const runningEntry = existing.find((w) => w.running);
  const typed = name.trim().toLowerCase();
  const sameName = typed ? existing.find((w) => w.name.trim().toLowerCase() === typed) : undefined;

  function start(e: React.FormEvent) {
    e.preventDefault();
    // Say what is missing rather than refusing silently.
    if (!name.trim()) {
      setError({ message: "Name the workspace first, such as Rocket Team." });
      nameInput.current?.focus();
      return;
    }
    if (!portText.trim()) {
      void launch({ workspaceName: name.trim() });
      return;
    }
    const port = portValue(portText);
    if (port === null) {
      setError({ message: "Choose a port from 1 to 65535, or leave it empty for the usual one." });
      return;
    }
    void launch({ workspaceName: name.trim(), port });
  }

  async function launch(request: HostingStart) {
    if (operationPending.current || unavailable) return;
    operationPending.current = true;
    setBusy("starting");
    setError(null);
    try {
      const next = await props.hosting.start(request);
      void refresh();
      if (next.running && next.phase !== "stopping" && next.port !== undefined)
        props.onStarted(next);
    } catch (reason) {
      // The desktop app says what went wrong in words it chose to show.
      setError({
        message:
          reason instanceof Error && reason.message
            ? reason.message
            : "The workspace could not start. Check that its data folder is writable and its port is available, then try again.",
      });
      await refresh();
    } finally {
      operationPending.current = false;
      setBusy(null);
    }
  }

  // The button already says what it does, so it stops without asking first.
  async function stop() {
    if (operationPending.current || unavailable) return;
    operationPending.current = true;
    setBusy("stopping");
    setError(null);
    try {
      await props.hosting.stop();
    } catch {
      setError({
        message:
          "The workspace could not be stopped. Check its current status; Quit Tandem offers recovery options if stopping keeps failing.",
      });
    } finally {
      await refresh();
      operationPending.current = false;
      setBusy(null);
    }
  }

  async function openToAll() {
    if (
      operationPending.current ||
      unavailable ||
      !props.hosting.openToAll ||
      status?.publicAddressError ||
      status?.tunnelAvailable === false
    )
      return;
    operationPending.current = true;
    setBusy("opening");
    setError(null);
    try {
      await props.hosting.openToAll(
        guestsSupported
          ? { inviteOnly: openPolicy === "invite_only", accessPolicy: openPolicy }
          : { inviteOnly: requireInvite },
      );
    } catch (err) {
      setError({
        tunnel: true,
        message:
          err instanceof Error && /Create your own account/i.test(err.message)
            ? "Open the workspace and create its owner account first, then try again."
            : "The public link could not be opened. Check that cloudflared is installed and that this computer is online, then try again.",
      });
    } finally {
      await refresh();
      operationPending.current = false;
      setBusy(null);
    }
  }

  async function endOpenToAll() {
    if (operationPending.current || !props.hosting.endOpenToAll) return;
    operationPending.current = true;
    setBusy("closing");
    setError(null);
    try {
      await props.hosting.endOpenToAll();
    } catch {
      setError({
        tunnel: true,
        message: externallyCarried
          ? "Tandem could not stop publishing this address. Try again, then stop its external tunnel or proxy separately."
          : "Tandem’s Cloudflare connection could not be closed cleanly. Try again before quitting Tandem.",
      });
    } finally {
      await refresh();
      operationPending.current = false;
      setBusy(null);
    }
  }

  /** Changes who may join, showing what the workspace then holds rather than the wish. */
  async function changeAccessPolicy(next: AccessPolicy) {
    if (operationPending.current || !props.hosting.setAccessPolicy) return;
    operationPending.current = true;
    setBusy("policy");
    setError(null);
    try {
      await props.hosting.setAccessPolicy(next);
    } catch {
      setError({
        message: "Who may join could not be changed. The previous setting is still in use.",
      });
    } finally {
      await refresh();
      operationPending.current = false;
      setBusy(null);
    }
  }

  async function changeInvitePolicy(next: boolean) {
    if (operationPending.current || !props.hosting.setInviteOnly) return;
    const previous = requireInvite;
    setRequireInvite(next);
    operationPending.current = true;
    setBusy("policy");
    setError(null);
    try {
      await props.hosting.setInviteOnly(next);
    } catch {
      setRequireInvite(previous);
      setError({
        message: "Who may join could not be changed. The previous setting is still in use.",
      });
    } finally {
      await refresh();
      operationPending.current = false;
      setBusy(null);
    }
  }

  async function saveAddress() {
    if (operationPending.current || !props.hosting.setPublicAddress) return;
    setAddressError(null);
    if (!addressValue.trim() && !savedAddress) {
      setAddressError("Enter the address, such as https://box.tail1234.ts.net.");
      addressField.current?.focus();
      return;
    }
    // Saving an address also turns invites back on, so the one already
    // saved is not saved again; Save says so instead.
    if (!addressDirty) {
      setAddressUnchanged(true);
      return;
    }
    operationPending.current = true;
    setBusy("address");
    try {
      await props.hosting.setPublicAddress(addressValue.trim());
      setAddressDraft(null);
    } catch (err) {
      // The main process says exactly what is wrong with the address; a
      // rewritten message here would only be vaguer than the real one.
      setAddressError(
        err instanceof Error && err.message
          ? err.message
          : "The address could not be saved. Try again.",
      );
      addressField.current?.focus();
    } finally {
      await refresh();
      operationPending.current = false;
      setBusy(null);
    }
  }

  /** The sections of a running workspace, each only where this app can do what it holds. */
  const sections: Section[] = [];
  if (!statusError && status && (status.running || changing)) {
    sections.push("overview");
    if (!status.isolated && (props.hosting.openToAll || props.hosting.relay))
      sections.push("internet");
    if (status.folder && (backupFn || props.hosting.setAutoBackup)) sections.push("backups");
    sections.push("advanced");
  }
  const live = sections.length > 0;
  const shown = sections.includes(section) ? section : "overview";
  const tabs = useTabs({ label: "Hosting", tabs: sections, selected: shown, onSelect: setSection });
  const addressId = useId();
  // A phone opens what the code holds, so it holds a whole address: the
  // public one where there is one, as it works from anywhere.
  const qrTarget = publicUrl ?? (status?.lanUrls?.[0] ? `http://${status.lanUrls[0]}` : null);

  return (
    <Dialog
      title={status?.running ? "Workspace is live" : "Host a workspace"}
      onClose={() => {
        if (!operationPending.current) props.onClose();
      }}
      dismissible={!busy}
      width={live ? 560 : 500}
      ownScroll
    >
      {!statusError && status && (status.running || changing) ? (
        <>
          <div
            {...tabs.listProps}
            className="tab-strip mx-6 mb-3 flex shrink-0 gap-1 overflow-x-auto rounded-lg bg-ground p-1"
          >
            {sections.map((s) => (
              <button
                key={s}
                {...tabs.tabProps(s)}
                className={`flex-auto whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  shown === s ? "bg-lifted text-ink" : "text-ink-dim hover:text-ink"
                }`}
              >
                {SECTION_NAMES[s]}
              </button>
            ))}
          </div>
          <div {...tabs.panelProps} className="flex min-h-0 flex-1 flex-col">
            {/* A section opens at its top. */}
            <DialogScroll key={shown}>
              {/* Tall enough for the overview, so moving between sections keeps Stop hosting where it was. */}
              <div className="space-y-4 text-sm sm:min-h-[21rem]">
                {shown === "overview" && (
                  <>
                    {renameFn &&
                    status.folder &&
                    renaming === status.folder &&
                    phase === "running" ? (
                      <RenameForm
                        folder={status.folder}
                        name={status.workspaceName ?? ""}
                        blocked={unavailable}
                        saving={busy === "renaming"}
                        onSave={(next) =>
                          saveName(status.folder!, status.workspaceName ?? "", next)
                        }
                        onCancel={closeRename}
                      />
                    ) : (
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                          <p
                            role="status"
                            className="min-w-0 break-words text-[15px] font-semibold text-ink"
                          >
                            {phase === "starting"
                              ? "Starting workspace…"
                              : phase === "stopping"
                                ? "Stopping workspace…"
                                : (status.workspaceName ?? "Workspace hosted on this computer")}
                          </p>
                          {phase === "running" && (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-online/15 px-2 py-0.5 text-xs font-medium text-online">
                              <span
                                aria-hidden="true"
                                className="size-1.5 rounded-full bg-online"
                              />
                              {status.isolated ? "Only on this computer" : "Live"}
                            </span>
                          )}
                        </div>
                        {renameFn &&
                          status.folder &&
                          status.workspaceName &&
                          phase === "running" && (
                            <button
                              id={`rename-${status.folder}`}
                              type="button"
                              disabled={unavailable}
                              aria-label={`Rename ${status.workspaceName}`}
                              onClick={() => setRenaming(status.folder!)}
                              className={`${linkBtnCls} shrink-0`}
                            >
                              Rename
                            </button>
                          )}
                      </div>
                    )}
                    <LaunchProblem
                      hosting={props.hosting}
                      message={status.launchError}
                      onRetry={
                        status.launchErrorPart === "public-address" &&
                        status.launchErrorFolder === status.folder &&
                        phase === "running" &&
                        !status.isolated &&
                        !status.openToAll &&
                        !status.publicAddressError &&
                        status.tunnelAvailable !== false &&
                        props.hosting.openToAll
                          ? () => void openToAll()
                          : null
                      }
                      disabled={unavailable}
                      onDismissed={() => void refresh()}
                      onError={(text) => setBackupNote(text ? { ok: false, text } : null)}
                    />
                    {status.isolated && (
                      <p role="status" className="card-warm rounded-xl p-3 text-sm">
                        You are looking inside {status.workspaceName ?? "a restored workspace"}.
                        Only this computer can reach it, nothing it had waiting is sent, and no app
                        is called. Stop it, then choose Put back in use from the list when it is
                        ready.
                      </p>
                    )}
                    {/* Only this computer reaches a workspace being looked inside. */}
                    {!status.isolated && (publicUrl || !!status.lanUrls?.length) && (
                      <div className="flex gap-4 rounded-xl border border-edge p-3">
                        <div className="min-w-0 flex-1 space-y-3">
                          {publicUrl && (
                            <div>
                              <p className="mb-1 text-ink-dim">Anyone can join at</p>
                              <AddressRow
                                url={publicUrl}
                                id={`${addressId}-public`}
                                copyLabel={copyLabel}
                                onCopy={() => void copy(publicUrl, "public-overview")}
                                copyKey="public-overview"
                              />
                            </div>
                          )}
                          {!!status.lanUrls?.length && (
                            <div>
                              <p className="mb-1 text-ink-dim">
                                {publicUrl ? "On this network" : "Teammates can connect at"}
                              </p>
                              <ul className="space-y-1">
                                {status.lanUrls.map((url, at) => (
                                  <li key={url}>
                                    <AddressRow
                                      url={url}
                                      id={`${addressId}-lan-${at}`}
                                      copyLabel={copyLabel}
                                      onCopy={() => void copy(url, `lan-${url}`)}
                                      copyKey={`lan-${url}`}
                                    />
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {qrTarget && (
                            <p className="text-xs text-ink-faint">
                              {publicUrl
                                ? "Or scan the code with a phone to open the workspace."
                                : "Or scan the code with a phone on this network to open the workspace."}
                            </p>
                          )}
                        </div>
                        {qrTarget && (
                          <QrCode value={qrTarget} label={`QR code for ${qrTarget}`} size={104} />
                        )}
                      </div>
                    )}
                    {status.running &&
                      !status.isolated &&
                      !status.lanUrls?.length &&
                      !publicUrl && (
                        <p className="text-ink-dim">
                          No network address is available. Check this computer’s network connection.
                        </p>
                      )}
                    {status.connected !== undefined && phase === "running" && (
                      <p className="text-ink-dim">
                        Connected now:{" "}
                        <span className="text-ink">
                          {status.connected === 0
                            ? "nobody"
                            : status.connected === 1
                              ? "1 person"
                              : `${status.connected} people`}
                        </span>
                      </p>
                    )}
                    {phase === "running" &&
                      (props.viewingHosted ? (
                        props.onInvite && (
                          <button
                            type="button"
                            className={buttonClass("primary")}
                            disabled={unavailable}
                            onClick={props.onInvite}
                          >
                            Invite people
                          </button>
                        )
                      ) : (
                        <button
                          type="button"
                          className={buttonClass("primary")}
                          disabled={unavailable || !status.running || status.port === undefined}
                          onClick={() => props.onStarted(status)}
                        >
                          Open it
                        </button>
                      ))}
                    {status.running && phase !== "stopping" && (
                      <p className="text-ink-dim">
                        {status.backgroundAvailable === true
                          ? "Closing this window keeps the workspace running in the system tray. Use the tray to reopen Tandem or stop hosting."
                          : status.backgroundAvailable === false
                            ? "Closing this window minimizes Tandem while hosting. Keep the app running so teammates can stay connected."
                            : "Keep Tandem running so teammates can stay connected."}
                      </p>
                    )}
                  </>
                )}
                {shown === "internet" && (
                  <>
                    {props.hosting.openToAll && (
                      <div>
                        <h3 className="font-semibold text-ink">
                          Let people outside your network join
                        </h3>
                        <p className="mt-1 text-ink-dim">
                          {publicUrl
                            ? "People anywhere can reach this workspace at its public address while it is open. Messages and files still stay on this computer."
                            : "Only people on the same network as this computer can join now. Give the workspace an address on the internet so people at home or on mobile data can join too. Messages and files stay on this computer."}
                        </p>
                      </div>
                    )}
                    {props.hosting.openToAll && !status.isolated && (
                      <div className="card-warm rounded-xl p-3">
                        <div className="mb-1 flex items-center justify-between gap-3">
                          <h3 className="font-semibold text-ink">Open to all</h3>
                          {publicUrl && (
                            <span className="rounded-full bg-copper/15 px-2 py-0.5 text-xs text-copper">
                              Public
                            </span>
                          )}
                        </div>
                        <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
                          {publicUrl
                            ? `Public link open at ${publicUrl}`
                            : status.openToAll?.phase === "opening"
                              ? "Opening public link"
                              : "Public link closed"}
                        </p>
                        {tunnelError && (
                          <p role="alert" className="mb-2 text-xs text-alert">
                            {tunnelError}
                          </p>
                        )}
                        {publicUrl ? (
                          <>
                            <p className="mb-2 text-xs text-ink-dim">
                              {!status.publicAddress
                                ? "This temporary address works from anywhere while Tandem and cloudflared stay running."
                                : status.publicAddressManaged
                                  ? "This configured address stays the same when you reopen the public link. Keep Tandem and its Cloudflare connector running so teammates can connect."
                                  : "This configured address stays the same when you reopen it. Tandem can stop publishing the address, but only you can stop its external tunnel or proxy and make it unreachable."}
                            </p>
                            <div className="flex items-center justify-between gap-2 rounded-lg border border-edge bg-raised p-2">
                              <a
                                href={publicUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="min-w-0 break-all font-mono text-xs text-ink underline decoration-ink-faint/60 underline-offset-2 hover:decoration-ink"
                              >
                                {publicUrl}
                              </a>
                              <button
                                type="button"
                                onClick={() => void copy(publicUrl, "public-address")}
                                className="shrink-0 rounded px-2 py-1 text-xs text-ink-dim hover:bg-ink/[0.05]"
                              >
                                <Swap text>
                                  {copyLabel(
                                    "Copy address",
                                    "Copied",
                                    "Copy failed",
                                    "public-address",
                                  )}
                                </Swap>
                              </button>
                            </div>
                            {guestsSupported && livePolicy ? (
                              <JoinPolicy
                                policy={livePolicy}
                                disabled={!!busy}
                                onChange={(next) => void changeAccessPolicy(next)}
                              />
                            ) : (
                              <label className="mt-3 flex items-start gap-2 text-xs text-ink-dim">
                                <input
                                  type="checkbox"
                                  checked={status.inviteOnly ?? requireInvite}
                                  disabled={!!busy || !props.hosting.setInviteOnly}
                                  onChange={(event) =>
                                    void changeInvitePolicy(event.target.checked)
                                  }
                                  className="mt-0.5"
                                />
                                <span>
                                  Require an invite link to create an account. Recommended for every
                                  public workspace.
                                </span>
                              </label>
                            )}
                            <p className="mt-2 text-xs text-ink-dim">
                              {livePolicy === "guest_allowed"
                                ? "Anyone with this address can join as a guest for a day and post in public channels. Requiring an account again signs every guest out."
                                : status.inviteOnly
                                  ? "In the workspace, choose Workspace → Invite people, generate a code, and copy its Browser link."
                                  : "Anyone with this address can create an account. Send the address only to people you trust."}
                            </p>
                            <button
                              type="button"
                              disabled={!!busy}
                              onClick={() => void endOpenToAll()}
                              className="mt-3 rounded-lg border border-edge px-3 py-2 text-xs text-ink-dim hover:text-ink disabled:opacity-40"
                            >
                              {busy === "closing"
                                ? externallyCarried
                                  ? "Stopping use of address…"
                                  : "Closing public link…"
                                : externallyCarried
                                  ? "Stop using address"
                                  : "Close public link"}
                            </button>
                          </>
                        ) : (
                          <>
                            {status.publicAddress ? (
                              <div className="space-y-2 text-xs text-ink-dim">
                                <p>
                                  Open this workspace at your own address, which does not change:
                                </p>
                                <p className="break-all font-mono text-ink">
                                  {status.publicAddress}
                                </p>
                                {status.port !== undefined && (
                                  <p>
                                    {status.publicAddressManaged ? "In Cloudflare, route" : "Send"}{" "}
                                    this address to{" "}
                                    <code className="break-all text-ink">{`http://127.0.0.1:${status.port}`}</code>
                                    .
                                  </p>
                                )}
                                <p>Keep Tandem running so teammates can connect.</p>
                                {externallyCarried && (
                                  <p>
                                    Its external tunnel or proxy may already make this workspace
                                    reachable. Tandem requires invites when you save the address;
                                    stop the carrier separately when you want the address itself to
                                    become unreachable.
                                  </p>
                                )}
                              </div>
                            ) : (
                              <p className="text-xs text-ink-dim">
                                Create a temporary HTTPS address through Cloudflare Tunnel. No
                                router setup or Cloudflare account is needed.
                              </p>
                            )}
                            {props.hosting.setPublicAddress && (
                              <div className="mt-3 border-t border-edge pt-3">
                                <label
                                  htmlFor="public-address"
                                  className="block text-xs font-medium text-ink-dim"
                                >
                                  Your own address
                                </label>
                                <p id="public-address-help" className="mt-1 text-xs text-ink-dim">
                                  Already have a Tailscale Funnel, reverse proxy, or tunnel of your
                                  own pointing here? Enter its address to reuse the same link every
                                  time. Leave it empty to{" "}
                                  {status.publicAddressManaged
                                    ? "use the configured Cloudflare address"
                                    : "create a temporary address"}
                                  .
                                </p>
                                <form
                                  noValidate
                                  className="mt-2 flex gap-2"
                                  onSubmit={(event) => {
                                    event.preventDefault();
                                    void saveAddress();
                                  }}
                                >
                                  <input
                                    ref={addressField}
                                    id="public-address"
                                    type="url"
                                    inputMode="url"
                                    spellCheck={false}
                                    placeholder="https://box.tail1234.ts.net"
                                    value={addressValue}
                                    // Off only when the environment fixes it; read-only
                                    // while saving, so focus stays here.
                                    disabled={status.publicAddressLocked}
                                    readOnly={busy === "address"}
                                    aria-describedby={`public-address-help${addressError ? " public-address-error" : ""}`}
                                    aria-invalid={!!addressError}
                                    aria-errormessage={
                                      addressError ? "public-address-error" : undefined
                                    }
                                    onChange={(event) => {
                                      setAddressDraft(event.target.value);
                                      setAddressError(null);
                                      setAddressUnchanged(false);
                                    }}
                                    className={inputClass(
                                      "small",
                                      "flex-1 font-mono disabled:opacity-40",
                                    )}
                                  />
                                  {/* Never off for want of a change: sent unchanged, it says so. */}
                                  <button
                                    type="submit"
                                    disabled={status.publicAddressLocked}
                                    aria-disabled={!!busy || undefined}
                                    className="h-8 shrink-0 rounded-lg border border-edge px-3 text-xs text-ink-dim hover:text-ink disabled:opacity-40"
                                  >
                                    {busy === "address" ? "Saving…" : "Save"}
                                  </button>
                                </form>
                                {status.publicAddressLocked && (
                                  <p className="mt-2 text-xs text-ink-dim">
                                    This address comes from an environment variable, so it cannot be
                                    changed here.
                                  </p>
                                )}
                                {addressError && (
                                  <p
                                    id="public-address-error"
                                    role="alert"
                                    className="mt-2 text-xs text-alert"
                                  >
                                    {addressError}
                                  </p>
                                )}
                                <p role="status" className="mt-2 text-xs text-ink-dim empty:hidden">
                                  {addressUnchanged
                                    ? "Nothing to save: that is the address already saved."
                                    : ""}
                                </p>
                              </div>
                            )}
                            {status.tunnelAvailable === false ? (
                              <div className="mt-3 text-xs text-ink-dim">
                                <p>Install Cloudflare’s cloudflared tool, then check again.</p>
                                <button
                                  type="button"
                                  disabled={!!busy}
                                  onClick={() => void refresh()}
                                  className="mt-2 font-medium text-ink underline decoration-ink-faint/60 underline-offset-2 hover:decoration-ink disabled:opacity-40"
                                >
                                  Check again
                                </button>
                              </div>
                            ) : (
                              <>
                                {guestsSupported ? (
                                  <JoinPolicy
                                    policy={openPolicy}
                                    disabled={!!busy}
                                    onChange={setOpenPolicy}
                                  />
                                ) : (
                                  <label className="mt-3 flex items-start gap-2 text-xs text-ink-dim">
                                    <input
                                      type="checkbox"
                                      checked={requireInvite}
                                      disabled={!!busy}
                                      onChange={(event) => setRequireInvite(event.target.checked)}
                                      className="mt-0.5"
                                    />
                                    <span>
                                      Require an invite link to create an account. Recommended and
                                      enabled by default.
                                    </span>
                                  </label>
                                )}
                                <button
                                  type="button"
                                  disabled={
                                    unavailable ||
                                    !!status.publicAddressError ||
                                    status.openToAll?.phase === "opening"
                                  }
                                  onClick={() => void openToAll()}
                                  className={buttonClass("primary", "mt-3 w-full")}
                                >
                                  {busy === "opening" || status.openToAll?.phase === "opening"
                                    ? "Opening public link…"
                                    : "Open to all"}
                                </button>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    )}
                    {props.hosting.relay && !status.isolated && (
                      <CallRelaySettings relay={props.hosting.relay} disabled={unavailable} />
                    )}
                  </>
                )}
                {shown === "backups" && (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="min-w-0 text-ink-dim">
                        {!runningEntry
                          ? "Backups copy the workspace into a folder you choose."
                          : runningEntry.lastBackupAt === null
                            ? "This workspace has not been backed up from this computer yet."
                            : `Last backed up ${backedUpWhen(runningEntry.lastBackupAt)}.`}
                      </p>
                      {backupFn && status.folder && (
                        <button
                          type="button"
                          disabled={unavailable}
                          className={buttonClass("secondary", "shrink-0")}
                          onClick={() =>
                            void backUp(status.folder!, status.workspaceName ?? "the workspace")
                          }
                        >
                          {busy === "backing-up" ? "Backing up…" : "Back up now"}
                        </button>
                      )}
                    </div>
                    {status.folder &&
                      status.workspaceName &&
                      phase === "running" &&
                      runningEntry && (
                        <AutoBackupSettings
                          hosting={props.hosting}
                          folder={status.folder}
                          name={status.workspaceName}
                          schedule={runningEntry.autoBackup ?? null}
                          error={runningEntry.autoBackupError ?? null}
                          held={!!runningEntry.restored}
                          disabled={unavailable}
                          onNote={setBackupNote}
                          onChanged={() => setListRevision((n) => n + 1)}
                        />
                      )}
                  </>
                )}
                {shown === "advanced" && (
                  <>
                    {status.folder && status.workspaceName && phase === "running" && (
                      <StartWithComputer
                        hosting={props.hosting}
                        folder={status.folder}
                        name={status.workspaceName}
                        startsOnLaunch={!!status.startsOnLaunch}
                        publicAddress={status.publicAddressError ? undefined : status.publicAddress}
                        reopensPublic={!!status.reopensPublicOnLaunch}
                        disabled={unavailable}
                        onError={(text) => setBackupNote(text ? { ok: false, text } : null)}
                      />
                    )}
                    {status.dataDir && (
                      <div>
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-ink-dim">Workspace data folder</p>
                          {openFolderFn && status.folder && (
                            <button
                              type="button"
                              onClick={() => void openFolder(status.folder!)}
                              className={`${linkBtnCls} shrink-0`}
                            >
                              Open folder
                            </button>
                          )}
                        </div>
                        <p className="break-all font-mono text-xs text-ink">{status.dataDir}</p>
                      </div>
                    )}
                    {status.port !== undefined && (
                      <div>
                        <p className="text-ink-dim">
                          Local port: <span className="font-mono text-ink">{status.port}</span>
                        </p>
                        {setPortFn && (
                          <p className="mt-1 text-xs text-ink-faint">
                            To use another port, stop hosting, then choose Change port beside the
                            workspace.
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </DialogScroll>
          </div>
          {/* The footer's own padding outranks a utility, so the space under its rule is inside. */}
          <div className="dialog-foot border-t border-edge">
            <div className="pt-4">
              {backupStatus}
              {status.warning && (
                <p
                  role="alert"
                  className="mb-3 rounded-lg border border-alert/40 bg-alert/10 p-3 text-sm"
                >
                  {status.warning}
                </p>
              )}
              {/* A public link's own problem is said in its card, when that is in sight. */}
              {error && !(error.tunnel && tunnelError && shown === "internet") && (
                <p role="alert" className="mb-3 text-sm text-alert">
                  {error.message}
                </p>
              )}
              <div className="flex items-center justify-between gap-3">
                <p role="status" className="min-w-0 text-sm text-ink-dim">
                  {loading ? "Checking hosting status…" : ""}
                </p>
                {/* Ending the workspace for everyone stands apart from the rest. */}
                <button
                  type="button"
                  disabled={unavailable}
                  className="inline-flex h-9 shrink-0 items-center rounded-lg border border-alert/30 px-3.5 text-sm font-medium text-alert transition-colors hover:bg-alert/10 disabled:opacity-40"
                  onClick={() => void stop()}
                >
                  {busy === "stopping" ? "Stopping…" : "Stop hosting"}
                </button>
              </div>
            </div>
          </div>
        </>
      ) : (
        <DialogScroll>
          {loading && (
            <p role="status" className="mb-4 text-sm text-ink-dim">
              Checking hosting status…
            </p>
          )}
          {statusError && (
            <div
              role="alert"
              className="mb-4 rounded-lg border border-alert/40 bg-alert/10 p-3 text-sm"
            >
              <p>Could not check whether this computer is hosting a workspace.</p>
              <button
                type="button"
                onClick={() => void refresh()}
                className="mt-2 font-medium text-ink underline decoration-ink-faint/60 hover:decoration-ink"
              >
                Retry status
              </button>
            </div>
          )}
          {status?.warning && (
            <p
              role="alert"
              className="mb-4 rounded-lg border border-alert/40 bg-alert/10 p-3 text-sm"
            >
              {status.warning}
            </p>
          )}
          {error && !(error.tunnel && tunnelError) && (
            <p role="alert" className="mb-4 text-sm text-alert">
              {error.message}
            </p>
          )}
          {!loading && !statusError && status ? (
            <>
              <p className="mb-4 text-sm text-ink-dim">
                Your computer becomes the server. Teammates on your network can connect while Tandem
                is running. Messages, files and accounts are stored on this machine.
              </p>
              <LaunchProblem
                hosting={props.hosting}
                message={status.launchError}
                onRetry={null}
                disabled={unavailable}
                className="mb-4"
                onDismissed={() => void refresh()}
                onError={(text) => setBackupNote(text ? { ok: false, text } : null)}
              />
              {listFailed && (
                <p role="alert" className="mb-4 text-sm text-alert">
                  {listFailed}
                </p>
              )}
              {backupStatus}
              <StartupWhileStopped
                hosting={props.hosting}
                chosen={existing.find((w) => w.startsOnLaunch) ?? null}
                launchError={status.launchError}
                disabled={unavailable}
                onChanged={() => setListRevision((n) => n + 1)}
                onError={(text) => setBackupNote(text ? { ok: false, text } : null)}
              />
              {existing.length > 0 && (
                <section aria-label="Hosted on this computer" className="mb-5">
                  <h3 className="mb-2 text-[13px] font-semibold text-ink">
                    Hosted on this computer
                  </h3>
                  <ul className="space-y-2">
                    {existing.map((w) => (
                      <li
                        key={w.folder}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-edge px-3 py-2"
                      >
                        {setPortFn && changingPort === w.folder && !w.missing ? (
                          <PortForm
                            folder={w.folder}
                            name={w.name}
                            port={w.port}
                            saving={busy === "renaming"}
                            onSave={(port) => savePort(w.folder, w.name, port)}
                            onCancel={() => {
                              portReturn.current = w.folder;
                              setChangingPort(null);
                            }}
                          />
                        ) : renameFn && renaming === w.folder && !w.missing ? (
                          <RenameForm
                            folder={w.folder}
                            name={w.name}
                            blocked={unavailable}
                            saving={busy === "renaming"}
                            onSave={(next) => saveName(w.folder, w.name, next)}
                            onCancel={closeRename}
                          />
                        ) : (
                          <>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm text-ink">{w.name}</p>
                              <p className="text-xs text-ink-dim">
                                {w.missing
                                  ? "Its folder is missing, so it cannot start"
                                  : `${w.restored ? "Restored, not in use yet · " : ""}Port ${w.port}${w.startsOnLaunch ? " · Starts with Tandem" : ""}${
                                      w.autoBackup
                                        ? `${w.autoBackup.everyDays === 1 ? " · Backs up daily" : " · Backs up weekly"}${
                                            w.restored ? " once back in use" : ""
                                          }`
                                        : ""
                                    }${
                                      backupFn
                                        ? w.lastBackupAt === null
                                          ? " · Not backed up yet"
                                          : ` · Backed up ${backedUpWhen(w.lastBackupAt)}`
                                        : ""
                                    }`}
                              </p>
                              {/* The running one says so under Automatic backups, with Try again. */}
                              {w.autoBackupError && !w.running && (
                                <p className="text-xs text-alert">{w.autoBackupError}</p>
                              )}
                              {!w.missing && (renameFn || openFolderFn || setPortFn) && (
                                <div className="mt-1 flex gap-3">
                                  {renameFn && (
                                    <button
                                      id={`rename-${w.folder}`}
                                      type="button"
                                      disabled={unavailable}
                                      aria-label={`Rename ${w.name}`}
                                      onClick={() => setRenaming(w.folder)}
                                      className={linkBtnCls}
                                    >
                                      Rename
                                    </button>
                                  )}
                                  {setPortFn && (
                                    <button
                                      id={`port-${w.folder}`}
                                      type="button"
                                      disabled={unavailable}
                                      aria-label={`Change port for ${w.name}`}
                                      onClick={() => {
                                        setRenaming(null);
                                        setChangingPort(w.folder);
                                      }}
                                      className={linkBtnCls}
                                    >
                                      Change port
                                    </button>
                                  )}
                                  {openFolderFn && (
                                    <button
                                      type="button"
                                      aria-label={`Open folder for ${w.name}`}
                                      onClick={() => void openFolder(w.folder)}
                                      className={linkBtnCls}
                                    >
                                      Open folder
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                            {backupFn && !w.missing && (
                              <button
                                type="button"
                                disabled={unavailable}
                                aria-label={`Back up ${w.name}`}
                                onClick={() => void backUp(w.folder, w.name)}
                                className="shrink-0 rounded-lg border border-edge px-3 py-1.5 text-sm text-ink-dim hover:text-ink disabled:opacity-40"
                              >
                                Back up
                              </button>
                            )}
                            {w.missing && forgetFn ? (
                              <button
                                type="button"
                                disabled={unavailable}
                                aria-label={`Remove ${w.name} from the list`}
                                onClick={() => void removeMissing(w.folder, w.name)}
                                className="shrink-0 rounded-lg border border-edge px-3 py-1.5 text-sm text-ink-dim hover:text-ink disabled:opacity-40"
                              >
                                Remove
                              </button>
                            ) : (
                              <>
                                {w.restored && !w.missing && (
                                  <button
                                    type="button"
                                    disabled={unavailable}
                                    aria-label={`Put ${w.name} back in use`}
                                    onClick={() => setActivating(w.folder)}
                                    className="shrink-0 rounded-lg border border-edge px-3 py-1.5 text-sm text-ink-dim hover:text-ink disabled:opacity-40"
                                  >
                                    Put back in use…
                                  </button>
                                )}
                                <button
                                  type="button"
                                  disabled={unavailable || w.missing}
                                  aria-label={
                                    w.restored ? `Look inside ${w.name}` : `Start hosting ${w.name}`
                                  }
                                  onClick={() => void launch({ folder: w.folder })}
                                  className="shrink-0 rounded-lg border border-edge px-3 py-1.5 text-sm text-ink hover:border-copper disabled:opacity-40"
                                >
                                  {w.restored ? "Look inside" : "Start"}
                                </button>
                              </>
                            )}
                          </>
                        )}
                        {activating === w.folder && (
                          <div
                            role="region"
                            aria-label={`Put ${w.name} back in use?`}
                            className="mt-2 w-full space-y-2 rounded-lg border border-edge bg-ground p-3 text-sm text-ink-dim"
                          >
                            <p>
                              {w.name} starts as the workspace itself: it sends the messages it had
                              waiting, calls its apps again, and accepts every sign-in it held when
                              the backup was taken, including ones ended since. Ask people to check
                              their signed-in devices afterwards.
                            </p>
                            <div className="flex gap-3">
                              <button
                                type="button"
                                disabled={unavailable}
                                onClick={() => {
                                  setActivating(null);
                                  void launch({ folder: w.folder, activate: true });
                                }}
                                className="btn-shape bg-copper px-3 py-1.5 text-sm font-medium text-ground disabled:opacity-40"
                              >
                                Put back in use
                              </button>
                              <button
                                type="button"
                                onClick={() => setActivating(null)}
                                className={linkBtnCls}
                              >
                                Not yet
                              </button>
                            </div>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                  {hosted!.unreadable.length > 0 && (
                    <p className="mt-2 text-xs text-ink-dim">
                      Could not read the workspace in{" "}
                      {hosted!.unreadable.length === 1 ? "the folder" : "the folders"}{" "}
                      {hosted!.unreadable.join(", ")}, so it is not listed.
                    </p>
                  )}
                  <h3 className="mt-5 text-[13px] font-semibold text-ink">New workspace</h3>
                </section>
              )}
              <form onSubmit={start} className="space-y-3">
                <label className="block">
                  <span className="mb-1.5 block text-[13px] font-medium text-ink-dim">
                    Workspace name
                  </span>
                  <input
                    ref={nameInput}
                    autoFocus
                    maxLength={80}
                    value={name}
                    disabled={!!busy}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Workspace name (e.g. Rocket Team)"
                    className={inputCls}
                  />
                </label>
                <details className="text-sm text-ink-dim">
                  <summary className="cursor-pointer">Choose a port</summary>
                  <label className="mt-2 block">
                    Port
                    <input
                      inputMode="numeric"
                      maxLength={5}
                      value={portText}
                      disabled={!!busy}
                      onChange={(e) => setPortText(e.target.value)}
                      placeholder="8543"
                      aria-describedby="host-port-hint"
                      className={`${inputCls} mt-1 w-32 font-mono`}
                    />
                  </label>
                  <p id="host-port-hint" className="mt-1 text-xs text-ink-faint">
                    Leave it empty to use 8543, or a free port if another program has that one. A
                    port you choose is kept, or the workspace does not start.
                  </p>
                </details>
                {sameName && (
                  <p className="text-xs text-ink-dim">
                    {sameName.name} is already hosted here. Start it from the list to keep its
                    messages; this starts a separate, empty workspace.
                  </p>
                )}
                <button
                  type="submit"
                  disabled={unavailable}
                  className={buttonClass("primary", "w-full")}
                >
                  {busy === "starting"
                    ? "Starting…"
                    : existing.length > 0
                      ? "Start new workspace"
                      : "Start hosting"}
                </button>
              </form>
              {restoreFn && (
                <button
                  type="button"
                  disabled={unavailable}
                  onClick={() => void restoreBackup()}
                  className={buttonClass("secondary", "mt-3 w-full")}
                >
                  {busy === "restoring" ? "Restoring…" : "Restore from a backup…"}
                </button>
              )}
            </>
          ) : null}
        </DialogScroll>
      )}
    </Dialog>
  );
}

/**
 * Who may join, as two choices: whether joining needs an account at all, and,
 * where it does, whether creating one needs an invite. Turning accounts back
 * on goes back to the account rule last in use here, or to invites.
 */
function JoinPolicy(props: {
  policy: AccessPolicy;
  disabled: boolean;
  onChange: (policy: AccessPolicy) => void;
}) {
  const lastAccountPolicy = useRef<AccessPolicy>("invite_only");
  if (props.policy !== "guest_allowed") lastAccountPolicy.current = props.policy;
  const accountRequired = props.policy !== "guest_allowed";
  return (
    <div className="mt-3 space-y-2 text-xs text-ink-dim">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={accountRequired}
          disabled={props.disabled}
          onChange={(event) =>
            props.onChange(event.target.checked ? lastAccountPolicy.current : "guest_allowed")
          }
          className="mt-0.5"
        />
        <span>Require an account to join.</span>
      </label>
      {accountRequired ? (
        <label className="ml-6 flex items-start gap-2">
          <input
            type="checkbox"
            checked={props.policy === "invite_only"}
            disabled={props.disabled}
            onChange={(event) =>
              props.onChange(event.target.checked ? "invite_only" : "account_required")
            }
            className="mt-0.5"
          />
          <span>
            Require an invite link to create an account. Recommended for every public workspace.
          </span>
        </label>
      ) : (
        <p className="ml-6">Visitors can join as guests. Creating an account is optional.</p>
      )}
    </div>
  );
}
