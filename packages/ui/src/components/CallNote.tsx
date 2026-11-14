import { useState } from "react";
import type { Message } from "@ownbase/protocol";
import { useWorkspace } from "../context.js";
import { Icon } from "./Icon.js";
import { buttonClass } from "./Button.js";
import { useStartHuddle } from "../lib/startHuddle.js";
import { failureMessage } from "../platform.js";

/**
 * A note the server left about a call, in place of its words (E10): a huddle
 * nobody answered. Everyone but the caller can call back, or join the huddle
 * if it is still going; the caller reads that nobody answered.
 */
export function CallNote({ message }: { message: Message }) {
  const huddle = useStartHuddle();
  const mine = useWorkspace((s) => s.self?.id === message.userId);
  const inThis = useWorkspace((s) => s.huddle?.channelId === message.channelId);
  const going = useWorkspace((s) => (s.huddles[message.channelId]?.length ?? 0) > 0);
  const [error, setError] = useState<string | null>(null);

  async function callBack() {
    if (huddle.starting) return;
    const failed = await huddle.start(message.channelId, { onAgreed: () => setError(null) });
    if (failed) setError(failureMessage(failed.error, "Could not start a huddle. Try again."));
  }

  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="flex items-center gap-2 text-[16px] text-ink/90">
        <span
          aria-hidden="true"
          className="grid size-7 place-items-center rounded-full bg-alert/12 text-alert"
        >
          <Icon name="phoneMissed" size={15} />
        </span>
        {mine ? "No answer" : "Missed huddle"}
      </span>
      {!mine && !inThis && (
        <button
          type="button"
          onClick={() => void callBack()}
          aria-disabled={huddle.starting || undefined}
          className={buttonClass("secondary", "h-8 aria-disabled:opacity-60")}
        >
          <Icon name="headphones" size={15} />
          {huddle.starting ? "Calling…" : going ? "Join huddle" : "Call back"}
        </button>
      )}
      {error && (
        <p role="alert" className="w-full text-sm text-alert">
          {error}
        </p>
      )}
    </div>
  );
}
