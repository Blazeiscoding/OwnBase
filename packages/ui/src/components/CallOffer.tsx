import { useEffect, useRef } from "react";
import type { ID } from "@ownbase/protocol";
import { useClient, useWorkspace } from "../context.js";
import { useToast } from "./Toast.js";
import { useStartHuddle } from "../lib/startHuddle.js";
import { conversationName } from "../lib/format.js";
import { huddleNames } from "../lib/huddleView.js";
import { namesList } from "../lib/catchUp.js";
import { failureMessage } from "../platform.js";

/**
 * What a link to a conversation's call offers (K18), once the workspace has
 * said who is in it: a notice naming them, with Join, or saying nobody is,
 * with Start a huddle. It never joins by itself. Nothing is offered for a
 * conversation this account cannot see, or a call it is already in.
 */
export function CallOffer({ offer }: { offer: { channelId: ID } }) {
  const client = useClient();
  const toast = useToast();
  const huddle = useStartHuddle();
  const online = useWorkspace((s) => s.status === "online");
  const { start } = huddle;
  const offered = useRef<{ channelId: ID } | null>(null);

  // Once for each link, as the workspace comes online.
  useEffect(() => {
    if (!online || offered.current === offer) return;
    offered.current = offer;
    const { channelId } = offer;
    const s = client.state;
    const channel = s.channels[channelId];
    if (!channel || s.huddle?.channelId === channelId) return;
    const where = conversationName(channel, s.users, s.self?.id);
    const inside = s.huddles[channelId] ?? [];
    const join = async () => {
      // Pressed on purpose: still wanted after anything else on screen changed.
      const failed = await start(channelId, { stillWanted: () => true });
      if (failed)
        toast({
          message: failureMessage(failed.error, "Could not join the huddle."),
          kind: "error",
        });
    };
    toast(
      inside.length > 0
        ? {
            message: `${namesList(huddleNames(inside, s.users, s.self?.id))} ${
              inside.length === 1 ? "is" : "are"
            } in the call in ${where}.`,
            kind: "info",
            action: { label: "Join", run: join },
          }
        : {
            message: `Nobody is in the call in ${where} right now.`,
            kind: "info",
            action: { label: "Start a huddle", run: join },
          },
    );
  }, [offer, online, client, start, toast]);
  return null;
}
