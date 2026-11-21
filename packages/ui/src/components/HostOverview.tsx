import { useId } from "react";
import { type AccessPolicy } from "@ownbase/protocol";
import { type HostingStatus, type StartedWorkspace } from "../platform.js";
import { type useCopy } from "../lib/useCopy.js";
import { Swap } from "./Motion.js";
import { buttonClass } from "./Button.js";
import { QrCode } from "./QrCode.js";
import { WorkspaceIcon } from "./WorkspaceIcon.js";
import { BreakableAddress } from "./BreakableAddress.js";
import {
  LaunchProblem,
  RenameForm,
  linkBtnCls,
  type Hosting,
  type HostingBusy,
  type HostNote,
  type RowForm,
  type SaveName,
} from "./hostParts.js";

/**
 * The Overview tab of a running workspace: its name, where people reach it,
 * who is connected, then Invite people or Open it.
 */
export function HostOverview(props: {
  hosting: Hosting;
  status: HostingStatus;
  phase: HostingStatus["phase"];
  /** The running workspace's icon, which follows a change made in Workspace settings. */
  liveIcon: string | null | undefined;
  /** The open public link's address, if one is open. */
  publicUrl: string | null;
  /** Who may join, as the running workspace holds it. */
  livePolicy: AccessPolicy | undefined;
  busy: HostingBusy;
  unavailable: boolean;
  /** The running workspace's name, while its form is open. */
  renaming: RowForm;
  saveName: SaveName;
  openToAll: () => Promise<void>;
  setBackupNote: (note: HostNote | null) => void;
  copy: ReturnType<typeof useCopy>["copy"];
  copyLabel: ReturnType<typeof useCopy>["label"];
  /** The hosted workspace is the one already on screen, so there is nothing to open. */
  viewingHosted?: boolean;
  onInvite?: () => void;
  onStarted: (started: Pick<StartedWorkspace, "port">) => void;
}) {
  const {
    status,
    phase,
    liveIcon,
    publicUrl,
    livePolicy,
    busy,
    unavailable,
    renaming,
    saveName,
    openToAll,
    setBackupNote,
    copy,
    copyLabel,
  } = props;
  const addressId = useId();
  // A phone opens what the code holds, so it holds a whole address: the
  // public one where there is one, as it works from anywhere.
  const qrTarget = publicUrl ?? (status.lanUrls?.[0] ? `http://${status.lanUrls[0]}` : null);
  return (
    <>
      {status.folder && renaming.folder === status.folder && phase === "running" ? (
        <RenameForm
          folder={status.folder}
          name={status.workspaceName ?? ""}
          blocked={unavailable}
          saving={busy === "renaming"}
          onSave={(next) =>
            saveName(status.folder!, status.workspaceName ?? "", next, renaming.close)
          }
          onCancel={renaming.close}
        />
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            {phase === "running" && status.workspaceName && (
              <WorkspaceIcon
                name={status.workspaceName}
                src={liveIcon}
                size={28}
                className="rounded-lg text-xs"
              />
            )}
            <p role="status" className="min-w-0 break-words text-[15px] font-semibold text-ink">
              {phase === "starting"
                ? "Starting workspace…"
                : phase === "stopping"
                  ? "Stopping workspace…"
                  : (status.workspaceName ?? "Workspace hosted on this computer")}
            </p>
            {phase === "running" && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-online/15 px-2 py-0.5 text-xs font-medium text-online">
                <span aria-hidden="true" className="fc-fill size-1.5 rounded-full bg-online" />
                {status.isolated ? "Only on this computer" : "Live"}
              </span>
            )}
          </div>
          {status.folder && status.workspaceName && phase === "running" && (
            <button
              id={`rename-${status.folder}`}
              type="button"
              disabled={unavailable}
              aria-label={`Rename ${status.workspaceName}`}
              onClick={() => renaming.set(status.folder!)}
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
          status.tunnelAvailable !== false
            ? () => void openToAll()
            : null
        }
        disabled={unavailable}
        onError={(text) => setBackupNote(text ? { ok: false, text } : null)}
      />
      {status.isolated && (
        <p role="status" className="card-warm rounded-xl p-3 text-sm">
          You are looking inside {status.workspaceName ?? "a restored workspace"}. Only this
          computer can reach it. It sends nothing it had waiting and calls no apps. When you are
          ready, stop it and choose Put back in use from the list.
        </p>
      )}
      {/* Only this computer reaches a workspace being looked inside. */}
      {!status.isolated && (publicUrl || !!status.lanUrls?.length) && (
        <div className="flex gap-4 rounded-xl border border-edge p-3">
          <div className="min-w-0 flex-1 space-y-3">
            {publicUrl && (
              <div>
                <p className="mb-1 text-ink-dim">
                  {livePolicy === "invite_only" ? "Public address" : "Anyone can join at"}
                </p>
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
          {qrTarget && <QrCode value={qrTarget} label={`QR code for ${qrTarget}`} size={104} />}
        </div>
      )}
      {status.running && !status.isolated && !status.lanUrls?.length && !publicUrl && (
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
            onClick={() => status.port !== undefined && props.onStarted({ port: status.port })}
          >
            Open it
          </button>
        ))}
      {status.running && phase !== "stopping" && (
        <p className="text-ink-dim">
          {status.backgroundAvailable
            ? "Closing this window keeps the workspace running in the system tray. Use the tray to reopen OwnBase or stop hosting."
            : "Closing this window only minimizes OwnBase. Keep it running, or people lose their connection."}
        </p>
      )}
    </>
  );
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
      <span id={props.id} className="min-w-0 font-mono text-ink">
        <BreakableAddress text={props.url} />
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
