/**
 * A part of the app kept out of the first download but fetched as soon as a
 * workspace opens, so it is usually here before it is wanted.
 */
export interface Preloadable<T> {
  /** Fetches it once; after a failure, the next call tries again. */
  load: () => Promise<T>;
  /** It, once it has arrived, to draw directly rather than through a loading state. */
  loaded: () => T | null;
}

const everyLoad: (() => Promise<unknown>)[] = [];

export function preloadable<T>(fetch: () => Promise<T>): Preloadable<T> {
  let arrived: T | null = null;
  let loading: Promise<T> | null = null;
  const load = () =>
    (loading ??= fetch().then(
      (value) => (arrived = value),
      (error: unknown) => {
        loading = null;
        throw error;
      },
    ));
  everyLoad.push(load);
  return { load, loaded: () => arrived };
}

/**
 * Fetches every part made with `preloadable`, as a workspace opens. Failing
 * here is not final: wanting the part fetches it again.
 */
export function preloadAll(): void {
  for (const load of everyLoad) load().catch(() => undefined);
}
