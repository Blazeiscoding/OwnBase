import type { ID } from "@ownbase/protocol";
import { ApiError } from "./api.js";
import { unhandled } from "./messageCache.js";

/** What one optimistic write is about. Writes with the same key go one at a time. */
type WriteKey =
  | { kind: "pin"; messageId: ID }
  | { kind: "save"; messageId: ID }
  | { kind: "poll"; messageId: ID }
  | { kind: "reaction"; messageId: ID; emoji: string }
  | { kind: "linkPreview"; previewId: ID }
  | { kind: "dnd" }
  | { kind: "notifyDefault" }
  | { kind: "sectionOrder" }
  | { kind: "prefs"; channelId: ID }
  /** Following, muting or marking a thread unread, sent in the order chosen (Q09). */
  | { kind: "threadFollow"; rootId: ID }
  /**
   * Reading a thread, which waits for no follow or mute: it moves only the
   * cursor. Reads made while one is out go as the latest of them.
   */
  | { kind: "threadRead"; rootId: ID };

function keyOf(key: WriteKey): string {
  switch (key.kind) {
    case "pin":
    case "save":
    case "poll":
      return `${key.kind}:${key.messageId}`;
    case "reaction":
      return `reaction:${key.messageId}:${key.emoji}`;
    case "linkPreview":
      return `linkPreview:${key.previewId}`;
    case "dnd":
    case "notifyDefault":
    case "sectionOrder":
      return key.kind;
    case "prefs":
      return `prefs:${key.channelId}`;
    case "threadFollow":
    case "threadRead":
      return `${key.kind}:${key.rootId}`;
    default:
      return unhandled(key);
  }
}

/** Whether a write is out or waiting, and what of it the server refused, when that is kept. */
interface WriteStatus<P> {
  saving: boolean;
  failed: P | null;
  /** What is shown is put back after a refusal, over whatever answer was shown before. */
  refused: boolean;
}

/**
 * How one kind of write is read, shown and sent. `V` is the value shown; `P`
 * is a change to it, the whole value unless `merge` and `apply` say otherwise.
 */
export interface WriteSpec<V, P = V> {
  /** What is shown now. */
  read: () => V;
  show: (value: V, status: WriteStatus<P>) => void;
  /** Resolves with what the server now has, when it says; otherwise it has the change applied. */
  send: (change: P) => Promise<V | void>;
  /** Two changes made one after the other, as one. By default the later replaces the earlier. */
  merge?: (earlier: P, later: P) => P;
  apply?: (value: V, change: P) => V;
  /** What of `change` a later `replacement` leaves standing; null when it replaces all of it. */
  unreplaced?: (change: P, replacement: P) => P | null;
  /** Keeps a refused change, shown as failed, until a later one replaces it or it is retried. */
  keepFailed?: boolean;
  /** Whether two values say the same, by default the same value. */
  same?: (a: V, b: V) => boolean;
}

interface Entry<V, P> {
  spec: WriteSpec<V, P>;
  /** What the server last said, by an answer or an echo, in the order heard. */
  confirmed: V;
  inFlight: P | null;
  /** Changes made while one was out, merged; the next request carries them. */
  queued: P | null;
  failed: P | null;
  /** Callers of the queued changes, answered by the request that carries them. */
  waiting: ((error: ApiError | null) => void)[];
  /** The server said something other than what is out, while it was out. */
  contested: boolean;
  /** The latest change was sent once more after a contest; not again for it. */
  resent: boolean;
  /** What this last showed, so a refusal puts back only what nothing else has replaced. */
  shown: V;
}

/** A failure as the error a caller can describe: the server's, or one for no answer. */
export function failureOf(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(0, "network_error", error instanceof Error ? error.message : undefined);
}

/** What the server answered, or why there was no answer. */
export async function answerOf<T>(request: () => Promise<T>): Promise<T | ApiError> {
  try {
    return await request();
  } catch (error) {
    return failureOf(error);
  }
}

/** Null once the server has done it; why it did not otherwise. */
export async function doneOf(request: () => Promise<unknown>): Promise<ApiError | null> {
  try {
    await request();
    return null;
  } catch (error) {
    return failureOf(error);
  }
}

/** Why a write was not sent: its client had been closed. */
export const CLOSED = new ApiError(0, "aborted", "The workspace client was closed.");

/**
 * Changes shown before the server has them (GL-13). Per key, one request is
 * out at a time, so the server takes them in the order they were made, and
 * what is shown is the server's last word with every change still out or
 * waiting on top. Changes made while one is out wait, merged, and go as one
 * request when it is answered, unless the server already has them. When
 * nothing more waits:
 *
 * - The change out was accepted: the server's answer is shown. If the server
 *   said otherwise while it was out, it is sent once more, so the server ends
 *   with it.
 * - It was refused: what the server last said is shown, by an answer or an
 *   echo, whichever was heard last; unless something else has replaced what
 *   was shown since, which stays. An earlier change failing never undoes a
 *   later one.
 *
 * A closed set sends and shows nothing more (REV-11): its client's
 * replacement may have chosen since, and a correction from this one would
 * undo that.
 */
export class OptimisticWrites {
  private entries = new Map<string, Entry<unknown, unknown>>();
  private closed = false;

