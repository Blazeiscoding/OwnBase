import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { MentionDocument } from "../lib/mentionDocument.js";

/**
 * What lays text out in a box, read from the box itself: its padding and
 * type change with the screen (a touchscreen writes at 16 px), and a copy
 * made by hand would drift from it.
 */
const MIRRORED = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "tabSize",
  "textIndent",
  "textTransform",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
] as const;

/**
 * Behind a message box, its mentions drawn as tags, since a textarea cannot
 * style part of its own text: "@Nik's wife Aaya" reads as a person tagged, not
 * as words that happen to start with @. This layer holds the box's text,
 * invisible and laid out as the box lays it out, so each tag lands under its
 * name, and it scrolls with the box. The box goes after it in a positioned
 * parent, positioned itself, with no background of its own.
 */
export function MentionTags({
  doc,
  box,
}: {
  doc: MentionDocument;
  box: RefObject<HTMLTextAreaElement | null>;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const tagged = doc.segments.some((segment) => segment.mention);
  useEffect(() => {
    const field = box.current;
    if (!field) return;
    const follow = () => {
      if (layer.current) layer.current.scrollTop = field.scrollTop;
    };
    field.addEventListener("scroll", follow);
    return () => field.removeEventListener("scroll", follow);
  }, [box]);
  // Before each paint: the box's type as it is now, and its scroll, which
  // typing can move without a scroll event reaching here first.
  useLayoutEffect(() => {
    const field = box.current;
    const tags = layer.current;
    if (!field || !tags) return;
    const style = getComputedStyle(field);
    for (const property of MIRRORED) tags.style[property] = style[property];
    tags.scrollTop = field.scrollTop;
  });
  if (!tagged) return null;
  return (
    <div
      ref={layer}
      aria-hidden="true"
      // Scrolls as the box does, with the same thin scrollbar, so a long
      // message wraps at the same width in both.
      className="pointer-events-none absolute inset-0 overflow-y-auto whitespace-pre-wrap break-words text-transparent"
    >
      {doc.segments.map((segment) =>
        segment.mention ? (
          <span key={segment.shownStart} className="mention-tag">
            {segment.shown}
          </span>
        ) : (
          segment.shown
        ),
      )}
      {/* A box ending in a new line shows that empty line; a div needs something on it. */}
      {"\u200b"}
    </div>
  );
}
