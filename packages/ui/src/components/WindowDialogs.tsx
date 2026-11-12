import { useEffect, useId, useState } from "react";
import type { AskedQuestion } from "@ownbase/protocol/desktop";
import { usePlatform } from "../context.js";
import { Dialog } from "./Dialog.js";
import { buttonClass } from "./Button.js";
import { useToast } from "./Toast.js";

/**
 * Asks what the desktop app's main process needs to know, such as whether to
 * stop hosting to quit, in the app's own dialog rather than a native box, and
 * says what went wrong away from the window in its notices. The main process
 * falls back to a native box only when the page cannot answer.
 */
export function WindowDialogs() {
  const dialogs = usePlatform().windowDialogs;
  const toast = useToast();
  const [queue, setQueue] = useState<AskedQuestion[]>([]);
  useEffect(() => {
    if (!dialogs) return;
    const offAsk = dialogs.onAsk((question) => {
      // Said at once, so the main process waits for the person rather than
      // falling back to a native box; a later question waits its turn here.
      void dialogs.shown(question.id).catch(() => {});
      setQueue((now) => [...now, question]);
    });
    const offWithdraw = dialogs.onWithdraw((id) =>
      setQueue((now) => now.filter((question) => question.id !== id)),
    );
    const offNotice = dialogs.onNotice((message) => toast({ message, kind: "error" }));
    return () => {
      offAsk();
      offWithdraw();
      offNotice();
    };
  }, [dialogs, toast]);
  const current = queue[0];
  if (!dialogs || !current) return null;
  const choose = (index: number) => {
    setQueue((now) => now.filter((question) => question.id !== current.id));
    void dialogs.answer(current.id, index).catch(() => {});
  };
  return <QuestionDialog key={current.id} question={current} choose={choose} />;
}

function QuestionDialog({
  question,
  choose,
}: {
  question: AskedQuestion;
  choose: (index: number) => void;
}) {
  const detailId = useId();
  const describedBy = question.detail ? detailId : undefined;
  return (
    <Dialog
      title={question.title}
      onClose={() => choose(question.cancel)}
      width={440}
      describedBy={describedBy}
    >
      {question.detail && (
        <p id={describedBy} className="mb-4 text-sm text-ink-dim">
          {question.detail}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {question.buttons.map((button, index) => (
          <button
            key={index}
            type="button"
            autoFocus={index === question.focus}
            onClick={() => choose(index)}
            className={buttonClass(button.tone)}
          >
            {button.label}
          </button>
        ))}
      </div>
    </Dialog>
  );
}
