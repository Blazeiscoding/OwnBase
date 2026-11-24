import type { ID, User } from "@ownbase/protocol";
import { useWorkspace } from "../context.js";
import { theirTime, useMinute } from "../lib/localTime.js";
import { AvatarWithPresence } from "./Avatar.js";

/** The one other person in a direct message, or undefined in any other conversation. */
function usePartner(channelId: ID): User | undefined {
  return useWorkspace((s) => {
    const channel = s.channels[channelId];
    if (channel?.type !== "dm") return undefined;
    const others = (channel.memberIds ?? []).filter((id) => id !== s.self?.id);
    return others.length === 1 ? s.users[others[0]!] : undefined;
  });
}

const PRESENCE_WORDS = { online: "Active", away: "Away", gone: "Offline" } as const;

/**
 * In a direct message with one other person, their face with whether they are
 * here, before the conversation's name, as Slack's header shows it. The word
 * is said too, since the dot alone is colour and shape.
 */
export function PartnerFace({ channelId }: { channelId: ID }) {
  const partner = usePartner(channelId);
  const presence = useWorkspace((s) => (partner ? s.presence[partner.id] : undefined));
  if (!partner) return null;
  const state = presence === "online" ? "online" : presence === "away" ? "away" : "gone";
  return (
    <span role="img" aria-label={PRESENCE_WORDS[state]} className="inline-flex shrink-0">
      <AvatarWithPresence
        user={partner}
        online={state === "online"}
        away={state === "away"}
        size={22}
        ring="var(--color-ground)"
      />
    </span>
  );
}

/** Their status after the name, the whole of it in the title when it is cut short. */
export function PartnerStatus({ channelId }: { channelId: ID }) {
  const partner = usePartner(channelId);
  const status = partner ? `${partner.statusEmoji ?? ""} ${partner.statusText ?? ""}`.trim() : "";
  if (!status) return null;
  return (
    <>
      <span aria-hidden="true" className="channel-topic h-5 w-px shrink-0 bg-edge" />
      <p
        dir="auto"
        title={status}
        className="channel-topic min-w-0 truncate text-[13px] text-ink-faint"
      >
        {status}
      </p>
    </>
  );
}

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
