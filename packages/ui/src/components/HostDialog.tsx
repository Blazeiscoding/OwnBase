import { useEffect, useRef, useState } from "react";
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
import { inventorySummary } from "../lib/restoreInventory.js";
import { useTabs } from "../lib/useTabs.js";
import { Dialog, DialogScroll } from "./Dialog.js";
import { inputCls } from "./TextField.js";
import { buttonClass } from "./Button.js";
import { Icon } from "./Icon.js";
import { useConfirm } from "./Confirm.js";
import {
  LaunchProblem,
  useHostingOperation,
  useRowForm,
  type Hosting,
  type SaveName,
} from "./hostParts.js";
import { StartupWhileStopped } from "./HostStartup.js";
import { HostOverview } from "./HostOverview.js";
import { HostInternet } from "./HostInternet.js";
import { HostBackups } from "./HostBackups.js";
import { HostAdvanced } from "./HostAdvanced.js";
import { HostedList } from "./HostedList.js";

/** The parts of managing a running workspace, each a tab (UX-62). */
type Section = "overview" | "internet" | "backups" | "advanced";
const SECTION_NAMES: Record<Section, string> = {
  overview: "Overview",
  internet: "Share on the internet",
  backups: "Backups",
  advanced: "Advanced",
};

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
  const { busy, run, running } = useHostingOperation();
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
  const refreshList = () => setListRevision((n) => n + 1);
  /** The running workspace's name, while its form is open. */
  const renaming = useRowForm("rename");

  /** Runs an operation that changes the list: the note clears, and the list is read again after. */
  const changeList: typeof run = (kind, work) =>
    run(kind, async () => {
      setBackupNote(null);
      try {
        return await work();
      } finally {
        refreshList();
      }
    });

  const saveName: SaveName = async (folder, previous, next, onSaved) => {
    const refusal = await changeList("renaming", async () => {
      try {
        const done = await props.hosting.rename(folder, next);
        onSaved();
        setBackupNote({ ok: true, text: `Renamed ${previous} to ${done.name}.` });
        return null;
      } catch (reason) {
        // The main process says what is wrong with the name, or with the folder.
        return failureMessage(reason, "The new name could not be saved. Try again.");
      }
    });
    return refusal ?? null;
  };

  async function openFolder(folder: string) {
    setBackupNote(null);
    try {
      await props.hosting.openFolder(folder);
    } catch (reason) {
      setBackupNote({ ok: false, text: failureMessage(reason, "The folder could not be opened.") });
    }
  }

  async function restoreBackup() {
    if (unavailable) return;
    await changeList("restoring", async () => {
      try {
        const restored = await props.hosting.restore();
        if (restored)
          setBackupNote({
            ok: true,
            text:
              `Restored ${restored.name}. Until you put it back in use, Look inside opens it on this computer only, sends nothing it had waiting and calls no app.` +
              (restored.inventory ? ` ${inventorySummary(restored.inventory)}` : ""),
          });
      } catch (reason) {
        setBackupNote({
          ok: false,
          text: failureWithReason("The backup was not restored.", reason),
        });
      }
    });
  }

  async function backUp(folder: string, name: string) {
    if (unavailable) return;
    await changeList("backing-up", async () => {
      try {
        const made = await props.hosting.backup(folder);
        if (made) setBackupNote({ ok: true, text: `Backed up ${name} to ${made.path}` });
      } catch (reason) {
        setBackupNote({
          ok: false,
          text: failureWithReason(`The backup of ${name} did not finish.`, reason),
        });
      }
    });
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
    if (unavailable) return;
    await run("starting", async () => {
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
      }
    });
  }

  // The button already says what it does, so it stops without asking first.
  async function stop() {
    if (unavailable) return;
    await run("stopping", async () => {
      setError(null);
      try {
        await props.hosting.stop();
      } catch {
        setError({
          message:
            "The workspace did not stop. If it keeps failing, quitting OwnBase offers ways to recover.",
        });
      }
    });
  }

  async function openToAll() {
    if (unavailable || status?.publicAddressError || status?.tunnelAvailable === false) return;
    await run("opening", async () => {
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
      }
    });
  }

  async function endOpenToAll() {
    await run("closing", async () => {
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
      }
    });
  }

  /** Changes who may join, showing what the workspace then holds rather than the wish. */
  async function changeAccessPolicy(next: AccessPolicy) {
    if (running()) return;
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
    await run("policy", async () => {
      setError(null);
      try {
        await props.hosting.setAccessPolicy(next);
      } catch {
        setError({
          message: "Who may join could not be changed. The previous setting is still in use.",
        });
      }
    });
  }

  async function saveAddress() {
    if (running()) return;
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
    await run("address", async () => {
      try {
        await props.hosting.setPublicAddress(addressValue.trim());
        setAddressDraft(null);
      } catch (err) {
        // The main process says exactly what is wrong with the address; a
        // rewritten message here would only be vaguer than the real one.
        setAddressError(failureMessage(err, "The address could not be saved. Try again."));
        addressField.current?.focus();
      }
    });
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

  return (
    <Dialog
      title={status?.running ? "Workspace is live" : "Host a workspace"}
      onClose={() => {
        if (!running()) props.onClose();
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
                  <HostOverview
                    hosting={props.hosting}
                    status={status}
                    phase={phase}
                    liveIcon={liveIcon}
                    publicUrl={publicUrl}
                    livePolicy={livePolicy}
                    busy={busy}
                    unavailable={unavailable}
                    renaming={renaming}
                    saveName={saveName}
                    openToAll={openToAll}
                    setBackupNote={setBackupNote}
                    copy={copy}
                    copyLabel={copyLabel}
                    viewingHosted={props.viewingHosted}
                    onInvite={props.onInvite}
                    onStarted={props.onStarted}
                  />
                )}
                {shown === "internet" && (
                  <HostInternet
                    hosting={props.hosting}
                    status={status}
                    publicUrl={publicUrl}
                    tunnelError={tunnelError}
                    externallyCarried={externallyCarried}
                    livePolicy={livePolicy}
                    invitesHere={invitesHere}
                    onInvite={props.onInvite}
                    busy={busy}
                    unavailable={unavailable}
                    copy={copy}
                    copyLabel={copyLabel}
                    refresh={refresh}
                    openPolicy={openPolicy}
                    setOpenPolicy={setOpenPolicy}
                    openToAll={openToAll}
                    endOpenToAll={endOpenToAll}
                    changeAccessPolicy={changeAccessPolicy}
                    address={{
                      addressField,
                      addressValue,
                      addressError,
                      addressUnchanged,
                      setAddressDraft,
                      setAddressError,
                      setAddressUnchanged,
                      saveAddress,
                    }}
                  />
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
                    refreshList={refreshList}
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
                onChanged={refreshList}
                onError={(text) => setBackupNote(text ? { ok: false, text } : null)}
              />
              {hosted && existing.length > 0 && (
                <HostedList
                  hosting={props.hosting}
                  hosted={hosted}
                  busy={busy}
                  unavailable={unavailable}
                  changeList={changeList}
                  saveName={saveName}
                  openFolder={openFolder}
                  backUp={backUp}
                  launch={launch}
                  setNote={setBackupNote}
                  refreshList={refreshList}
                />
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
