import { type HostingStatus } from "../platform.js";
import { linkBtnCls, type Hosting, type HostNote } from "./hostParts.js";
import { StartWithComputer } from "./HostStartup.js";

/** The Advanced tab of a running workspace: start-up choices, its data folder and its port. */
export function HostAdvanced(props: {
  hosting: Hosting;
  status: HostingStatus;
  phase: HostingStatus["phase"];
  unavailable: boolean;
  openFolder: (folder: string) => Promise<void>;
  setBackupNote: (note: HostNote | null) => void;
}) {
  const { status, phase, unavailable, openFolder, setBackupNote } = props;
  return (
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
            {status.folder && (
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
          <p className="mt-1 text-xs text-ink-faint">
            To use another port, stop hosting, then choose Change port beside the workspace.
          </p>
        </div>
      )}
    </>
  );
}
