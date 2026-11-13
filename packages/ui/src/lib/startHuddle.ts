import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceClient } from "@ownbase/client-core";
import type { ID } from "@ownbase/protocol";
import { useClient } from "../context.js";
import { useConfirm } from "../components/Confirm.js";
import { useCallPreferences } from "./callPreferences.js";
import { conversationName } from "./format.js";

/**
 * Joining a huddle leaves the one you are in. Asked first, so a press on
 * another channel's Join does not end a call, or a screen being shared.
 * True to go ahead.
 */
export async function confirmHuddleSwitch(
  client: WorkspaceClient,
  confirm: ReturnType<typeof useConfirm>,
  channelId: ID,
): Promise<boolean> {
  const current = client.state.huddle;
  if (!current || current.channelId === channelId) return true;
  const state = client.state;
  const channel = state.channels[current.channelId];
  const where = channel
    ? conversationName(channel, state.users, state.self?.id)
    : "the other conversation";
  return confirm({
    title: "Switch huddles?",
    body: current.sharingScreen
      ? `You leave the huddle in ${where}, and stop sharing your screen there.`
      : `You leave the huddle in ${where} and join this one.`,
    confirmLabel: "Switch",
  });
}

export interface StartHuddleOptions {
  /**
   * Read again after each wait, the device check included: false drops the
   * join. By default, while the part that asked is still on screen.
   */
  stillWanted?: () => boolean;
  /** Once the person has agreed to leave any other huddle, before joining. */
  onAgreed?: () => void;
}

/**
 * Joins a conversation's huddle, starting one if none is going, for every
 * control that does: asks first when that leaves a huddle elsewhere, joins
 * with the call preferences, and gives back what went wrong, or null when it
 * joined, was declined or is no longer wanted. `starting` is true from the
 * agreement until the join settles.
 */
export function useStartHuddle(): {
  start: (channelId: ID, options?: StartHuddleOptions) => Promise<{ error: unknown } | null>;
  starting: boolean;
  /** Whether the part that asked is still on screen. */
  shown: () => boolean;
} {
  const client = useClient();
  const confirm = useConfirm();
  const calls = useCallPreferences();
  const [starting, setStarting] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const shown = useCallback(() => mounted.current, []);
  const start = useCallback(
    async (channelId: ID, options: StartHuddleOptions = {}) => {
      if (!(await confirmHuddleSwitch(client, confirm, channelId))) return null;
      setStarting(true);
      options.onAgreed?.();
      try {
        await calls.joinHuddle(client, channelId, options.stillWanted ?? shown);
        return null;
      } catch (error) {
        return { error };
      } finally {
        setStarting(false);
      }
    },
    [client, confirm, calls, shown],
  );
  return { start, starting, shown };
}
