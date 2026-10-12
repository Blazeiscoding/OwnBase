import { useState, type RefObject } from "react";
import { formatScheduleShort, localDateTime, schedulePresets } from "../lib/schedule.js";
import { Popover } from "./Popover.js";

/**
 * Send later's choices: a few times from now, or any date and time. Chosen
 * now and then, so it loads when the composer's clock is first pressed.
 */
export function SendLaterPopover(props: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  onPick: (at: Date) => void;
}) {
  const [customTime, setCustomTime] = useState("");
  return (
    <Popover label="Send later" anchor={props.anchor} onClose={props.onClose} width={260}>
      <div className="px-3 pb-1 pt-2.5 text-[12px] font-medium text-ink-faint">Send later</div>
      <ul className="px-1">
        {schedulePresets().map((p) => (
          <li key={p.label}>
            <button
              onClick={() => props.onPick(p.at)}
              className="flex w-full items-baseline justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-ink-dim transition-colors hover:bg-ink/[0.07] hover:text-ink"
            >
              <span>{p.label}</span>
              <span className="tabular text-[12px] text-ink-faint">
                {p.at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-1 border-t border-edge p-3">
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            props.onPick(new Date(customTime));
          }}
        >
          <label className="block text-[12px] font-medium text-ink-faint">
            Choose a date and time
            <input
              type="datetime-local"
              required
              value={customTime}
              min={localDateTime(new Date())}
              onChange={(e) => setCustomTime(e.target.value)}
              className="mt-1.5 w-full min-w-0 rounded-lg border border-edge bg-ground px-2.5 py-1.5 text-sm text-ink outline-none focus:border-copper"
            />
          </label>
          <p className="text-[11px] text-ink-faint">Uses your device's time zone.</p>
          {/* Named for the time chosen, so the choice is confirmed where it is made. */}
          <button
            type="submit"
            disabled={!customTime}
            className="btn-shape h-8 w-full truncate bg-copper px-2 text-[13px] font-semibold text-ground transition-colors hover:bg-copper-deep disabled:opacity-40"
          >
            {customTime && !Number.isNaN(new Date(customTime).getTime())
              ? `Schedule for ${formatScheduleShort(new Date(customTime).getTime())}`
              : "Schedule message"}
          </button>
        </form>
      </div>
    </Popover>
  );
}
