import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isImeKey } from "../lib/textInput.js";

interface Layer {
  root: HTMLDivElement;
  panel: HTMLDivElement;
  opener: HTMLElement | null;
  owner: Layer | null;
  lastFocus: HTMLElement | null;
  close: () => void;
}

const layers = new Set<Layer>();
const originalInert = new Map<HTMLElement, string | null>();
let bodyObserver: MutationObserver | null = null;
let focusObserver: MutationObserver | null = null;
let observedLayer: Layer | null = null;
let redirectingFocus = false;

function follows(element: Node, other: Node) {
  return !!(other.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function activeLayer(): Layer | null {
  let active: Layer | null = null;
  for (const layer of layers) {
    if (layer.root.isConnected && (!active || follows(layer.root, active.root))) active = layer;
  }
  return active;
}

export function hasOpenModal(): boolean {
  return activeLayer() !== null;
}

function focusedElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function ownerOf(element: HTMLElement | null): Layer | null {
  return element ? ([...layers].find((layer) => layer.panel.contains(element)) ?? null) : null;
}

function available(element: HTMLElement): boolean {
  if (
    !element.isConnected ||
    element.closest("[hidden], [inert]") ||
    element.matches(":disabled, input[type=hidden]")
  )
    return false;
  const style = getComputedStyle(element);
  return (
    style.visibility !== "hidden" &&
    style.visibility !== "collapse" &&
    element.getClientRects().length > 0
  );
}

function usableIn(layer: Layer, element: HTMLElement | null): element is HTMLElement {
  return !!element && layer.panel.contains(element) && available(element);
}

/** Child autoFocus can run before the new portal's layout effect registers it. */
function enteringHigherLayer(element: HTMLElement | null, current: Layer): boolean {
  const root = element?.closest<HTMLElement>("[data-ownbase-modal]");
  return !!root && root.parentElement === document.body && follows(root, current.root);
}

function focus(element: HTMLElement) {
  if (redirectingFocus) return;
  redirectingFocus = true;
  try {
    element.focus({ preventScroll: true });
  } finally {
    redirectingFocus = false;
  }
}

function recoverFocus() {
  const layer = activeLayer();
  if (!layer || redirectingFocus) return;
  const current = focusedElement();
  if (enteringHigherLayer(current, layer)) return;
  if (usableIn(layer, current)) {
    layer.lastFocus = current;
    return;
  }
  const target = usableIn(layer, layer.lastFocus) ? layer.lastFocus : layer.panel;
  focus(target);
  if (usableIn(layer, focusedElement())) layer.lastFocus = focusedElement();
}

function restoreInert(element: HTMLElement, value: string | null) {
  if (value === null) element.removeAttribute("inert");
  else element.setAttribute("inert", value);
}

/** The active portal stays interactive; the workspace and older portals do not. */
function isolate(layer: Layer | null) {
  for (const [element, value] of originalInert) {
    if (!layer || element.parentElement !== document.body || element === layer.root) {
      restoreInert(element, value);
      originalInert.delete(element);
    }
  }
  if (!layer) return;
  for (const element of document.body.children) {
    if (!(element instanceof HTMLElement) || element === layer.root) continue;
    // Notices report what happened elsewhere, including while this dialog has
    // been open. They compete with nothing on it, so they stay readable and
    // stay in the accessibility tree rather than going inert behind it.
    if (element.hasAttribute("data-ownbase-toasts")) continue;
    if (!originalInert.has(element)) originalInert.set(element, element.getAttribute("inert"));
    if (!element.hasAttribute("inert")) element.setAttribute("inert", "");
  }
}

function reconcile() {
  const layer = activeLayer();
  isolate(layer);
  if (observedLayer !== layer) {
    focusObserver?.disconnect();
    observedLayer = layer;
    if (layer) {
      focusObserver ??= new MutationObserver(recoverFocus);
      focusObserver.observe(layer.root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [
          "disabled",
          "hidden",
          "inert",
          "style",
          "class",
          "tabindex",
          "type",
          "open",
        ],
      });
    }
  }
  recoverFocus();
}

function tabStops(panel: HTMLElement): HTMLElement[] {
  const candidates = [
    ...panel.querySelectorAll<HTMLElement>(
      "a[href], area[href], button, input, select, textarea, iframe, audio[controls], video[controls], summary, [tabindex], [contenteditable]",
    ),
  ].filter((element) => element.tabIndex >= 0 && available(element));
  // A radio group is one Tab stop, even though every radio can receive focus.
  return candidates
    .filter((element) => {
      if (!(element instanceof HTMLInputElement) || element.type !== "radio" || !element.name)
        return true;
      const group = candidates.filter(
        (candidate): candidate is HTMLInputElement =>
          candidate instanceof HTMLInputElement &&
          candidate.type === "radio" &&
          candidate.name === element.name &&
          candidate.form === element.form,
      );
      return element === (group.find((radio) => radio.checked) ?? group[0]);
    })
    .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
}

/** How much of its own height each key scrolls a dialog's content by. */
const SCROLL_KEYS: Record<string, number> = {
  PageDown: 0.9,
  PageUp: -0.9,
  ArrowDown: 0.1,
  ArrowUp: -0.1,
  End: 1e4,
  Home: -1e4,
};

/**
 * A key that scrolls does so only from inside what scrolls, and a dialog's
 * name, its close button and a field kept above a list are outside it, as
 * settings' list of sections is. Page Up and Page Down reach it from those,
 * and every key here from the dialog itself, which is where focus is when
 * nothing in it asked for it.
 */
function scrollFromOutside(event: KeyboardEvent, panel: HTMLElement): boolean {
  const from = event.target as Element;
  const scroller = panel.querySelector(".dialog-scroll");
  const by = SCROLL_KEYS[event.key];
  if (!by || !scroller || scroller.contains(from)) return false;
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  // In a control an arrow, Home or End is the control's, and so is a page in a box of lines.
  const paging = event.key.startsWith("Page");
  if (from !== panel && (!paging || from.matches("textarea, select"))) return false;
  scroller.scrollTop += by * scroller.clientHeight;
  return true;
}

function onKeyDown(event: KeyboardEvent) {
  const layer = activeLayer();
  if (!layer || event.defaultPrevented || isImeKey(event)) return;
  if (event.key === "Escape") {
    event.preventDefault();
    layer.close();
    return;
  }
  if (scrollFromOutside(event, layer.panel)) {
    event.preventDefault();
    return;
  }
  if (event.key !== "Tab") return;
  const stops = tabStops(layer.panel);
  const first = stops[0],
    last = stops.at(-1);
  const current = focusedElement();
  if (!first || !last) {
    event.preventDefault();
    focus(layer.panel);
    return;
  }
  const outside = !usableIn(layer, current);
  const panelFocused = current === layer.panel;
  // A focused confirmation section may have tabIndex=-1. Preserve natural Tab
  // navigation through its children, while still wrapping at the panel edges.
  const beyondStops =
    current &&
    !stops.includes(current) &&
    !panelFocused &&
    !stops.some((stop) => (event.shiftKey ? follows(current, stop) : follows(stop, current)));
  if (event.shiftKey && (outside || panelFocused || current === first || beyondStops)) {
    event.preventDefault();
    focus(last);
  } else if (!event.shiftKey && (outside || panelFocused || current === last || beyondStops)) {
    event.preventDefault();
    focus(first);
  }
}

function install() {
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("focusin", recoverFocus);
  bodyObserver = new MutationObserver(reconcile);
  bodyObserver.observe(document.body, { childList: true });
}

function uninstall() {
  document.removeEventListener("keydown", onKeyDown);
  document.removeEventListener("focusin", recoverFocus);
  bodyObserver?.disconnect();
  focusObserver?.disconnect();
  bodyObserver = null;
  focusObserver = null;
  observedLayer = null;
  isolate(null);
}

/** Find an opener even if the dialog which contained it was removed earlier. */
function returnTarget(layer: Layer, active: Layer | null): HTMLElement | null {
  const seen = new Set<Layer>();
  for (let record: Layer | null = layer; record && !seen.has(record); record = record.owner) {
    seen.add(record);
    const removedOwner =
      record.owner &&
      !layers.has(record.owner) &&
      !!record.opener &&
      record.owner.panel.contains(record.opener);
    if (
      !removedOwner &&
      record.opener &&
      available(record.opener) &&
      (!active || active.panel.contains(record.opener))
    ) {
      return record.opener;
    }
  }
  return null;
}

/**
 * A dialog is gone the moment whatever drew it stops, so it cannot play its
 * own way out. A copy of it does: put where it was, inert and hidden from
 * readers, with no ids or names to be found by, it plays the "-out" twin of
 * each opening animation (theme.css, under [data-leaving]) and removes itself
 * when they end. Called while the dialog is still in the document, so the
 * copy can take its fields' values and its scroll positions. Returns how to
 * take the copy back, for a dialog that was not closing after all. Nothing is
 * left for anyone who asked for less motion, or where nothing animates.
 */
function leaveBehind(root: HTMLElement): (() => void) | undefined {
  if (
    typeof root.getAnimations !== "function" ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
    // One closed while still opening, as a loading placeholder is when what
    // it waited for arrives, was barely there: a copy would flash it whole.
    root
      .getAnimations({ subtree: true })
      .some((animation) => (animation as CSSAnimation).animationName?.endsWith("-in"))
  )
    return;
  const copy = root.cloneNode(true) as HTMLElement;
  const twins = copy.querySelectorAll<HTMLElement>("*");
  const scrolled: [HTMLElement, number, number][] = [];
  root.querySelectorAll<HTMLElement>("*").forEach((element, i) => {
    const twin = twins[i]!;
    for (const name of ["id", "name", "for", "role", "autofocus", "autoplay"])
      twin.removeAttribute(name);
    if (element.scrollTop || element.scrollLeft)
      scrolled.push([twin, element.scrollTop, element.scrollLeft]);
    if (element instanceof HTMLInputElement) {
      (twin as HTMLInputElement).checked = element.checked;
      if (element.type !== "file") (twin as HTMLInputElement).value = element.value;
    } else if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      (twin as HTMLTextAreaElement).value = element.value;
    } else if (element instanceof HTMLCanvasElement && element.width && element.height) {
      (twin as HTMLCanvasElement).getContext("2d")?.drawImage(element, 0, 0);
    }
  });
  copy.removeAttribute("data-ownbase-modal");
  copy.setAttribute("aria-hidden", "true");
  copy.setAttribute("data-leaving", "");
  copy.inert = true;
  root.before(copy);
  for (const [twin, top, left] of scrolled) {
    twin.scrollTop = top;
    twin.scrollLeft = left;
  }
  const leaving = copy
    .getAnimations({ subtree: true })
    .filter((animation) => (animation as CSSAnimation).animationName?.endsWith("-out"));
  const remove = () => copy.remove();
  if (leaving.length === 0) remove();
  else void Promise.allSettled(leaving.map((animation) => animation.finished)).then(remove);
  return remove;
}

