import {
  isRoom,
  type Channel,
  type CustomEmoji,
  type ID,
  type User,
  type UserGroup,
} from "@ownbase/protocol";
import type { Platform } from "../platform.js";
import { usePlatform, useWorkspace } from "../context.js";
import { Avatar } from "./Avatar.js";
import { CustomEmojiImage } from "./CustomEmoji.js";
import { Icon } from "./Icon.js";
import { useEmoji, type EmojiKit } from "../lib/emoji.js";
import { matchTier } from "../lib/switcherRank.js";
import { groupSize } from "../lib/userGroups.js";
import type { Suggestion, SuggestionKind, Suggestions } from "./Suggestions.js";

/**
 * The ranking and the open list behind `useSuggestions`. They only matter
 * while a word is being typed after `@`, `#` or `:`, so they stay out of the
 * first download and arrive as the workspace opens.
 */

const BROADCASTS = [
  { token: "channel" as const, description: "Everyone in this channel" },
  { token: "here" as const, description: "Everyone who is around now" },
];

/** How many a list shows: enough to choose among, few enough to read at a glance. */
const SHOWN = 6;

/** The best of a name's tiers for a query, or -1 when none matches (`matchTier`). */
function bestTier(query: string, ...names: string[]): number {
  const tiers = names.map((n) => matchTier(n.normalize("NFC"), query)).filter((t) => t >= 0);
  return tiers.length ? Math.min(...tiers) : -1;
}

/**
 * People for `@query`: the room first when its word is typed, then whoever
 * matches best, as Ctrl+K ranks names ("sa" finds Sam before Lisa), yourself
 * after others who match as well.
 */
export function rankPeople(users: readonly User[], query: string, selfId: ID | undefined) {
  const q = query.toLowerCase().normalize("NFC");
  return users
    .filter((u) => !u.deactivated)
    .map((user) => ({ user, tier: bestTier(q, user.displayName, user.handle) }))
    .filter((r) => r.tier >= 0)
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        Number(a.user.id === selfId) - Number(b.user.id === selfId) ||
        a.user.displayName.localeCompare(b.user.displayName),
    )
    .map((r) => r.user);
}

/** User groups for `@query` (J13), by how well the handle or name matches, then by handle. */
export function rankGroups(groups: readonly UserGroup[], query: string): UserGroup[] {
  const q = query.toLowerCase().normalize("NFC");
  return groups
    .map((group) => ({ group, tier: bestTier(q, group.handle, group.name) }))
    .filter((r) => r.tier >= 0)
    .sort((a, b) => a.tier - b.tier || a.group.handle.localeCompare(b.group.handle))
    .map((r) => r.group);
}

/**
 * People and groups for `@query` in one list: people whose name or handle is
 * exactly what was typed first, then groups, then the other people who match.
 * A group sits below the person it could be mistaken for, so naming one person
 * never reaches a whole team by a slip.
 */
export function mentionChoices(
  users: readonly User[],
  groups: readonly UserGroup[],
  query: string,
  selfId: ID | undefined,
): Suggestion[] {
  const q = query.toLowerCase().normalize("NFC");
  const people = rankPeople(users, query, selfId);
  const exact = (user: User) =>
    !!q &&
    (user.handle.toLowerCase() === q || user.displayName.toLowerCase().normalize("NFC") === q);
  return [
    ...people.filter(exact).map((user): Suggestion => ({ kind: "user", user })),
    ...rankGroups(groups, query).map((group): Suggestion => ({ kind: "group", group })),
    ...people.filter((user) => !exact(user)).map((user): Suggestion => ({ kind: "user", user })),
  ];
}

/** Channels for `#query`: named ones still open, best match first, then those you are in. */
export function rankChannels(
  channels: readonly Channel[],
  query: string,
  joined: (id: ID) => boolean,
) {
  const q = query.toLowerCase().normalize("NFC");
  return channels
    .filter((c) => isRoom(c.type) && !c.archived)
    .map((channel) => ({ channel, tier: bestTier(q, channel.name) }))
    .filter((r) => r.tier >= 0)
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        Number(joined(b.channel.id)) - Number(joined(a.channel.id)) ||
        a.channel.name.localeCompare(b.channel.name),
    )
    .map((r) => r.channel);
}

/**
 * The workspace's own emoji for `:query` (J12): those whose name, or a word
 * of it after a dash or underscore, starts with what was typed, by name.
 */
export function customStartingWith(
  custom: Record<string, CustomEmoji>,
  query: string,
): CustomEmoji[] {
  const q = query.toLowerCase();
  const whole = (emoji: CustomEmoji) => emoji.name.startsWith(q);
  return Object.values(custom)
    .filter((emoji) => whole(emoji) || emoji.name.split(/[-_]/).some((word) => word.startsWith(q)))
    .sort((a, b) => Number(whole(b)) - Number(whole(a)) || a.name.localeCompare(b.name));
}

/** What the box knows of the workspace, to rank what a word could be. */
export interface ChoiceSources {
  users: Record<ID, User>;
  groups: Record<ID, UserGroup> | null;
  channels: Record<ID, Channel>;
  memberships: Record<ID, unknown>;
  selfId: ID | undefined;
  custom: Record<string, CustomEmoji>;
  /** Whether the box writes to a channel, where @channel and @here mean something. */
  room: boolean;
  emoji: EmojiKit | null;
  platform: Platform;
}

