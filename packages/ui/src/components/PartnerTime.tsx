import type { ID } from "@ownbase/protocol";
import { useWorkspace } from "../context.js";
import { theirTime, useMinute } from "../lib/localTime.js";

/**
 * In a direct message with one other person, their time now, beside the
 * conversation's name, when their clock reads otherwise than yours (E9).
 */
export function PartnerTime({ channelId }: { channelId: ID }) {
  const self = useWorkspace((s) => s.self);
  const partner = useWorkspace((s) => {
    const others = (s.channels[channelId]?.memberIds ?? []).filter((id) => id !== s.self?.id);
    return others.length === 1 ? s.users[others[0]!] : undefined;
  });
  const now = useMinute();
  const local = theirTime(partner, self, now);
  if (!partner || !local?.differs) return null;
  return (
    <>
      <span aria-hidden="true" className="channel-topic h-5 w-px shrink-0 bg-edge" />
      <p className="channel-topic min-w-0 truncate text-[13px] text-ink-faint">
        {local.time} for {partner.displayName}
      </p>
    </>
  );
}
