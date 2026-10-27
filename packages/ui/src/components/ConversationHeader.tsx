import { useEffect, useMemo, useState } from "react";
import type { ID, Message, User } from "@ownbase/protocol";
import { notificationBody, type WorkspaceClient } from "@ownbase/client-core";
import { useClient, useWorkspace } from "../context.js";
import { Avatar } from "./Avatar.js";
import { Icon } from "./Icon.js";
import { Menu, type MenuItem } from "./Menu.js";
import { useOptionalToast } from "./Toast.js";
import { Tooltip } from "./Tooltip.js";
import { starItem } from "../lib/conversationChoices.js";

/**
 * The last answer to each question the header asks, per client, so a
 * conversation opened again shows its people and pins at once, while they are
 * asked for again, instead of the header changing height and width twice.
 */
const answers = new WeakMap<WorkspaceClient, Map<string, unknown>>();
function remembered(client: WorkspaceClient): Map<string, unknown> {
  let known = answers.get(client);
  if (!known) answers.set(client, (known = new Map()));
  return known;
}

/** How many faces the members button shows before its count. */
const FACES = 3;

/**
 * Who is in this conversation, as faces and a count; it opens the member list.
 * A group message knows its people already. A channel's are asked for, and
 * asked again when someone joins or leaves, or the connection comes back.
 */
