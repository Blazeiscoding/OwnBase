import { useCallback, useEffect, useState } from "react";
import type { UpdateStatus } from "../platform.js";
import { usePlatform } from "../context.js";
import { formatDay, formatTime, sameDay } from "../lib/format.js";
import { useSaved } from "../lib/savedNote.js";
import { settingMark } from "../lib/settingsSearch.js";
import { Banner, BannerAction } from "./Banner.js";
import { buttonClass } from "./Button.js";
import { useConfirm } from "./Confirm.js";
import { useToast } from "./Toast.js";

const RESTART_FAILED = "OwnBase could not restart. Quit and open it again to update.";

/** Where the app's own updates have got, followed as they change; null until known. */
export function useUpdateStatus(): UpdateStatus | null {
  const updates = usePlatform().updates;
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    if (!updates) return;
    let live = true;
    const off = updates.subscribe((next) => live && setStatus(next));
    void updates.status().then(
      (next) => live && setStatus((now) => now ?? next),
      () => {},
    );
    return () => {
      live = false;
      off();
    };
  }, [updates]);
  return status;
}

/**
 * Tells the app whether a call is on, so an update never restarts it in the
 * middle of one. A call ends, as far as updates go, when the workspace closes.
 */
export function useReportCall(inCall: boolean): void {
  const updates = usePlatform().updates;
  useEffect(() => {
    if (!updates) return;
    void updates.reportCall(inCall).catch(() => {});
    return () => void updates.reportCall(false).catch(() => {});
  }, [updates, inCall]);
}

/**
 * "Restart to update", wherever it is pressed. When the restart disconnects
 * the people in a workspace hosted here, it asks first in the app's own
 * dialog. Resolves to why it did not restart, or null when it is restarting
 * or the person chose to wait.
 */
export function useRestartToUpdate(): () => Promise<string | null> {
  const updates = usePlatform().updates;
  const confirm = useConfirm();
  return useCallback(async () => {
    if (!updates) return null;
    try {
      let answer = await updates.restart();
      if (!answer.restarting && answer.question) {
        const { title, detail, button } = answer.question;
        if (!(await confirm({ title, body: detail, confirmLabel: button }))) return null;
        answer = await updates.restart(true);
      }
      return answer.restarting ? null : (answer.reason ?? null);
    } catch {
      return RESTART_FAILED;
    }
  }, [updates, confirm]);
}

/**
 * The tray's "Restart to update". The main process restarts at once when
 * nothing stands in the way; otherwise it opens the window, which asks or
 * says why here, as its own button does.
 */
export function TrayRestart() {
  const updates = usePlatform().updates;
  const restart = useRestartToUpdate();
  const toast = useToast();
  useEffect(() => {
    if (!updates) return;
    let live = true;
    const run = () =>
      void restart().then((reason) => {
        if (live && reason) toast({ message: reason, kind: "info" });
      });
    const off = updates.onRestartAsked(run);
    void updates.takeRestartAsk().then(
      (asked) => live && asked && run(),
      () => {},
    );
    return () => {
      live = false;
      off();
    };
  }, [updates, restart, toast]);
  return null;
}

/**
 * "A new version is ready", in the place for banners, at most once a day
 * (the main process's updates.ts decides when). Windows restarts into it;
 * the Mac app opens the download page.
 */
