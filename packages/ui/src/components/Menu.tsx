import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Modal } from "./Modal.js";
import { Icon, type IconName } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";

export interface MenuItem {
  id: string;
  label: string;
  /** A small drawn icon before the label. */
  icon?: IconName;
  /** An emoji in the icon's place, such as a status's. */
  emoji?: string;
  /** What a screen reader says, where the label alone would not explain it. */
  ariaLabel?: string;
  /**
   * Starts a group: a hairline above it, and its name when given. Items that
   * belong together read as one, so a long menu scans in sections.
   */
  section?: string | true;
  /** Danger-zone actions read red. */
  destructive?: boolean;
  /** Ticked when chosen: the one of a set, or each of several in a `multiple` menu. */
  checked?: boolean;
  /** A word or two after the label, such as how long a status lasts. */
  hint?: string;
  disabled?: boolean;
  onSelect: () => void;
}

interface MenuProps {
  /** Accessible name, e.g. "Actions for Sam Rivera". */
  label: string;
  items: MenuItem[];
  /** Small trigger for tight rows; default fits a full-width row. */
  triggerClassName?: string;
  triggerContent?: React.ReactNode;
  /**
   * The trigger's own accessible name, for one whose content says only part of
   * it. Said in one piece: a visually hidden span beside the content reads with
   * a stray space before its comma, as "My Workspace , workspace menu".
   */
  triggerLabel?: string;
  disabled?: boolean;
  /** A hint on the trigger, for one that shows only an icon. It stays away while the menu is open. */
  tooltip?: string;
  /** Line the menu up with the trigger's start rather than its end. */
  align?: "start" | "end";
  /** Told when the menu opens and closes, for a trigger that hides on its own. */
  onOpenChange?: (open: boolean) => void;
  /** Opens and closes it from outside too, as a long press does. */
  open?: boolean;
  /** Shown above the items, such as a row of quick reactions. */
  header?: (close: () => void) => React.ReactNode;
  /** On a phone, rise from the bottom of the screen within a thumb's reach. */
  sheet?: boolean;
  /** How wide it opens, for items such as device names that need the room. */
  width?: number;
  /** Any number of its items can be ticked, each on its own, as filters are. */
  multiple?: boolean;
}

/**
 * One menu for every row of actions, so a person reads as a name rather than
 * five buttons. Built on the modal layer: Escape and a press outside close
 * only the menu, the page underneath stays inert, and focus returns to the
 * trigger. Arrow keys move, Enter chooses, Tab closes and returns focus.
 * Scrolling moves the menu with its trigger instead of dismissing it, so a
 * live timeline settling under an open menu does not take the menu with it.
 */
