import {
  Suspense,
  lazy,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { Icon } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";
import { shortcutLabel } from "../lib/shortcuts.js";
import { preloadable } from "../lib/preloadable.js";

// The box asking for a link's address, fetched as the workspace opens.
const linkBox = preloadable(() => import("./LinkBox.js"));
const LazyLinkBox = lazy(() => linkBox.load().then((module) => ({ default: module.LinkBox })));

// Every emoji is far too much for the first download; the workspace fetches it as it opens.
const emojiPicker = preloadable(() => import("./EmojiPicker.js"));
const EmojiPicker = lazy(() =>
  emojiPicker.load().then((module) => ({ default: module.EmojiPicker })),
);

/**
 * What the toolbar's buttons and Ctrl/Cmd keys put round the selection, as in
 * Slack: B, I and E, and Shift+X for strikethrough. The shortcut sheet lists them.
 */
export const TEXT_FORMATS = [
  {
    label: "Bold",
    symbol: "B",
    marker: "*",
    style: "font-bold",
    combo: "Mod+B",
    sheet: "Bold selected text",
  },
  {
    label: "Italic",
    symbol: "I",
    marker: "_",
    style: "italic",
    combo: "Mod+I",
    sheet: "Italic selected text",
  },
  {
    label: "Strikethrough",
    symbol: "S",
    marker: "~",
    style: "line-through",
    combo: "Mod+Shift+X",
    sheet: "Strikethrough selected text",
  },
  {
    label: "Inline code",
    symbol: "</>",
    marker: "`",
    style: "font-mono text-xs",
    combo: "Mod+E",
    sheet: "Inline code",
  },
] as const;

/** The key of a combo, past Mod and Shift, and whether it needs Shift. */
const keyOf = (combo: string) => ({
  key: combo.split("+").at(-1)!.toLowerCase(),
  shift: combo.includes("+Shift+"),
});

/** The marker Ctrl/Cmd with this key puts round the selection. */
export const formattingShortcut = (key: string, shift = false) =>
  TEXT_FORMATS.find((format) => {
    const wanted = keyOf(format.combo);
    return wanted.key === key.toLowerCase() && wanted.shift === shift;
  })?.marker;

/** A bulleted list ("- ") or a numbered one ("1. "), as Mrkdwn draws them. */
export type ListKind = "bullets" | "numbers";

/**
 * Ctrl/Cmd+Shift+8 for a bulleted list and +7 for a numbered one, as in Slack.
 * Read from the key's place, since Shift changes what the key types.
 */
export const LIST_FORMATS = [
  { kind: "bullets", label: "Bulleted list", combo: "Mod+Shift+8", code: "Digit8" },
  { kind: "numbers", label: "Numbered list", combo: "Mod+Shift+7", code: "Digit7" },
] as const;

export function listShortcut(event: { code: string; shiftKey: boolean }): ListKind | undefined {
  if (!event.shiftKey) return undefined;
  return LIST_FORMATS.find((list) => list.code === event.code)?.kind;
}

/** The marker an item starts with, of each kind; the space after it is the composer's to type. */
const LIST_MARKERS: Record<ListKind, RegExp> = {
  bullets: /^[-*\u2022][ \t]+/,
  numbers: /^\d{1,3}[.)][ \t]+/,
};

/**
 * Makes each line the selection touches an item of a list, numbered from 1
 * for a numbered one, or, when every one of them already is an item of that
 * kind, plain lines again. An item of the other kind changes kind; a blank
 * line among several stays blank. A caret keeps its place in its line's words.
 */
