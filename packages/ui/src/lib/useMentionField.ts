import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import type { Channel, ID, User } from "@ownbase/protocol";
import {
  projectMentions,
  replaceShown,
  shownEdit,
  shownPosition,
  storedPosition,
  type MentionDocument,
} from "./mentionDocument.js";
import { caretToRestore, type PendingCaret } from "./textInput.js";

/** How many earlier states Undo and Redo can find their mentions in. */
const REMEMBERED = 200;

/**
 * A message box that shows mentions as names while its text keeps their ids
 * (see `mentionDocument`). The box's owner keeps the stored text as before;
 * this works out what the box shows, turns the box's changes back into stored
 * text, and makes its own rewrites (a completed mention, a formatting shortcut)
 * as the browser's own edits, so Undo and Redo take them back like typing.
 */
export function useMentionField(
  text: string,
  box: RefObject<HTMLTextAreaElement | null>,
  /** Takes the stored text after a rewrite the browser could not make itself. */
  commit: (stored: string) => void,
  users: Record<ID, User>,
  channels: Record<ID, Channel>,
) {
  const doc = useMemo(() => projectMentions(text, { users, channels }), [text, users, channels]);
  const current = useRef(doc);
  current.current = doc;
  /** A rewrite handed to the browser, for the change it brings back. */
  const expected = useRef<{ shown: string; stored: string } | null>(null);
  const pendingCaret = useRef<PendingCaret | null>(null);
  /**
   * What each recent state of the box stored, by what it showed. Undo brings
   * back only the characters; this brings back the mentions they were.
   */
  const remembered = useRef(new Map<string, string>());

  useEffect(() => {
    const seen = remembered.current;
    seen.delete(doc.shown);
    seen.set(doc.shown, doc.stored);
    if (seen.size > REMEMBERED) seen.delete(seen.keys().next().value!);
  }, [doc]);

  /**
   * Puts the caret back after a rewrite, before the browser has painted, and
   * only while the box still holds what the position was worked out for: a
   * keystroke since then wins (see `caretToRestore`).
   */
  useLayoutEffect(() => {
    const target = caretToRestore(pendingCaret.current, doc.shown);
    pendingCaret.current = null;
    if (!target || !box.current) return;
    box.current.focus();
    box.current.setSelectionRange(target.start, target.end);
  }, [doc.shown, box]);

  /** The stored text a change of the box brings, and what the box will show. */
  function fromInput(event: React.ChangeEvent<HTMLTextAreaElement>): MentionDocument {
    const value = event.target.value;
    const want = expected.current;
    expected.current = null;
    const names = { users, channels };
    if (want && want.shown === value) return projectMentions(want.stored, names);
    const kind = (event.nativeEvent as InputEvent).inputType;
    if (kind === "historyUndo" || kind === "historyRedo") {
      const stored = remembered.current.get(value);
      if (stored !== undefined) return projectMentions(stored, names);
    }
    const edit = shownEdit(current.current.shown, value, event.target.selectionStart);
    const next = replaceShown(current.current, edit.start, edit.end, edit.inserted);
    const nextDoc = projectMentions(next.stored, names);
    // A token typed out in full reads as its mention at once, which moves
    // what follows it; the caret stays after what was typed.
    if (nextDoc.shown !== value) {
      const caret = shownPosition(nextDoc, next.caret);
      pendingCaret.current = { start: caret, end: caret, text: nextDoc.shown };
    }
    return nextDoc;
  }

  /**
   * Rewrites the box to `stored`, selecting `start..end` (stored positions;
   * the caret goes after the change when there are none). The browser makes
   * the change itself where it can, so it can be undone like typing.
   */
  function edit(stored: string, start?: number, end = start) {
    const field = box.current;
    const before = current.current;
    const next = projectMentions(stored, { users, channels });
    const change = shownEdit(before.shown, next.shown);
    const caretAt =
      start === undefined
        ? {
            start: change.start + change.inserted.length,
            end: change.start + change.inserted.length,
          }
        : { start: shownPosition(next, start, "start"), end: shownPosition(next, end!, "end") };
    pendingCaret.current = { ...caretAt, text: next.shown };
    if (
      field &&
      !field.readOnly &&
      !field.disabled &&
      field.value === before.shown &&
      typeof document.execCommand === "function"
    ) {
      expected.current = { shown: next.shown, stored };
      field.focus();
      field.setSelectionRange(change.start, change.end);
      const done = change.inserted
        ? document.execCommand("insertText", false, change.inserted)
        : document.execCommand("delete");
      // The change event has taken it.
      if (done && expected.current === null) return;
      expected.current = null;
    }
    commit(stored);
  }

  /**
   * Backspace at the end of a mention, or Delete at its start, takes the
   * whole mention, as one, rather than leaving most of a name behind.
   */
  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Backspace" && event.key !== "Delete") return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const field = event.currentTarget;
    if (field.selectionStart !== field.selectionEnd) return;
    const at = field.selectionStart;
    const mention = current.current.segments.find(
      (s) =>
        s.mention &&
        (event.key === "Backspace" ? s.shownStart + s.shown.length === at : s.shownStart === at),
    );
    if (mention)
      field.setSelectionRange(mention.shownStart, mention.shownStart + mention.shown.length);
  }

  /** The box's selection, in the stored text. */
  function selection(): { start: number; end: number } {
    const field = box.current;
    const start = field?.selectionStart ?? doc.shown.length;
    const end = field?.selectionEnd ?? start;
    return { start: storedPosition(doc, start, "start"), end: storedPosition(doc, end, "end") };
  }

  /** The stored text with the box's selection replaced by `insert`. */
  function replaceSelection(insert: string, start?: number, end?: number) {
    const field = box.current;
    return replaceShown(
      doc,
      start ?? field?.selectionStart ?? doc.shown.length,
      end ?? field?.selectionEnd ?? doc.shown.length,
      insert,
    );
  }

  return {
    doc,
    fromInput,
    edit,
    onKeyDown,
    selection,
    replaceSelection,
    /** Whether a shown position starts a mention, which is never a mention being typed. */
    startsMention: (at: number, within: MentionDocument = doc) =>
      within.segments.some((s) => s.mention && s.shownStart === at),
  };
}
