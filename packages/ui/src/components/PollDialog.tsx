import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  POLL_OPTION_MAX,
  POLL_OPTIONS_MAX,
  POLL_OPTIONS_MIN,
  POLL_QUESTION_MAX,
  type ID,
} from "@slackoss/protocol";
import { useClient } from "../context.js";
import { buttonClass } from "./Button.js";
import { Dialog, DialogScroll } from "./Dialog.js";
import { Icon } from "./Icon.js";
import { inputCls } from "./TextField.js";

/** Which field a problem is about, so it is said beside that field. */
type Problem = { field: "question" | number | "send"; text: string };

/**
 * Makes a poll (E6): a question, two to ten choices, and whether people may
 * choose more than one and whether who chose what is kept from everyone. It
 * goes like any message, through the outbox, into the conversation or thread
 * it was made in. Enter in a choice moves to the next, and adds one at the end.
 */
export function PollDialog({
  channelId,
  threadRootId,
  question: initial = "",
  onClose,
  onSent,
}: {
  channelId: ID;
  threadRootId?: ID;
  /** Words already typed after /poll. */
  question?: string;
  onClose: () => void;
  onSent?: () => void;
}) {
  const client = useClient();
  const [question, setQuestion] = useState(initial.slice(0, POLL_QUESTION_MAX));
  const [options, setOptions] = useState<string[]>(() => Array(POLL_OPTIONS_MIN).fill(""));
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const questionField = useRef<HTMLInputElement>(null);
  const optionFields = useRef<(HTMLInputElement | null)[]>([]);
  /** A choice field to move to once it is drawn. */
  const focusOption = useRef<number | null>(null);
  const problemId = useId();

  useEffect(() => {
    if (focusOption.current === null) return;
    optionFields.current[focusOption.current]?.focus();
    focusOption.current = null;
  });

  const say = (field: Problem["field"], text: string) => {
    setProblem({ field, text });
    if (field === "question") questionField.current?.focus();
    else if (typeof field === "number") optionFields.current[field]?.focus();
  };

  function setOption(i: number, value: string) {
    setOptions((all) => all.map((o, j) => (j === i ? value : o)));
    if (problem?.field === i) setProblem(null);
  }

  function addOption() {
    if (options.length >= POLL_OPTIONS_MAX) return;
    focusOption.current = options.length;
    setOptions((all) => [...all, ""]);
  }

  function removeOption(i: number) {
    focusOption.current = Math.min(i, options.length - 2);
    setOptions((all) => all.filter((_, j) => j !== i));
    setProblem(null);
  }

  function onOptionKey(event: KeyboardEvent<HTMLInputElement>, i: number) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    const last = i === options.length - 1;
    // At the end, a filled choice asks for another; an empty one, or the tenth, sends.
    if (last && (!options[i]!.trim() || options.length >= POLL_OPTIONS_MAX)) return;
    event.preventDefault();
    if (last) addOption();
    else optionFields.current[i + 1]?.focus();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const asked = question.trim();
    if (!asked) return say("question", "Write the question to ask.");
    const filled = options.map((o) => o.trim());
    const given = filled.filter(Boolean);
    if (given.length < POLL_OPTIONS_MIN) {
      const empty = filled.findIndex((o) => !o);
      return say(empty === -1 ? 0 : empty, "Give at least two choices.");
    }
    const seen = new Set<string>();
    for (const [i, option] of filled.entries()) {
      if (!option) continue;
      const key = option.toLowerCase();
      if (seen.has(key)) return say(i, "Each choice must be different.");
      seen.add(key);
    }
    const sent = client.send(channelId, asked, {
      ...(threadRootId ? { threadRootId } : {}),
      poll: { options: given, multiple, anonymous },
    });
    if (!sent)
      return say("send", "Too many messages are waiting to send. Try again once they have gone.");
    onSent?.();
    onClose();
  }

  const described = (field: Problem["field"]) =>
    problem?.field === field
      ? { "aria-invalid": true as const, "aria-describedby": problemId }
      : {};
  const problemText = (field: Problem["field"]) =>
    problem?.field === field && (
      <p id={problemId} role="alert" className="mt-1.5 text-xs text-alert">
        {problem.text}
      </p>
    );

  return (
    <Dialog title="Create a poll" onClose={onClose} width={480} ownScroll>
      <form noValidate onSubmit={submit} className="flex min-h-0 flex-col">
        <DialogScroll>
          <div className="space-y-4">
            <div>
              <label
                htmlFor={`${problemId}-question`}
                className="mb-1.5 block text-[13px] font-medium text-ink-dim"
              >
                Question
              </label>
              <input
                ref={questionField}
                id={`${problemId}-question`}
                autoFocus
                value={question}
                maxLength={POLL_QUESTION_MAX}
                placeholder="What should we ask?"
                onChange={(event) => {
                  setQuestion(event.target.value);
                  if (problem?.field === "question") setProblem(null);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  optionFields.current[0]?.focus();
                }}
                className={inputCls}
                {...described("question")}
              />
              {problemText("question")}
            </div>
            <fieldset>
              <legend className="mb-1.5 text-[13px] font-medium text-ink-dim">Choices</legend>
              <ol className="space-y-2">
                {options.map((option, i) => (
                  <li key={i}>
                    <div className="flex items-center gap-1.5">
                      <input
                        ref={(node) => {
                          optionFields.current[i] = node;
                        }}
                        value={option}
                        maxLength={POLL_OPTION_MAX}
                        aria-label={`Choice ${i + 1}`}
                        placeholder={`Choice ${i + 1}`}
                        onChange={(event) => setOption(i, event.target.value)}
                        onKeyDown={(event) => onOptionKey(event, i)}
                        className={inputCls}
                        {...described(i)}
                      />
                      {options.length > POLL_OPTIONS_MIN && (
                        <button
                          type="button"
                          aria-label={`Remove choice ${i + 1}`}
                          onClick={() => removeOption(i)}
                          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
                        >
                          <Icon name="close" size={15} />
                        </button>
                      )}
                    </div>
                    {problemText(i)}
                  </li>
                ))}
              </ol>
              {options.length < POLL_OPTIONS_MAX ? (
                <button
                  type="button"
                  onClick={addOption}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-md text-[13px] font-medium text-ink-dim hover:text-ink"
                >
                  <Icon name="plus" size={14} strokeWidth={2.4} />
                  Add a choice
                </button>
              ) : (
                <p className="mt-2 text-[13px] text-ink-faint">
                  {POLL_OPTIONS_MAX} choices is the most a poll can have.
                </p>
              )}
            </fieldset>
            <div className="space-y-2.5">
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={multiple}
                  onChange={(event) => setMultiple(event.target.checked)}
                  className="mt-0.5 size-4 accent-[var(--color-copper)]"
                />
                <span className="text-sm">
                  <span className="block font-medium text-ink">Allow more than one choice</span>
                  <span className="block text-[13px] text-ink-dim">
                    People can pick as many as they like.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={anonymous}
                  onChange={(event) => setAnonymous(event.target.checked)}
                  className="mt-0.5 size-4 accent-[var(--color-copper)]"
                />
                <span className="text-sm">
                  <span className="block font-medium text-ink">Anonymous</span>
                  <span className="block text-[13px] text-ink-dim">
                    Show the counts but not who chose what, to anyone, you included.
                  </span>
                </span>
              </label>
            </div>
          </div>
        </DialogScroll>
        <div className="dialog-foot">
          {problemText("send")}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={buttonClass("secondary")}>
              Cancel
            </button>
            <button type="submit" className={buttonClass("primary")}>
              Create poll
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
