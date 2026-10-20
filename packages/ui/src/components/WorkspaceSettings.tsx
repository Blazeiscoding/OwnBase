import { useCallback, useEffect, useId, useRef, useState } from "react";
import { WORKSPACE_NAME_MAX, type AccessPolicy } from "@slackoss/protocol";
import { ApiError } from "@slackoss/client-core";
import { useClient, usePlatform, useWorkspace } from "../context.js";
import { SavedContext, useSaved } from "../lib/savedNote.js";
import { IconProblem, prepareIcon } from "../lib/iconImage.js";
import { useCurrentWorkspaceIcon } from "../lib/workspaceIcon.js";
import { buttonClass } from "./Button.js";
import { useConfirm } from "./Confirm.js";
import { Icon } from "./Icon.js";
import { Modal } from "./Modal.js";
import { stepIn } from "./Motion.js";
import { TextField } from "./TextField.js";
import { WorkspaceIcon } from "./WorkspaceIcon.js";

/** The sections of Workspace settings, in the order its tabs show them. */
const SECTIONS = [
  { id: "general", label: "General" },
  { id: "joining", label: "Who can join" },
] as const;
type Section = (typeof SECTIONS)[number]["id"];

/** How long "Saved" stays after a choice is kept. */
const SAVED_FOR_MS = 2000;

/** Who may join, each said plainly: what it lets in, and what it keeps out. */
const POLICIES: { id: AccessPolicy; title: string; hint: string }[] = [
  {
    id: "invite_only",
    title: "People with an invite",
    hint: "Someone new creates an account with an invite link or code. Owners and admins make them, and so can members they allow.",
  },
  {
    id: "account_required",
    title: "Anyone who creates an account",
    hint: "Anyone who can reach this workspace's address can create an account and join, without an invite.",
  },
  {
    id: "guest_allowed",
    title: "Anyone, guests included",
    hint: "Visitors can also join with only a display name, as guests for a day. Guests see public channels only, and can still create an account.",
  },
];

/** Where an arrow key, Home or End moves from one section, wrapping at either end. */
function sectionAfter(key: string, current: Section): Section | null {
  const at = SECTIONS.findIndex((s) => s.id === current);
  const last = SECTIONS.length - 1;
  if (key === "ArrowDown" || key === "ArrowRight") return SECTIONS[at === last ? 0 : at + 1]!.id;
  if (key === "ArrowUp" || key === "ArrowLeft") return SECTIONS[at === 0 ? last : at - 1]!.id;
  if (key === "Home") return SECTIONS[0]!.id;
  if (key === "End") return SECTIONS[last]!.id;
  return null;
}

/** Whether this view is still on screen, for work that finishes after it may have closed. */
function useAlive() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

/**
 * The workspace's own settings, for its owner and admins (UX-60): its icon,
 * its name and who may join. A page over the workspace, as Account settings
 * is, with its sections on one side and the open one on the other. Choices
 * save as they are made and say so quietly; the name, being typed, has a Save.
 */
