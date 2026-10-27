import type { ID } from "@ownbase/protocol";
import type { ReadingPosition } from "./route.js";

/** How many threads' places are kept; the one read longest ago goes first. */
const KEPT = 100;
const positions = new Map<string, ReadingPosition>();

/**
 * Notes where a thread was left (IMP-02): the reply at the top of the panel
 * and how far below the panel's top it sat, so opening the thread again goes
 * back there rather than to its newest reply. Null, at the newest reply,
 * forgets it. Kept per workspace for as long as the app runs.
 */
export function rememberThreadPosition(
  serverUrl: string,
  rootId: ID,
  position: ReadingPosition | null,
): void {
  const key = `${serverUrl} ${rootId}`;
  positions.delete(key);
  if (!position) return;
  positions.set(key, position);
  if (positions.size > KEPT) positions.delete(positions.keys().next().value!);
}

/** Where a thread was left, if it was left before its newest reply. */
export function rememberedThreadPosition(serverUrl: string, rootId: ID): ReadingPosition | null {
  return positions.get(`${serverUrl} ${rootId}`) ?? null;
}
