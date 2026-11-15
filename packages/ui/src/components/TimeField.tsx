import { useId, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { readerLocale } from "../lib/readerLocale.js";

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * How the reader writes times: 12 hours with which words for morning and
 * afternoon, and whether those come first, or 24 hours.
 */
function clockOf(locale: string | undefined) {
  const parts = (hour: number) =>
    new Intl.DateTimeFormat(locale, { hour: "numeric" }).formatToParts(new Date(2000, 0, 1, hour));
  const morning = parts(9);
  const twelve = morning.some((part) => part.type === "dayPeriod");
  const period = (hour: number) =>
    parts(hour).find((part) => part.type === "dayPeriod")?.value ?? (hour < 12 ? "AM" : "PM");
  return {
    twelve,
    am: period(9),
    pm: period(15),
    periodFirst:
      morning.findIndex((part) => part.type === "dayPeriod") <
      morning.findIndex((part) => part.type === "hour"),
  };
}

/**
 * An hour and a minute, as the reader writes times. `<input type="time">`
 * follows Chromium's language rather than the device, so on an English
 * install set to 24-hour times it still asked for AM or PM. The arrow keys
 * step each part and digits type it, as in the browser's own.
 */
export function TimeField(props: {
  /** "HH:MM" on the 24-hour clock, or "" for none yet. */
  defaultValue?: string;
  /** "HH:MM" on the 24-hour clock once hour and minute are both there, else "". */
  onChange: (value: string) => void;
  label: string;
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
  hourRef?: Ref<HTMLInputElement>;
}) {
  const [clock] = useState(() => clockOf(readerLocale()));
  const [start] = useState(() => {
    const match = /^(\d{2}):(\d{2})$/.exec(props.defaultValue ?? "");
    return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
  });
  const [hourText, setHourText] = useState(() => {
    if (!start) return "";
    if (!clock.twelve) return pad(start.hour);
    return String(start.hour % 12 || 12);
  });
  const [minuteText, setMinuteText] = useState(() => (start ? pad(start.minute) : ""));
  const [pm, setPm] = useState(() => (start ? start.hour >= 12 : false));
  const minute = useRef<HTMLInputElement>(null);
  const id = useId();

  const maxHour = clock.twelve ? 12 : 23;
  const minHour = clock.twelve ? 1 : 0;

  function report(hours: string, minutes: string, afternoon: boolean) {
    const h = hours === "" ? NaN : Number(hours);
    const m = minutes === "" ? NaN : Number(minutes);
    if (!(h >= minHour && h <= maxHour) || !(m >= 0 && m <= 59)) {
      props.onChange("");
      return;
    }
    const hour24 = clock.twelve ? (h % 12) + (afternoon ? 12 : 0) : h;
    props.onChange(`${pad(hour24)}:${pad(m)}`);
  }

  function typeHour(raw: string) {
    const text = raw.replace(/\D/g, "").slice(-2);
    const value = Number(text);
    // A second digit that makes no hour starts the hour again.
    const kept = text.length === 2 && value > maxHour ? text.slice(-1) : text;
    setHourText(kept);
    report(kept, minuteText, pm);
    // Nothing more can follow, so on to the minutes.
    if (kept.length === 2 || (kept !== "" && Number(kept) * 10 > maxHour)) minute.current?.focus();
  }

  function typeMinute(raw: string) {
    const text = raw.replace(/\D/g, "").slice(-2);
    const kept = text.length === 2 && Number(text) > 59 ? text.slice(-1) : text;
    setMinuteText(kept);
    report(hourText, kept, pm);
  }

  function step(part: "hour" | "minute", by: number) {
    if (part === "hour") {
      const span = maxHour - minHour + 1;
      const now = hourText === "" ? (by > 0 ? minHour - 1 : maxHour + 1) : Number(hourText);
      const next = ((((now - minHour + by) % span) + span) % span) + minHour;
      const text = clock.twelve ? String(next) : pad(next);
      setHourText(text);
      report(text, minuteText, pm);
    } else {
      const now = minuteText === "" ? (by > 0 ? -1 : 60) : Number(minuteText);
      const text = pad((((now + by) % 60) + 60) % 60);
      setMinuteText(text);
      report(hourText, text, pm);
    }
  }

  function setPeriod(afternoon: boolean) {
    setPm(afternoon);
    report(hourText, minuteText, afternoon);
  }

  function keys(part: "hour" | "minute") {
    return (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        step(part, event.key === "ArrowUp" ? 1 : -1);
      } else if (part === "hour" && (event.key === ":" || event.key === ".")) {
        event.preventDefault();
        minute.current?.focus();
      } else if (clock.twelve && /^[ap]$/i.test(event.key)) {
        event.preventDefault();
        setPeriod(event.key.toLowerCase() === "p");
      }
    };
  }

  const box =
    "w-[2.6ch] min-w-0 bg-transparent text-center tabular outline-none placeholder:text-ink-faint";
  const period = clock.twelve && (
    <button
      type="button"
      disabled={props.disabled}
      aria-label={`${pm ? clock.pm : clock.am}, switch to ${pm ? clock.am : clock.pm}`}
      onClick={() => setPeriod(!pm)}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          setPeriod(!pm);
        } else if (/^[ap]$/i.test(event.key)) {
          event.preventDefault();
          setPeriod(event.key.toLowerCase() === "p");
        }
      }}
      className="rounded px-1 text-[13px] font-medium text-ink-dim hover:bg-ink/[0.06] hover:text-ink"
    >
      {pm ? clock.pm : clock.am}
    </button>
  );
  return (
    <div
      role="group"
      aria-label={props.label}
      aria-describedby={props.describedBy}
      className="flex items-center gap-1 rounded-lg border border-edge bg-ground px-2.5 py-1.5 text-sm text-ink focus-within:border-copper data-[invalid]:border-alert"
      data-invalid={props.invalid ? "" : undefined}
    >
      {clock.periodFirst && period}
      <input
        ref={props.hourRef}
        id={`${id}-hour`}
        inputMode="numeric"
        autoComplete="off"
        role="spinbutton"
        aria-label="Hour"
        aria-valuemin={minHour}
        aria-valuemax={maxHour}
        aria-valuenow={hourText === "" ? undefined : Number(hourText)}
        aria-invalid={props.invalid ? true : undefined}
        aria-describedby={props.describedBy}
        placeholder={clock.twelve ? "h" : "hh"}
        disabled={props.disabled}
        value={hourText}
        onChange={(event) => typeHour(event.target.value)}
        onKeyDown={keys("hour")}
        className={box}
      />
      <span aria-hidden="true" className="text-ink-faint">
        :
      </span>
      <input
        ref={minute}
        inputMode="numeric"
        autoComplete="off"
        role="spinbutton"
        aria-label="Minute"
        aria-valuemin={0}
        aria-valuemax={59}
        aria-valuenow={minuteText === "" ? undefined : Number(minuteText)}
        aria-invalid={props.invalid ? true : undefined}
        aria-describedby={props.describedBy}
        placeholder="mm"
        disabled={props.disabled}
        value={minuteText}
        onChange={(event) => typeMinute(event.target.value)}
        onKeyDown={keys("minute")}
        onBlur={() => {
          if (minuteText.length === 1) {
            const text = pad(Number(minuteText));
            setMinuteText(text);
            report(hourText, text, pm);
          }
        }}
        className={box}
      />
      {!clock.periodFirst && period}
    </div>
  );
}
