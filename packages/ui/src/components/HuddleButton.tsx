import { useEffect, useRef, useState } from "react";
import type { ID } from "@ownbase/protocol";
import { useClient, useWorkspace } from "../context.js";
import { Avatar } from "./Avatar.js";
import { Icon } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";
import { useCallPreferences } from "../lib/callPreferences.js";
import { huddleNames } from "../lib/huddleView.js";
import { namesList } from "../lib/catchUp.js";
import { channelTitle } from "../lib/format.js";
import { useOptionalToast } from "./Toast.js";
import { useOptionalConfirm } from "./Confirm.js";
import type { WorkspaceClient } from "@ownbase/client-core";

/**
 * Joining a huddle leaves the one you are in. Asked first, so a press on
 * another channel's Join does not end a call, or a screen being shared.
 * True to go ahead.
 */
export async function confirmHuddleSwitch(
  client: WorkspaceClient,
  confirm: ReturnType<typeof useOptionalConfirm>,
  channelId: ID,
): Promise<boolean> {
  const current = client.state.huddle;
  if (!current || current.channelId === channelId || !confirm) return true;
  const state = client.state;
  const channel = state.channels[current.channelId];
  const where = !channel
    ? "the other conversation"
    : channel.type === "public" || channel.type === "private"
      ? `#${channel.name}`
      : channelTitle(channel, state.users, state.self?.id);
  return confirm({
    title: "Switch huddles?",
    body: current.sharingScreen
      ? `You leave the huddle in ${where}, and stop sharing your screen there.`
      : `You leave the huddle in ${where} and join this one.`,
    confirmLabel: "Switch",
  });
}

/** How many faces the button shows before it counts the rest. */
const FACES = 3;

/** Header control: start a huddle, join the running one, or show you're in it. */
export function HuddleButton({ channelId }: { channelId: ID }) {
  const client = useClient();
  const participants = useWorkspace((s) => s.huddles[channelId]);
  const inThis = useWorkspace((s) => s.huddle?.channelId === channelId);
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const calls = useCallPreferences();
  const confirm = useOptionalConfirm();
  const toast = useOptionalToast();
  const currentRoom = useRef({ client, channelId });
  currentRoom.current = { client, channelId };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const inside = participants ?? [];
  const count = inside.length;

  async function join() {
    setError(null);
    if (!(await confirmHuddleSwitch(client, confirm, channelId))) return;
    setJoining(true);
    try {
      await calls.joinHuddle(
        client,
        channelId,
        () =>
          mounted.current &&
          currentRoom.current.client === client &&
          currentRoom.current.channelId === channelId,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not join this huddle.";
      // A notice stays until read; the button had room for a few words for four seconds.
      if (toast) toast({ message, kind: "error" });
      else if (mounted.current) {
        setError(message);
        setTimeout(() => {
          if (mounted.current) setError(null);
        }, 4000);
      }
    } finally {
      if (mounted.current) setJoining(false);
    }
  }

  if (inThis) {
    return (
      <span className="mr-1 flex h-8 items-center gap-1.5 rounded-full bg-online/12 px-3 text-[13px] font-medium text-online">
        {/* Still: an animation that never ends has the page drawn sixty times a
            second for as long as the call lasts, every video and effect on it again. */}
        <span className="size-1.5 rounded-full bg-online" />
        <span className="header-secondary">In huddle</span>
      </span>
    );
  }

  // Who is in it, so nobody has to join to find out.
  const label =
    count > 0
      ? `Join the huddle with ${namesList(huddleNames(inside, users, selfId))}`
      : "Start a huddle";
  return (
    <Tooltip label={label}>
      <button
        onClick={join}
        disabled={joining}
        aria-label={label}
        className={`mr-1 flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors ${
          error
            ? "border-alert/40 text-alert"
            : count > 0
              ? "border-online/30 bg-online/12 text-online hover:bg-online/20"
              : "border-edge text-ink-dim hover:bg-ink/[0.05] hover:text-ink"
        }`}
      >
        {error ? (
          <span role="alert">{error}</span>
        ) : joining ? (
          "Joining…"
        ) : (
          <>
            <Icon name="headphones" size={16} />
            <span className="header-secondary">{count > 0 ? "Join" : "Huddle"}</span>
            {count > 0 && (
              <span className="flex items-center" aria-hidden="true">
                {inside.slice(0, FACES).map((id) => (
                  <span key={id} className="-ml-1 flex rounded-full ring-2 ring-ground first:ml-0">
                    <Avatar user={users[id]} size={18} />
                  </span>
                ))}
                {count > FACES && (
                  <span className="tabular ml-1 text-[12px]">+{count - FACES}</span>
                )}
              </span>
            )}
          </>
        )}
      </button>
    </Tooltip>
  );
}
