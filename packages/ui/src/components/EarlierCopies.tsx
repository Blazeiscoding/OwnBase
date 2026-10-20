import { useEffect, useRef, useState } from "react";
import type { HostedBackup, Platform } from "../platform.js";
import { formatBytes, formatDay, formatTime } from "../lib/format.js";
import { inventorySummary } from "../lib/restoreInventory.js";
import { buttonClass } from "./Button.js";

type Hosting = NonNullable<Platform["hosting"]>;

/** When a backup was made, as the list of hosted workspaces says it. */
function when(at: number): string {
  const day = formatDay(at);
  return `${day === "Today" || day === "Yesterday" ? day.toLowerCase() : day}, ${formatTime(at)}`;
}

const linkCls = "text-xs text-copper hover:underline disabled:opacity-40";

/**
 * The earlier copies of a stopped hosted workspace, from its backup folder,
 * and restoring one over it (O01): the backups the app finds there, newest
 * first, or a backup's folder chosen in the system's dialog. Restoring asks
 * first, saying that what the workspace holds now is moved beside it, not
 * deleted, and that the copy waits until it is put back in use.
 */
export function EarlierCopies(props: {
  hosting: Hosting;
  folder: string;
  name: string;
  disabled: boolean;
  /** What happened, for the list's note; the panel closes after it. */
  onDone: (note: { ok: boolean; text: string }) => void;
  onClose: () => void;
}) {
  const { backups, restoreOver } = props.hosting;
  const [found, setFound] = useState<HostedBackup[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** The copy whose restore is being asked about; "chosen" for one picked in the system's dialog. */
  const [asking, setAsking] = useState<HostedBackup | "chosen" | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    if (!backups) return;
    backups(props.folder).then(
      (list) => alive.current && setFound(list),
      (error: unknown) =>
        alive.current &&
        setFailed(error instanceof Error && error.message ? error.message : "Try again."),
    );
    return () => {
      alive.current = false;
    };
  }, [backups, props.folder]);

  async function restore() {
    if (!restoreOver || !asking || busy) return;
    setBusy(true);
    try {
      const done = await restoreOver(props.folder, asking === "chosen" ? null : asking.name);
      if (!alive.current) return;
      setBusy(false);
      // No folder chosen in the dialog: nothing happened, and nothing to say.
      if (!done) return setAsking(null);
      props.onDone({
        ok: true,
        text:
          `Restored an earlier copy of ${done.name}.` +
          (done.setAside ? ` What it held before is kept in ${done.setAside}.` : "") +
          " Until you put it back in use, Look inside opens it on this computer only, sends nothing it had waiting and calls no app." +
          (done.inventory ? ` ${inventorySummary(done.inventory)}` : ""),
      });
    } catch (error) {
      if (!alive.current) return;
      setBusy(false);
      const why = error instanceof Error && error.message ? ` ${error.message}` : "";
      props.onDone({ ok: false, text: `The earlier copy was not restored.${why}` });
    }
  }

  return (
    <div
      role="region"
      aria-label={`Earlier copies of ${props.name}`}
      className="mt-2 w-full space-y-2 rounded-lg border border-edge bg-ground p-3 text-sm text-ink-dim"
    >
      {asking ? (
        <>
          <p>
            {asking === "chosen"
              ? `Restore a backup you choose over ${props.name}?`
              : `Restore the copy from ${when(asking.at)} over ${props.name}?`}{" "}
            What {props.name} holds now is moved to a folder beside it, not deleted. The copy does
            not start until you put it back in use.
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              disabled={props.disabled}
              aria-disabled={busy || undefined}
              onClick={() => void restore()}
              className={buttonClass("danger")}
            >
              {busy ? "Restoring…" : `Restore over ${props.name}`}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setAsking(null)}
              className={linkCls}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            An earlier copy takes the place of what {props.name} holds now, which is kept beside it.
          </p>
          {failed ? (
            <p role="alert" className="text-alert">
              Its backups could not be read. {failed}
            </p>
          ) : found === null ? (
            <p role="status">Checking its backups…</p>
          ) : found.length === 0 ? (
            <p>No backups were found in its backup folder.</p>
          ) : (
            <ul aria-label={`Backups of ${props.name}`} className="space-y-1">
              {found.map((backup) => (
                <li key={backup.name} className="flex items-center justify-between gap-3">
                  <span className={backup.damaged ? "text-ink-faint" : "text-ink"}>
                    {when(backup.at)}
                    {backup.damaged
                      ? " · failed its check, so it cannot be restored"
                      : backup.bytes !== null
                        ? ` · ${formatBytes(backup.bytes)}`
                        : ""}
                  </span>
                  {!backup.damaged && (
                    <button
                      type="button"
                      disabled={props.disabled}
                      aria-label={`Restore the copy from ${when(backup.at)}`}
                      onClick={() => setAsking(backup)}
                      className={linkCls}
                    >
                      Restore…
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-3">
            <button
              type="button"
              disabled={props.disabled}
              onClick={() => setAsking("chosen")}
              className={linkCls}
            >
              Choose a backup folder…
            </button>
            <button type="button" onClick={props.onClose} className={linkCls}>
              Close
            </button>
          </div>
        </>
      )}
    </div>
  );
}
