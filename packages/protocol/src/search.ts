/**
 * Search syntax shared by the server (which runs the query) and the client
 * (which shows what it understood). Everything that isn't a recognised
 * modifier becomes free text, matched against what messages say and against
 * the names of the files attached to them.
 *
 *   from:@alice  in:#general  has:link  has:file  type:pdf  before:2026-01-31  after:2026-01-01
 */

/** The kinds of attachment `type:` can ask for. */
export const FILE_TYPES = [
  "image",
  "video",
  "audio",
  "pdf",
  "document",
  "spreadsheet",
  "presentation",
  "archive",
] as const;
export type FileType = (typeof FILE_TYPES)[number];

/**
 * What makes a file one kind or another: its media type, as SQL LIKE patterns,
 * or failing that the ending of its name, for a file sent as anything at all.
 */
export const FILE_TYPE_MATCH: Record<
  FileType,
  { mime: readonly string[]; ext: readonly string[] }
> = {
  image: { mime: ["image/%"], ext: [] },
  video: { mime: ["video/%"], ext: [] },
  audio: { mime: ["audio/%"], ext: [] },
  pdf: { mime: ["application/pdf"], ext: ["pdf"] },
  document: {
    mime: [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.%",
      "application/vnd.oasis.opendocument.text",
      "application/rtf",
      "text/plain",
      "text/markdown",
    ],
    ext: ["doc", "docx", "odt", "rtf", "txt", "md"],
  },
  spreadsheet: {
    mime: [
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.%",
      "application/vnd.oasis.opendocument.spreadsheet",
      "text/csv",
    ],
    ext: ["xls", "xlsx", "ods", "csv", "tsv"],
  },
  presentation: {
    mime: [
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.%",
      "application/vnd.oasis.opendocument.presentation",
    ],
    ext: ["ppt", "pptx", "odp", "key"],
  },
  archive: {
    mime: [
      "application/zip",
      "application/x-7z-compressed",
      "application/x-tar",
      "application/gzip",
      "application/vnd.rar",
      "application/x-rar-compressed",
    ],
    ext: ["zip", "7z", "tar", "gz", "tgz", "rar"],
  },
};

/**
 * What the file browser sorts files into (E7): pictures, documents (PDFs,
 * documents, spreadsheets and presentations, by `FILE_TYPE_MATCH`) and
 * everything else. A picture is never also a document.
 */
export const FILE_KINDS = ["image", "document", "other"] as const;
export type FileKind = (typeof FILE_KINDS)[number];
export const FILE_KIND_TYPES: Record<Exclude<FileKind, "other">, readonly FileType[]> = {
  image: ["image"],
  document: ["pdf", "document", "spreadsheet", "presentation"],
};

/** Whether a file is of a `type:` kind, as the server's LIKE patterns say. */
export function isFileType(type: FileType, mime: string, name: string): boolean {
  const lower = mime.toLowerCase();
  const fileName = name.toLowerCase();
  const { mime: patterns, ext } = FILE_TYPE_MATCH[type];
  return (
    patterns.some((p) => (p.endsWith("%") ? lower.startsWith(p.slice(0, -1)) : lower === p)) ||
    ext.some((e) => fileName.endsWith(`.${e}`))
  );
}

export function fileKind(mime: string, name: string): FileKind {
  for (const kind of ["image", "document"] as const)
    if (FILE_KIND_TYPES[kind].some((type) => isFileType(type, mime, name))) return kind;
  return "other";
}

const isFileTypeName = (value: string): value is FileType =>
  (FILE_TYPES as readonly string[]).includes(value);
export interface ParsedSearch {
  /** Words left over after modifiers are removed. */
  terms: string[];
  /** Handles, without the leading @. */
  from: string[];
  /** Channel names, without the leading #. */
  in: string[];
  has: ("link" | "file")[];
  /** Kinds of attachment: a message must have a file of one of them. */
  types: FileType[];
  /**
   * Epoch ms bounds, as Slack reads them: `before:` excludes the named day and
   * everything after it, `after:` excludes the named day and everything before.
   * `before` is where the named day starts and `after` where the next one does,
   * both in the reader's time zone.
   */
  before: number | null;
  after: number | null;
  /** The days as named, YYYY-MM-DD, for saying back what was understood. */
  beforeDay: string | null;
  afterDay: string | null;
  /** `before:` and `after:` tokens whose value is not a real calendar date. */
  invalid: string[];
}

export interface SearchQueryOptions {
  /**
   * The IANA zone whose calendar days `before:` and `after:` name. The reader's
   * own, carried to the server with the query; without one, this process's.
   */
  timeZone?: string;
}

const MODIFIER = /^(from|in|has|type|before|after):(.*)$/i;

/** A real calendar date written YYYY-MM-DD, or null. */
function calendarDay(value: string): [year: number, month: number, day: number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Date quietly turns 31 February into 3 March. A date that does not come
  // back as it was written was never a date.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  )
    return null;
  return [year, month, day];
}

/**
 * How many zones keep a formatter, the least recently used going first. A
 * workspace's readers share a handful of zones; the bound is what stops a
 * stream of different ones, and every UTC offset is one, from filling memory.
 */
