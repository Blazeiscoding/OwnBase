import { useId, useRef, useState, type RefObject } from "react";
import { localDateTime, type SchedulePreset } from "../lib/schedule.js";
import { Icon } from "./Icon.js";
import { Popover } from "./Popover.js";

/**
 * A time to do something at: a few from now, or any date and time. Send later
 * and reminders choose with it. Chosen now and then, so it loads when first
 * opened.
 */
export function TimePopover(props: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  onPick: (at: Date) => void;
  /** Names the popover and heads its list, such as "Send later". */
  label: string;
  presets: SchedulePreset[];
  /** What the button under the field says, for the time chosen there or none yet. */
  submitLabel: (at: Date | null) => string;
}) {
  const [customTime, setCustomTime] = useState("");
  /** What is wrong with the chosen time, said under it once Schedule is pressed. */
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const errorId = useId();
  return (
    <Popover label={props.label} anchor={props.anchor} onClose={props.onClose} width={260}>
      <div className="px-3 pb-1 pt-2.5 text-[12px] font-medium text-ink-faint">{props.label}</div>
      <ul className="px-1">
        {props.presets.map((p) => (
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
        {/* The button always answers: with no time, or one already past, it says so under the field. */}
        <form
          noValidate
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            const at = new Date(customTime);
            const problem = !customTime
              ? "Choose a date and time."
              : !Number.isFinite(at.getTime()) || at.getTime() <= Date.now()
                ? "Choose a date and time in the future."
                : null;
            setError(problem);
            if (problem) field.current?.focus();
            else props.onPick(at);
          }}
        >
          <label className="block text-[12px] font-medium text-ink-faint">
            Choose a date and time
            <input
              ref={field}
              type="datetime-local"
              required
              value={customTime}
              min={localDateTime(new Date())}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => {
                setCustomTime(e.target.value);
                setError(null);
              }}
              className="mt-1.5 w-full min-w-0 rounded-lg border border-edge bg-ground px-2.5 py-1.5 text-sm text-ink outline-none focus:border-copper aria-invalid:border-alert"
            />
          </label>
          {error && (
            <p id={errorId} role="alert" className="flex items-start gap-1 text-[11px] text-alert">
              <Icon name="alert" size={12} className="mt-px" />
              <span>{error}</span>
            </p>
          )}
          <p className="text-[11px] text-ink-faint">Uses your device's time zone.</p>
          {/* Named for the time chosen, so the choice is confirmed where it is made. */}
          <button
            type="submit"
            className="btn-shape h-8 w-full truncate bg-copper px-2 text-[13px] font-semibold text-ground transition-colors hover:bg-copper-deep"
          >
            {props.submitLabel(
              customTime && !Number.isNaN(new Date(customTime).getTime())
                ? new Date(customTime)
                : null,
            )}
          </button>
        </form>
      </div>
    </Popover>
  );
}