export function MemberStack(props: { channelId: ID; pressed: boolean; onToggle: () => void }) {
  const client = useClient();
  const known = useWorkspace((s) => s.channels[props.channelId]?.memberIds);
  const moved = useWorkspace((s) => s.memberChanges[props.channelId] ?? 0);
  const online = useWorkspace((s) => s.status === "online");
  const users = useWorkspace((s) => s.users);
  const presence = useWorkspace((s) => s.presence);
  const key = `members:${props.channelId}`;
  const [answer, setAnswer] = useState<{ key: string; ids: ID[] } | null>(null);

  useEffect(() => {
    if (known || !online) return;
    let active = true;
    client.api.channelMembers(props.channelId).then(
      (r) => {
        remembered(client).set(key, r.memberIds);
        if (active) setAnswer({ key, ids: r.memberIds });
      },
      // The list it opens says what went wrong, and offers Retry.
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [client, props.channelId, key, known, moved, online]);

  const ids =
    known ?? (answer?.key === key ? answer.ids : (remembered(client).get(key) as ID[] | undefined));
  const people = useMemo(
    () =>
      (ids ?? [])
        .map((id) => users[id])
        .filter((u): u is User => !!u && !u.deactivated)
        // Faces of people here now first.
        .sort(
          (a, b) =>
            Number(presence[b.id] === "online") - Number(presence[a.id] === "online") ||
            a.displayName.localeCompare(b.displayName),
        ),
    [ids, users, presence],
  );
  const count = people.length;

  return (
    <Tooltip label="Members">
      <button
        onClick={props.onToggle}
        aria-label={ids ? `Members (${count})` : "Members"}
        aria-pressed={props.pressed}
        className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full pl-1.5 pr-2.5 text-[13px] font-medium transition-colors ${
          props.pressed
            ? "bg-ink/[0.07] text-ink"
            : "text-ink-dim hover:bg-ink/[0.05] hover:text-ink"
        }`}
      >
        {count > 0 ? (
          <span aria-hidden="true" className="flex items-center">
            {people.slice(0, FACES).map((user, i) => (
              // A phone shows one face, with the count.
              <span
                key={user.id}
                className={`${i > 0 ? "header-secondary " : ""}-ml-1.5 flex rounded-full ring-2 ring-ground first:ml-0`}
              >
                <Avatar user={user} size={20} />
              </span>
            ))}
          </span>
        ) : (
          <Icon name="members" size={18} />
        )}
        {ids && (
          <span aria-hidden="true" className="tabular">
            {count}
          </span>
        )}
      </button>
    </Tooltip>
  );
}

/**
 * Search in this conversation, drawn as a field in the header. It opens search
 * on this conversation, ready to type in. A phone has room for its icon only.
 */
export function ConversationSearch(props: {
  /** "#design", or the people in a direct message. */
  title: string;
  onSearch: () => void;
}) {
  const label = `Search ${props.title}`;
  return (
    <button
      onClick={props.onSearch}
      aria-label={label}
      className="header-search flex h-8 shrink-0 items-center gap-2 rounded-lg bg-ink/[0.06] px-2.5 text-[13px] text-ink-faint transition-colors hover:bg-ink/[0.09] hover:text-ink-dim"
    >
      <Icon name="search" size={14} className="shrink-0" />
      <span className="header-secondary min-w-0 truncate">{label}</span>
    </button>
  );
}

/** The rest of what a conversation offers, behind `⋯`. */
export function ConversationMenu(props: {
  channelId: ID;
  isRoom: boolean;
  onPins: () => void;
  /** The files shared here, where the server lists shared files (E7). */
  onFiles?: () => void;
  /** Absent for a channel this account only looks into, which has no settings of its own. */
  onNotifications?: () => void;
  onDetails: () => void;
}) {
  const client = useClient();
  const toast = useOptionalToast();
  // A star is kept with a membership, by a server that keeps stars.
  const canStar = useWorkspace((s) => s.stars && props.channelId in s.memberships);
  const starred = useWorkspace((s) => s.prefs[props.channelId]?.starred === true);
  const conversation = {
    id: props.channelId,
    noun: props.isRoom ? ("channel" as const) : ("conversation" as const),
  };
  const items: MenuItem[] = [
    { id: "pins", label: "Pinned messages", icon: "pin", onSelect: props.onPins },
    ...(props.onFiles
      ? [{ id: "files", label: "Files", icon: "file" as const, onSelect: props.onFiles }]
      : []),
    ...(canStar ? [starItem(client, toast, conversation, starred)] : []),
    ...(props.onNotifications
      ? [
          {
            id: "notifications",
            label: "Notification settings",
            icon: "bell" as const,
            onSelect: props.onNotifications,
          },
        ]
      : []),
    {
      id: "details",
      label: props.isRoom ? "Channel details" : "Conversation details",
      icon: "settings",
      onSelect: props.onDetails,
    },
  ];
  return (
    <Menu
      label="Conversation options"
      tooltip="More"
      items={items}
      sheet
      triggerClassName="icon-live flex size-8 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink-dim aria-expanded:text-ink"
      triggerContent={<Icon name="dots" size={18} strokeWidth={2} />}
      triggerLabel="Conversation options"
    />
  );
}

interface Pins {
  /** Null from a server too old to count them: there are some. */
  total: number | null;
  newest: Message | undefined;
}

/**
 * A slim line under the header while a conversation has pins: how many, and
 * the newest one's first words. It opens the Pinned panel, and asks again
 * when a pin, an edit or a deletion changes the conversation.
 */
export function PinnedBar(props: { channelId: ID; open: boolean; onToggle: () => void }) {
  const client = useClient();
  const changed = useWorkspace((s) => s.changedContent[props.channelId] ?? 0);
  const online = useWorkspace((s) => s.status === "online");
  // Names in the preview follow renames.
  useWorkspace((s) => s.users);
  const key = `pins:${props.channelId}`;
  const [answer, setAnswer] = useState<{ key: string; pins: Pins } | null>(null);

  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    client.api.listPins(props.channelId, controller.signal, undefined, 1).then(
      (r) => {
        const pins = { total: r.total ?? (r.messages.length ? null : 0), newest: r.messages[0] };
        remembered(client).set(key, pins);
        if (!controller.signal.aborted) setAnswer({ key, pins });
      },
      // Nothing to show is the quiet answer; the menu still opens the panel.
      () => undefined,
    );
    return () => controller.abort();
  }, [client, props.channelId, key, changed, online]);

  const pins =
    answer?.key === key ? answer.pins : (remembered(client).get(key) as Pins | undefined);
  if (!pins || pins.total === 0) return null;
  const count = pins.total === null ? "Pinned" : `${pins.total} pinned`;
  const preview = pins.newest ? notificationBody(client.state, pins.newest) : "";

  return (
    <button
      onClick={props.onToggle}
      aria-pressed={props.open}
      aria-label={preview ? `${count}: ${preview}` : count}
      className={`pinned-bar flex h-8 w-full shrink-0 items-center gap-2 px-5 text-left text-[13px] shadow-[0_1px_0_var(--color-edge)] transition-colors ${
        props.open ? "text-ink" : "text-ink-dim hover:bg-ink/[0.03] hover:text-ink"
      }`}
    >
      <Icon name="pin" size={14} className="shrink-0 text-ink-faint" />
      <span className="tabular shrink-0 font-medium">{count}</span>
      {preview && <span className="min-w-0 truncate text-ink-faint">{preview}</span>}
    </button>
  );
}
