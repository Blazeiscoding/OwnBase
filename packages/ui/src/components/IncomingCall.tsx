import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { HuddleRing, ID, NotificationPreview } from "@ownbase/protocol";
import { isSnoozed } from "@ownbase/client-core";
import { scheduleAllows } from "@ownbase/protocol";
import { useClient, usePlatform, useWorkspace } from "../context.js";
import { Avatar } from "./Avatar.js";
import { Icon } from "./Icon.js";
import { buttonClass } from "./Button.js";
import { useToast } from "./Toast.js";
import { useStartHuddle } from "../lib/startHuddle.js";
import { failureMessage } from "../platform.js";
import { channelTitle } from "../lib/format.js";
import { ringContent } from "../lib/notificationPreview.js";
import { startRingTone } from "../lib/ringTone.js";
import { focusedElsewhere, inOneWindow } from "../lib/focusedView.js";

/**
 * A direct message's huddle ringing this account (E10), or someone asking it
 * into a channel's call (K18): who, with Join and Decline, a ring tone, and a
 * system notification while the window is not in front. During Do Not
 * Disturb, outside the hours the account allows notifications, or in a muted
 * conversation, it rings silently: the prompt still shows.
 */
export function IncomingCall(props: {
  /** Opens the conversation, as answering goes to the call. */
  onOpen: (channelId: ID) => void;
  /** How much a notification may say on this device (IMP-03). */
  preview: NotificationPreview;
  /** Tags this account's notifications, so its windows show one between them. */
  tag: string | null;
}) {
  const platform = usePlatform();
  const rings = useWorkspace((s) => s.rings);
  const selfId = useWorkspace((s) => s.self?.id);
  const blocked = useWorkspace((s) => s.blocked);
  const dndUntil = useWorkspace((s) => s.self?.dndUntil ?? null);
  const schedule = useWorkspace((s) => s.notifySchedule);
  const timeZone = useWorkspace((s) => s.self?.timeZone);
  const prefs = useWorkspace((s) => s.prefs);
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const ringingMe = useMemo(
    () =>
      Object.values(rings ?? {}).filter(
        (ring) =>
          !!selfId &&
          ring.ringing.includes(selfId) &&
          // Someone this account blocked never rings it (E12).
          !blocked.includes(callerOf(ring, selfId)),
      ),
    [rings, selfId, blocked],
  );
  const snoozed = isSnoozed(dndUntil) || !scheduleAllows(schedule, timeZone, Date.now());
  const loud = ringingMe.filter((ring) => !snoozed && !prefs[ring.channelId]?.muted);
  const ringing = loud.length > 0;

  // One window rings, however many of this account's are open (lib/focusedView).
  const account = props.tag;
  useEffect(() => {
    if (!ringing) return;
    return inOneWindow(account, "ring", startRingTone);
  }, [ringing, account]);

  // Each ring once, while the window is behind something else.
  const told = useRef(new Set<string>());
  const open = useRef(props.onOpen);
  open.current = props.onOpen;
  useEffect(() => {
    for (const ring of loud) {
      const key = `${ring.channelId} ${ring.startedAt}`;
      // In front, here or in another window of this account, the card says it.
      if (told.current.has(key) || document.hasFocus() || focusedElsewhere(props.tag)) continue;
      told.current.add(key);
      const channel = channels[ring.channelId];
      const from = users[callerOf(ring, selfId)]?.displayName ?? "Someone";
      // Asked into a channel's call (K18), worded here rather than with the first screen.
      const { title, body } =
        ring.askedBy && props.preview !== "none"
          ? {
              title: `${from} is asking you to join the call in #${channel?.name}`,
              body: "Open OwnBase to join or decline.",
            }
          : ringContent(props.preview, {
              from,
              group:
                channel?.type === "group_dm" ? channelTitle(channel, users, selfId) : undefined,
            });
      platform.notify(title, body, () => open.current(ring.channelId), {
        tag: `${props.tag ?? ""} ring ${ring.channelId}`,
      });
    }
  });

  if (ringingMe.length === 0) return null;
  // On the body and outside the modal layer's reach (Modal.tsx), so a call can
  // be answered from inside settings or any other dialog, by mouse or by Tab.
  return createPortal(
    <div
      data-ownbase-call=""
      className="pointer-events-none fixed inset-x-0 top-14 z-[66] flex flex-col items-center gap-2 px-3"
    >
      {ringingMe.map((ring) => (
        <RingCard key={ring.channelId} ring={ring} onOpen={props.onOpen} />
      ))}
    </div>,
    document.body,
  );
}