const FORMATTERS_KEPT = 32;
const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * A formatter for calendar days in a zone, kept under the zone's canonical
 * name: names are case-insensitive and have aliases, so keyed as written,
 * every spelling of one zone would cost a formatter of its own.
 */
function formatter(timeZone: string): Intl.DateTimeFormat {
  let zone = timeZone;
  let found = formatters.get(zone);
  if (!found) {
    const made = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    zone = made.resolvedOptions().timeZone;
    found = formatters.get(zone) ?? made;
  }
  formatters.delete(zone);
  formatters.set(zone, found);
  if (formatters.size > FORMATTERS_KEPT) formatters.delete(formatters.keys().next().value!);
  return found;
}

/** The zones a formatter is kept for, so a test can prove the cache stays bounded. */
export function cachedTimeZones(): string[] {
  return [...formatters.keys()];
}

/** True when `timeZone` is a zone this runtime knows, such as "Europe/Paris". */
export function isTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * Zones the IANA database has renamed that Chromium, and so Electron and
 * Node, still give by the old name, as CLDR does: a device in India says
 * "Asia/Calcutta". Each old name is an alias of the new, the same clock (E9).
 */
const RENAMED_ZONES: Readonly<Record<string, string>> = {
  "Africa/Asmera": "Africa/Asmara",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Coral_Harbour": "America/Atikokan",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Mendoza": "America/Argentina/Mendoza",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};

/** A zone under the name the IANA database gives it now: "Asia/Kolkata" for "Asia/Calcutta". */
export function currentZoneName(timeZone: string): string {
  return RENAMED_ZONES[timeZone] ?? timeZone;
}

/** The calendar day an instant falls on in a zone, as the number yyyymmdd. */
function dayNumberAt(instant: number, zone: Intl.DateTimeFormat): number {
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of zone.formatToParts(instant)) {
    if (part.type === "year") year = Number(part.value);
    else if (part.type === "month") month = Number(part.value);
    else if (part.type === "day") day = Number(part.value);
  }
  return year * 10_000 + month * 100 + day;
}

const HOUR = 3_600_000;

/**
 * The first instant of a calendar day in a zone. Found by searching rather
 * than by adding hours, because a day is not always 24 of them: one that
 * starts or ends a daylight-saving change is 23 or 25, and in a zone that
 * changes at midnight the day does not begin at 00:00 at all.
 */
function startOfDay([year, month, day]: [number, number, number], timeZone: string): number {
  const zone = formatter(timeZone);
  const target = year * 10_000 + month * 100 + day;
  const utcMidnight = Date.UTC(year, month - 1, day);
  // Every zone is within UTC-12 and UTC+14, so the day starts in this window.
  let before = utcMidnight - 15 * HOUR;
  let atOrAfter = utcMidnight + 13 * HOUR;
  while (atOrAfter - before > 1) {
    const middle = Math.floor((before + atOrAfter) / 2);
    if (dayNumberAt(middle, zone) >= target) atOrAfter = middle;
    else before = middle;
  }
  return atOrAfter;
}

/** The calendar day after this one. */
function nextDay([year, month, day]: [number, number, number]): [number, number, number] {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()];
}

const dayText = ([year, month, day]: [number, number, number]) =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

export function parseSearchQuery(raw: string, options: SearchQueryOptions = {}): ParsedSearch {
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const result: ParsedSearch = {
    terms: [],
    from: [],
    in: [],
    has: [],
    types: [],
    before: null,
    after: null,
    beforeDay: null,
    afterDay: null,
    invalid: [],
  };

  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    const m = MODIFIER.exec(token);
    if (!m) {
      result.terms.push(token);
      continue;
    }
    const key = m[1]!.toLowerCase();
    const value = m[2]!;
    // A bare "from:" with nothing after it is just noise, not a filter.
    if (!value) continue;

    switch (key) {
      case "from":
        result.from.push(value.replace(/^@/, "").toLowerCase());
        break;
      case "in":
        result.in.push(value.replace(/^#/, "").toLowerCase());
        break;
      case "has":
        if (value.toLowerCase() === "link" || value.toLowerCase() === "file") {
          result.has.push(value.toLowerCase() as "link" | "file");
        }
        break;
      case "type": {
        // As with has:, a kind there is no such thing as is left out, and the
        // hints show it was not understood.
        const type = value.toLowerCase();
        if (isFileTypeName(type) && !result.types.includes(type)) result.types.push(type);
        break;
      }
      case "before": {
        const day = calendarDay(value);
        if (!day) {
          result.invalid.push(token);
          break;
        }
        result.before = startOfDay(day, timeZone);
        result.beforeDay = dayText(day);
        break;
      }
      case "after": {
        const day = calendarDay(value);
        if (!day) {
          result.invalid.push(token);
          break;
        }
        // Exclusive of the named day: "after:2026-01-01" means from the 2nd on,
        // from wherever the 2nd starts, which is not always 24 hours later.
        result.after = startOfDay(nextDay(day), timeZone);
        result.afterDay = dayText(day);
        break;
      }
    }
  }

  return result;
}

/** True when the query has something to act on. */
export function hasSearchCriteria(p: ParsedSearch): boolean {
  return (
    p.terms.length > 0 ||
    p.from.length > 0 ||
    p.in.length > 0 ||
    p.has.length > 0 ||
    p.types.length > 0 ||
    p.before !== null ||
    p.after !== null
  );
}
