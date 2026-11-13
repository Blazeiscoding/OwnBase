import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  blockedPartner,
  isUnread,
  notificationBody,
  selfMay,
} from "@ownbase/client-core";
import type { Channel, ID, Message } from "@ownbase/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle, formatFull } from "../lib/format.js";
import { usePanelFocus } from "../lib/usePanelFocus.js";
import { AvatarWithPresence } from "./Avatar.js";
import { Badge } from "./Badge.js";
import { Icon } from "./Icon.js";
import { ListStatus } from "./ListStatus.js";
import { Tooltip } from "./Tooltip.js";
import { When } from "./When.js";

/**
 * Your direct messages, newest first, as a side panel: what the phone's bottom
 * bar opens under DMs, so a conversation with someone is two taps away without
 * the drawer. The list is the sidebar's own (the conversations this account is
 * in, from the workspace's live state), so it keeps itself current and needs
 * no loading of its own once the workspace has arrived. Under each name, as
 * Slack's list does, the last thing said there and when, read from the server
 * in one request and again whenever one of these conversations changes.
 */
export function DirectMessagesPanel(props: {
  activeChannelId: ID | null;
  onClose: () => void;
  onOpen: (channelId: ID) => void;
  onNewMessage: () => void;
  onFriends: () => void;
}) {
  const client = useClient();
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
  const blocked = useWorkspace((s) => s.blocked);
  const friendRequests = useWorkspace(
    (s) => s.friends.filter((f) => f.status === "incoming").length,
  );
  // A guest has the public channels only.
  const messaging = useWorkspace((s) => selfMay(s, "latestDirectMessages"));
  const { panel, heading } = usePanelFocus({ takeFocus: true });
  const latest = useLatestDirectMessages(status === "online" && messaging);

  const dms = useMemo(() => {
    const list: Channel[] = [];
    for (const channel of Object.values(channels))
      if (
        !channel.archived &&
        (channel.type === "dm" || channel.type === "group_dm") &&
        channel.id in memberships &&
        // One with someone this account blocked is not listed (E12).
        !blockedPartner(channel, self?.id, blocked)
      )
        list.push(channel);
    return list.sort((a, b) => (channelLastSeq[b.id] ?? 0) - (channelLastSeq[a.id] ?? 0));
  }, [channels, memberships, channelLastSeq, self?.id, blocked]);

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
        {messaging && (
          <>
            <Tooltip label="Friends">
              <button
                type="button"
                onClick={props.onFriends}
                aria-label={friendRequests > 0 ? `Friends, ${friendRequests} new` : "Friends"}
                className="relative flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
              >
                <Icon name="friends" size={17} />
                <Badge
                  count={friendRequests}
                  dot
                  className="absolute right-1 top-1 ring-2 ring-ground"
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
              : !messaging
                ? "Direct messages are for members. As a guest, you can use the public channels."
                : "No direct messages yet. Start one with anyone in this workspace."
          }
          emptyAction={!messaging ? undefined : { label: "New message", run: props.onNewMessage }}
        />
        <ul className="space-y-px">
          {dms.map((channel) => {
            const others = (channel.memberIds ?? []).filter((id) => id !== self?.id);
            const first = users[others[0] ?? ""];
            const online = others.some((id) => presence[id] === "online");
            const away = !online && others.some((id) => presence[id] === "away");
            const title = channelTitle(channel, users, self?.id);
            const active = channel.id === props.activeChannelId;
            const muted = prefs[channel.id]?.muted ?? false;
            const mentions = mentionCounts[channel.id] ?? 0;
            const unread = !active && isUnread({ channelLastSeq, memberships }, channel.id);
            const last = latest[channel.id];
            // Who said it, where the conversation's name does not already:
            // you, or one of a group.
            const lastBy = !last
              ? null
              : last.userId === self?.id
                ? "You"
                : others.length > 1
                  ? (users[last.userId]?.displayName.split(" ")[0] ?? null)
                  : null;
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
                    away={away}
                    size={32}
                    ring="var(--color-ground)"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate">{title}</span>
                      {last && (
                        <time
                          dateTime={new Date(last.createdAt).toISOString()}
                          title={formatFull(last.createdAt)}
                          className="shrink-0 text-[12px] font-normal text-ink-faint"
                        >
                          <When at={last.createdAt} />
                        </time>
                      )}
                    </span>
                    {last && (
                      <span
                        className={`block truncate text-[13px] font-normal ${
                          unread && !muted ? "text-ink-dim" : "text-ink-faint"
                        }`}
                      >
                        {lastBy && `${lastBy}: `}
                        {notificationBody(client.state, last)}
                      </span>
                    )}
                  </span>
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
                  {/* Always drawn, so one that comes while the list is open pops in. */}
                  <Badge
                    count={mentions}
                    label={`${mentions} unread ${mentions === 1 ? "mention" : "mentions"}`}
                  />
                  <Badge
                    dot
                    tone="quiet"
                    count={mentions === 0 && unread && !muted}
                    label="Unread"
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}

/** How long a burst of changes waits before the list is read again. */
const LATEST_DELAY_MS = 250;

/**
 * The newest message in each direct conversation, by conversation, read
 * while `active` and again (once a burst settles) whenever one of them gets a
 * message or has one edited or deleted. What was read stays on show while the
 * next read is out.
 */
function useLatestDirectMessages(active: boolean): Record<ID, Message> {
  const client = useClient();
  const [latest, setLatest] = useState<Record<ID, Message>>({});
  const read = useRef(false);
  const signature = useWorkspace((s) =>
    Object.values(s.channels)
      .filter((c) => (c.type === "dm" || c.type === "group_dm") && c.id in s.memberships)
      .map((c) => `${c.id}:${s.channelLastSeq[c.id] ?? 0}:${s.changedContent[c.id] ?? 0}`)
      .sort()
      .join(","),
  );
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        void client.latestDirectMessages(controller.signal).then((answer) => {
          if (answer instanceof ApiError) return;
          read.current = true;
          setLatest(Object.fromEntries(answer.messages.map((m) => [m.channelId, m])));
        });
      },
      read.current ? LATEST_DELAY_MS : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, active, signature]);
  return latest;
}