export function formatList(text: string, start: number, end: number, kind: ListKind) {
  // A selection ending at the start of a line does not take that line in.
  const last = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const next = text.indexOf("\n", last);
  const to = next === -1 ? text.length : next;
  const lines = text.slice(from, to).split("\n");
  const marker = (line: string) =>
    (LIST_MARKERS.bullets.exec(line) ?? LIST_MARKERS.numbers.exec(line))?.[0] ?? "";
  const written = lines.filter((line) => line.trim());
  const undo = written.length > 0 && written.every((line) => LIST_MARKERS[kind].test(line));
  let count = 0;
  const changed = lines.map((line) => {
    const words = line.slice(marker(line).length);
    if (undo) return words;
    if (!line.trim() && lines.length > 1) return line;
    return (kind === "bullets" ? "- " : `${++count}. `) + words;
  });
  const block = changed.join("\n");
  const result = text.slice(0, from) + block + text.slice(to);
  if (start !== end || lines.length !== 1)
    return { text: result, selectionStart: from, selectionEnd: from + block.length };
  const line = lines[0]!;
  const intoWords = Math.max(0, start - from - marker(line).length);
  const caret = from + marker(changed[0]!).length + intoWords;
  return { text: result, selectionStart: caret, selectionEnd: caret };
}

/** Keep composer and editor selection behavior identical. */
export function formatText(
  text: string,
  start: number,
  end: number,
  marker: string,
  placeholder = "text",
  block = false,
) {
  const selected = text.slice(start, end) || placeholder;
  const unwrap =
    !block &&
    start >= marker.length &&
    text.slice(start - marker.length, start) === marker &&
    text.slice(end, end + marker.length) === marker;
  const prefix = unwrap
    ? ""
    : block
      ? `${start > 0 && text[start - 1] !== "\n" ? "\n" : ""}${marker}\n`
      : marker;
  const suffix = unwrap
    ? ""
    : block
      ? `\n${marker}${end < text.length && text[end] !== "\n" ? "\n" : ""}`
      : marker;
  const from = unwrap ? start - marker.length : start;
  const to = unwrap ? end + marker.length : end;
  return {
    text: text.slice(0, from) + prefix + selected + suffix + text.slice(to),
    selectionStart: from + prefix.length,
    selectionEnd: from + prefix.length + selected.length,
  };
}

/** Ctrl/Cmd+Shift+U adds a link, and Ctrl/Cmd+Shift+9 a quote, as in Slack. */
export const LINK_FORMAT = { label: "Link", combo: "Mod+Shift+U", sheet: "Add a link" } as const;
export const QUOTE_FORMAT = {
  label: "Quote",
  combo: "Mod+Shift+9",
  code: "Digit9",
  sheet: "Quote selected lines",
} as const;

export function linkShortcut(event: { key: string; shiftKey: boolean }): boolean {
  return event.shiftKey && event.key.toLowerCase() === "u";
}

export function quoteShortcut(event: { code: string; shiftKey: boolean }): boolean {
  return event.shiftKey && event.code === QUOTE_FORMAT.code;
}

/**
 * What was typed as a link's address, as a link can hold it: a bare
 * "ownbase.site" gets https://, and anything that is not a web or mail
 * address is refused (null).
 */
export function linkAddress(typed: string): string | null {
  const text = typed.trim();
  if (!text || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol === "mailto:") return withScheme;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // "https://notes" is a word, not a site.
  if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
  return withScheme;
}

/**
 * Makes the selection a link to `url`, written as Mrkdwn's `<url|words>`, with
 * the caret after it. Without a selection the address goes in by itself.
 * Words that cannot sit inside a link's brackets keep their place, the
 * address after them.
 */
export function formatLink(text: string, start: number, end: number, url: string) {
  const words = text.slice(start, end);
  const inserted = !words
    ? `<${url}>`
    : /[<>|\n]/.test(words)
      ? `${words} <${url}>`
      : `<${url}|${words}>`;
  const caret = start + inserted.length;
  return {
    text: text.slice(0, start) + inserted + text.slice(end),
    selectionStart: caret,
    selectionEnd: caret,
  };
}

/** A quoted line's start, as Mrkdwn reads it. */
const QUOTED = /^>[ \t]?/;

/**
 * Quotes each line the selection touches, or, when every written one already
 * is quoted, takes the quote away again, as the list buttons do.
 */
