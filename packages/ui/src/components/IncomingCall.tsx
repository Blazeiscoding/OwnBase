import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { HuddleRing, ID } from "@slackoss/protocol";
import { useClient, usePlatform, useWorkspace } from "../context.js";
import { Avatar } from "./Avatar.js";
import { Icon } from "./Icon.js";
import { buttonClass } from "./Button.js";
import { useOptionalToast } from "./Toast.js";
import { useCallPreferences } from "../lib/callPreferences.js";
import { channelTitle } from "../lib/format.js";
import { ringContent, type NotificationPreview } from "../lib/notificationPreview.js";
import { startRingTone } from "../lib/ringTone.js";

/**
 * A direct message's huddle ringing this account (E10): who is calling, with
 * Join and Decline, a ring tone, and a system notification while the window
 * is not in front. During Do Not Disturb, or in a muted conversation, it
 * rings silently: the prompt still shows.
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
  const dndUntil = useWorkspace((s) => s.self?.dndUntil ?? null);
  const prefs = useWorkspace((s) => s.prefs);
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const ringingMe = useMemo(
    () => Object.values(rings ?? {}).filter((ring) => !!selfId && ring.ringing.includes(selfId)),
    [rings, selfId],
  );
  const snoozed = dndUntil !== null && dndUntil > Date.now();
  const loud = ringingMe.filter((ring) => !snoozed && !prefs[ring.channelId]?.muted);
  const ringing = loud.length > 0;

  useEffect(() => {
    if (!ringing) return;
    return startRingTone();
  }, [ringing]);

  // Each ring once, while the window is behind something else.
  const told = useRef(new Set<string>());
  const open = useRef(props.onOpen);
  open.current = props.onOpen;
  useEffect(() => {
    for (const ring of loud) {
      const key = `${ring.channelId} ${ring.startedAt}`;
      if (told.current.has(key) || document.hasFocus()) continue;
      told.current.add(key);
      const channel = channels[ring.channelId];
      const { title, body } = ringContent(props.preview, {
        from: users[ring.callerId]?.displayName ?? "Someone",
        group: channel?.type === "group_dm" ? channelTitle(channel, users, selfId) : undefined,
      });
      platform.notify(title, body, () => open.current(ring.channelId), {
        tag: `${props.tag ?? ""} ring ${ring.channelId}`,
      });
    }
  });

  if (ringingMe.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-14 z-[66] flex flex-col items-center gap-2 px-3">
      {ringingMe.map((ring) => (
        <RingCard key={ring.channelId} ring={ring} onOpen={props.onOpen} />
      ))}
    </div>
  );
}

function RingCard({ ring, onOpen }: { ring: HuddleRing; onOpen: (channelId: ID) => void }) {
  const client = useClient();
  const calls = useCallPreferences();
  const toast = useOptionalToast();
  const caller = useWorkspace((s) => s.users[ring.callerId]);
  const group = useWorkspace((s) => {
    const channel = s.channels[ring.channelId];
    return channel?.type === "group_dm" ? channelTitle(channel, s.users, s.self?.id) : null;
  });
  const [joining, setJoining] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const titleId = useId();
  const name = caller?.displayName ?? "Someone";

  async function join() {
    if (joining) return;
    setJoining(true);
    onOpen(ring.channelId);
    try {
      // Answered on purpose: a ring that runs out meanwhile does not take it back.
      await calls.joinHuddle(client, ring.channelId, () => true);
    } catch (err) {
      toast?.({
        message:
          err instanceof Error
            ? `Could not join the huddle: ${err.message}`
            : "Could not join the huddle. Check your connection and try again.",
        kind: "error",
      });
    } finally {
      if (mounted.current) setJoining(false);
    }
  }

  return (
    <section
      aria-labelledby={titleId}
      className="pointer-events-auto flex w-full max-w-[32rem] animate-pop-in items-center gap-3 rounded-2xl border border-edge bg-raised p-3 shadow-lg"
    >
      <span className="relative flex shrink-0">
        <span
          aria-hidden="true"
          className="absolute -inset-1 rounded-full border-2 border-online/60 motion-safe:animate-ping"
        />
        <Avatar user={caller} size={44} />
      </span>
      <div className="min-w-0 flex-1">
        <p id={titleId} role="alert" className="truncate text-[15px] font-semibold">
          {name} is calling
        </p>
        <p className="truncate text-[13px] text-ink-dim">
          {group ? `Huddle with ${group}` : "Huddle with you"}
        </p>
      </div>
      <button
        type="button"
        onClick={() => client.declineRing(ring.channelId)}
        className={buttonClass("danger", "shrink-0 px-3")}
      >
        <Icon name="phoneOff" size={16} />
        Decline
      </button>
      <button
        type="button"
        onClick={() => void join()}
        aria-disabled={joining || undefined}
        className={buttonClass("primary", "shrink-0 px-3 aria-disabled:opacity-60")}
      >
        <Icon name="headphones" size={16} />
        {joining ? "Joining…" : "Join"}
      </button>
    </section>
  );
}
