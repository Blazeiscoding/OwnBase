import { useId, useRef, useState, type RefObject } from "react";
import { firstRepeat, type RepeatEvery, type RepeatRule } from "@ownbase/protocol";
import { useWorkspace } from "../context.js";
import { clockSkewNote, localDateTime, type SchedulePreset } from "../lib/schedule.js";
import { readerLocale } from "../lib/readerLocale.js";
import { deviceZone, repeatEveryText } from "../lib/repeat.js";
import { Icon } from "./Icon.js";
import { Popover } from "./Popover.js";
import { TimeField } from "./TimeField.js";

const REPEATS: RepeatEvery[] = ["day", "weekday", "week", "month"];

/**
 * A time to do something at: a few from now, or any date and time. Send later
 * and reminders choose with it. Chosen now and then, so it loads when first
 * opened.
 */
export function TimePopover(props: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** With a repeat, `at` is the time chosen; the first send is the rule's first time from it. */
  onPick: (at: Date, repeat?: RepeatRule) => void;
  /** Names the popover and heads its list, such as "Send later". */
  label: string;
  presets: SchedulePreset[];
  /** What the button under the field says, for the time chosen there or none yet. */
  submitLabel: (at: Date | null) => string;
  /** Offers a Repeat choice (K14), or says why it cannot repeat now. */
  repeatable?: true | string;
}) {
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const customTime = date && time ? `${date}T${time}` : "";
  const [every, setEvery] = useState<RepeatEvery | "">("");
  const [until, setUntil] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dateField = useRef<HTMLInputElement>(null);
  const hourField = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const repeatId = useId();
  const untilId = useId();
  // A time chosen here is the device's; a clock far off sends it at the wrong moment.
  const skewNote = clockSkewNote(useWorkspace((s) => s.clockSkewMs));
  const repeating = props.repeatable === true && every !== "";
  // The weekly and monthly choices name the chosen date's weekday and day.
  const day = new Date(date ? `${date}T12:00` : Date.now());
  const rule: RepeatRule | undefined =
    props.repeatable === true && every && time
      ? {
          every,
          ...(every === "week" ? { weekday: day.getDay() } : {}),
          ...(every === "month" ? { monthDay: day.getDate() } : {}),
          time,
          timeZone: deviceZone(),
          until: until || null,
        }
      : undefined;
  const chosen = customTime ? new Date(customTime) : null;
  const valid = chosen && Number.isFinite(chosen.getTime()) ? chosen : null;
  // Every weekday, chosen for a Saturday, first goes on the Monday.
  const first = valid && rule ? firstRepeat(rule, valid.getTime()) : valid?.getTime();
  return (
    // Wide enough for a whole date beside the time: at 260 the date field cut
    // its year short ("dd-mm-yy").
    <Popover label={props.label} anchor={props.anchor} onClose={props.onClose} width={296}>
      <div className="px-3 pb-1 pt-2.5 text-[12px] font-medium text-ink-faint">{props.label}</div>
      {skewNote && (
        <p role="note" className="flex items-start gap-1.5 px-3 pb-1.5 text-[12px] text-alert">
          <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
          <span>{skewNote}</span>
        </p>
      )}
      {/* A repeat goes at a date and time chosen below, so the quick times step aside. */}
      {!repeating && (
        <ul className="px-1">
          {props.presets.map((p) => (
            <li key={p.label}>
              <button
                onClick={() => props.onPick(p.at)}
                className="flex w-full items-baseline justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-ink-dim transition-colors hover:bg-ink/[0.07] hover:text-ink"
              >
                <span>{p.label}</span>
                <span className="tabular text-[12px] text-ink-faint">
                  {p.at.toLocaleTimeString(readerLocale(), { hour: "numeric", minute: "2-digit" })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={`p-3 ${repeating ? "" : "mt-1 border-t border-edge"}`}>
        {/* The button always answers: with no time, or one already past, it says so under the field. */}
        <form
          noValidate
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            const problem = !valid
              ? "Choose a date and time."
              : valid.getTime() <= Date.now()
                ? "Choose a date and time in the future."
                : rule && first === null
                  ? "Choose an end date on or after the first send."
                  : null;
            setError(problem);
            if (problem) (date ? hourField : dateField).current?.focus();
            // A time that does not repeat is picked as it always was.
            else if (rule) props.onPick(valid!, rule);
            else props.onPick(valid!);
          }}
        >
          <fieldset className="min-w-0">
            <legend className="text-[12px] font-medium text-ink-faint">
              Choose a date and time
            </legend>
            <div className="mt-1.5 flex gap-2">
              <input
                ref={dateField}
                type="date"
                aria-label="Date"
                required
                value={date}
                min={localDateTime(new Date()).slice(0, 10)}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => {
                  setDate(e.target.value);
                  setError(null);
                }}
                className="w-full min-w-0 flex-1 rounded-lg border border-edge bg-ground px-2.5 py-1.5 text-sm text-ink outline-none focus:border-copper aria-invalid:border-alert"
              />
              <TimeField
                label="Time"
                hourRef={hourField}
                invalid={!!error}
                describedBy={error ? errorId : undefined}
                onChange={(value) => {
                  setTime(value);
                  setError(null);
                }}
              />
            </div>
          </fieldset>
          {props.repeatable && (
            <div className="flex items-center gap-2">
              <label htmlFor={repeatId} className="w-12 shrink-0 text-[12px] text-ink-faint">
                Repeat
              </label>
              <select
                id={repeatId}
                value={props.repeatable === true ? every : ""}
                disabled={props.repeatable !== true}
                onChange={(e) => {
                  setEvery(e.target.value as RepeatEvery | "");
                  setError(null);
                }}
                className="h-8 w-full min-w-0 rounded-lg border border-edge bg-ground px-2 text-[13px] text-ink outline-none focus-visible:border-copper disabled:text-ink-faint"
              >
                <option value="">Does not repeat</option>
                {REPEATS.map((kind) => (
                  <option key={kind} value={kind}>
                    {repeatEveryText(kind, day.getDay(), day.getDate())}
                  </option>
                ))}
              </select>
            </div>
          )}
          {typeof props.repeatable === "string" && (
            <p className="text-[11px] text-ink-faint">{props.repeatable}</p>
          )}
          {repeating && (
            <div className="flex items-center gap-2">
              <label htmlFor={untilId} className="w-12 shrink-0 text-[12px] text-ink-faint">
                Ends
              </label>
              <input
                id={untilId}
                type="date"
                value={until}
                min={date || localDateTime(new Date()).slice(0, 10)}
                aria-describedby={`${untilId}-hint`}
                onChange={(e) => {
                  setUntil(e.target.value);
                  setError(null);
                }}
                className="w-full min-w-0 flex-1 rounded-lg border border-edge bg-ground px-2.5 py-1.5 text-sm text-ink outline-none focus:border-copper"
              />
              <span id={`${untilId}-hint`} className="shrink-0 text-[11px] text-ink-faint">
                Optional
              </span>
            </div>
          )}
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
            {props.submitLabel(typeof first === "number" ? new Date(first) : null)}
          </button>
        </form>
      </div>
    </Popover>
  );
}
