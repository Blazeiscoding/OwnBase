import { vi } from "vitest";
import { HUDDLE_GRACE_MS, HUDDLE_RING_MS } from "../src/huddles/rooms.js";

/**
 * Puts the server's timeouts on a clock a test can move, so a call's grace
 * and ring run at their real lengths without the test waiting them out. Only
 * `setTimeout` is faked, and it keeps moving at real speed, so sockets, fetch
 * and `expect.poll` work as usual. Call it before the timer you want to move
 * starts, and `vi.useRealTimers()` after the test.
 */
export function moveableClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
}

/** Moves past the time a dropped device's place in a call is kept for it. */
export const passGrace = () => vi.advanceTimersByTimeAsync(HUDDLE_GRACE_MS);

/** Moves past the time a direct message's huddle rings. */
export const passRing = () => vi.advanceTimersByTimeAsync(HUDDLE_RING_MS);
