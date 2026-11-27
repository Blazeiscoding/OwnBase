import { useState } from "react";
import {
  scheduleQuietUntil,
  type NotifyHours,
  type NotifySchedule,
  type NotifyScheduleKind,
} from "@ownbase/protocol";
import { useClient, useWorkspace } from "../context.js";
import { settingMark } from "../lib/accountSections.js";
import { failureText } from "../lib/failure.js";
import { readerTimeZone, useMinute, zoneLabel } from "../lib/localTime.js";
import { useSaved } from "../lib/savedNote.js";
import { resumeTime } from "../lib/snooze.js";
import { scheduleResumeText } from "./ScheduleNotice.js";
import { Select } from "./Select.js";
import { inputClass, TextField } from "./TextField.js";

const WORK_HOURS: NotifyHours = { from: "09:00", to: "18:00" };

/** Sunday first, as the schedule keeps them; shown Monday first, as Slack does. */
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHOWN_ORDER = [1, 2, 3, 4, 5, 6, 0];

const CHOICES: { value: NotifyScheduleKind | "off"; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "every-day", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "custom", label: "Custom" },
];

const isWeekday = (day: number) => day >= 1 && day <= 5;

/** The schedule a choice of kind makes, keeping the hours already chosen. */
function scheduleOf(
  kind: NotifyScheduleKind,
  hours: NotifyHours,
  earlier: NotifySchedule | null,
): NotifySchedule {
  if (kind === "custom") {
    const days = earlier?.days ?? DAY_NAMES.map((_, day) => (isWeekday(day) ? hours : null));
    return { kind, days };
  }
  return {
    kind,
    days: DAY_NAMES.map((_, day) => (kind === "every-day" || isWeekday(day) ? hours : null)),
  };
}

/**
 * Notifications → Schedule (K12): the hours this account allows
 * notifications, on every device it uses. Outside them notifications pause by
 * themselves; Activity still lists everything.
 */
export function NotifyScheduleSettings() {
  const client = useClient();
  const saved = useSaved();
  const schedule = useWorkspace((s) => s.notifySchedule);
  const self = useWorkspace((s) => s.self);
  const zone = readerTimeZone(self);
  const now = useMinute();
  const [failed, setFailed] = useState<string | null>(null);
  const quietUntil = scheduleQuietUntil(schedule, zone, now);
  // "Turn on for 1 hour" from the sidebar, while the hours alone would hold notifications.
  const turnedOnUntil =
    schedule?.onUntil &&
    schedule.onUntil > now &&
    scheduleQuietUntil({ ...schedule, onUntil: null }, zone, now) !== null
      ? schedule.onUntil
      : null;
  const hours = schedule?.days.find((day) => day !== null) ?? WORK_HOURS;

  const save = (next: NotifySchedule | null) => {
    setFailed(null);
    void client.setNotifySchedule(next).then((error) => {
      if (!error) saved();
      else setFailed(failureText("Your schedule was not saved.", error, "Try again."));
    });
  };

  /** One day's hours changed, or every day's for every day and weekdays. */
  const setHours = (day: number | null, part: keyof NotifyHours, time: string) => {
    // A time field cleared halfway through typing says nothing yet.
    if (!schedule || !time) return;
    const days = schedule.days.map((hours, index) =>
      hours && (day === null || index === day) ? { ...hours, [part]: time } : hours,
    );
    save({ ...schedule, days, onUntil: null });
  };

  const setDay = (day: number, on: boolean) => {
    if (!schedule) return;
    const days = schedule.days.map((hours, index) =>
      index === day ? (on ? (hours ?? WORK_HOURS) : null) : hours,
    );
    if (days.every((hours) => hours === null)) {
      setFailed("Keep at least one day ticked. To stop using a schedule, choose Off.");
      return;
    }
    save({ ...schedule, days, onUntil: null });
  };

  /** One day's row under Custom: "Monday [09:00] to [18:00]", the day naming each field. */
  const dayFields = (day: number, value: NotifyHours, name: string) => (
    <div className="flex items-center gap-2 text-sm text-ink-dim">
      <input
        type="time"
        aria-label={`${name} from`}
        className={inputClass("regular", "w-32")}
        value={value.from}
        onChange={(event) => setHours(day, "from", event.target.value)}
      />
      to
      <input
        type="time"
        aria-label={`${name} until`}
        className={inputClass("regular", "w-32")}
        value={value.to}
        onChange={(event) => setHours(day, "to", event.target.value)}
      />
    </div>
  );

  return (
    <section
      {...settingMark("notification-schedule")}
      aria-labelledby="account-schedule-title"
      className="mt-6 border-t border-edge pt-5"
    >
      <h3 id="account-schedule-title" className="font-semibold">
        Notification schedule
      </h3>
      <p className="mt-1 text-sm text-ink-dim">
        Outside these hours, notifications pause by themselves on every device you use. Activity
        still lists everything. Times are in {zoneLabel(zone)}.
      </p>
      <Select
        label="Schedule"
        className="mt-3 w-48"
        value={schedule?.kind ?? "off"}
        onChange={(event) => {
          const kind = event.target.value as NotifyScheduleKind | "off";
          save(kind === "off" ? null : scheduleOf(kind, hours, schedule));
        }}
      >
        {CHOICES.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </Select>
      {schedule && schedule.kind !== "custom" && (
        <div className="mt-3 flex flex-wrap gap-2">
          <TextField
            type="time"
            label="From"
            className="w-32"
            value={hours.from}
            onChange={(event) => setHours(null, "from", event.target.value)}
          />
          <TextField
            type="time"
            label="Until"
            className="w-32"
            value={hours.to}
            onChange={(event) => setHours(null, "to", event.target.value)}
          />
        </div>
      )}
      {schedule?.kind === "custom" && (
        <ul className="mt-3 space-y-2">
          {SHOWN_ORDER.map((day) => {
            const dayHours = schedule.days[day] ?? null;
            const name = DAY_NAMES[day]!;
            return (
              <li key={day} className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-1">
                <label className="flex w-28 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={dayHours !== null}
                    onChange={(event) => setDay(day, event.target.checked)}
                  />
                  {name}
                </label>
                {dayHours ? (
                  dayFields(day, dayHours, name)
                ) : (
                  <span className="text-sm text-ink-faint">No notifications</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {schedule && (
        <p role="status" className="mt-3 text-sm text-ink-dim">
          {quietUntil !== null
            ? `Paused now by your schedule. ${scheduleResumeText(quietUntil, new Date(now))}.`
            : turnedOnUntil !== null
              ? `Turned on until ${resumeTime(turnedOnUntil, new Date(now))}. After that, your schedule applies again.`
              : "Notifications are on now."}
        </p>
      )}
      {failed && (
        <p role="alert" className="mt-2 text-sm text-alert">
          {failed}
        </p>
      )}
    </section>
  );
}