/** What is offered for `query` of `kind`, best first. */
export function suggestionsFor(
  kind: SuggestionKind,
  query: string,
  from: ChoiceSources,
): Suggestion[] {
  if (kind === "person") {
    const q = query.toLowerCase();
    // A room-wide mention has no meaning in a DM, so it is not offered there.
    const rooms: Suggestion[] = from.room
      ? BROADCASTS.filter((b) => b.token.startsWith(q)).map((b) => ({ kind: "broadcast", ...b }))
      : [];
    const named = mentionChoices(
      Object.values(from.users),
      from.groups ? Object.values(from.groups) : [],
      query,
      from.selfId,
    );
    return [...rooms, ...named].slice(0, SHOWN);
  }
  if (kind === "channel")
    return rankChannels(Object.values(from.channels), query, (id) => id in from.memberships)
      .slice(0, SHOWN)
      .map((channel) => ({ kind: "channel", channel }));
  const own = customStartingWith(from.custom, query).map((e): Suggestion => ({
    kind: "custom",
    emoji: e,
  }));
  const { emoji } = from;
  const standard = emoji
    ? emoji
        .emojiStartingWith(
          query,
          emoji.likedBy(emoji.emojiPreferences(from.platform).getState().used),
        )
        .map((e): Suggestion => ({ kind: "emoji", emoji: e }))
    : [];
  return [...own, ...standard].slice(0, 8);
}

const LABELS: Record<SuggestionKind, string> = {
  person: "Mentions",
  channel: "Channels",
  emoji: "Emoji",
};

/** The open list of suggestions, above the box. */
export function SuggestionChoices({
  suggestions: s,
  className,
}: {
  suggestions: Suggestions;
  className: string;
}) {
  const platform = usePlatform();
  const selfId = useWorkspace((s) => s.self?.id);
  const memberships = useWorkspace((s) => s.memberships);
  const emoji = useEmoji(s.kind === "emoji");
  return (
    <ul
      {...s.list.listProps}
      aria-label={LABELS[s.kind!]}
      className={`surface-float absolute bottom-full z-10 mb-2 origin-bottom-left animate-menu-in overflow-hidden rounded-xl p-1 ${className}`}
    >
      {s.options.map((option, i) => (
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- an option of a combobox: the field keeps focus and takes the keys (aria-activedescendant)
        <li
          key={
            option.kind === "user"
              ? option.user.id
              : option.kind === "group"
                ? `group:${option.group.id}`
                : option.kind === "broadcast"
                  ? option.token
                  : option.kind === "channel"
                    ? option.channel.id
                    : option.kind === "custom"
                      ? `custom:${option.emoji.id}`
                      : option.emoji.id
          }
          {...s.list.optionProps(i)}
          onClick={() => s.choose(option)}
          className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm ${
            i === s.list.active ? "bg-ink/[0.07]" : ""
          }`}
        >
          {option.kind === "user" ? (
            <>
              <Avatar user={option.user} size={22} />
              <span className="font-medium">{option.user.displayName}</span>
              <span className="font-mono text-xs text-ink-faint">@{option.user.handle}</span>
              {option.user.id === selfId && <span className="text-xs text-ink-faint">(you)</span>}
            </>
          ) : option.kind === "group" ? (
            <>
              <span className="flex size-[22px] items-center justify-center rounded-md bg-ink/[0.08] text-ink-dim">
                <Icon name="members" size={14} />
              </span>
              <span className="font-medium">@{option.group.handle}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">
                {option.group.name}, {groupSize(option.group)}
              </span>
            </>
          ) : option.kind === "broadcast" ? (
            <>
              <span className="flex size-[22px] items-center justify-center rounded-md bg-ink/[0.08] text-ink-dim">
                <Icon name="at" size={14} />
              </span>
              <span className="font-medium">@{option.token}</span>
              <span className="text-xs text-ink-faint">{option.description}</span>
            </>
          ) : option.kind === "channel" ? (
            <>
              <span className="flex size-[22px] items-center justify-center rounded-md bg-ink/[0.08] text-ink-dim">
                <Icon name={option.channel.type === "private" ? "lock" : "hash"} size={14} />
              </span>
              <span className="font-medium">{option.channel.name}</span>
              {!(option.channel.id in memberships) && (
                <span className="text-xs text-ink-faint">Not joined</span>
              )}
              {option.channel.topic && (
                <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">
                  {option.channel.topic}
                </span>
              )}
            </>
          ) : option.kind === "custom" ? (
            <>
              <span aria-hidden="true" className="w-[22px] text-center text-lg leading-none">
                <CustomEmojiImage emoji={option.emoji} />
              </span>
              <span className="font-medium">:{option.emoji.name}:</span>
            </>
          ) : (
            <>
              <span
                aria-hidden="true"
                className="font-emoji w-[22px] text-center text-lg leading-none"
              >
                {emoji?.inTone(option.emoji, emoji.emojiPreferences(platform).getState().tone)}
              </span>
              <span className="font-medium">:{option.emoji.id}:</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
