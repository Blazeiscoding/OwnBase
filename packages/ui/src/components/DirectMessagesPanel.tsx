import { useMemo } from "react";
import type { Channel, ID } from "@slackoss/protocol";
import { useWorkspace } from "../context.js";
import { channelTitle } from "../lib/format.js";
import { usePanelFocus } from "../lib/usePanelFocus.js";
import { AvatarWithPresence } from "./Avatar.js";
import { Icon } from "./Icon.js";
import { ListStatus } from "./ListStatus.js";
import { CountBadge } from "./Motion.js";
import { Tooltip } from "./Tooltip.js";

/**
 * Your direct messages, newest first, as a side panel: what the phone's bottom
 * bar opens under DMs, so a conversation with someone is two taps away without
 * the drawer. The list is the sidebar's own (the conversations this account is
 * in, from the workspace's live state), so it keeps itself current and needs
 * no loading of its own once the workspace has arrived.
 */
export function DirectMessagesPanel(props: {
  activeChannelId: ID | null;
  onClose: () => void;
  onOpen: (channelId: ID) => void;
  onNewMessage: () => void;
  onFriends: () => void;
}) {
  const channels = useWorkspace((s) => s.channels);
  const memberships = useWorkspace((s) => s.memberships);
  const channelLastSeq = useWorkspace((s) => s.channelLastSeq);
  const users = useWorkspace((s) => s.users);
  const presence = useWorkspace((s) => s.presence);
  const self = useWorkspace((s) => s.self);
  const status = useWorkspace((s) => s.status);
  const prefs = useWorkspace((s) => s.prefs);
  const drafts = useWorkspace((s) => s.drafts);
  const mentionCounts = useWorkspace((s) => s.mentionCounts);
  const friendRequests = useWorkspace(
    (s) => s.friends.filter((f) => f.status === "incoming").length,
  );
  const guest = self?.role === "guest";
  const { panel, heading } = usePanelFocus({ takeFocus: true });

  const dms = useMemo(() => {
    const list: Channel[] = [];
    for (const channel of Object.values(channels))
      if (
        !channel.archived &&
        (channel.type === "dm" || channel.type === "group_dm") &&
        channel.id in memberships
      )
        list.push(channel);
    return list.sort((a, b) => (channelLastSeq[b.id] ?? 0) - (channelLastSeq[a.id] ?? 0));
  }, [channels, memberships, channelLastSeq]);

  // Nothing has arrived from the workspace yet, so there is nothing to list.
  const arriving = !self && status !== "online";

  return (
    <aside
      ref={panel}
      aria-label="Direct messages"
      className="flex w-[380px] max-w-full shrink-0 flex-col border-l border-edge"
    >
      <header className="flex h-12 shrink-0 items-center gap-1 pl-4 pr-2 shadow-[0_1px_0_var(--color-edge)]">
        <h2 ref={heading} tabIndex={-1} className="flex-1 text-[15px] font-semibold outline-none">
          Direct messages
        </h2>
        {!guest && (
          <>
            <Tooltip label="Friends">
              <button
                type="button"
                onClick={props.onFriends}
                aria-label={friendRequests > 0 ? `Friends, ${friendRequests} new` : "Friends"}
                className="relative flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
              >
                <Icon name="friends" size={17} />
                <CountBadge
                  count={friendRequests}
                  dot
                  aria-hidden="true"
                  className="badge-mention absolute right-1 top-1 size-2 rounded-full ring-2 ring-ground"
                />
              </button>
            </Tooltip>
            <Tooltip label="New message">
              <button
                type="button"
                onClick={props.onNewMessage}
                aria-label="New message"
                className="icon-live flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
              >
                <Icon name="edit" size={16} />
              </button>
            </Tooltip>
          </>
        )}
        <button
          type="button"
          onClick={props.onClose}
          aria-label="Close direct messages"
          className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {status !== "online" && !arriving && (
          <p
            role="status"
            className="mx-1 mb-2 rounded-lg bg-copper/10 px-2.5 py-1.5 text-[12px] text-copper"
          >
            Not connected, so this list may be out of date.
          </p>
        )}
        <ListStatus
          loading={arriving}
          placeholder
          loadingLabel="Loading direct messages…"
          emptyIcon="messages"
          empty={
            arriving || dms.length > 0
              ? null
              : guest
                ? "Direct messages are for members. As a guest you have the public channels."
                : "No direct messages yet. Start one with anyone in this workspace."
          }
          emptyAction={guest ? undefined : { label: "New message", run: props.onNewMessage }}
        />
        <ul className="space-y-px">
          {dms.map((channel) => {
            const others = (channel.memberIds ?? []).filter((id) => id !== self?.id);
            const first = users[others[0] ?? ""];
            const online = others.some((id) => presence[id] === "online");
            const title = channelTitle(channel, users, self?.id);
            const active = channel.id === props.activeChannelId;
            const muted = prefs[channel.id]?.muted ?? false;
            const mentions = mentionCounts[channel.id] ?? 0;
            const unread =
              !active && (channelLastSeq[channel.id] ?? 0) > (memberships[channel.id] ?? 0);
            return (
              <li key={channel.id}>
                <button
                  type="button"
                  onClick={() => props.onOpen(channel.id)}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-12 w-full items-center gap-3 rounded-lg px-2.5 text-left text-[15px] transition-colors ${
                    active
                      ? "channel-row-active text-ink"
                      : unread && !muted
                        ? "font-semibold text-ink hover:bg-ink/[0.05]"
                        : "text-ink-dim hover:bg-ink/[0.05]"
                  }`}
                >
                  <AvatarWithPresence
                    user={first}
                    online={online}
                    size={32}
                    ring="var(--color-ground)"
                  />
                  <span className="min-w-0 flex-1 truncate">{title}</span>
                  {drafts[channel.id] && !active && (
                    <span role="img" aria-label="Draft" title="Draft" className="text-ink-faint">
                      <Icon name="edit" size={13} />
                    </span>
                  )}
                  {muted && (
                    <span role="img" aria-label="Muted" title="Muted" className="text-ink-faint">
                      <Icon name="bellOff" size={13} />
                    </span>
                  )}
                  {mentions > 0 ? (
                    <CountBadge
                      count={mentions}
                      aria-label={`${mentions} unread ${mentions === 1 ? "mention" : "mentions"}`}
                      className="badge-mention tabular min-w-5 shrink-0 rounded-full px-1.5 text-center text-[11px] font-bold leading-[18px]"
                    />
                  ) : (
                    unread &&
                    !muted && (
                      <span
                        role="img"
                        aria-label="Unread"
                        className="size-2 shrink-0 rounded-full bg-ink"
                      />
                    )
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
