import { useCallback, useEffect, useId, useRef, useState } from "react";
import { DEFAULT_PORT, WORKSPACE_NAME_MAX, type AccessPolicy } from "@ownbase/protocol";
import { PORT_RULE, portFromText } from "@ownbase/protocol/desktop";
import {
  failureCode,
  failureMessage,
  failureWithReason,
  type HostedWorkspaces,
  type HostingStart,
  type HostingStatus,
  type StartedWorkspace,
} from "../platform.js";
import { useHostingStatus } from "../lib/hosting.js";
import { useHostedIcon } from "../lib/workspaceIcon.js";
import { useCopy } from "../lib/useCopy.js";
import { formatBytes } from "../lib/format.js";
import { inventorySummary } from "../lib/restoreInventory.js";
import { isImeKey } from "../lib/textInput.js";
import { useTabs } from "../lib/useTabs.js";
import { Dialog, DialogScroll } from "./Dialog.js";
import { inputClass, inputCls } from "./TextField.js";
import { Swap } from "./Motion.js";
import { buttonClass } from "./Button.js";
import { EarlierCopies } from "./EarlierCopies.js";
import { Icon } from "./Icon.js";
import { JoinPolicyChoice } from "./JoinPolicyChoice.js";
import { CallRelaySettings } from "./CallRelaySettings.js";
import { QrCode } from "./QrCode.js";
import { WorkspaceIcon } from "./WorkspaceIcon.js";
import { useConfirm } from "./Confirm.js";
import { BreakableAddress } from "./BreakableAddress.js";
import {
  LaunchProblem,
  RenameForm,
  backedUpWhen,
  linkBtnCls,
  type Hosting,
  type HostingBusy,
} from "./hostParts.js";
import { StartupWhileStopped } from "./HostStartup.js";
import { HostAdvanced } from "./HostAdvanced.js";
import { HostBackups } from "./HostBackups.js";

