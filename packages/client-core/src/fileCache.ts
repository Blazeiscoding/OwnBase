import type { ID } from "@ownbase/protocol";
import type { Api } from "./api.js";

/** The message a file is attached to, and its conversation. */
export interface FileOwner {
  channelId: ID;
  messageId: ID;
  /** Root of the whole thread retention removes; absent for a top-level message. */
  threadRootId?: ID | null;
}

/**
 * Uploads are auth-gated, so an `<img src>` can't fetch them directly.
 * This fetches once with the session token and hands back a blob: URL,
 * deduping concurrent requests for the same file. At most four transfers run
 * at once; releasing the last view cancels unfinished work for that file.
 *
 * Each file it holds or is fetching remembers the message it came with, when
 * that was known (F07), for as long as the cache holds it: the bytes must go
 * when the message is deleted or its conversation becomes unreadable, even
 * after the history that listed it has been let go.
 */
/**
 * The cache's key for a link preview's picture (E2), which it holds and lets
 * go with its message as it does a file.
 */
export const previewImageKey = (previewId: ID): string => `preview:${previewId}`;

export class FileCache {
  private owners = new Map<ID, FileOwner | null>();
  private listeners = new Set<(fileId: ID) => void>();
  private urls = new Map<ID, string>();
  private inflight = new Map<ID, Promise<string>>();
  private controllers = new Map<ID, AbortController>();
  private queued = new Map<ID, () => void>();
  private activeFetches = 0;
  private sizes = new Map<ID, number>();
  private references = new Map<ID, number>();
  private disposed = false;

  constructor(
    private api: Api,
    private maxIdleBytes = 32 * 1024 * 1024,
    /** Which loaded message a file is attached to, if any. */
    private ownerOf: (fileId: ID) => FileOwner | null = () => null,
  ) {}

