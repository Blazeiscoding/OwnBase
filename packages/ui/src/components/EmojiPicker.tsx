import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  categories,
  emojiFor,
  inTone,
  searchEmoji,
  type Emoji,
  type EmojiCategory,
} from "../lib/emojiSet.js";
import {
  SKIN_TONES,
  frequentEmoji,
  likedBy,
  useEmojiPreferences,
} from "../lib/emojiPreferences.js";
import { isImeKey } from "../lib/textInput.js";
import { useListbox } from "../lib/useListbox.js";
import { Icon } from "./Icon.js";

/** Emoji to a row. theme.css draws the rows at a fixed height, which the jumps rely on. */
const COLUMNS = 9;
const ROW_HEIGHT = 36;
const TITLE_HEIGHT = 28;

/**
 * The sections' marks, after Its Hover's and Lucide's drawings. Frequently
 * used and Smileys & People use the app's own clock and smile.
 */
const MARKS: Record<string, string> = {
  nature:
    "M13 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0M20 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0M22 16a2 2 0 1 1-4 0 2 2 0 0 1 4 0M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z",
  foods:
    "M6 2v3M10 2v3M14 2v3M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1",
  activity:
    "M6 9H4.5a1 1 0 0 1 0-5H6M18 9h1.5a1 1 0 0 0 0-5H18M4 22h16M10 14.66v1.626a2 2 0 0 1-.976 1.696A5 5 0 0 0 7 21.978M14 14.66v1.626a2 2 0 0 0 .976 1.696A5 5 0 0 1 17 21.978M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z",
  places:
    "M13.617 1.53c.926-.747 1.964-.793 3.097-.777.587.009.88.013 1.115.104.373.145.67.442.815.815.09.235.095.528.104 1.115.016 1.133-.03 2.17-.778 3.097-.63.78-1.714 1.188-2.235 2.05-.398.656-.213 1.337-.042 2.038l1.28 5.245c.255 1.046.06 1.715-.67 2.446-.39.39-.713.37-1.028-.133l-3.862-6.154-1.845 1.466c-.67.532-1.003.798-1.18 1.172-.41.876-.15 2.192-.136 3.142.008.525-.446 1.56-1.088 1.594-.396.022-.531-.452-.66-.743l-1.232-2.802c-.294-.67-.306-.682-.976-.976l-2.802-1.233c-.29-.128-.765-.263-.743-.66.035-.641 1.07-1.095 1.594-1.087.95.013 2.266.274 3.142-.137.374-.176.64-.51 1.172-1.18l1.466-1.844L1.97 4.226c-.503-.316-.522-.64-.133-1.028.73-.73 1.4-.925 2.446-.67l5.245 1.28c.7.17 1.382.356 2.039-.042.86-.52 1.269-1.604 2.049-2.235",
  objects:
    "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4",
  symbols: "M19.5 12.572 12 20l-7.5-7.428a5 5 0 1 1 7.5-6.566 5 5 0 1 1 7.5 6.572",
  flags:
    "M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528",
};

function Mark({ section }: { section: string }): ReactNode {
  if (section === "frequent") return <Icon name="clock" size={18} />;
  if (section === "people") return <Icon name="smile" size={18} />;
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d={MARKS[section]} />
    </svg>
  );
}

interface Section {
  id: string;
  name: string;
  emoji: Emoji[];
}

/**
 * Every emoji, as Slack's picker offers them: the ones used most first, then
 * each category under its name, with a mark above to jump to it. Typing
 * searches them all by name, shortcode and keyword; the arrow keys move in
 * the grid and Enter picks. The footer names the emoji under the pointer or
 * the arrows, with its shortcode, and holds the skin tone.
 *
 * Focus stays in the search box, as the reaction picker's always has, and a
 * screen reader follows the choice through aria-activedescendant.
 */