export function WorkspaceSettings({
  onClose,
  hostedHere = false,
}: {
  onClose: () => void;
  /** This computer hosts the workspace, so Manage hosting can change who may join too. */
  hostedHere?: boolean;
}) {
  const platform = usePlatform();
  const tabsId = useId();
  const name = useWorkspace((s) => s.workspaceName);
  // A server from before workspace settings refuses both, so neither is offered.
  const editable = useWorkspace((s) => s.workspaceSettings);
  // A server from before workspace icons keeps none, so none is offered.
  const icons = useWorkspace((s) => s.workspaceIcon);
  const [section, setSection] = useState<Section>("general");
  const panel = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const markSaved = useCallback(() => {
    setSaved(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), SAVED_FOR_MS);
  }, []);
  useEffect(() => () => clearTimeout(savedTimer.current), []);

  function choose(next: Section) {
    if (next === section) return;
    setSection(next);
    if (panel.current) panel.current.scrollTop = 0;
    const at = (id: Section) => SECTIONS.findIndex((s) => s.id === id);
    stepIn(panel.current?.firstElementChild, at(next) - at(section));
    setSaved(false);
  }

  const label = SECTIONS.find((s) => s.id === section)!.label;
  const closeButton = (className: string) => (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close"
      className={`flex size-9 items-center justify-center rounded-full border border-edge text-ink-dim transition-colors hover:border-ink-faint hover:text-ink ${className}`}
    >
      <Icon name="close" size={16} />
    </button>
  );
  return (
    <SavedContext.Provider value={markSaved}>
      <Modal
        title="Workspace settings"
        onClose={onClose}
        backdropClassName={`settings-page animate-fade-in${platform.kind === "desktop" ? " settings-page-under-titlebar" : ""}`}
        className="flex h-full w-full flex-col bg-ground outline-none sm:flex-row"
      >
        <div className="settings-nav flex shrink-0 justify-end sm:flex-[1_0_15rem] sm:overflow-y-auto">
          <div className="flex w-full min-w-0 flex-col gap-3 px-4 pb-2 pt-[max(1rem,env(safe-area-inset-top))] sm:w-60 sm:gap-4 sm:px-3 sm:pb-6 sm:pt-12">
            <div className="flex items-start gap-2 sm:px-2">
              <div className="min-w-0 flex-1">
                <h2 className="text-[13px] font-semibold text-ink-dim">Workspace settings</h2>
                <p className="mt-0.5 truncate text-xs text-ink-faint">{name}</p>
              </div>
              {closeButton("sm:hidden")}
            </div>
            <div
              role="tablist"
              aria-label="Workspace settings"
              aria-orientation="vertical"
              // Padded by the width of a focus ring, which its scrolling would clip.
              className="tab-strip -mx-1 flex shrink-0 gap-0.5 overflow-auto p-1 sm:mx-0 sm:flex-col"
              onKeyDown={(event) => {
                const next = sectionAfter(event.key, section);
                if (!next) return;
                event.preventDefault();
                choose(next);
                document.getElementById(`${tabsId}-tab-${next}`)?.focus();
              }}
            >
              {SECTIONS.map((s) => (
                <button
                  key={s.id}
                  id={`${tabsId}-tab-${s.id}`}
                  type="button"
                  role="tab"
                  aria-selected={section === s.id}
                  aria-controls={`${tabsId}-panel`}
                  tabIndex={section === s.id ? 0 : -1}
                  onClick={() => choose(s.id)}
                  className={`shrink-0 rounded-md px-3 py-1.5 text-left text-sm font-medium transition-colors ${
                    section === s.id
                      ? "channel-row-active text-ink"
                      : "text-ink-faint hover:bg-ink/[0.04] hover:text-ink"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 sm:flex-[1_1_50rem]">
          <div
            ref={panel}
            id={`${tabsId}-panel`}
            role="tabpanel"
            aria-labelledby={`${tabsId}-tab-${section}`}
            className="settings-scroll min-w-0 flex-1 overflow-y-auto"
          >
            <div className="max-w-[46rem] px-4 pb-16 pt-2 sm:px-10 sm:pt-12">
              <div className="mb-5 flex items-baseline gap-3">
                <h3 className="text-[17px] font-semibold tracking-tight">{label}</h3>
                {/* Always there, so "Saved" is read out when it appears. */}
                <p
                  aria-live="polite"
                  className="ml-auto flex items-center gap-1 text-xs text-ink-faint"
                >
                  {saved && (
                    <>
                      <Icon name="check" size={13} />
                      Saved
                    </>
                  )}
                </p>
              </div>
              {!editable && (
                <p
                  role="note"
                  className="mb-4 rounded-lg border border-edge bg-raised p-3 text-sm text-ink-dim"
                >
                  This workspace's server runs an older version of Tandem, so its name and who can
                  join are changed where it is hosted, not here.
                </p>
              )}
              {section === "general" && (
                <>
                  {icons && <IconSection />}
                  <NameSection editable={editable} />
                  <PreviewsSection />
                </>
              )}
              {section === "joining" && (
                <JoiningSection editable={editable} hostedHere={hostedHere} />
              )}
            </div>
          </div>
          <div className="hidden shrink-0 flex-col items-center gap-1 pr-5 pt-12 sm:flex">
            {closeButton("")}
            <span aria-hidden="true" className="text-[11px] font-semibold text-ink-faint">
              Esc
            </span>
          </div>
        </div>
      </Modal>
    </SavedContext.Provider>
  );
}

/** What went wrong with the icon, said under its buttons. */
function iconProblem(err: unknown): string {
  if (err instanceof IconProblem) return err.message;
  if (err instanceof ApiError) {
    if (err.code === "admin_only")
      return "Only the workspace's owner and admins can change its icon.";
    if (err.code === "unsupported_icon_type" || err.code === "invalid_icon")
      return "The server could not use that picture. Choose another PNG, JPEG or WebP.";
    if (err.code === "icon_too_large")
      return "That picture is too large for an icon. Choose a simpler one.";
  }
  return "The icon was not changed. Check your connection and try again.";
}

/**
 * The workspace's icon: the one it has, Upload icon to choose a picture,
 * and Remove. A picture is cut to its middle square and sent as soon as it
 * is chosen. Remove asks nothing, since uploading again puts it back.
 */
function IconSection() {
  const client = useClient();
  const saved = useSaved();
  const alive = useAlive();
  const id = useId();
  const name = useWorkspace((s) => s.workspaceName);
  const version = useWorkspace((s) => s.iconVersion);
  const shown = useCurrentWorkspaceIcon();
  const picker = useRef<HTMLInputElement>(null);
  const upload = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<"uploading" | "removing" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function choose(file: File) {
    setBusy("uploading");
    setProblem(null);
    try {
      await client.setWorkspaceIcon(await prepareIcon(file));
      if (alive.current) saved();
    } catch (err) {
      if (!alive.current) return;
      setProblem(iconProblem(err));
      upload.current?.focus();
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy("removing");
    setProblem(null);
    try {
      await client.removeWorkspaceIcon();
      if (!alive.current) return;
      saved();
      // Remove goes with the icon, so focus stays on the section.
      upload.current?.focus();
    } catch (err) {
      if (alive.current) setProblem(iconProblem(err));
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="mb-8">
      <h4 id={`${id}-title`} className="mb-2 text-[13px] font-medium text-ink-dim">
        Workspace icon
      </h4>
      <div className="flex items-start gap-4">
        <WorkspaceIcon
          name={name}
          src={shown}
          size={64}
          letters={2}
          className="rounded-2xl text-xl shadow-[0_8px_24px_-12px_rgb(0_0_0/0.5)]"
        />
        <div className="min-w-0 flex-1">
          <p id={`${id}-hint`} className="text-[13px] text-ink-dim">
            Shown beside the workspace&rsquo;s name in the sidebar, and to anyone who finds it to
            join. A PNG, JPEG or WebP picture, cut to a square.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              ref={upload}
              type="button"
              aria-disabled={busy ? true : undefined}
              aria-describedby={problem ? `${id}-hint ${id}-problem` : `${id}-hint`}
              onClick={() => {
                if (!busy) picker.current?.click();
              }}
              className={buttonClass("secondary")}
            >
              {busy === "uploading" ? "Uploading…" : "Upload icon"}
            </button>
            {version && (
              <button
                type="button"
                aria-disabled={busy ? true : undefined}
                onClick={() => void remove()}
                className={buttonClass("quiet")}
              >
                {busy === "removing" ? "Removing…" : "Remove"}
              </button>
            )}
          </div>
          {/* Opened by Upload icon, which the keyboard and a touch reach as any button. */}
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="Choose a picture for the workspace icon"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared, so choosing the same file again is a choice too.
              event.target.value = "";
              if (file) void choose(file);
            }}
          />
          {problem && (
            <p id={`${id}-problem`} role="alert" className="mt-2 text-sm text-alert">
              {problem}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/** What went wrong renaming, said under the name. */
function renameProblem(err: unknown): string {
  if (err instanceof ApiError && err.code === "invalid_request")
    return `A workspace name has 1 to ${WORKSPACE_NAME_MAX} characters, without tabs or line breaks.`;
  if (err instanceof ApiError && err.code === "admin_only")
    return "Only the workspace's owner and admins can rename it.";
  return "Could not rename the workspace. Check your connection and try again.";
}

/** The workspace's name: typed, checked when sent, and kept with Save. */
function NameSection({ editable }: { editable: boolean }) {
  const client = useClient();
  const saved = useSaved();
  const alive = useAlive();
  const name = useWorkspace((s) => s.workspaceName);
  const [draft, setDraft] = useState(name);
  const [typed, setTyped] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  // Renamed from elsewhere, by another admin or the host, while nothing is
  // typed here: the field shows the new name rather than an old one to save.
  useEffect(() => {
    if (!typed) setDraft(name);
  }, [name, typed]);

  if (!editable)
    return (
      <section aria-labelledby="workspace-name-title">
        <h4 id="workspace-name-title" className="mb-1.5 text-[13px] font-medium text-ink-dim">
          Workspace name
        </h4>
        <p className="text-sm text-ink">{name}</p>
      </section>
    );

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const next = draft.trim();
    const found = !next
      ? "Give the workspace a name."
      : /\p{Cc}/u.test(draft)
        ? "Take out the tab or line break: a workspace name is one line."
        : null;
    setProblem(found);
    if (found) {
      field.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const kept = await client.renameWorkspace(next);
      if (!alive.current) return;
      setDraft(kept);
      setTyped(false);
      saved();
    } catch (err) {
      if (!alive.current) return;
      setProblem(renameProblem(err));
      field.current?.focus();
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <section>
      <form onSubmit={(event) => void save(event)} noValidate className="space-y-3">
        <TextField
          ref={field}
          label="Workspace name"
          hint="Everyone in the workspace sees it, and so does anyone who finds it to join."
          error={problem}
          value={draft}
          maxLength={WORKSPACE_NAME_MAX}
          autoComplete="off"
          onChange={(event) => {
            setDraft(event.target.value);
            setTyped(true);
            setProblem(null);
          }}
        />
        {/* Never off until something is typed: sent empty, the form says what is missing. */}
        <button type="submit" aria-disabled={busy || undefined} className={buttonClass("primary")}>
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
    </section>
  );
}

/**
 * Link previews for new messages (E2), on or off, saved the moment it is
 * changed. A server without previews says nothing about them, so nothing is
 * shown there.
 */
function PreviewsSection() {
  const client = useClient();
  const saved = useSaved();
  const alive = useAlive();
  const current = useWorkspace((s) => s.linkPreviews);
  const [choosing, setChoosing] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const shown = choosing ?? current;
  if (shown === null) return null;

  async function change(enabled: boolean) {
    const ticket = ++request.current;
    setChoosing(enabled);
    setError(null);
    try {
      await client.setLinkPreviews(enabled);
      if (alive.current && ticket === request.current) saved();
    } catch (err) {
      if (!alive.current || ticket !== request.current) return;
      setError(
        err instanceof ApiError && err.code === "admin_only"
          ? "Only the workspace's owner and admins can change link previews."
          : "Link previews were not changed. Check your connection and try again.",
      );
    } finally {
      if (alive.current && ticket === request.current) setChoosing(null);
    }
  }

  return (
    <section aria-labelledby="workspace-previews-title" className="mt-8">
      <h4 id="workspace-previews-title" className="mb-1.5 text-[13px] font-medium text-ink-dim">
        Link previews
      </h4>
      <label className="flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          className="mt-1"
          checked={shown}
          onChange={(event) => void change(event.target.checked)}
        />
        <span>
          Show a preview of web pages linked in messages
          <span className="block text-[13px] text-ink-dim">
            The server reads the page and its picture, so nobody's device contacts the site. Private
            and local addresses are never read. Turning this off adds no previews to new messages;
            ones already shown stay until their sender removes them.
          </span>
        </span>
      </label>
      {error && (
        <p role="alert" className="mt-3 text-sm text-alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Who may join: three rules, each saved the moment it is chosen. */
function JoiningSection({ editable, hostedHere }: { editable: boolean; hostedHere: boolean }) {
  const client = useClient();
  const saved = useSaved();
  const confirm = useConfirm();
  const alive = useAlive();
  const current = useWorkspace((s) => s.accessPolicy);
  const guests = useWorkspace(
    (s) => Object.values(s.users).filter((u) => u.role === "guest" && !u.deactivated).length,
  );
  /** A rule chosen and not yet kept, shown meanwhile. */
  const [choosing, setChoosing] = useState<AccessPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const shown = choosing ?? current;

  if (!editable || !shown) return null;

  async function choose(next: AccessPolicy) {
    if (next === shown) return;
    // Signing guests out cannot be taken back: they have to join again.
    if (current === "guest_allowed" && next !== "guest_allowed" && guests > 0) {
      const sure = await confirm({
        title: "Sign every guest out?",
        body: `${guests === 1 ? "A guest has" : `${guests} guests have`} joined this workspace. Whoever is signed in as a guest is signed out now, and nobody new can join as one. What guests wrote stays.`,
        confirmLabel: "Sign guests out",
        destructive: true,
      });
      if (!sure || !alive.current) return;
    }
    const ticket = ++request.current;
    setChoosing(next);
    setError(null);
    try {
      await client.setAccessPolicy(next);
      if (alive.current && ticket === request.current) saved();
    } catch (err) {
      if (!alive.current || ticket !== request.current) return;
      setError(
        err instanceof ApiError && err.code === "admin_only"
          ? "Only the workspace's owner and admins can change who can join."
          : "Who can join was not changed. Check your connection and try again.",
      );
    } finally {
      if (alive.current && ticket === request.current) setChoosing(null);
    }
  }

  return (
    <section aria-labelledby="workspace-joining-title">
      <fieldset aria-describedby="workspace-joining-hint">
        {/* The section's title says it on screen; the group still needs its name. */}
        <legend id="workspace-joining-title" className="sr-only">
          Who can join
        </legend>
        <p id="workspace-joining-hint" className="mb-3 text-sm text-ink-dim">
          Changes as soon as you choose. People already in the workspace stay either way.
        </p>
        <div className="space-y-2">
          {POLICIES.map((policy) => (
            <label
              key={policy.id}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-copper ${
                shown === policy.id
                  ? "border-ink/30 bg-ink/[0.04]"
                  : "border-edge hover:border-ink/20"
              }`}
            >
              <input
                type="radio"
                name="workspace-access-policy"
                value={policy.id}
                checked={shown === policy.id}
                onChange={() => void choose(policy.id)}
                className="sr-only"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink">{policy.title}</span>
                <span className="block text-[13px] text-ink-dim">{policy.hint}</span>
              </span>
              <span
                aria-hidden="true"
                className={`mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border ${
                  shown === policy.id ? "border-copper" : "border-edge"
                }`}
              >
                {shown === policy.id && <span className="size-2 rounded-full bg-copper" />}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {current === "guest_allowed" && (
        <p className="mt-3 flex items-start gap-2 text-[13px] text-ink-dim">
          <Icon name="alert" size={14} className="mt-0.5 shrink-0 text-copper" />
          <span>
            Choosing either of the others signs every guest out at once, and nobody new can join as
            a guest.
          </span>
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-alert">
          {error}
        </p>
      )}
      {hostedHere && (
        <p className="mt-4 flex items-start gap-2 text-[13px] text-ink-faint">
          <Icon name="server" size={14} className="mt-0.5 shrink-0" />
          <span>
            You host this workspace on this computer. Opening it to all from Manage hosting chooses
            who can join for the public link, and while the link is open Manage hosting shows and
            changes this same setting.
          </span>
        </p>
      )}
    </section>
  );
}
