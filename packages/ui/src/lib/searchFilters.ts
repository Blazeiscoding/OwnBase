import { parseSearchQuery, type FileType, type ID, type User } from "@ownbase/protocol";

/**
 * Search's filters as chips (UX-51). A filter is held as the modifier it adds
 * to the query, such as `from:sam` or `type:pdf`, so the server reads chips and
 * typed modifiers alike, and a recent search is just its query again.
 */
export type FilterKind = "from" | "in" | "has" | "type" | "after" | "before";

/** Each kind of file `type:` asks for, as the Has choices and the chips name it. */
export const FILE_TYPE_LABELS: Record<FileType, string> = {
  image: "Images",
  video: "Videos",
  audio: "Audio",
  pdf: "PDFs",
  document: "Documents",
  spreadsheet: "Spreadsheets",
  presentation: "Presentations",
  archive: "Archives",
};

export const kindOf = (token: string) => token.slice(0, token.indexOf(":")) as FilterKind;
const valueOf = (token: string) => token.slice(token.indexOf(":") + 1);

/**
 * The filter a typed word stands for, written the one way, or null for a word
 * that is not one: plain words, a modifier with nothing after it yet, and one
 * that cannot be read, such as `has:pizza` or `after:2026-02-31`, which stays
 * in the field for the hints to point at.
 */
export function filterToken(word: string): string | null {
  if (!/^(from|in|has|type|before|after):/i.test(word)) return null;
  const parsed = parseSearchQuery(word);
  if (parsed.from[0]) return `from:${parsed.from[0]}`;
  if (parsed.in[0]) return `in:${parsed.in[0]}`;
  if (parsed.has[0]) return `has:${parsed.has[0]}`;
  if (parsed.types[0]) return `type:${parsed.types[0]}`;
  if (parsed.afterDay) return `after:${parsed.afterDay}`;
  if (parsed.beforeDay) return `before:${parsed.beforeDay}`;
  return null;
}

/**
 * The filters with one more. People, places and kinds add up, as the server
 * reads several of them; a day replaces the day of its kind, as only one
 * bound on each side means anything.
 */
export function withFilter(filters: readonly string[], token: string): string[] {
  if (filters.includes(token)) return [...filters];
  const kind = kindOf(token);
  const kept =
    kind === "after" || kind === "before" ? filters.filter((f) => kindOf(f) !== kind) : filters;
  return [...kept, token];
}

/**
 * Takes the modifiers out of what is typed, as filters. A modifier becomes one
 * once a space follows it and the caret has left it, so `from:@pri` is not
 * taken while `from:@priya` is still being written; `all` takes every one, as
 * Enter does. Says where the caret goes in what is left.
 */
export function takeFilters(
  text: string,
  caret: number,
  all = false,
): { text: string; caret: number; tokens: string[] } {
  const tokens: string[] = [];
  let left = "";
  let from = 0;
  let at = caret;
  for (const match of text.matchAll(/\S+/g)) {
    const start = match.index;
    const end = start + match[0].length;
    const finished = all || (end < text.length && (caret < start || caret > end));
    const token = finished ? filterToken(match[0]) : null;
    if (!token) continue;
    tokens.push(token);
    // The word goes with the spaces after it, so no gap is left where it was.
    let cut = end;
    while (cut < text.length && /\s/.test(text[cut]!)) cut++;
    if (caret >= cut) at -= cut - start;
    else if (caret > start) at = left.length + (start - from);
    left += text.slice(from, start);
    from = cut;
  }
  if (tokens.length === 0) return { text, caret, tokens };
  left += text.slice(from);
  return { text: left, caret: Math.min(Math.max(at, 0), left.length), tokens };
}

/** A calendar day `offset` days from today, where the reader is, as YYYY-MM-DD. */
export function localDay(offset: number, now = new Date()): string {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  return [
    String(day.getFullYear()).padStart(4, "0"),
    String(day.getMonth() + 1).padStart(2, "0"),
    String(day.getDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * The Date choices, as the `after:` day each one names. `after:` leaves out
 * the day it names, so today alone is after yesterday, and the last seven
 * days, today among them, are after the day a week ago.
 */
export const DATE_PRESETS = [
  { label: "Today", offset: -1 },
  { label: "Last 7 days", offset: -7 },
  { label: "Last 30 days", offset: -30 },
] as const;

// Read in UTC, so a day written as YYYY-MM-DD is not moved a day by the reader's zone.
const calendarDay = new Intl.DateTimeFormat(undefined, { timeZone: "UTC" });

/** A YYYY-MM-DD day in the reader's own date style. */
export function dayLabel(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return calendarDay.format(Date.UTC(year, month - 1, date));
}

/** What a chip says for a filter: a person by name, a day in the reader's style. */
export function filterLabel(token: string, users: Record<ID, User>, now = new Date()): string {
  const value = valueOf(token);
  switch (kindOf(token)) {
    case "from": {
      const person = Object.values(users).find((user) => user.handle.toLowerCase() === value);
      return person ? `From ${person.displayName}` : `From @${value}`;
    }
    case "in":
      return `In #${value}`;
    case "has":
      return value === "link" ? "Has a link" : "Has a file";
    case "type":
      return FILE_TYPE_LABELS[value as FileType] ?? value;
    case "after": {
      const preset = DATE_PRESETS.find((p) => localDay(p.offset, now) === value);
      return preset ? preset.label : `After ${dayLabel(value)}`;
    }
    case "before":
      return `Before ${dayLabel(value)}`;
  }
}
