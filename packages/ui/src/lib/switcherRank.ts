import type { ID } from "@ownbase/protocol";

/** What Ctrl+K weighs a place by, besides how well its name matches. */
export interface PlaceStanding {
  /** The conversation this place opens, if one exists: a recent one comes first. */
  channelId?: ID;
  /** This account is in it. A public channel it is not in comes after one it is. */
  member: boolean;
  /** Something in it is unread. */
  unread: boolean;
  /** The event seq of its newest message: higher is more recent. 0 for none. */
  activity: number;
}

/**
 * How well `query` matches `text`, best first: the whole of it (0), its start
 * (1), the start of a word in it (2), anywhere in it (3); -1 for not at all.
 * Both are compared in lower case; an empty query matches everything at 3.
 */
export function matchTier(text: string, query: string): number {
  if (!query) return 3;
  const lower = text.toLowerCase();
  if (lower === query) return 0;
  if (lower.startsWith(query)) return 1;
  let at = lower.indexOf(query);
  if (at < 0) return -1;
  for (; at >= 0; at = lower.indexOf(query, at + 1)) {
    if (/[^\p{L}\p{N}]/u.test(lower[at - 1] ?? " ")) return 2;
  }
  return 3;
}

/**
 * Places in the order Ctrl+K lists them. With nothing typed: what was open
 * recently, newest first, then anything unread, then the rest by their latest
 * message. With something typed, how well each name matches comes first and
 * the same order breaks ties, so "des" finds #design before #ux-design and a
 * recent #design-review before a quiet #design-archive.
 */
export function rankPlaces<T extends { label: string; tier: number; standing: PlaceStanding }>(
  rows: readonly T[],
  recent: readonly ID[],
): T[] {
  const recency = new Map(recent.map((id, i) => [id, i]));
  const recentAt = (row: T): number => {
    const id = row.standing.channelId;
    return id === undefined ? Infinity : (recency.get(id) ?? Infinity);
  };
  return [...rows].sort(
    (a, b) =>
      a.tier - b.tier ||
      recentAt(a) - recentAt(b) ||
      Number(b.standing.member) - Number(a.standing.member) ||
      Number(b.standing.unread) - Number(a.standing.unread) ||
      b.standing.activity - a.standing.activity ||
      a.label.localeCompare(b.label),
  );
}
