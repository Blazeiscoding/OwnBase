import { useRef, useState } from "react";
import { DEFAULT_PORT } from "@ownbase/protocol";
import { PORT_RULE, portFromText } from "@ownbase/protocol/desktop";
import {
  failureMessage,
  failureWithReason,
  type HostedWorkspaces,
  type HostingStart,
} from "../platform.js";
import { useHostedIcon } from "../lib/workspaceIcon.js";
import { isImeKey } from "../lib/textInput.js";
import { inputClass } from "./TextField.js";
import { buttonClass } from "./Button.js";
import { EarlierCopies } from "./EarlierCopies.js";
import { WorkspaceIcon } from "./WorkspaceIcon.js";
import {
  RenameForm,
  backedUpWhen,
  linkBtnCls,
  useRowForm,
  type Hosting,
  type HostingBusy,
  type HostNote,
  type RunOperation,
  type SaveName,
} from "./hostParts.js";

/**
 * Hosted on this computer, on the stopped screen: each workspace this
 * computer hosts, with what can be done to it while nothing runs. Which
 * line has a form or a question open is its own.
 */
export function HostedList(props: {
  hosting: Hosting;
  hosted: HostedWorkspaces;
  busy: HostingBusy;
  unavailable: boolean;
  /** Runs an operation that changes the list: the note clears, and the list is read again after. */
  changeList: RunOperation;
  saveName: SaveName;
  openFolder: (folder: string) => Promise<void>;
  backUp: (folder: string, name: string) => Promise<void>;
  launch: (request: HostingStart) => Promise<void>;
  setNote: (note: HostNote | null) => void;
  refreshList: () => void;
}) {
  const { hosted, busy, unavailable, changeList, openFolder, backUp, launch, setNote } = props;
  const renaming = useRowForm("rename");
  const changingPort = useRowForm("port");
  /** The stopped workspace whose earlier copies are showing. */
  const [earlierOf, setEarlierOf] = useState<string | null>(null);
  /** The restored workspace whose "put back in use" question is showing. */
  const [activating, setActivating] = useState<string | null>(null);

  async function savePort(folder: string, name: string, port: number): Promise<string | null> {
    const refusal = await changeList("renaming", async () => {
      try {
        await props.hosting.setPort(folder, port);
        changingPort.close();
        setNote({ ok: true, text: `${name} will start on port ${port}.` });
        return null;
      } catch (reason) {
        return failureMessage(reason, "The port could not be saved. Try again.");
      }
    });
    return refusal ?? null;
  }

  async function removeMissing(folder: string, name: string) {
    if (unavailable) return;
    await changeList("removing", async () => {
      try {
        await props.hosting.forget(folder);
      } catch (reason) {
        setNote({
          ok: false,
          text: failureWithReason(`${name} could not be removed from the list.`, reason),
        });
      }
    });
  }

  return (
    <section aria-label="Hosted on this computer" className="mb-5">
      <h3 className="mb-2 text-[13px] font-semibold text-ink">Hosted on this computer</h3>
      <ul className="space-y-2">
        {hosted.workspaces.map((w) => (
          <li
            key={w.folder}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-edge px-3 py-2"
          >
            {changingPort.folder === w.folder && !w.missing ? (
              <PortForm
                folder={w.folder}
                name={w.name}
                port={w.port}
                saving={busy === "renaming"}
                onSave={(port) => savePort(w.folder, w.name, port)}
                onCancel={changingPort.close}
              />
            ) : renaming.folder === w.folder && !w.missing ? (
              <RenameForm
                folder={w.folder}
                name={w.name}
                blocked={unavailable}
                saving={busy === "renaming"}
                onSave={(next) => props.saveName(w.folder, w.name, next, renaming.close)}
                onCancel={renaming.close}
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
                        onClick={() => renaming.set(w.folder)}
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
                          renaming.set(null);
                          changingPort.set(w.folder);
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
                          onClick={() => setEarlierOf(earlierOf === w.folder ? null : w.folder)}
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
                      aria-label={w.restored ? `Look inside ${w.name}` : `Start hosting ${w.name}`}
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
                  setNote(note);
                  props.refreshList();
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
                  {w.name} starts as the workspace itself: it sends the messages it had waiting,
                  calls its apps again, and accepts every sign-in it held when the backup was taken,
                  including ones ended since. Ask people to check their signed-in devices
                  afterwards.
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
                  <button type="button" onClick={() => setActivating(null)} className={linkBtnCls}>
                    Not yet
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {hosted.unreadable.length > 0 && (
        <p className="mt-2 text-xs text-ink-dim">
          Could not read the workspace in{" "}
          {hosted.unreadable.length === 1 ? "the folder" : "the folders"}{" "}
          {hosted.unreadable.join(", ")}, so it is not listed.
        </p>
      )}
      <h3 className="mt-5 text-[13px] font-semibold text-ink">New workspace</h3>
    </section>
  );
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
