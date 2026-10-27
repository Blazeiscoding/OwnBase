import type { ID, Message } from "@ownbase/protocol";

/** At most one catch-up summary per workspace this often (IMP-03). */
export const CATCH_UP_INTERVAL_MS = 2 * 60_000;
/** A reconnect's replay is taken as over once nothing more has arrived for this long. */
export const CATCH_UP_QUIET_MS = 1_000;

export interface CatchUpOptions {
  /**
   * Whether a held message is still worth telling about when the summary is
   * made: not read since, not muted since, and still somewhere this account
   * can see it.
   */
  stillNews: (message: Message) => boolean;
  /** Shows the messages, oldest first. Never called with none. */
  show: (messages: Message[]) => void;
  intervalMs?: number;
  quietMs?: number;
  now?: () => number;
}

/**
 * What a reconnect caught up on, told once rather than one interruption per
 * missed message (IMP-03). Messages are held while the replay runs; once it
 * has been quiet a moment, whichever are still news are shown together. A
 * catch-up soon after a summary waits until the interval has passed since
 * that one, and is then shown with anything else held by then.
 */
export class CatchUpSummary {
  private readonly held = new Map<ID, Message>();
  private lastShownAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly intervalMs: number;
  private readonly quietMs: number;
  private readonly now: () => number;

  constructor(private readonly options: CatchUpOptions) {
    this.intervalMs = options.intervalMs ?? CATCH_UP_INTERVAL_MS;
    this.quietMs = options.quietMs ?? CATCH_UP_QUIET_MS;
    this.now = options.now ?? Date.now;
  }

  /** A missed message that would have notified, had it arrived live. */
  hold(message: Message): void {
    this.held.set(message.id, message);
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(this.quietMs, this.lastShownAt + this.intervalMs - this.now());
    this.timer = setTimeout(() => this.flush(), wait);
  }

  /** A held message that was deleted before the summary was made. */
  drop(messageId: ID): void {
    this.held.delete(messageId);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.held.clear();
  }

  private flush(): void {
    this.timer = null;
    const messages = [...this.held.values()]
      .filter((message) => this.options.stillNews(message))
      .sort((a, b) => a.seq - b.seq);
    this.held.clear();
    // Nothing shown, so the next catch-up need not wait for this one.
    if (messages.length === 0) return;
    this.lastShownAt = this.now();
    this.options.show(messages);
  }
}

/** "Sam", "Sam and Ana", "Sam, Ana and Lee", "Sam, Ana and 3 others". */
export function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}