  /**
   * Calls back with each file whose bytes were taken away, so a preview
   * showing it can say it is gone rather than go on showing it.
   */
  onInvalidate(listener: (fileId: ID) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  retain(fileId: ID): void {
    this.references.set(fileId, (this.references.get(fileId) ?? 0) + 1);
  }

  release(fileId: ID): void {
    const count = (this.references.get(fileId) ?? 0) - 1;
    if (count > 0) this.references.set(fileId, count);
    else {
      this.references.delete(fileId);
      this.cancelFetch(fileId);
    }
    this.trim();
  }

  private cancelFetch(fileId: ID): void {
    this.controllers.get(fileId)?.abort();
    this.controllers.delete(fileId);
    this.inflight.delete(fileId);
    // Held for neither bytes nor a transfer: what it came with is forgotten too.
    if (!this.urls.has(fileId)) this.owners.delete(fileId);
  }

  private drain(): void {
    while (!this.disposed && this.activeFetches < 4 && this.queued.size > 0) {
      const [id, start] = this.queued.entries().next().value!;
      this.queued.delete(id);
      start();
    }
  }

  /** A slot covers the full body transfer, not just receipt of the headers. */
  private fetch(fileId: ID, controller: AbortController): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (this.queued.get(fileId) !== start) return;
        this.queued.delete(fileId);
        reject(this.disposed ? new Error("File cache is closed") : controller.signal.reason);
      };
      const start = () => {
        controller.signal.removeEventListener("abort", onAbort);
        this.activeFetches++;
        void (async () => {
          try {
            resolve(
              await (fileId.startsWith("preview:")
                ? this.api.fetchPreviewImage(fileId.slice("preview:".length), controller.signal)
                : this.api.fetchFile(fileId, controller.signal)),
            );
          } catch (err) {
            reject(err);
          } finally {
            this.activeFetches--;
            this.drain();
          }
        })();
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      this.queued.set(fileId, start);
    });
  }

  private trim(except?: ID): void {
    let idleBytes = 0;
    for (const [id, size] of this.sizes) if (!this.references.has(id)) idleBytes += size;
    for (const [id, url] of this.urls) {
      if (idleBytes <= this.maxIdleBytes) break;
      if (id === except || this.references.has(id)) continue;
      idleBytes -= this.sizes.get(id) ?? 0;
      URL.revokeObjectURL(url);
      this.urls.delete(id);
      this.sizes.delete(id);
      this.owners.delete(id);
    }
  }

  /** A blob URL retained by active views, with an LRU budget for idle files. */
  get(fileId: ID): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("File cache is closed"));
    const cached = this.urls.get(fileId);
    if (cached) {
      this.urls.delete(fileId);
      this.urls.set(fileId, cached);
      return Promise.resolve(cached);
    }

    const pending = this.inflight.get(fileId);
    if (pending) return pending;

    const controller = new AbortController();
    this.controllers.set(fileId, controller);
    // Asked afresh for each transfer: a message not loaded last time may be now.
    this.owners.set(fileId, this.ownerOf(fileId) ?? this.owners.get(fileId) ?? null);
    const request = this.fetch(fileId, controller)
      .then((blob) => {
        if (this.disposed) throw new Error("File cache is closed");
        if (this.inflight.get(fileId) !== request) throw new Error("File access was invalidated");
        const url = URL.createObjectURL(blob);
        this.urls.set(fileId, url);
        this.sizes.set(fileId, blob.size);
        this.trim(fileId);
        this.inflight.delete(fileId);
        if (this.controllers.get(fileId) === controller) this.controllers.delete(fileId);
        return url;
      })
      .catch((err: unknown) => {
        if (this.inflight.get(fileId) === request) this.inflight.delete(fileId);
        if (!this.urls.has(fileId) && !this.inflight.has(fileId)) this.owners.delete(fileId);
        if (this.controllers.get(fileId) === controller) this.controllers.delete(fileId);
        throw err;
      });
    this.inflight.set(fileId, request);
    this.drain();
    return request;
  }

  /** Already-resolved URL, for a first paint with no flash. */
  peek(fileId: ID): string | undefined {
    return this.urls.get(fileId);
  }

  invalidate(fileId: ID): void {
    const held = this.urls.has(fileId) || this.inflight.has(fileId);
    this.cancelFetch(fileId);
    const url = this.urls.get(fileId);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(fileId);
    this.sizes.delete(fileId);
    this.references.delete(fileId);
    this.owners.delete(fileId);
    if (!held) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(fileId);
      } catch {
        // One preview cannot stop the others from hearing.
      }
    }
  }

  /** Takes away every file attached to a message that has been deleted (F07). */
  invalidateMessage(messageId: ID): void {
    for (const [id, owner] of [...this.owners])
      if (owner === null || owner.messageId === messageId) this.invalidate(id);
  }

  /** Retention removes complete threads, including cached replies with evicted history. */
  invalidateRoots(channelId: ID, rootIds: readonly ID[]): void {
    if (rootIds.length === 0) return;
    const gone = new Set(rootIds);
    for (const [id, owner] of [...this.owners])
      if (
        owner === null ||
        (owner.channelId === channelId && gone.has(owner.threadRootId ?? owner.messageId))
      )
        this.invalidate(id);
  }

  /**
   * Takes away every file from a conversation this account can no longer
   * read (F07), and every file whose conversation was never known, since it
   * may have been that one; a file still readable is simply fetched again.
   */
  invalidateChannel(channelId: ID): void {
    for (const [id, owner] of [...this.owners])
      if (owner === null || owner.channelId === channelId) this.invalidate(id);
  }

  /** Takes away everything, as when this account is signed out (F07). */
  invalidateAll(): void {
    for (const id of new Set([...this.urls.keys(), ...this.inflight.keys(), ...this.owners.keys()]))
      this.invalidate(id);
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.queued.clear();
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.inflight.clear();
    this.sizes.clear();
    this.references.clear();
    this.owners.clear();
    this.listeners.clear();
  }
}