interface Props {
  title: string;
  onClose: () => void;
  dismissible?: boolean;
  children: ReactNode;
  /** Id of text read along with the title, for content the label cannot carry. */
  describedBy?: string;
  backdropClassName?: string;
  className?: string;
  style?: CSSProperties;
}

/** One keyboard/focus owner for every dialog and image viewer. */
export function Modal({
  title,
  onClose,
  dismissible = true,
  children,
  describedBy,
  backdropClassName = "",
  className,
  style,
}: Props) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const layer = useRef<Layer | null>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const opener = useRef(focusedElement());
  const owner = useRef(ownerOf(opener.current));
  const close = useRef(onClose);
  close.current = () => {
    if (dismissible) onClose();
  };
  const left = useRef<(() => void) | undefined>(undefined);

  useLayoutEffect(() => {
    if (!root.current || !panel.current) return;
    // Development runs this twice on open, closing it in between: the copy
    // that close left behind goes before anyone sees it.
    left.current?.();
    const current: Layer = {
      root: root.current,
      panel: panel.current,
      opener: opener.current,
      owner: owner.current,
      lastFocus: lastFocus.current,
      close: () => close.current(),
    };
    layer.current = current;
    if (layers.size === 0) install();
    layers.add(current);
    reconcile();
    return () => {
      left.current = leaveBehind(current.root);
      const wasActive = activeLayer() === current;
      lastFocus.current = current.lastFocus;
      layers.delete(current);
      layer.current = null;
      if (layers.size === 0) uninstall();
      else reconcile();
      if (wasActive) {
        const target = returnTarget(current, activeLayer());
        if (target) focus(target);
        else recoverFocus();
      }
    };
  }, []);

  return createPortal(
    <div
      ref={root}
      data-ownbase-modal=""
      className={"fixed inset-0 z-[60] " + backdropClassName}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && activeLayer() === layer.current) {
          // Closing gives focus back to the opener; the press's own focus
          // change would then take it to the page.
          event.preventDefault();
          close.current();
        }
      }}
    >
      <div
        ref={panel}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-label={title}
        aria-describedby={describedBy}
        className={className}
        style={style}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