  /** Resolves with the server's refusal of the request carrying this change, or null. */
  write<V, P = V>(key: WriteKey, change: P, spec: WriteSpec<V, P>): Promise<ApiError | null> {
    if (this.closed) return Promise.resolve(CLOSED);
    const id = keyOf(key);
    let entry = this.entries.get(id) as Entry<V, P> | undefined;
    if (!entry) {
      const value = spec.read();
      entry = {
        spec,
        confirmed: value,
        inFlight: null,
        queued: null,
        failed: null,
        waiting: [],
        contested: false,
        resent: false,
        shown: value,
      };
      this.entries.set(id, entry as Entry<unknown, unknown>);
    }
    entry.spec = spec;
    entry.queued = entry.queued === null ? change : merge(spec, entry.queued, change);
    if (entry.failed !== null) entry.failed = unreplaced(spec, entry.failed, change);
    entry.resent = false;
    const answered = new Promise<ApiError | null>((resolve) => entry.waiting.push(resolve));
    if (entry.inFlight === null) void this.sendNext(id, entry);
    else this.publish(entry);
    return answered;
  }

  /**
   * What the server now has, heard from it rather than answered. While a
   * write about it is out or failed, the server's word goes under what is
   * shown, and true says the write showed it; otherwise false, and the caller
   * shows it.
   */
  heard<V>(key: WriteKey, value: V): boolean {
    const entry = this.entries.get(keyOf(key)) as Entry<V, unknown> | undefined;
    if (!entry) return false;
    entry.confirmed = value;
    if ((entry.inFlight !== null || entry.queued !== null) && !same(entry.spec, value, entry.shown))
      entry.contested = true;
    this.publish(entry);
    return true;
  }

  isPending(key: WriteKey): boolean {
    const entry = this.entries.get(keyOf(key));
    return !!entry && (entry.inFlight !== null || entry.queued !== null);
  }

  /** Sends again what the server refused for `key`, when that was kept. */
  retry(key: WriteKey): Promise<ApiError | null> | null {
    const entry = this.entries.get(keyOf(key));
    if (!entry?.failed) return null;
    return this.write(key, entry.failed, entry.spec);
  }

  /** Shows again every write not yet settled, over what a page just loaded put back. */
  reshow(): void {
    for (const entry of this.entries.values()) this.publish(entry);
  }

  /** Lets go of a write whose subject is gone; nothing it answers is shown. */
  forget(key: WriteKey): void {
    this.entries.delete(keyOf(key));
  }

  close(): void {
    this.closed = true;
    this.entries.clear();
  }

  private publish<V, P>(entry: Entry<V, P>, refused = false): void {
    const { spec } = entry;
    let value = entry.confirmed;
    if (entry.inFlight !== null) value = apply(spec, value, entry.inFlight);
    if (entry.queued !== null) value = apply(spec, value, entry.queued);
    entry.shown = value;
    spec.show(value, {
      saving: entry.inFlight !== null || entry.queued !== null,
      failed: spec.keepFailed ? entry.failed : null,
      refused,
    });
  }

  private async sendNext<V, P>(id: string, entry: Entry<V, P>): Promise<void> {
    const { spec } = entry;
    const change = entry.queued!;
    entry.queued = null;
    entry.inFlight = change;
    entry.contested = false;
    const answering = entry.waiting.splice(0);
    this.publish(entry);
    let error: ApiError | null = null;
    try {
      const answer = await spec.send(change);
      entry.confirmed = answer === undefined ? apply(spec, entry.confirmed, change) : answer;
    } catch (failure) {
      error = failureOf(failure);
    }
    const settle = (resolvers: typeof answering, outcome: ApiError | null) => {
      for (const resolve of resolvers) resolve(outcome);
    };
    if (this.closed || this.entries.get(id) !== entry) {
      // Closed, or what it was about is gone: nothing more goes, and nobody waits on it.
      settle(answering, error);
      settle(entry.waiting.splice(0), CLOSED);
      return;
    }
    entry.inFlight = null;
    if (error && spec.keepFailed) {
      const lost = entry.queued === null ? change : unreplaced(spec, change, entry.queued);
      if (lost !== null)
        entry.failed = entry.failed === null ? lost : merge(spec, entry.failed, lost);
    }
    const already =
      !error &&
      entry.queued !== null &&
      same(spec, apply(spec, entry.confirmed, entry.queued), entry.confirmed);
    if (entry.queued !== null && !already) {
      void this.sendNext(id, entry);
    } else if (!error && entry.queued === null && entry.contested && !entry.resent) {
      entry.resent = true;
      entry.queued = change;
      void this.sendNext(id, entry);
    } else {
      entry.queued = null;
      // Chosen while this was out, and already what the server has.
      settle(entry.waiting.splice(0), null);
      if (entry.failed === null) this.entries.delete(id);
      if (!error || Object.is(spec.read(), entry.shown)) this.publish(entry, !!error);
    }
    settle(answering, error);
  }
}

function merge<V, P>(spec: WriteSpec<V, P>, earlier: P, later: P): P {
  return spec.merge ? spec.merge(earlier, later) : later;
}

function apply<V, P>(spec: WriteSpec<V, P>, value: V, change: P): V {
  return spec.apply ? spec.apply(value, change) : (change as unknown as V);
}

function same<V, P>(spec: WriteSpec<V, P>, a: V, b: V): boolean {
  return spec.same ? spec.same(a, b) : Object.is(a, b);
}

function unreplaced<V, P>(spec: WriteSpec<V, P>, change: P, replacement: P): P | null {
  return spec.unreplaced ? spec.unreplaced(change, replacement) : null;
}
