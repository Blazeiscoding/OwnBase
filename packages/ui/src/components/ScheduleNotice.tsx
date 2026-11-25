import { scheduleQuietUntil, type NotifySchedule } from "@ownbase/protocol";
import { useClient, useWorkspace } from "../context.js";
import { failureText } from "../lib/failure.js";
import { useMinute } from "../lib/localTime.js";
import { resumeTime } from "../lib/snooze.js";
import { Icon } from "./Icon.js";
import { useToast } from "./Toast.js";

/** "Notifications resume at 9:00 AM", or "… tomorrow at 9:00 AM" (K12). */
export function scheduleResumeText(until: number, now: Date): string {
  const when = resumeTime(until, now);
  const today = new Date(until).toDateString() === now.toDateString();
  return `Notifications resume ${today ? "at " : ""}${when}`;
}

/**
 * Atop the sidebar's foot while the notification schedule holds notifications
 * (K12): when they come back, and a way to have them for the next hour. Loaded
 * only for an account with a schedule.
 */
export function ScheduleNotice({ schedule }: { schedule: NotifySchedule }) {
  const toast = useToast();
  const client = useClient();
  const zone = useWorkspace((s) => s.self?.timeZone);
  // Hours start and end on the minute.
  const now = useMinute();
  const until = scheduleQuietUntil(schedule, zone, now);
  if (until === null) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg bg-ink/[0.05] px-2.5 py-1.5">
      <span className="text-ink-dim">
        <Icon name="moon" size={14} />
      </span>
      <span className="min-w-0 flex-1 text-[12px] text-ink-dim">
        {scheduleResumeText(until, new Date(now))}
      </span>
      <button
        onClick={() =>
          void client
            .setNotifySchedule({ ...schedule, onUntil: Date.now() + 60 * 60_000 })
            .then((error) => {
              if (error) toast({ message: failureText("Could not turn notifications on.", error) });
            })
        }
        className="rounded px-1 text-[12px] font-medium text-ink hover:underline"
      >
        Turn on for 1 hour
      </button>
    </div>
  );
}
