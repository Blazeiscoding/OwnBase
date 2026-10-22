import type { ID } from "@slackoss/protocol";

/**
 * Profile pictures (E9). The server serves one only to someone signed in, and
 * an <img> cannot send the session's token, so each is fetched with it and
 * kept as an object URL, named by its person and version: a new picture has a
 * new version, so an old URL is never shown for it. At most `max` are kept,
 * the least recently asked for going first.
 */
export class AvatarCache {
  private urls = new Map<string, string>();
  private loading = new Map<string, Promise<string | null>>();
  private listeners = new Set<() => void>();
  private stopped = false;

  constructor(
    private fetchPicture: (userId: ID, version: string) => Promise<Blob>,
    private max = 400,
  ) {}

  /** The picture's URL if it is here already. */
  peek(userId: ID, version: string): string | null {
    const key = `${userId}:${version}`;
    const url = this.urls.get(key);
    if (!url) return null;
    // Asked for again: the last to go.
    this.urls.delete(key);
    this.urls.set(key, url);
    return url;
  }

  /** Fetches the picture once, however many ask; null when it cannot be had. */
  load(userId: ID, version: string): Promise<string | null> {
    const key = `${userId}:${version}`;
    const known = this.peek(userId, version);
    if (known) return Promise.resolve(known);
    const running = this.loading.get(key);
    if (running) return running;
    const loading = this.fetchPicture(userId, version)
      .then((blob) => {
        if (this.stopped || typeof URL.createObjectURL !== "function") return null;
        const url = URL.createObjectURL(blob);
        this.urls.set(key, url);
        while (this.urls.size > this.max) {
          const [oldest, gone] = this.urls.entries().next().value!;
          this.urls.delete(oldest);
          URL.revokeObjectURL(gone);
        }
        for (const listener of this.listeners) listener();
        return url;
      })
      .catch(() => null)
      .finally(() => this.loading.delete(key));
    this.loading.set(key, loading);
    return loading;
  }

  /** Told whenever a picture arrives. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Lets every picture go, for a client being closed. */
  clear(): void {
    this.stopped = true;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.listeners.clear();
  }
}
