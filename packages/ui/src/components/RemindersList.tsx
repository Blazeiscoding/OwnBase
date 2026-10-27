import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { notificationBody } from "@ownbase/client-core";
import type { ID, ReminderItem } from "@ownbase/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle } from "../lib/format.js";
import { formatReminderTime, formatScheduleShort, reminderPresets } from "../lib/schedule.js";
import { Avatar } from "./Avatar.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { Icon } from "./Icon.js";
import { ListStatus } from "./ListStatus.js";
import { Tooltip } from "./Tooltip.js";
import { useToast } from "./Toast.js";

const TimePopover = lazy(() =>
  import("./TimePopover.js").then((module) => ({ default: module.TimePopover })),
);

/**
 * Activity's Reminders (E4): those come due, the latest first, then those
 * waiting, the soonest first. A row opens its message; Done, Change and Cancel
 * act on the reminder. Read again whenever this account's reminders change,
 * here or on another device, keeping what is shown meanwhile.
 */
export function RemindersList({ onJump }: { onJump: (channelId: ID, messageId: ID) => void }) {
  const client = useClient();
  const toast = useToast();
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const selfId = useWorkspace((s) => s.self?.id);
  const signature = useWorkspace((s) =>
    Object.values(s.reminders ?? {})
      .map((r) => `${r.messageId}:${r.remindAt}:${r.dueAt}`)
      .sort()
      .join(","),
  );
  const [items, setItems] = useState<ReminderItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** The reminder whose time is being changed, and the row its choices hang from. */
  const [changing, setChanging] = useState<ReminderItem | null>(null);
  const anchor = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    client.api.listReminders(controller.signal).then(
      ({ reminders }) => {
        setItems(reminders);
        setFailed(false);
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => controller.abort();
  }, [client, signature, attempt]);

  function change(item: ReminderItem, at: Date) {
    setChanging(null);
    const when = at.getTime();
    void client.setReminder(item.message.id, when).then((ok) =>
      toast(
        ok
          ? { message: `Reminder set for ${formatReminderTime(when)}.`, kind: "success" }
          : {
              message: "Could not set that reminder.",
              action: { label: "Try again", run: () => change(item, at) },
            },
      ),
    );
  }
  function finish(item: ReminderItem) {
    void client.cancelReminder(item.message.id).then((ok) => {
      if (!ok)
        toast({
          message: "Could not remove that reminder.",
          action: { label: "Try again", run: () => finish(item) },
        });
    });
  }

  // A conversation this client no longer has is not shown, as Activity's lists do.
  const shown = (items ?? []).filter((item) => channels[item.message.channelId]);
  const due = shown.filter((item) => item.reminder.dueAt !== null);
  const waiting = shown.filter((item) => item.reminder.dueAt === null);
  const row = (item: ReminderItem) => {
    const { message, reminder } = item;
    const channel = channels[message.channelId]!;
    const place =
      channel.type === "public" || channel.type === "private"
        ? `#${channel.name}`
        : channelTitle(channel, users, selfId);
    return (
      <ReminderRow
        key={reminder.id}
        author={users[message.userId]?.displayName}
        avatarUser={users[message.userId]}
        where={message.threadRootId ? `Thread in ${place}` : place}
        when={formatScheduleShort(reminder.remindAt)}
        preview={notificationBody(client.state, message)}
        due={reminder.dueAt !== null}
        onOpen={() => onJump(message.channelId, message.id)}
        onChange={(element) => {
          anchor.current = element;
          setChanging(item);
        }}
        onFinish={() => finish(item)}
      />
    );
  };

  return (
    <>
      <ListStatus
        loading={items === null && !failed}
        placeholder={items === null}
        loadingLabel="Loading reminders…"
        error={failed ? "Could not load reminders. Check your connection and try again." : null}
        onRetry={() => setAttempt((n) => n + 1)}
        empty={
          items && shown.length === 0
            ? "No reminders. Choose Remind me about this… in a message's menu."
            : null
        }
        emptyIcon="clock"
      />
      {[
        { title: "Due", list: due },
        { title: "Upcoming", list: waiting },
      ].map(
        ({ title, list }) =>
          list.length > 0 && (
            <section key={title} aria-label={title} className="mb-2.5">
              <h3 className="px-2 pb-0.5 text-[12px] font-semibold text-ink-dim">{title}</h3>
              <ul>{list.map(row)}</ul>
            </section>
          ),
      )}
      {changing && (
        <ErrorBoundary
          fallback={
            <p role="alert" className="px-2 text-xs text-ink-dim">
              Reminders could not load. Reload the app to try again.
            </p>
          }
        >
          <Suspense fallback={null}>
            <TimePopover
              label="Remind me"
              presets={reminderPresets()}
              submitLabel={(at) =>
                at ? `Remind me ${formatReminderTime(at.getTime())}` : "Set reminder"
              }
              anchor={anchor}
              onClose={() => setChanging(null)}
              onPick={(at) => change(changing, at)}
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </>
  );
}

/**
 * One reminder on one line: who wrote the message, where, when it is for, and
 * the start of what it says. Its actions show on hover or focus, and stay in
 * sight where there is no hover, as Activity's rows do.
 */
function ReminderRow(props: {
  author: string | undefined;
  avatarUser: Parameters<typeof Avatar>[0]["user"];
  where: string;
  when: string;
  preview: string;
  due: boolean;
  onOpen: () => void;
  onChange: (row: HTMLElement) => void;
  onFinish: () => void;
}) {
  const item = useRef<HTMLLIElement>(null);
  const action =
    "flex size-7 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink";
  return (
    <li ref={item} className="group/row relative">
      <button
        type="button"
        data-activity-row=""
        onClick={props.onOpen}
        className="flex w-full items-start gap-2.5 rounded-lg py-1.5 pl-3 pr-2 text-left transition-colors hover:bg-ink/[0.035] focus-visible:bg-ink/[0.035] [@media(hover:none)]:pr-[4.5rem]"
      >
        <Avatar user={props.avatarUser} size={24} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5 text-[13px]">
            <span className="truncate font-semibold">{props.author ?? "Unknown member"}</span>
            <span className="truncate text-[12px] text-ink-faint">{props.where}</span>
            <span className="ml-auto shrink-0 text-[12px] text-ink-faint">{props.when}</span>
          </span>
          <span className="block truncate text-[13px] text-ink-dim">{props.preview}</span>
        </span>
      </button>
      <span className="absolute right-1.5 top-1 flex gap-0.5 rounded-lg bg-raised p-0.5 opacity-0 shadow-[0_1px_3px_rgb(0_0_0/0.18)] transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:top-2 [@media(hover:none)]:opacity-100">
        {props.due && (
          <Tooltip label="Done: take it off the list">
            <button
              type="button"
              aria-label="Mark done"
              className={action}
              onClick={props.onFinish}
            >
              <Icon name="check" size={14} />
            </button>
          </Tooltip>
        )}
        <Tooltip label={props.due ? "Remind me again later" : "Change when"}>
          <button
            type="button"
            aria-label={props.due ? "Remind me later" : "Change reminder"}
            className={action}
            onClick={() => item.current && props.onChange(item.current)}
          >
            <Icon name="clock" size={14} />
          </button>
        </Tooltip>
        {!props.due && (
          <Tooltip label="Cancel reminder">
            <button
              type="button"
              aria-label="Cancel reminder"
              className={action}
              onClick={props.onFinish}
            >
              <Icon name="close" size={14} />
            </button>
          </Tooltip>
        )}
      </span>
    </li>
  );
}