export function EmojiPicker(props: {
  onPick: (emoji: string) => void;
  /** False on a touchscreen, so opening it does not raise a keyboard over the emoji. */
  autoFocus?: boolean;
}) {
  const { tone, used, setTone, countUse } = useEmojiPreferences();
  const [query, setQuery] = useState("");
  // Once the arrows have moved the choice, Left and Right move it too, rather
  // than the caret in what was typed.
  const [inGrid, setInGrid] = useState(false);
  const [toning, setToning] = useState(false);
  const [current, setCurrent] = useState("frequent");
  const scroller = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const jumpTo = useRef<string | null>(null);
  const searching = query.trim().length > 0;
  // The sections drawn so far: those in view and the next screenful. The rest
  // hold their place at their height until scrolling, a jump or the arrows
  // come near, so the picker opens without making nearly two thousand emoji.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set(["frequent", "people"]));
  const see = (ids: string[]) =>
    setSeen((was) => (ids.every((id) => was.has(id)) ? was : new Set([...was, ...ids])));

  // The first row is fixed while the picker is open, so a pick does not shuffle it.
  const [frequent] = useState(() =>
    frequentEmoji(used)
      .map((char) => emojiFor(char))
      .filter((emoji): emoji is Emoji => emoji !== undefined),
  );
  const sections: Section[] = useMemo(
    () =>
      searching
        ? [{ id: "results", name: "Search results", emoji: searchEmoji(query, likedBy(used)) }]
        : [{ id: "frequent", name: "Frequently used", emoji: frequent }, ...categories],
    [searching, query, frequent, used],
  );
  const starts = useMemo(() => {
    let at = 0;
    return sections.map((section) => {
      const start = at;
      at += section.emoji.length;
      return start;
    });
  }, [sections]);
  const count = starts.length ? starts.at(-1)! + sections.at(-1)!.emoji.length : 0;
  const list = useListbox(count);

  /** The section an option is in, and its place there. */
  function locate(i: number): [section: number, place: number] {
    let s = 0;
    while (s + 1 < starts.length && starts[s + 1]! <= i) s++;
    return [s, i - starts[s]!];
  }
  const at = (i: number) => {
    const [s, place] = locate(i);
    return sections[s]?.emoji[place];
  };

  /** The option a row up or down, moving into the next section as the eye would. */
  function vertical(i: number, down: boolean): number {
    const [s, place] = locate(i);
    const size = sections[s]!.emoji.length;
    const column = place % COLUMNS;
    const lastRow = (n: number) => Math.floor((n - 1) / COLUMNS) * COLUMNS;
    if (down) {
      if (place + COLUMNS < size) return i + COLUMNS;
      // A shorter last row below this one.
      if (place < lastRow(size)) return starts[s]! + size - 1;
      for (let t = s + 1; t < sections.length; t++) {
        const next = sections[t]!.emoji.length;
        if (next) return starts[t]! + Math.min(column, next - 1);
      }
      return i;
    }
    if (place >= COLUMNS) return i - COLUMNS;
    for (let t = s - 1; t >= 0; t--) {
      const previous = sections[t]!.emoji.length;
      if (previous) return starts[t]! + Math.min(lastRow(previous) + column, previous - 1);
    }
    return i;
  }

  function pick(emoji: Emoji) {
    countUse(emoji.char);
    props.onPick(inTone(emoji, tone));
  }

  function jump(section: string) {
    if (searching) {
      // Back to every emoji, then to the section, once they are drawn.
      jumpTo.current = section;
      setQuery("");
      return;
    }
    const s = sections.findIndex((candidate) => candidate.id === section);
    const element = scroller.current?.querySelector<HTMLElement>(`[data-section="${section}"]`);
    if (s < 0 || !element || !scroller.current) return;
    see(sections.slice(s, s + 2).map((candidate) => candidate.id));
    scroller.current.scrollTop = element.offsetTop;
    setCurrent(section);
    list.choose(starts[s]!);
    search.current?.focus();
  }
  useEffect(() => {
    if (searching || !jumpTo.current) return;
    const section = jumpTo.current;
    jumpTo.current = null;
    jump(section);
  });

  function followScroll() {
    const top = scroller.current?.scrollTop ?? 0;
    const near = top + 2 * (scroller.current?.clientHeight ?? 0);
    let shown = sections[0]?.id ?? "frequent";
    const coming: string[] = [];
    for (const element of scroller.current?.querySelectorAll<HTMLElement>("[data-section]") ?? []) {
      if (element.offsetTop <= top + 1) shown = element.dataset.section!;
      if (element.offsetTop <= near) coming.push(element.dataset.section!);
    }
    if (shown !== current) setCurrent(shown);
    see(coming);
  }

  /** Moves the choice as a key does, drawing its section first if it has not been. */
  function moveTo(i: number) {
    const section = sections[locate(Math.max(0, Math.min(i, count - 1)))[0]];
    if (section) see([section.id]);
    list.moveTo(i);
  }

  const optionAt = (target: EventTarget) =>
    Number((target as Element).closest?.("[data-i]")?.getAttribute("data-i") ?? -1);

  const shown = list.active >= 0 ? at(list.active) : undefined;
  const hand = emojiFor("✋");
  const listId = list.id;

  return (
    <div className="emoji-picker flex w-full flex-col">
      <div
        role="group"
        aria-label="Emoji categories"
        className="flex items-center justify-between gap-0.5 border-b border-edge/60 px-2 py-1.5"
      >
        {[{ id: "frequent", name: "Frequently used" }, ...categories].map((section) => (
          <button
            key={section.id}
            type="button"
            aria-label={section.name}
            aria-current={!searching && current === section.id ? "true" : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => jump(section.id)}
            className="emoji-mark flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.07] hover:text-ink"
          >
            <Mark section={section.id} />
          </button>
        ))}
      </div>
      <div className="px-3 pt-2.5">
        <input
          ref={search}
          autoFocus={props.autoFocus}
          {...list.comboboxProps}
          aria-label="Search emoji"
          placeholder="Search all emoji"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setInGrid(false);
            list.choose(0);
            if (scroller.current) scroller.current.scrollTop = 0;
          }}
          onKeyDown={(e) => {
            if (isImeKey(e.nativeEvent) || count === 0) return;
            const active = Math.max(list.active, 0);
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setInGrid(true);
              moveTo(vertical(active, e.key === "ArrowDown"));
            } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && (inGrid || !query)) {
              e.preventDefault();
              setInGrid(true);
              moveTo(active + (e.key === "ArrowRight" ? 1 : -1));
            } else if (e.key === "Enter") {
              const chosen = at(active);
              if (!chosen) return;
              e.preventDefault();
              pick(chosen);
            }
          }}
          className="w-full rounded-lg border border-edge bg-ground px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-copper"
        />
      </div>
      {/* Focus stays in the search box, so the grid takes a Tab stop of its own for scrolling by keyboard. */}
      <div
        ref={scroller}
        onScroll={followScroll}
        tabIndex={0}
        role="group"
        aria-label="Emoji grid"
        className="emoji-scroll outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-copper/50"
      >
        {count === 0 ? (
          <p role="status" className="px-3 py-3 text-sm text-ink-faint">
            No emoji matched. Try another word.
          </p>
        ) : (
          <div
            {...list.listProps}
            aria-label="Emoji"
            onMouseDown={(e) => e.preventDefault()}
            onMouseOver={(e) => {
              const i = optionAt(e.target);
              if (i >= 0 && i !== list.active) list.choose(i);
            }}
            onClick={(e) => {
              const chosen = at(optionAt(e.target));
              if (chosen) pick(chosen);
            }}
          >
            {sections.map((section, s) => (
              <EmojiSection
                key={section.id}
                section={section}
                titled={!searching}
                drawn={searching || seen.has(section.id)}
                start={starts[s]!}
                active={
                  list.active >= starts[s]! && list.active < starts[s]! + section.emoji.length
                    ? list.active
                    : -1
                }
                tone={tone}
                listId={listId}
              />
            ))}
          </div>
        )}
      </div>
      <div className="flex h-14 shrink-0 items-center gap-3 border-t border-edge/60 px-3">
        {toning && hand ? (
          <div role="radiogroup" aria-label="Skin tone" className="flex w-full justify-between">
            {SKIN_TONES.map((name, i) => (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={tone === i}
                aria-label={name}
                autoFocus={tone === i}
                onClick={() => {
                  setTone(i);
                  setToning(false);
                  search.current?.focus();
                }}
                className="emoji-tone font-emoji flex size-9 items-center justify-center rounded-lg transition-colors hover:bg-ink/[0.07] aria-checked:bg-copper/15"
              >
                {inTone(hand, i)}
              </button>
            ))}
          </div>
        ) : (
          <>
            {shown && (
              <div aria-hidden="true" className="flex min-w-0 items-center gap-2.5">
                <span className="emoji-preview font-emoji">{inTone(shown, tone)}</span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold text-ink">
                    {shown.name}
                  </span>
                  <span className="block truncate text-[12px] text-ink-faint">:{shown.id}:</span>
                </span>
              </div>
            )}
            {hand && (
              <button
                type="button"
                aria-label={`Skin tone: ${SKIN_TONES[tone]}`}
                aria-expanded={false}
                onClick={() => setToning(true)}
                className="emoji-tone font-emoji ml-auto flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-ink/[0.07]"
              >
                {inTone(hand, tone)}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One section of the grid. Drawn again only when the choice moves in or out
 * of it or the tone changes, so pointing along the grid stays quick with
 * nearly two thousand emoji in it.
 */
const EmojiSection = memo(function EmojiSection(props: {
  section: Section | EmojiCategory;
  titled: boolean;
  /** False for a section held open at its height, not yet drawn. */
  drawn: boolean;
  start: number;
  active: number;
  tone: number;
  listId: string;
}) {
  const { section, start, active, tone, listId } = props;
  const titleId = useId();
  if (section.emoji.length === 0) return null;
  const rows = Math.ceil(section.emoji.length / COLUMNS);
  return (
    <div
      role="group"
      aria-labelledby={props.titled ? titleId : undefined}
      aria-label={props.titled ? undefined : section.name}
      data-section={section.id}
      className="emoji-section"
      // What it takes before it is drawn, so a jump past it lands exactly.
      style={{
        containIntrinsicBlockSize: `auto ${(props.titled ? TITLE_HEIGHT : 0) + rows * ROW_HEIGHT}px`,
      }}
    >
      {props.titled && (
        <div id={titleId} className="emoji-section-title">
          {section.name}
        </div>
      )}
      {!props.drawn ? (
        <div style={{ height: rows * ROW_HEIGHT }} />
      ) : (
        <div role="none" className="emoji-grid">
          {section.emoji.map((emoji, place) => {
            const i = start + place;
            return (
              <div
                key={emoji.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                aria-label={emoji.name}
                data-i={i}
                className="emoji-cell font-emoji"
              >
                {inTone(emoji, tone)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