export function UpdateBanner({ onShowing }: { onShowing?: (showing: boolean) => void }) {
  const updates = usePlatform().updates;
  const status = useUpdateStatus();
  const restart = useRestartToUpdate();
  const [refused, setRefused] = useState<string | null>(null);
  const showing = !!updates && !!status?.offer;
  useEffect(() => {
    onShowing?.(showing);
    return () => onShowing?.(false);
  }, [showing, onShowing]);
  if (!updates || !showing) return null;
  const later = () => {
    setRefused(null);
    void updates.later().catch(() => {});
  };
  if (updates.mode === "notify")
    return (
      <Banner
        tone="status"
        actions={
          <>
            <BannerAction onClick={() => void updates.openDownloadPage().catch(() => {})}>
              Get it
            </BannerAction>
            <BannerAction onClick={later}>Later</BannerAction>
          </>
        }
      >
        A new version of OwnBase is available.
      </Banner>
    );
  return (
    <Banner
      tone={refused ? "alert" : "status"}
      actions={
        <>
          <BannerAction onClick={() => void restart().then(setRefused)}>
            Restart to update
          </BannerAction>
          <BannerAction onClick={later}>Later</BannerAction>
        </>
      }
    >
      {refused ?? "A new version of OwnBase is ready. Restart to update."}
    </Banner>
  );
}

function checkedWhen(at: number): string {
  return sameDay(at, Date.now()) ? `today at ${formatTime(at)}` : formatDay(at);
}

/** What the Updates section of Account settings says about where updates have got. */
function statusLine(status: UpdateStatus): string | null {
  switch (status.phase) {
    case "checking":
      return "Looking for a new version…";
    case "downloading":
      return `Downloading ${status.newVersion}${status.progress !== undefined ? `, ${status.progress}%` : ""}…`;
    case "ready":
      return `${status.newVersion} is downloaded. It installs when you restart or quit OwnBase.`;
    case "available":
      return `${status.newVersion} is available on the website.`;
    case "failed":
      return status.error ?? "Could not check for a new version.";
    default:
      return status.checkedAt
        ? `This is the newest version. Last checked ${checkedWhen(status.checkedAt)}.`
        : null;
  }
}

/** The Updates section of Account settings, in the desktop app only. */
export function UpdateSettings() {
  const updates = usePlatform().updates;
  const status = useUpdateStatus();
  const saved = useSaved();
  const restart = useRestartToUpdate();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!updates) return null;
  const line = status ? statusLine(status) : null;
  const looking = status?.phase === "checking" || status?.phase === "downloading";
  return (
    <section aria-labelledby="account-updates-title" className="space-y-4">
      <div>
        <h3 id="account-updates-title" className="font-semibold">
          This version
        </h3>
        <p className="mt-1 text-sm text-ink-dim">
          {status ? `You have OwnBase ${status.version}.` : "Loading…"}
        </p>
        {line && (
          <p role="status" className="mt-1 text-sm text-ink-dim">
            {line}
          </p>
        )}
        {problem && (
          <p role="alert" className="mt-1 text-sm text-alert">
            {problem}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {status?.phase === "ready" && (
            <button
              type="button"
              className={buttonClass("primary")}
              onClick={() => {
                setProblem(null);
                void restart().then(setProblem);
              }}
            >
              Restart to update
            </button>
          )}
          {status?.phase === "available" && (
            <button
              type="button"
              className={buttonClass("primary")}
              onClick={() => void updates.openDownloadPage().catch(() => {})}
            >
              Get it from the website
            </button>
          )}
          <button
            type="button"
            className={buttonClass("secondary")}
            disabled={busy || looking}
            onClick={() => {
              setBusy(true);
              setProblem(null);
              void updates
                .check()
                .catch(() => setProblem("Could not check for a new version. Try again."))
                .finally(() => setBusy(false));
            }}
          >
            {busy || looking ? "Checking…" : "Check now"}
          </button>
        </div>
      </div>
      <div>
        <label {...settingMark("updates")} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={status?.automatic ?? true}
            disabled={!status}
            onChange={(event) =>
              void updates.setAutomatic(event.target.checked).then(
                () => saved(),
                () => setProblem("Could not save that. Try again."),
              )
            }
          />
          Update automatically
        </label>
        <p className="mt-2 text-sm text-ink-dim">
          {updates.mode === "install"
            ? "OwnBase looks for a new version every few hours and downloads it in the background. It installs when you restart or quit OwnBase, never during a call."
            : "OwnBase looks for a new version every few hours and tells you when one is out. Download it from the website to install it."}
        </p>
      </div>
    </section>
  );
}