/** Who rang: in a channel's call, whoever asked this account (K18). */
const callerOf = (ring: HuddleRing, selfId: ID | undefined) =>
  ring.askedBy?.[selfId ?? ""] ?? ring.callerId;

function RingCard({ ring, onOpen }: { ring: HuddleRing; onOpen: (channelId: ID) => void }) {
  const client = useClient();
  const toast = useToast();
  const caller = useWorkspace((s) => s.users[callerOf(ring, s.self?.id)]);
  const room = useWorkspace((s) => (ring.askedBy ? s.channels[ring.channelId]?.name : null));
  const group = useWorkspace((s) => {
    const channel = s.channels[ring.channelId];
    return channel?.type === "group_dm" ? channelTitle(channel, s.users, s.self?.id) : null;
  });
  const huddle = useStartHuddle();
  const titleId = useId();
  const name = caller?.displayName ?? "Someone";

  async function join() {
    if (huddle.starting) return;
    const failed = await huddle.start(ring.channelId, {
      // Answered on purpose: a ring that runs out meanwhile does not take it back.
      stillWanted: () => true,
      onAgreed: () => onOpen(ring.channelId),
    });
    if (!failed) return;
    const why = failureMessage(failed.error, "");
    toast({
      message: why
        ? `Could not join the huddle: ${why}`
        : "Could not join the huddle. Check your connection and try again.",
      kind: "error",
    });
  }

  return (
    <section
      aria-labelledby={titleId}
      className="pointer-events-auto flex w-full max-w-[32rem] animate-pop-in flex-wrap items-center gap-3 rounded-2xl border border-edge bg-raised p-3 shadow-lg"
    >
      <span className="relative flex shrink-0">
        <span
          aria-hidden="true"
          className="absolute -inset-1 rounded-full border-2 border-online/60 motion-safe:animate-ping"
        />
        <Avatar user={caller} size={44} />
      </span>
      {/* Room for the name; on a phone the buttons take a row of their own. */}
      <div className="min-w-0 flex-1 basis-40">
        {room != null ? (
          // The whole sentence, over two lines on a phone rather than cut short.
          <p id={titleId} role="alert" className="line-clamp-2 text-[15px] font-semibold">
            {name} is asking you to join the call in #{room}
          </p>
        ) : (
          <>
            <p id={titleId} role="alert" className="truncate text-[15px] font-semibold">
              {name} is calling
            </p>
            <p className="truncate text-[13px] text-ink-dim">
              {group ? `Huddle with ${group}` : "Huddle with you"}
            </p>
          </>
        )}
      </div>
      <div className="flex shrink-0 gap-2 max-sm:w-full">
        <button
          type="button"
          onClick={() => client.declineRing(ring.channelId)}
          className={buttonClass("danger", "px-3 max-sm:flex-1")}
        >
          <Icon name="phoneOff" size={16} />
          Decline
        </button>
        <button
          type="button"
          onClick={() => void join()}
          aria-disabled={huddle.starting || undefined}
          className={buttonClass("primary", "px-3 aria-disabled:opacity-60 max-sm:flex-1")}
        >
          <Icon name="headphones" size={16} />
          {huddle.starting ? "Joining…" : "Join"}
        </button>
      </div>
    </section>
  );
}
