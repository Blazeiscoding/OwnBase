import { useEffect, useState, type RefObject } from "react";
import { notificationBody } from "@ownbase/client-core";
import type { ID, ReactionActivity, User } from "@ownbase/protocol";
import { useClient, useWorkspace } from "../context.js";
import { formatFull } from "../lib/format.js";
import { useOpenList } from "../lib/pagedList.js";
import { Avatar } from "./Avatar.js";
import { CustomEmojiImage, customEmojiFor, useCustomEmoji } from "./CustomEmoji.js";
import { ListStatus } from "./ListStatus.js";
import { LoadMore } from "./LoadMore.js";
import { When } from "./When.js";

/**
 * Who reacted, as an entry says it: one name, two, or the newest and how
 * many others.
 */
export function reactorsText(
  entry: Pick<ReactionActivity, "userIds" | "count">,
  users: Record<ID, User>,
): string {
  const names = entry.userIds.map((id) => users[id]?.displayName ?? "Someone");
  const first = names[0] ?? "Someone";
  if (entry.count <= 1) return first;
  if (entry.count === 2 && names[1]) return `${first} and ${names[1]}`;
  const others = entry.count - 1;
  return `${first} and ${others} ${others === 1 ? "other" : "others"}`;
}

/**
 * Activity's Reactions (K13): other people's reactions to this account's
 * messages, one entry per message and emoji, newest first. Opening it sees
 * them, on every device; what was new when it opened keeps its dot while it
 * stays open, so one can tell which they are.
 */
export function ReactionsList({
  onJump,
  scroller,
}: {
  onJump: (channelId: ID, messageId: ID) => void;
  scroller: RefObject<HTMLDivElement | null>;
}) {
  const client = useClient();
  const users = useWorkspace((s) => s.users);
  const seenAt = useWorkspace((s) => s.reactionActivity.seenAt);
  const custom = useCustomEmoji();
  const [list, paged] = useOpenList(() => client.lists.reactionActivity(), "reactions");
  const { items } = paged;
  // Taken as the first page comes, which brings the server's mark with it.
  const [newSince, setNewSince] = useState<number | null>(null);
  if (items && newSince === null) setNewSince(seenAt);

  const newest = items?.[0]?.at ?? 0;
  useEffect(() => {
    // A failure leaves them new, to be seen next time; nothing to tell.
    if (newest > seenAt) void client.seeReactions(newest);
  }, [client, newest, seenAt]);

  return (
    <>
      <ListStatus
        loading={paged.loading}
        placeholder={!items}
        loadingLabel="Loading reactions…"
        error={
          paged.failed ? "Could not load reactions. Check your connection and try again." : null
        }
        onRetry={() => list.retry()}
        empty={
          items && !items.length && !paged.nextCursor ? "No reactions to your messages yet." : null
        }
        emptyIcon="smile"
      />
      <ul>
        {(items ?? []).map((entry) => {
          const fresh = newSince !== null && entry.at > newSince;
          const known = customEmojiFor(custom, entry.emoji);
          return (
            <li key={entry.id} className="relative">
              {fresh && (
                <span
                  aria-hidden="true"
                  className="fc-fill absolute left-0.5 top-4 size-1.5 rounded-full bg-copper"
                />
              )}
              <button
                type="button"
                data-activity-row=""
                onClick={() => onJump(entry.message.channelId, entry.message.id)}
                className="flex w-full items-start gap-2.5 rounded-lg py-1.5 pl-3 pr-2 text-left transition-colors hover:bg-ink/[0.035] focus-visible:bg-ink/[0.035]"
              >
                <Avatar user={users[entry.userIds[0] ?? ""]} size={24} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5 text-[13px]">
                    <span className="min-w-0 truncate">
                      <span className="font-semibold">{reactorsText(entry, users)}</span> reacted{" "}
                      {known ? <CustomEmojiImage emoji={known} /> : entry.emoji} to:
                    </span>
                    {fresh && <span className="sr-only">, new</span>}
                    <time
                      dateTime={new Date(entry.at).toISOString()}
                      title={formatFull(entry.at)}
                      className="ml-auto shrink-0 text-[12px] text-ink-faint"
                    >
                      <When at={entry.at} />
                    </time>
                  </span>
                  <span className="block truncate text-[13px] text-ink-dim">
                    {notificationBody(client.state, entry.message)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <LoadMore
        more={!!paged.nextCursor}
        loading={paged.loadingMore}
        failed={paged.moreFailed}
        count={items?.length ?? 0}
        onMore={() => list.loadMore()}
        scroller={scroller}
      />
    </>
  );
}
