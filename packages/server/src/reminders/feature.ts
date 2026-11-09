import { endpoints, type Reminder, type User } from "@ownbase/protocol";
import { requireVisibleMessage, type ServerContext } from "../core/context.js";
import { SoonestTimer } from "../core/soonest.js";
import { HttpError } from "../httpError.js";

/**
 * Bounds on reminders (E4): how many an account may keep, how far ahead one
 * may be set, and how many come due in one pass of the timer before it lets
 * the loop go and takes the rest on its next turn.
 */
export const REMINDER_LIMITS = {
  perAccount: 200,
  maxAheadMs: 5 * 366 * 24 * 60 * 60_000,
  batch: 100,
};

export interface RemindersOptions {
  /** Overrides for reminders' bounds; see `REMINDER_LIMITS`. */
  reminderLimits?: Partial<typeof REMINDER_LIMITS>;
}

/** Reminders (E4): set on a message, they come due for their account at their time. */
export function registerReminders(ctx: ServerContext) {
  const { store, route, opts, background } = ctx;
  const limits = { ...REMINDER_LIMITS, ...opts.reminderLimits };

  /**
   * Reminders come due on one timer set for the soonest, and on starting,
   * so one due while the server was stopped comes due then. One whose message
   * is gone, or whose account can no longer read it or is deactivated, is
   * dropped rather than delivered. An isolated copy brings none due.
   */
  const timer = new SoonestTimer({
    lifecycle: ctx.lifecycle,
    off: opts.isolated,
    next: () => store.reminders.nextAt(),
    due: () =>
      background.maintain("reminders", () => {
        const now = Date.now();
        for (const due of store.reminders.due(now, limits.batch)) {
          const message = store.getMessage(due.messageId);
          const user = store.getUser(due.userId);
          if (
            !message ||
            !user ||
            user.deactivated ||
            !store.canAccess(message.channelId, due.userId)
          ) {
            store.reminders.delete(due.userId, due.messageId);
            continue;
          }
          store.reminders.markDue(due.userId, due.messageId, now);
        }
      }),
  });

  route(endpoints.setReminder, async ({ reply, user: me, body, params }) => {
    const message = requireVisibleMessage(store, params.id, me);
    const { at } = body;
    const now = Date.now();
    if (at <= now) throw new HttpError(400, "reminder_in_past", "Choose a time in the future.");
    if (at > now + limits.maxAheadMs) {
      throw new HttpError(400, "reminder_too_far", "Choose a time within five years.");
    }
    const existing = store.reminders.get(me.id, message.id);
    if (!existing && store.reminders.count(me.id) >= limits.perAccount) {
      throw new HttpError(
        409,
        "reminder_limit",
        `You already have ${limits.perAccount} reminders. Finish or cancel some before setting more.`,
      );
    }
    const reminder = store.reminders.set(me.id, message.id, at);
    timer.arm();
    reply.status(existing ? 200 : 201);
    return { reminder };
  });

  route(endpoints.cancelReminder, async ({ user: me, params }) => {
    // Done or cancelled, whatever has become of the message since.
    if (!store.reminders.delete(me.id, params.id)) throw new HttpError(404, "not_found");
    timer.arm();
    return { ok: true };
  });

  route(endpoints.listReminders, async ({ user: me }) => {
    return { reminders: store.reminders.list(me.id) };
  });

  return {
    start: () => timer.arm(),
    snapshot: (user: User): { reminders: Reminder[] } => ({
      reminders: store.reminders.reachable(user.id),
    }),
  };
}
