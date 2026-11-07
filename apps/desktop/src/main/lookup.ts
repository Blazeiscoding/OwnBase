/**
 * Something read from outside the app (a program on disk, a configuration
 * file), kept for a few seconds because hosting status is read far more often
 * than it changes. Read again once that time is up, or at once after `forget`,
 * which whoever knows it may have changed calls.
 */
export interface Lookup<T> {
  get(): T;
  forget(): void;
}

export function lookup<T>(read: () => T, keepMs = 5_000, now = Date.now): Lookup<T> {
  let kept: { at: number; value: T } | null = null;
  return {
    get() {
      if (!kept || now() - kept.at > keepMs) kept = { at: now(), value: read() };
      return kept.value;
    },
    forget() {
      kept = null;
    },
  };
}
