import { useState, type Dispatch, type SetStateAction } from "react";
import {
  failureMessage,
  type AutoBackup,
  type HostedWorkspaces,
  type HostingStatus,
} from "../platform.js";
import { buttonClass } from "./Button.js";
import {
  backedUpWhen,
  linkBtnCls,
  type Hosting,
  type HostingBusy,
  type HostNote,
} from "./hostParts.js";

/** The Backups tab of a running workspace: its last backup, Back up now and the schedule. */
export function HostBackups(props: {
  hosting: Hosting;
  status: HostingStatus;
  phase: HostingStatus["phase"];
  /** The running workspace's entry in the list, once the list is read. */
  runningEntry: HostedWorkspaces["workspaces"][number] | undefined;
  busy: HostingBusy;
  unavailable: boolean;
  backUp: (folder: string, name: string) => Promise<void>;
  setBackupNote: (note: HostNote | null) => void;
  setListRevision: Dispatch<SetStateAction<number>>;
}) {
  const { status, phase, runningEntry, busy, unavailable, backUp, setBackupNote, setListRevision } =
    props;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-ink-dim">
          {!runningEntry
            ? "Backups copy the workspace into a folder you choose."
            : runningEntry.lastBackupAt === null
              ? "This workspace has not been backed up from this computer yet."
              : `Last backed up ${backedUpWhen(runningEntry.lastBackupAt)}.`}
        </p>
        {status.folder && (
          <button
            type="button"
            disabled={unavailable}
            className={buttonClass("secondary", "shrink-0")}
            onClick={() => void backUp(status.folder!, status.workspaceName ?? "the workspace")}
          >
            {busy === "backing-up" ? "Backing up…" : "Back up now"}
          </button>
        )}
      </div>
      {status.folder && status.workspaceName && phase === "running" && runningEntry && (
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
  );
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
  if (props.held && !schedule) return null;

  async function save(
    next: { everyDays: 1 | 7; keep: number } | null,
    chooseFolder: boolean,
    said: (result: AutoBackup | null) => string,
  ) {
    setSaving(true);
    props.onNote(null);
    try {
      const result = await setAutoBackup(props.folder, next, chooseFolder);
      // No folder chosen: nothing changed, and nothing needs saying.
      if (result === undefined) return;
      props.onNote({ ok: true, text: said(result) });
      props.onChanged();
    } catch (reason) {
      props.onNote({
        ok: false,
        text: failureMessage(reason, "The backup schedule could not be saved. Try again."),
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
      await retryBackups();
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
              Automatic backups of {props.name} are paused until it is back in use. Nothing in{" "}
              <span className="break-all font-mono text-xs">{schedule.destination}</span> is
              deleted. After that, OwnBase backs it up {often(schedule.everyDays)} and keeps the
              newest {schedule.keep}.
            </p>
          ) : (
            <p className="text-ink">
              OwnBase backs up {props.name} {often(schedule.everyDays)} to{" "}
              <span className="break-all font-mono text-xs">{schedule.destination}</span> and keeps
              the newest {schedule.keep}.
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
                    `Automatic backups of ${props.name} are off. Backups already made stay where they are.`,
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
            OwnBase can back up {props.name} every day to a folder you choose, ideally on another
            drive. It keeps the newest seven and deletes older ones from that folder.
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
          {schedule && schedule.failure?.kind !== "cleanup" && !props.held && (
            <button type="button" className={linkBtnCls} onClick={() => void retry()}>
              {retrying ? "Trying again…" : "Try again"}
            </button>
          )}
        </div>
      )}
    </fieldset>
  );
}