export function formatQuote(text: string, start: number, end: number) {
  const last = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const next = text.indexOf("\n", last);
  const to = next === -1 ? text.length : next;
  const lines = text.slice(from, to).split("\n");
  const written = lines.filter((line) => line.trim());
  const undo = written.length > 0 && written.every((line) => QUOTED.test(line));
  const changed = lines.map((line) => {
    if (undo) return line.replace(QUOTED, "");
    if (!line.trim() && lines.length > 1) return line;
    return `> ${line}`;
  });
  const block = changed.join("\n");
  const result = text.slice(0, from) + block + text.slice(to);
  if (start !== end || lines.length !== 1)
    return { text: result, selectionStart: from, selectionEnd: from + block.length };
  const caret = Math.max(from, start + (block.length - (to - from)));
  return { text: result, selectionStart: caret, selectionEnd: caret };
}

/** What the composer and the editor can ask of their toolbar. */
export interface FormattingToolbarHandle {
  /** Opens the box that asks for a link's address, as Ctrl/Cmd+Shift+U does. */
  openLink: () => void;
}

interface Props {
  onFormat: (marker: string, placeholder: string, block?: boolean) => void;
  /** Makes the text box's selection a link to this address. */
  onLink: (url: string) => void;
  onQuote: () => void;
  /** The link box closed, added or not: the text box takes focus back. */
  onLinkDone: () => void;
  ref?: Ref<FormattingToolbarHandle>;
  onList: (kind: ListKind) => void;
  onInsert: (text: string) => void;
  preview: boolean;
  onTogglePreview: () => void;
  /**
   * "row", the default, is a strip of its own above the text, as in the
   * message editor. "inline" sits among the composer's other controls under
   * the text, and its emoji chooser floats above the composer.
   */
  placement?: "row" | "inline";
}

const tool =
  "icon-live flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-ink-faint transition-colors hover:bg-ink/[0.07] hover:text-ink";

