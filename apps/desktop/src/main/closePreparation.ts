const CLOSE_WITHIN_MS = 10_000;

/** Keeps the renderer alive until its final work and the native settings queue are saved (N03). */
export class ClosePreparation {
  private nextId = 0;
  private pending: {
    id: number;
    windowId: number | null;
    acknowledged: boolean;
    promise: Promise<void>;
    resolve: () => void;
    reject: (reason: Error) => void;
    drain: () => Promise<void>;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  prepare(
    windowId: number | null,
    send: (id: number) => void,
    drain: () => Promise<void>,
  ): Promise<void> {
    if (this.pending) return this.pending.promise;
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const id = ++this.nextId;
    const request = {
      id,
      windowId,
      acknowledged: false,
      promise,
      resolve,
      reject,
      drain,
      timer: setTimeout(
        () => this.finish(id, new Error("Saving local work did not finish in time.")),
        CLOSE_WITHIN_MS,
      ),
    };
    this.pending = request;
    if (windowId === null) this.acknowledge(null, id, true);
    else {
      try {
        send(id);
      } catch {
        this.finish(id, new Error("The window could not hand over its local work."));
      }
    }
    return promise;
  }

  acknowledge(windowId: number | null, id: unknown, saved: unknown): boolean {
    const request = this.pending;
    if (
      !request ||
      request.windowId !== windowId ||
      request.id !== id ||
      request.acknowledged ||
      typeof saved !== "boolean"
    )
      return false;
    request.acknowledged = true;
    if (!saved) this.finish(request.id, new Error("The window could not save its local work."));
    else
      void Promise.resolve()
        .then(request.drain)
        .then(
          () => this.finish(request.id),
          () => this.finish(request.id, new Error("The desktop settings could not finish saving.")),
        );
    return true;
  }

  private finish(id: number, error?: Error): void {
    const request = this.pending;
    if (!request || request.id !== id) return;
    this.pending = null;
    clearTimeout(request.timer);
    if (error) request.reject(error);
    else request.resolve();
  }
}