export function Menu({
  label,
  items,
  triggerClassName,
  triggerContent,
  triggerLabel,
  disabled,
  tooltip,
  align = "end",
  onOpenChange,
  open: openProp,
  header,
  sheet = false,
  width,
  multiple = false,
}: MenuProps) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  };
  const trigger = useRef<HTMLButtonElement>(null);
  const button = (
    <button
      ref={trigger}
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={triggerLabel ?? (typeof triggerContent === "undefined" ? label : undefined)}
      disabled={disabled}
      onClick={() => setOpen(true)}
      className={
        triggerClassName ??
        "icon-live rounded-lg border border-edge px-2 py-1 text-[12px] text-ink-dim transition-colors hover:bg-ink/[0.05] hover:text-ink disabled:opacity-40"
      }
    >
      {triggerContent ?? <Icon name="dots" size={15} strokeWidth={2} />}
    </button>
  );

  return (
    <>
      {/* Always the same button, open or not: one put in its place as the menu
          opens is not the one focus can go back to when it closes. */}
      {tooltip ? (
        <Tooltip label={tooltip} disabled={open}>
          {button}
        </Tooltip>
      ) : (
        button
      )}
      {open && (
        <MenuPanel
          label={label}
          items={items}
          header={header}
          sheet={sheet}
          width={width}
          align={align}
          multiple={multiple}
          anchor={() => trigger.current?.getBoundingClientRect() ?? null}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** Phones without a pointer get the sheet; everything else, a dropdown. */
const SHEET_QUERY = "(hover: none) and (max-width: 760px)";

function MenuPanel({
  label,
  items,
  header,
  sheet,
  align,
  width: wanted,
  multiple,
  anchor,
  onClose,
}: {
  label: string;
  items: MenuItem[];
  header?: (close: () => void) => React.ReactNode;
  sheet: boolean;
  align: "start" | "end";
  width?: number;
  multiple: boolean;
  anchor: () => DOMRect | null;
  onClose: () => void;
}) {
  const [active, setActive] = useState(() => {
    const first = items.findIndex((item) => !item.disabled);
    return first === -1 ? 0 : first;
  });
  const list = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [asSheet] = useState(
    () =>
      sheet && typeof window.matchMedia === "function" && window.matchMedia(SHEET_QUERY).matches,
  );

  // Sit under the trigger, aligned to its end; above it when the bottom
  // would run off the screen. Fixed, because the portal lives on the body.
  // Re-run on every scroll and resize so the menu follows its trigger;
  // only a trigger that is gone closes it.
  const place = useRef(() => {});
  place.current = () => {
    const box = anchor();
    const el = panel.current;
    if (!box || !el) {
      close.current();
      return;
    }
    // A sheet is placed by its class: along the bottom, wherever the trigger is.
    if (asSheet) return;
    const width = Math.min(
      wanted ?? Math.max(200, Math.min(280, box.width)),
      window.innerWidth - 16,
    );
    const height = Math.min(el.offsetHeight, window.innerHeight - 16);
    const roomBelow = window.innerHeight - box.bottom - 8;
    const below = roomBelow >= height || box.top < height;
    const top = below
      ? Math.min(box.bottom + 4, window.innerHeight - height - 8)
      : Math.max(8, box.top - height - 4);
    el.style.width = `${width}px`;
    el.style.top = `${Math.max(8, top)}px`;
    // An aligned menu keeps the trigger's column; nudge back on screen.
    const left = align === "start" ? box.left : box.right - width;
    el.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
    // It grows from the corner nearest the trigger, and shrinks back into it.
    el.style.transformOrigin = `${align === "start" ? "left" : "right"} ${below ? "top" : "bottom"}`;
  };
  useLayoutEffect(() => {
    place.current();
  }, [anchor, align]);
  useEffect(() => {
    const handler = () => place.current();
    document.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      document.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, []);

  // Focus the active item once the modal layer has registered, so its focus
  // recovery keeps it rather than pulling focus back to the panel.
  useLayoutEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-menu-index="${active}"]`)
      ?.focus({ preventScroll: true });
    // Only on mount; arrows move from here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function move(next: number) {
    const enabled = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !item.disabled);
    if (enabled.length === 0) return;
    const at = enabled.findIndex(({ index }) => index === active);
    const pick = enabled[(at + next + enabled.length) % enabled.length]!.index;
    setActive(pick);
    list.current
      ?.querySelector<HTMLElement>(`[data-menu-index="${pick}"]`)
      ?.focus({ preventScroll: true });
  }

  function choose(index: number) {
    const item = items[index];
    if (!item || item.disabled) return;
    onClose();
    item.onSelect();
  }

  const menu = (
    <div
      ref={panel}
      role="menu"
      aria-label={label}
      className={
        asSheet
          ? "surface-float max-h-[60vh] overflow-y-auto rounded-2xl p-1.5 outline-none"
          : "surface-float fixed max-h-[60vh] animate-menu-in overflow-y-auto rounded-xl p-1 outline-none"
      }
      onKeyDown={(event) => {
        // Tab leaves menus rather than cycling them; stop it reaching the
        // modal layer, which would trap it inside instead.
        if (event.key === "Tab") {
          event.stopPropagation();
          event.preventDefault();
          onClose();
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          move(-1);
        } else if (event.key === "Home") {
          event.preventDefault();
          const first = items.findIndex((item) => !item.disabled);
          if (first !== -1) {
            setActive(first);
            list.current
              ?.querySelector<HTMLElement>(`[data-menu-index="${first}"]`)
              ?.focus({ preventScroll: true });
          }
        } else if (event.key === "End") {
          event.preventDefault();
          for (let i = items.length - 1; i >= 0; i--) {
            if (!items[i]!.disabled) {
              setActive(i);
              list.current
                ?.querySelector<HTMLElement>(`[data-menu-index="${i}"]`)
                ?.focus({ preventScroll: true });
              break;
            }
          }
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          choose(active);
        }
      }}
    >
      <div ref={list} className="flex flex-col">
        {items.map((item, index) => (
          <div key={item.id} className="contents">
            {item.section && index > 0 && (
              <div role="separator" className="mx-1.5 my-1 h-px bg-edge" />
            )}
            {typeof item.section === "string" && (
              <div
                aria-hidden="true"
                className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-ink-faint"
              >
                {item.section}
              </div>
            )}
            <button
              type="button"
              role={
                item.checked === undefined
                  ? "menuitem"
                  : multiple
                    ? "menuitemcheckbox"
                    : "menuitemradio"
              }
              aria-checked={item.checked}
              data-menu-index={index}
              tabIndex={-1}
              disabled={item.disabled}
              aria-disabled={item.disabled || undefined}
              aria-label={item.ariaLabel}
              onClick={() => choose(index)}
              onMouseEnter={() => {
                if (!item.disabled) setActive(index);
              }}
              className={`flex items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors ${
                asSheet ? "min-h-12 gap-3 px-3 text-[15px]" : "py-1.5 text-sm"
              } ${
                // A sheet answers a finger: it shows the press, not a choice
                // made in advance, and the keyboard's place only when it is used.
                asSheet
                  ? `${item.destructive ? "text-alert" : "text-ink"} outline-none focus-visible:bg-ink/[0.07] active:bg-ink/[0.07]`
                  : item.destructive
                    ? index === active && !item.disabled
                      ? "bg-alert/10 text-alert"
                      : "text-alert"
                    : index === active && !item.disabled
                      ? "bg-copper/[0.12] text-ink"
                      : "text-ink-dim"
              } disabled:opacity-40`}
            >
              {item.icon && (
                <Icon
                  name={item.icon}
                  size={16}
                  className={item.destructive ? "" : "text-ink-faint"}
                />
              )}
              {item.emoji && (
                <span aria-hidden="true" className="w-4 text-center text-[15px] leading-none">
                  {item.emoji}
                </span>
              )}
              {item.checked === undefined && !item.hint ? (
                item.label
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && (
                    <span className="shrink-0 pl-3 text-[12px] text-ink-faint">{item.hint}</span>
                  )}
                  {item.checked && <Icon name="check" size={14} className="shrink-0 text-copper" />}
                </>
              )}
            </button>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <Modal
      title={label}
      onClose={onClose}
      backdropClassName={asSheet ? "animate-fade-in bg-black/40" : "bg-transparent"}
      className="fixed outline-none"
    >
      {asSheet ? (
        // Along the bottom, in reach of a thumb, with anything quick above it.
        <div className="menu-sheet fixed flex animate-sheet-in flex-col gap-2">
          {header && <div className="surface-float rounded-2xl p-2">{header(onClose)}</div>}
          {menu}
        </div>
      ) : (
        menu
      )}
    </Modal>
  );
}
