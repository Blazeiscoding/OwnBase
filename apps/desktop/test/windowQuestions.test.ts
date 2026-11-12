import { describe, expect, it, vi } from "vitest";
import type { AskedQuestion, WindowQuestion } from "@ownbase/protocol/desktop";
import { SHOWN_WITHIN_MS, WindowQuestions } from "../src/main/windowQuestions.js";

const QUIT: WindowQuestion = {
  title: "Quit OwnBase and stop the hosted workspace?",
  buttons: [
    { label: "Cancel", tone: "quiet" },
    { label: "Stop hosting and quit", tone: "danger" },
  ],
  cancel: 0,
  focus: 0,
};

function setUp(window: "answers" | "none" = "answers") {
  const sent: AskedQuestion[] = [];
  const timers: { run: () => void; ms: number; cleared: boolean }[] = [];
  const withdraw = vi.fn();
  const questions = new WindowQuestions({
    send: (asked) => {
      if (window === "none") return false;
      sent.push(asked);
      return true;
    },
    withdraw,
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as { cleared: boolean }).cleared = true;
    },
  });
  const fire = () => timers.filter((t) => !t.cleared).forEach((t) => t.run());
  return { questions, sent, withdraw, timers, fire };
}

describe("WindowQuestions", () => {
  it("asks in the window and answers with the button chosen, however long it takes", async () => {
    const { questions, sent, fire, timers } = setUp();
    const answer = questions.ask(QUIT);
    expect(sent).toEqual([{ ...QUIT, id: 1 }]);
    expect(timers[0]!.ms).toBe(SHOWN_WITHIN_MS);
    questions.shown(1);
    // Once shown, the person takes as long as they need.
    fire();
    questions.answer(1, 1);
    expect(await answer).toBe(1);
  });

  it("leaves it to a native box when no page can ask", async () => {
    const { questions } = setUp("none");
    expect(await questions.ask(QUIT)).toBeNull();
  });

  it("takes the question back when the page does not show it in time", async () => {
    const { questions, withdraw, fire } = setUp();
    const answer = questions.ask(QUIT);
    fire();
    expect(await answer).toBeNull();
    expect(withdraw).toHaveBeenCalledWith(1);
    // A late answer changes nothing.
    questions.answer(1, 1);
  });

  it("falls back when the page goes while the question is open", async () => {
    const { questions } = setUp();
    const answer = questions.ask(QUIT);
    questions.shown(1);
    questions.windowGone();
    expect(await answer).toBeNull();
  });

  it("ignores answers that are not one of its buttons, or not its questions", async () => {
    const { questions } = setUp();
    const answer = questions.ask(QUIT);
    questions.shown(1);
    questions.answer(1, 2);
    questions.answer(1, -1);
    questions.answer(1, 0.5);
    questions.answer(1, "1");
    questions.answer(2, 0);
    questions.answer("1", 0);
    questions.answer(1, 0);
    expect(await answer).toBe(0);
  });
});