export function FormattingToolbar({
  onFormat,
  onLink,
  onQuote,
  onLinkDone,
  onList,
  onInsert,
  preview,
  onTogglePreview,
  placement = "row",
  ref,
}: Props) {
  const inline = placement === "inline";
  const [open, setOpen] = useState(false);
  const [linking, setLinking] = useState(false);
  useImperativeHandle(ref, () => ({ openLink: () => setLinking(true) }), []);
  // The formatting buttons fold away behind one, so the composer leaves room
  // for what is being written. theme.css does the folding.
  const [expanded, setExpanded] = useState(false);
  const buttonsId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const chooser = useRef<HTMLDivElement>(null);
  function insert(emoji: string) {
    onInsert(emoji);
    setOpen(false);
  }
  // A press anywhere else closes the chooser, as Slack's does, and focus goes
  // where the press put it. The button that opened it closes it itself.
  useEffect(() => {
    if (!open) return;
    const pressed = (event: PointerEvent) => {
      const target = event.target as Node;
      if (chooser.current?.contains(target) || trigger.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", pressed, true);
    return () => document.removeEventListener("pointerdown", pressed, true);
  }, [open]);
  return (
    <>
      <div
        role="group"
        aria-label="Message formatting"
        data-expanded={expanded || undefined}
        className={
          inline
            ? // Never narrower than its own buttons: squeezed, "Aa" and the emoji button stacked.
              "formatting-group flex max-w-full shrink-0 flex-wrap items-center gap-0.5 text-sm text-ink-dim"
            : "flex flex-wrap items-center gap-0.5 border-b border-edge/60 px-2 py-1 text-sm text-ink-dim"
        }
      >
        <Tooltip label={expanded ? "Hide formatting" : "Formatting"}>
          <button
            type="button"
            aria-label="Formatting"
            aria-expanded={expanded}
            aria-controls={buttonsId}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setExpanded((v) => !v)}
            className={`formatting-toggle ${tool} text-[13px] font-semibold ${
              expanded ? "bg-ink/[0.08] text-ink" : ""
            }`}
          >
            Aa
          </button>
        </Tooltip>
        <span
          id={buttonsId}
          className="formatting-buttons flex items-center gap-0.5"
          data-expanded={expanded || undefined}
        >
          {TEXT_FORMATS.map((item) => (
            <Tooltip key={item.label} label={item.label} keys={shortcutLabel(item.combo)}>
              <button
                type="button"
                aria-label={item.label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onFormat(item.marker, "text")}
                className={`${tool} ${item.style}`}
              >
                {item.symbol}
              </button>
            </Tooltip>
          ))}
          <Tooltip label="Code block">
            <button
              type="button"
              aria-label="Code block"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onFormat("```", "code", true)}
              className={`${tool} font-mono text-xs`}
            >
              {"{ }"}
            </button>
          </Tooltip>
          <Tooltip label={LINK_FORMAT.label} keys={shortcutLabel(LINK_FORMAT.combo)}>
            <button
              type="button"
              aria-label={LINK_FORMAT.label}
              aria-expanded={linking}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setLinking((v) => !v)}
              className={`${tool} ${linking ? "bg-ink/[0.08] text-ink" : ""}`}
            >
              <Icon name="link" size={16} />
            </button>
          </Tooltip>
          {LIST_FORMATS.map((item) => (
            <Tooltip key={item.kind} label={item.label} keys={shortcutLabel(item.combo)}>
              <button
                type="button"
                aria-label={item.label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onList(item.kind)}
                className={tool}
              >
                <Icon name={item.kind} size={16} />
              </button>
            </Tooltip>
          ))}
          <Tooltip label={QUOTE_FORMAT.label} keys={shortcutLabel(QUOTE_FORMAT.combo)}>
            <button
              type="button"
              aria-label={QUOTE_FORMAT.label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onQuote}
              className={`${tool} text-[15px] font-semibold`}
            >
              {"\u201D"}
            </button>
          </Tooltip>
          <button
            type="button"
            aria-pressed={preview}
            onClick={onTogglePreview}
            className={`${tool} text-xs ${preview ? "bg-ink/[0.08] text-ink" : ""}`}
          >
            Preview
          </button>
          <span aria-hidden="true" className="mx-1 h-4 w-px bg-edge" />
        </span>
        <Tooltip label="Insert emoji">
          <button
            ref={trigger}
            type="button"
            aria-label="Insert emoji"
            aria-expanded={open}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOpen((v) => !v)}
            className={`${tool} ${open ? "bg-ink/[0.08] text-ink" : ""}`}
          >
            <Icon name="smile" size={16} />
          </button>
        </Tooltip>
      </div>
      {linking && (
        <Suspense fallback={null}>
          <LazyLinkBox
            inline={inline}
            onAdd={(url) => {
              setLinking(false);
              onLink(url);
              onLinkDone();
            }}
            onCancel={() => {
              setLinking(false);
              onLinkDone();
            }}
          />
        </Suspense>
      )}
      {open && (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape from the chooser's search or buttons closes it
        <div
          ref={chooser}
          role="group"
          aria-label="Choose an emoji"
          className={
            inline
              ? "surface-float absolute bottom-full left-2 z-20 mb-2 w-[360px] max-w-[calc(100vw-1rem)] origin-bottom-left animate-menu-in overflow-hidden rounded-xl"
              : "border-b border-edge/60"
          }
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
            }
          }}
        >
          <ErrorBoundary
            fallback={
              <p role="alert" className="p-3 text-sm text-ink-dim">
                The emoji picker could not load. Reload the app to try again.
              </p>
            }
          >
            <Suspense
              fallback={
                <p role="status" className="p-3 text-sm text-ink-faint">
                  Loading emoji…
                </p>
              }
            >
              {/* As wide as it floats in the composer, not the width of the edit box. */}
              <div className="max-w-[360px]">
                {/* eslint-disable-next-line jsx-a11y/no-autofocus -- the emoji chooser opened from the toolbar starts in its search */}
                <EmojiPicker onPick={insert} autoFocus />
              </div>
            </Suspense>
          </ErrorBoundary>
        </div>
      )}
    </>
  );
}
