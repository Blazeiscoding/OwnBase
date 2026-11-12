import type { AskedQuestion, WindowQuestion } from "@ownbase/protocol/desktop";

/** How long the page has to say the question is on screen before a native box takes over. */
export const SHOWN_WITHIN_MS = 5_000;

export interface WindowQuestionDeps {
  /** Shows the window and hands it the question; false when no working page can take it. */
  send: (asked: AskedQuestion) => boolean;
  /** Takes a question back off the page, when the native box took over or the page went. */
  withdraw: (id: number) => void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  shownWithinMs?: number;
}

interface Pending {
  question: WindowQuestion;
  resolve: (answer: number | null) => void;
  timer: unknown;
}

/**
 * Questions the main process asks in the window's own dialog rather than a
 * native box. `ask` resolves to the index of the button chosen, or null when
 * the window could not ask: no page that answers, a page that did not show it
 * in time, or a page that went while it was open. On null the caller asks in
 * a native box, since a dead page has nothing to draw a dialog in.
 */
export class WindowQuestions {
  private serial = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly deps: WindowQuestionDeps) {}

  ask(question: WindowQuestion): Promise<number | null> {
    const id = ++this.serial;
    return new Promise((resolve) => {
      const setTimer = this.deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
      const timer = setTimer(() => {
        if (!this.pending.has(id)) return;
        this.settle(id, null);
        this.deps.withdraw(id);
      }, this.deps.shownWithinMs ?? SHOWN_WITHIN_MS);
      this.pending.set(id, { question, resolve, timer });
      let sent = false;
      try {
        sent = this.deps.send({ ...question, id });
      } catch {
        sent = false;
      }
      if (!sent) this.settle(id, null);
    });
  }

  /** The page shows the question: from now it waits for the person, however long. */
  shown(id: unknown): void {
    const question = typeof id === "number" ? this.pending.get(id) : undefined;
    if (!question || question.timer === null) return;
    (this.deps.clearTimer ?? ((timer) => clearTimeout(timer as never)))(question.timer);
    question.timer = null;
  }

  /** The person chose a button; anything that is not one of them is ignored. */
  answer(id: unknown, index: unknown): void {
    if (typeof id !== "number" || !this.pending.has(id)) return;
    const { question } = this.pending.get(id)!;
    if (typeof index !== "number" || !Number.isInteger(index)) return;
    if (index < 0 || index >= question.buttons.length) return;
    this.settle(id, index);
  }

  /** The page went (crashed, reloaded, closed): its open questions fall back to native boxes. */
  windowGone(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, null);
  }

  private settle(id: number, answer: number | null): void {
    const question = this.pending.get(id);
    if (!question) return;
    this.pending.delete(id);
    if (question.timer !== null)
      (this.deps.clearTimer ?? ((timer) => clearTimeout(timer as never)))(question.timer);
    question.resolve(answer);
  }
}