/** The parts of managing a running workspace, each a tab (UX-62). */
type Section = "overview" | "internet" | "backups" | "advanced";
const SECTION_NAMES: Record<Section, string> = {
  overview: "Overview",
  internet: "Share on the internet",
  backups: "Backups",
  advanced: "Advanced",
};

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
        const port = portFromText(draft);
        if (port === null) {
          setError(PORT_RULE);
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
            // eslint-disable-next-line jsx-a11y/no-autofocus -- Change port swaps the line for this field, which takes focus in its place
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

/**
 * What to do when the list of hosted workspaces cannot be read. The app says
 * why a list it read is unusable; any other failure's raw details stay out.
 */
export function hostedListError(reason: unknown): string {
  return failureCode(reason) === "registry-unreadable"
    ? failureMessage(reason, "")
    : "Could not read the list of workspaces hosted on this computer, so none can start. Check that OwnBase’s settings file can be read, then open this again.";
}

/**
 * Every workspace hosted on this computer, read again whenever hosting
 * starts or stops. Null until read, and when it cannot be read.
 */
function useHostedWorkspaces(hosting: Hosting, phase: string, revision: number) {
  const [hosted, setHosted] = useState<HostedWorkspaces | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
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

/**
 * A hosted workspace's icon in the list, read from its own database: one
 * that is stopped shows its icon without being started.
 */
function HostedIcon(props: {
  hosting: Hosting;
  folder: string;
  name: string;
  version: string | null | undefined;
}) {
  const icon = useHostedIcon(props.hosting, props.folder, props.version);
  return (
    <WorkspaceIcon name={props.name} src={icon} size={32} className="rounded-lg text-[13px]" />
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

export function HostDialog(props: {
  hosting: Hosting;
  state: ReturnType<typeof useHostingStatus>;
  /** The hosted workspace is the one already on screen, so there is nothing to open. */
  viewingHosted?: boolean;
  onClose: () => void;
  onStarted: (started: Pick<StartedWorkspace, "port">) => void;
  /** Opens Invite people in the hosted workspace, which is on screen. */
  onInvite?: () => void;
  /** The tab to open on, once the workspace is running and has it. */
  initialSection?: Section;
}) {
  const { status, loading, error: statusError, refresh } = props.state;
  const confirm = useConfirm();
  const [name, setName] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  /** The port for a new workspace, as typed. Empty for the usual one. */
  const [portText, setPortText] = useState("");
  const [busy, setBusy] = useState<HostingBusy>(null);
  const operationPending = useRef(false);
  const [section, setSection] = useState<Section>(props.initialSection ?? "overview");
  const [error, setError] = useState<{ message: string; tunnel?: boolean } | null>(null);
  /** Null while the saved address is shown; a string while it is being edited. */
  const [addressDraft, setAddressDraft] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  /** Save was pressed with the address already saved, which is said rather than saved again. */
  const [addressUnchanged, setAddressUnchanged] = useState(false);
  const addressField = useRef<HTMLInputElement>(null);
  /**
   * Who may join once opened, chosen before opening. A public address is not
   * authorization, so a workspace first put on the internet needs invites.
   */
  const [openPolicy, setOpenPolicy] = useState<AccessPolicy>("invite_only");
  /** What the running workspace holds now, as acknowledged by it. */
  const livePolicy = status?.accessPolicy;
  const { copy, label: copyLabel } = useCopy();
  const phase = status?.phase ?? "stopped";
  const changing = phase === "starting" || phase === "stopping";
  const unavailable = loading || statusError || !status || changing || !!busy;
  const publicUrl = status?.openToAll?.phase === "open" ? status.openToAll.url : null;
  // Invite people opens in the hosted workspace, so only while it is on screen.
  const invitesHere = !!(props.viewingHosted && props.onInvite);
  const externallyCarried = !!status?.publicAddress && !status.publicAddressManaged;
  const tunnelError = status?.publicAddressError ?? status?.openToAllError;
  const savedAddress = status?.publicAddressSetting ?? "";
  const addressValue = addressDraft ?? savedAddress;
  const addressDirty = addressDraft !== null && addressDraft.trim() !== savedAddress;

  // Opening it looks again for what a public link needs, which nothing announces.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Once cloudflared is installed, the install button that had focus is gone,
  // and Get a public link, which took its place, is what comes next.
  const openButton = useRef<HTMLButtonElement>(null);
  const tunnelWasMissing = useRef(false);
  useEffect(() => {
    if (
      status?.tunnelAvailable &&
      tunnelWasMissing.current &&
      document.activeElement === document.body
    )
      openButton.current?.focus();
    tunnelWasMissing.current = status?.tunnelAvailable === false;
  }, [status?.tunnelAvailable]);

  const [listRevision, setListRevision] = useState(0);
  const { hosted, failed: listFailed } = useHostedWorkspaces(props.hosting, phase, listRevision);
  /** The running workspace's icon, which follows a change made in Workspace settings. */
  const liveIcon = useHostedIcon(
    props.hosting,
    phase === "running" ? status?.folder : null,
    status?.iconVersion,
  );
  /** What the last backup or removal from the list did, until another starts. */
  const [backupNote, setBackupNote] = useState<{ ok: boolean; text: string } | null>(null);
  const backupFn = props.hosting.backup;
  const forgetFn = props.hosting.forget;
  const restoreFn = props.hosting.restore;
  /** The restored workspace whose "put back in use" question is showing. */
  const [activating, setActivating] = useState<string | null>(null);
  /** The stopped workspace whose earlier copies are showing. */
  const [earlierOf, setEarlierOf] = useState<string | null>(null);
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
    if (operationPending.current) return null;
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
      return failureMessage(reason, "The port could not be saved. Try again.");
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
    if (operationPending.current) return null;
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
      return failureMessage(reason, "The new name could not be saved. Try again.");
    } finally {
      setListRevision((n) => n + 1);
      operationPending.current = false;
      setBusy(null);
    }
  }

  async function openFolder(folder: string) {
    setBackupNote(null);
    try {
      await openFolderFn(folder);
    } catch (reason) {
      setBackupNote({ ok: false, text: failureMessage(reason, "The folder could not be opened.") });
    }
  }

  async function restoreBackup() {
    if (operationPending.current || unavailable) return;
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
      setBackupNote({ ok: false, text: failureWithReason("The backup was not restored.", reason) });
    } finally {
      setListRevision((n) => n + 1);
      operationPending.current = false;
      setBusy(null);
    }
  }

  async function removeMissing(folder: string, name: string) {
    if (operationPending.current || unavailable) return;
    operationPending.current = true;
    setBusy("removing");
    setBackupNote(null);
    try {
      await forgetFn(folder);
    } catch (reason) {
      setBackupNote({
        ok: false,
        text: failureWithReason(`${name} could not be removed from the list.`, reason),
      });
    } finally {
      setListRevision((n) => n + 1);
      operationPending.current = false;
      setBusy(null);
    }
  }

  async function backUp(folder: string, name: string) {
    if (operationPending.current || unavailable) return;
    operationPending.current = true;
    setBusy("backing-up");
    setBackupNote(null);
    try {
      const made = await backupFn(folder);
      if (made) setBackupNote({ ok: true, text: `Backed up ${name} to ${made.path}` });
    } catch (reason) {
      setBackupNote({
        ok: false,
        text: failureWithReason(`The backup of ${name} did not finish.`, reason),
      });
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
    const port = portFromText(portText);
    if (port === null) {
      setError({ message: `${PORT_RULE} Or leave it empty for the usual one.` });
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
      props.onStarted(await props.hosting.start(request));
    } catch (reason) {
      // The desktop app says what went wrong in words it chose to show.
      setError({
        message: failureMessage(
          reason,
          "The workspace could not start. Check that its data folder is writable and its port is available, then try again.",
        ),
      });
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
          "The workspace did not stop. If it keeps failing, quitting OwnBase offers ways to recover.",
      });
    } finally {
      operationPending.current = false;
      setBusy(null);
    }
  }

  async function openToAll() {
    if (
      operationPending.current ||
      unavailable ||
      status?.publicAddressError ||
      status?.tunnelAvailable === false
    )
      return;
    operationPending.current = true;
    setBusy("opening");
    setError(null);
    try {
      await props.hosting.openToAll(openPolicy);
    } catch (err) {
      setError({
        tunnel: true,
        message:
          failureCode(err) === "owner-account-missing"
            ? "Open the workspace and create its owner account first, then try again."
            : "The public link did not open. Check that cloudflared is installed and this computer is online, then try again.",
      });
    } finally {
      operationPending.current = false;
      setBusy(null);
    }
  }

  async function endOpenToAll() {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy("closing");
    setError(null);
    try {
      await props.hosting.endOpenToAll();
    } catch {
      setError({
        tunnel: true,
        message: externallyCarried
          ? "OwnBase could not stop publishing this address. Try again, then stop its external tunnel or proxy separately."
          : "OwnBase’s Cloudflare connection could not be closed cleanly. Try again before quitting OwnBase.",
      });
    } finally {
      operationPending.current = false;
      setBusy(null);
    }
  }

  /** Changes who may join, showing what the workspace then holds rather than the wish. */
  async function changeAccessPolicy(next: AccessPolicy) {
    if (operationPending.current) return;
    // Signing guests out cannot be taken back, so it is asked first, as
    // Workspace settings asks for the same change.
    if (livePolicy === "guest_allowed" && next !== "guest_allowed") {
      const sure = await confirm({
        title: "Sign every guest out?",
        body: "Whoever is signed in as a guest is signed out now, and nobody new can join as one. What guests wrote stays.",
        confirmLabel: "Sign guests out",
        destructive: true,
      });
      if (!sure) return;
    }
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
      operationPending.current = false;
      setBusy(null);
    }
  }

  async function saveAddress() {
    if (operationPending.current) return;
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
      setAddressError(failureMessage(err, "The address could not be saved. Try again."));
      addressField.current?.focus();
    } finally {
      operationPending.current = false;
      setBusy(null);
    }
  }

  /** The sections of a running workspace; one being looked inside is not on the internet. */
  const sections: Section[] = [];
  if (!statusError && status && (status.running || changing)) {
    sections.push("overview");
    if (!status.isolated) sections.push("internet");
    if (status.folder) sections.push("backups");
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
                    {status.folder && renaming === status.folder && phase === "running" ? (
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
                          {phase === "running" && status.workspaceName && (
                            <WorkspaceIcon
                              name={status.workspaceName}
                              src={liveIcon}
                              size={28}
                              className="rounded-lg text-xs"
                            />
                          )}
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
                                className="fc-fill size-1.5 rounded-full bg-online"
                              />
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
                        status.tunnelAvailable !== false
                          ? () => void openToAll()
                          : null
                      }
                      disabled={unavailable}
                      onError={(text) => setBackupNote(text ? { ok: false, text } : null)}
                    />
                    {status.isolated && (
                      <p role="status" className="card-warm rounded-xl p-3 text-sm">
                        You are looking inside {status.workspaceName ?? "a restored workspace"}.
                        Only this computer can reach it. It sends nothing it had waiting and calls
                        no apps. When you are ready, stop it and choose Put back in use from the
                        list.
                      </p>
                    )}
                    {/* Only this computer reaches a workspace being looked inside. */}
                    {!status.isolated && (publicUrl || !!status.lanUrls?.length) && (
                      <div className="flex gap-4 rounded-xl border border-edge p-3">
                        <div className="min-w-0 flex-1 space-y-3">
                          {publicUrl && (
                            <div>
                              <p className="mb-1 text-ink-dim">
                                {livePolicy === "invite_only"
                                  ? "Public address"
                                  : "Anyone can join at"}
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
                          onClick={() =>
                            status.port !== undefined && props.onStarted({ port: status.port })
                          }
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
                )}
                {shown === "internet" && (
                  <>
                    <div>
                      <h3 className="font-semibold text-ink">
                        Let people outside your network join
                      </h3>
                      <p className="mt-1 text-ink-dim">
                        {publicUrl
                          ? "The workspace has a public link now, so people can join from anywhere. Messages and files still stay on this computer."
                          : "Right now only people on the same Wi-Fi or network as this computer can join. A public link lets people join from home or on mobile data too. Messages and files still stay on this computer."}
                      </p>
                    </div>
                    {!status.isolated && (
                      <div className="card-warm rounded-xl p-3">
                        <div className="mb-1 flex items-center justify-between gap-3">
                          <h3 className="font-semibold text-ink">Public link</h3>
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
                                ? "This link works from anywhere while OwnBase is running. You get a new one each time you open it."
                                : status.publicAddressManaged
                                  ? "This address stays the same each time you open the link. Keep OwnBase and its Cloudflare connector running so people can connect."
                                  : "This address stays the same each time you open the link. OwnBase can stop using it, but turning off the tunnel or proxy behind it is up to you."}
                            </p>
                            <div className="flex items-center justify-between gap-2 rounded-lg border border-edge bg-raised p-2">
                              <a
                                href={publicUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="min-w-0 font-mono text-xs text-ink underline decoration-ink-faint/60 underline-offset-2 hover:decoration-ink"
                              >
                                <BreakableAddress text={publicUrl} />
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
                            {livePolicy && (
                              <div className="mt-3">
                                <JoinPolicyChoice
                                  compact
                                  legend="Who can join"
                                  hint="Who can join through the public link. A change applies right away."
                                  value={livePolicy}
                                  disabled={!!busy}
                                  onChange={(next) => void changeAccessPolicy(next)}
                                />
                              </div>
                            )}
                            <p className="mt-2 text-xs text-ink-dim">
                              {livePolicy === "guest_allowed"
                                ? "Anyone with this address can join as a guest for a day and post in public channels. Choosing either of the others signs every guest out."
                                : livePolicy !== "invite_only"
                                  ? "Anyone with this address can create an account. Send the address only to people you trust."
                                  : invitesHere
                                    ? "This address alone will not let anyone in. Send an invite link instead. It has this address and an invite code, so people join in one click."
                                    : "This address alone will not let anyone in. To bring someone in, open the workspace, choose Invite people from its menu and send them that link."}
                            </p>
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              {livePolicy === "invite_only" && invitesHere && (
                                <button
                                  type="button"
                                  disabled={!!busy}
                                  onClick={props.onInvite}
                                  className={buttonClass("primary", "h-8 px-3 text-[13px]")}
                                >
                                  Get an invite link
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={!!busy}
                                onClick={() => void endOpenToAll()}
                                className="h-8 rounded-lg border border-edge px-3 text-xs text-ink-dim hover:text-ink disabled:opacity-40"
                              >
                                {busy === "closing"
                                  ? externallyCarried
                                    ? "Stopping use of address…"
                                    : "Closing public link…"
                                  : externallyCarried
                                    ? "Stop using address"
                                    : "Close public link"}
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            {status.publicAddress ? (
                              <div className="space-y-2 text-xs text-ink-dim">
                                <p>
                                  The public link will use your own address, which never changes.
                                </p>
                                <p className="font-mono text-ink">
                                  <BreakableAddress text={status.publicAddress} />
                                </p>
                                {status.port !== undefined && (
                                  <p>
                                    {status.publicAddressManaged ? "In Cloudflare, route" : "Send"}{" "}
                                    this address to{" "}
                                    <code className="break-all text-ink">{`http://127.0.0.1:${status.port}`}</code>
                                    .
                                  </p>
                                )}
                                <p>Keep OwnBase running so teammates can connect.</p>
                                {externallyCarried && (
                                  <p>
                                    The tunnel or proxy behind this address may already let people
                                    reach the workspace, so saving it turned on invites. To make the
                                    address stop working, turn off that tunnel or proxy yourself.
                                  </p>
                                )}
                              </div>
                            ) : (
                              <p className="text-xs text-ink-dim">
                                OwnBase asks Cloudflare for a free web address that leads to this
                                computer. You do not need a Cloudflare account or any router
                                settings. The address changes each time you open the link.
                              </p>
                            )}
                            {status.tunnelAvailable === false ? (
                              <div className="mt-3 text-xs text-ink-dim">
                                {status.cloudflaredInstall ? (
                                  <InstallCloudflared
                                    install={status.cloudflaredInstall}
                                    onInstall={props.hosting.installCloudflared}
                                    disabled={!!busy}
                                  />
                                ) : (
                                  <p>
                                    Install cloudflared, a free program from Cloudflare, then press
                                    Check again.
                                  </p>
                                )}
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
                                <div className="mt-3">
                                  <JoinPolicyChoice
                                    compact
                                    legend="Who can join"
                                    hint="Who can join once the link is open."
                                    value={openPolicy}
                                    disabled={!!busy}
                                    onChange={setOpenPolicy}
                                  />
                                </div>
                                <button
                                  ref={openButton}
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
                                    : "Get a public link"}
                                </button>
                              </>
                            )}
                            <div className="mt-3 border-t border-edge pt-3">
                              <label
                                htmlFor="public-address"
                                className="block text-xs font-medium text-ink-dim"
                              >
                                Your own address
                              </label>
                              <p id="public-address-help" className="mt-1 text-xs text-ink-dim">
                                Only if you already run Tailscale Funnel, a reverse proxy or a
                                tunnel of your own to this computer. Enter its address to keep the
                                same link every time. Most people leave this empty, and OwnBase{" "}
                                {status.publicAddressManaged
                                  ? "uses the Cloudflare address set up for it"
                                  : "gets a new address each time"}
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
                                  An environment variable sets this address, so you cannot change it
                                  here.
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
                                {addressUnchanged ? "That address is already saved." : ""}
                              </p>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                    {!status.isolated && (
                      <CallRelaySettings relay={props.hosting.relay} disabled={unavailable} />
                    )}
                  </>
                )}
                {shown === "backups" && (
                  <HostBackups
                    hosting={props.hosting}
                    status={status}
                    phase={phase}
                    runningEntry={runningEntry}
                    busy={busy}
                    unavailable={unavailable}
                    backUp={backUp}
                    setBackupNote={setBackupNote}
                    setListRevision={setListRevision}
                  />
                )}
                {shown === "advanced" && (
                  <HostAdvanced
                    hosting={props.hosting}
                    status={status}
                    phase={phase}
                    unavailable={unavailable}
                    openFolder={openFolder}
                    setBackupNote={setBackupNote}
                  />
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
                This computer runs the workspace. People on the same Wi-Fi or network can join while
                OwnBase is open. Messages, files and accounts are saved on this computer.
              </p>
              <LaunchProblem
                hosting={props.hosting}
                message={status.launchError}
                onRetry={null}
                disabled={unavailable}
                className="mb-4"
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
                        {changingPort === w.folder && !w.missing ? (
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
                        ) : renaming === w.folder && !w.missing ? (
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
                            <HostedIcon
                              hosting={props.hosting}
                              folder={w.folder}
                              name={w.name}
                              // A missing folder has no database to read it from.
                              version={w.missing ? null : w.iconVersion}
                            />
                            {/* Room for the name first: the buttons go to the next line before it narrows. */}
                            <div className="min-w-[12rem] flex-1">
                              <p className="truncate text-sm text-ink">{w.name}</p>
                              <p className="text-xs text-ink-dim empty:hidden">
                                {w.missing
                                  ? "Its folder is missing, so it cannot start"
                                  : [
                                      w.restored && "Restored, not in use yet",
                                      // The usual port is no news; one chosen, or taken
                                      // because that one was busy, tells two apart.
                                      w.port !== DEFAULT_PORT && `Port ${w.port}`,
                                      w.startsOnLaunch && "Starts with OwnBase",
                                      w.autoBackup &&
                                        `${w.autoBackup.everyDays === 1 ? "Backs up daily" : "Backs up weekly"}${
                                          w.restored ? " once back in use" : ""
                                        }`,
                                      w.lastBackupAt === null
                                        ? "Not backed up yet"
                                        : `Backed up ${backedUpWhen(w.lastBackupAt)}`,
                                    ]
                                      .filter(Boolean)
                                      .join(" · ")}
                              </p>
                              {/* The running one says so under Automatic backups, with Try again. */}
                              {w.autoBackupError && !w.running && (
                                <p className="text-xs text-alert">{w.autoBackupError}</p>
                              )}
                              {!w.missing && (
                                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
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
                                  <button
                                    type="button"
                                    aria-label={`Open folder for ${w.name}`}
                                    onClick={() => void openFolder(w.folder)}
                                    className={linkBtnCls}
                                  >
                                    Open folder
                                  </button>
                                  {!w.running && (
                                    <button
                                      type="button"
                                      disabled={unavailable}
                                      aria-label={`Earlier copies of ${w.name}`}
                                      aria-expanded={earlierOf === w.folder}
                                      onClick={() =>
                                        setEarlierOf(earlierOf === w.folder ? null : w.folder)
                                      }
                                      className={linkBtnCls}
                                    >
                                      Earlier copies
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                            {!w.missing && (
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
                            {w.missing ? (
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
                        {earlierOf === w.folder && !w.missing && !w.running && (
                          <EarlierCopies
                            hosting={props.hosting}
                            folder={w.folder}
                            name={w.name}
                            disabled={unavailable}
                            onDone={(note) => {
                              setEarlierOf(null);
                              setBackupNote(note);
                              setListRevision((n) => n + 1);
                            }}
                            onClose={() => setEarlierOf(null)}
                          />
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
                    // eslint-disable-next-line jsx-a11y/no-autofocus -- the dialog's first field: focus moves there as it opens
                    autoFocus
                    maxLength={WORKSPACE_NAME_MAX}
                    value={name}
                    disabled={!!busy}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Rocket Team"
                    className={inputCls}
                  />
                </label>
                <details className="group text-sm text-ink-dim">
                  <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 hover:text-ink">
                    <Icon
                      name="chevronDown"
                      size={14}
                      className="-rotate-90 transition-transform group-open:rotate-0"
                    />
                    Choose a port
                  </summary>
                  <label className="mt-2 block">
                    Port
                    <input
                      inputMode="numeric"
                      maxLength={5}
                      value={portText}
                      disabled={!!busy}
                      onChange={(e) => setPortText(e.target.value)}
                      placeholder={String(DEFAULT_PORT)}
                      aria-describedby="host-port-hint"
                      className={`${inputCls} mt-1 max-w-32 font-mono`}
                    />
                  </label>
                  <p id="host-port-hint" className="mt-1 text-xs text-ink-faint">
                    Most people leave this empty. OwnBase then uses {DEFAULT_PORT}, or another free
                    port if something else has it. If you type a port and it is taken, the workspace
                    will not start.
                  </p>
                </details>
                {sameName && (
                  <p className="text-xs text-ink-dim">
                    {sameName.name} is already hosted here. To keep its messages, start it from the
                    list. This button starts a separate, empty workspace.
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
              <button
                type="button"
                disabled={unavailable}
                onClick={() => void restoreBackup()}
                className={buttonClass("secondary", "mt-3 w-full")}
              >
                {busy === "restoring" ? "Restoring…" : "Restore from a backup…"}
              </button>
            </>
          ) : null}
        </DialogScroll>
      )}
    </Dialog>
  );
}

const INSTALLED_WITH = { winget: "winget", homebrew: "Homebrew" } as const;

/**
 * Installs cloudflared for a public link with what this computer has, or by
 * downloading Cloudflare's own release, and shows how far it has got. The
 * install is the main process's, so a window opened again while it runs
 * shows it too.
 */
function InstallCloudflared(props: {
  install: NonNullable<HostingStatus["cloudflaredInstall"]>;
  onInstall: () => Promise<void>;
  disabled: boolean;
}) {
  const [pressed, setPressed] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { via, received, total } = props.install;
  const installing = pressed || !!props.install.installing;
  const downloading = via === "download" && installing && total !== undefined;

  async function install() {
    if (installing || props.disabled) return;
    setPressed(true);
    setFailure(null);
    try {
      await props.onInstall();
    } catch (err) {
      setFailure(
        failureMessage(
          err,
          "cloudflared could not be installed. Install it yourself, then check again.",
        ),
      );
    } finally {
      setPressed(false);
    }
  }

  return (
    <>
      <p>
        A public link needs cloudflared, a free program from Cloudflare. This computer does not have
        it yet.
      </p>
      {/* Kept in place while it installs, so focus stays where it was. */}
      <button
        type="button"
        disabled={props.disabled && !installing}
        aria-disabled={installing || undefined}
        onClick={() => void install()}
        className={buttonClass("primary", "mt-3 w-full aria-disabled:opacity-60")}
      >
        {installing ? "Installing cloudflared…" : "Install cloudflared"}
      </button>
      <p role="status" className="mt-2">
        {!installing
          ? via === "download"
            ? "OwnBase downloads it from Cloudflare's page on GitHub and checks that it matches what Cloudflare published."
            : `OwnBase installs it with ${INSTALLED_WITH[via]}, which this computer already has.`
          : via === "download"
            ? "Downloading from Cloudflare…"
            : `Installing with ${INSTALLED_WITH[via]}. This can take a few minutes.`}
      </p>
      {/* Outside the status above, so a screen reader is not told every percent. */}
      {downloading && (
        <>
          <progress
            max={total}
            value={received ?? 0}
            aria-label="Downloading cloudflared"
            className="mt-2 h-1.5 w-full accent-[var(--color-copper)]"
          />
          <p className="mt-1 tabular-nums">
            {formatBytes(received ?? 0)} of {formatBytes(total)}
          </p>
        </>
      )}
      {failure && (
        <p role="alert" className="mt-2 text-alert">
          {failure}
        </p>
      )}
      <p className="mt-3">Or install it yourself, then press Check again.</p>
    </>
  );
}
