import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { useGuardRegistry } from "../lib/dismissGuard.js";
import { usePlatform } from "../context.js";
import { DialogScroll } from "./Dialog.js";
import { Icon } from "./Icon.js";
import { Modal } from "./Modal.js";
import { stepIn } from "./Motion.js";

interface Section<S extends string> {
  id: S;
  label: string;
}

/** Where an arrow key, Home or End moves from one section, wrapping at either end. */
function sectionAfter<S extends string>(
  sections: readonly Section<S>[],
  key: string,
  current: S,
): S | null {
  const at = sections.findIndex((s) => s.id === current);
  const last = sections.length - 1;
  if (key === "ArrowDown" || key === "ArrowRight") return sections[at === last ? 0 : at + 1]!.id;
  if (key === "ArrowUp" || key === "ArrowLeft") return sections[at === 0 ? last : at - 1]!.id;
  if (key === "Home") return sections[0]!.id;
  if (key === "End") return sections[last]!.id;
  return null;
}

/**
 * The window Account settings and Workspace settings are drawn in (UX-60):
 * their name and a list of sections on one side, and the open section on the
 * other, whose name stays in sight while what is under it scrolls. Over the
 * workspace as the other dialogs are, and one size for every section, so
 * choosing another moves nothing under the pointer. On a phone, or in a window
 * too narrow for it, it fills the screen with the sections as a strip above
 * the open one (theme.css).
 */
export function SettingsWindow<S extends string>({
  title,
  about,
  sections,
  section,
  onChoose,
  tabsId,
  search,
  found,
  searching = false,
  saved,
  scroller,
  onClose,
  children,
}: {
  title: string;
  /** Whose settings these are, said under the name. */
  about: ReactNode;
  sections: readonly Section<S>[];
  section: S;
  onChoose: (section: S) => void;
  /** Starts the ids of the tabs and the panel, so a tab can be found to focus. */
  tabsId: string;
  /** A search above the sections. */
  search?: ReactNode;
  /** What the search found, shown in place of the sections while searching. */
  found?: ReactNode;
  searching?: boolean;
  saved: boolean;
  /** What scrolls: the open section, under its name. */
  scroller: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const platform = usePlatform();
  // Closing, and going to another section, which puts this one away, both ask
  // what the open section holds (`useDismissGuard`).
  const guards = useGuardRegistry();
  const choose = (next: S) => guards.ask(() => onChoose(next));
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef(section);

  useLayoutEffect(() => {
    const from = shown.current;
    shown.current = section;
    if (from === section) return;
    // A section steps in from the side of the list it is on: one further down from the right.
    const at = (id: S) => sections.findIndex((s) => s.id === id);
    stepIn(heading.current, at(section) - at(from));
    stepIn(scroller.current?.firstElementChild, at(section) - at(from));
  }, [section, sections, scroller]);

  // On a phone the sections are a strip that scrolls sideways, and the one
  // opened on may be past its end. Brought to the middle, it shows its neighbours.
  useEffect(() => {
    document
      .getElementById(`${tabsId}-tab-${section}`)
      ?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [tabsId, section]);

  return (
    <Modal
      title={title}
      onClose={onClose}
      guards={guards}
      backdropClassName={`settings-backdrop dialog-backdrop animate-fade-in${platform.kind === "desktop" ? " settings-under-titlebar" : ""}`}
      className="settings-window dialog-surface animate-pop-in outline-none"
    >
      {/* The window's own navigation: its name, whose settings they are, a
          search and the sections. It stays put while a section scrolls. */}
      <div className="settings-nav">
        <div className="settings-nav-head">
          <h2 className="text-[13px] font-semibold text-ink-dim">{title}</h2>
          <p className="mt-0.5 truncate text-xs text-ink-faint">{about}</p>
        </div>
        {search}
        <div
          role="tablist"
          aria-label={title}
          aria-orientation="vertical"
          hidden={searching}
          // Padded by the width of a focus ring, which its scrolling would clip.
          className="settings-tabs tab-strip flex shrink-0 gap-0.5 overflow-auto p-1"
          onKeyDown={(event) => {
            const next = sectionAfter(sections, event.key, section);
            if (!next) return;
            event.preventDefault();
            choose(next);
            document.getElementById(`${tabsId}-tab-${next}`)?.focus();
          }}
        >
          {sections.map((s) => (
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
        {found}
      </div>
      <button
        type="button"
        onClick={() => guards.ask(onClose)}
        aria-label="Close"
        className="settings-close flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
      >
        <Icon name="close" size={16} />
      </button>
      <div
        id={`${tabsId}-panel`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-tab-${section}`}
        className="settings-section"
      >
        <div className="settings-head">
          <h3 ref={heading} className="text-[17px] font-semibold tracking-tight">
            {sections.find((s) => s.id === section)?.label}
          </h3>
          {/* Always there, so "Saved" is read out when it appears; not a
              status of its own, which would crowd out the section's. */}
          <p aria-live="polite" className="ml-auto flex items-center gap-1 text-xs text-ink-faint">
            {saved && (
              <>
                <Icon name="check" size={13} />
                Saved
              </>
            )}
          </p>
        </div>
        {/* Each section scrolls on its own, so it opens at its start, and its
            edges fade for what it holds: a scroll timeline left with nothing
            to scroll keeps the fade the last section ended on. */}
        <DialogScroll key={section} ref={scroller}>
          {children}
        </DialogScroll>
      </div>
    </Modal>
  );
}
