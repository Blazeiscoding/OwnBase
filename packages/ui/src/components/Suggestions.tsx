import { useMemo, useState } from "react";
import type React from "react";
import { isRoom, type Channel, type ID, type User } from "@ownbase/protocol";
import { usePlatform, useWorkspace } from "../context.js";
import { Avatar } from "./Avatar.js";
import { Icon } from "./Icon.js";
import { useEmoji } from "../lib/emoji.js";
import type { Emoji } from "../lib/emojiSet.js";
import { insideCodeBlock } from "../lib/textInput.js";
import { matchTier } from "../lib/switcherRank.js";
import type { MentionDocument } from "../lib/mentionDocument.js";
import { useListbox } from "../lib/useListbox.js";

/**
 * What a message box offers while a word is being typed: people after `@`,
 * channels after `#`, emoji after `:`. The composer and the message editor
 * both use it, so editing a message finishes names as writing one does.
 */

/** The box's mention field, as `useMentionField` returns it. */
interface Field {
  doc: MentionDocument;
  replaceSelection: (
    insert: string,
    start?: number,
    end?: number,
  ) => { stored: string; caret: number };
  startsMention: (at: number, within?: MentionDocument) => boolean;
}

type Kind = "person" | "channel" | "emoji";
interface Query {
  kind: Kind;
  /** Where the `@`, `#` or `:` is, in the shown text. */
  start: number;
  query: string;
}

export type Suggestion =
  | { kind: "user"; user: User }
  | { kind: "broadcast"; token: "channel" | "here"; description: string }
  | { kind: "channel"; channel: Channel }
  | { kind: "emoji"; emoji: Emoji };

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

/** A word being typed after `@`, `#` or `:`, up to the caret. */
function queryAt(value: string, caret: number, field: Field, shown: MentionDocument): Query | null {
  const upTo = value.slice(0, caret);
  // A mention already made is not one being typed.
  const made = (q: string) => field.startsMention(caret - q.length - 1, shown);
  const at = /(^|\s)@([\p{L}\p{N}\p{M}._-]*)$/u.exec(upTo);
  if (at)
    return made(at[2]!)
      ? null
      : { kind: "person", start: caret - at[2]!.length - 1, query: at[2]! };
  // Not in code, where # and : are code.
  if (insideCodeBlock(value, caret)) return null;
  const hash = /(^|\s)#([\p{L}\p{N}_-]*)$/u.exec(upTo);
  if (hash)
    return made(hash[2]!)
      ? null
      : { kind: "channel", start: caret - hash[2]!.length - 1, query: hash[2]! };
  // Two letters after a colon, as Slack waits for, so a time such as 10:30
  // or a ":)" is left alone.
  const colon = /(^|\s):([\p{L}\p{N}_+-]{2,})$/u.exec(upTo);
  if (colon) return { kind: "emoji", start: caret - colon[2]!.length - 1, query: colon[2]! };
  return null;
}

interface Options {
  field: Field;
  box: React.RefObject<HTMLTextAreaElement | null>;
  /** Puts the chosen text in the box: the stored text and where the caret goes. */
  apply: (stored: string, caret: number) => void;
  /** Whether the box writes to a channel, where @channel and @here mean something. */
  room: boolean;
}

export function useSuggestions({ field, box, apply, room }: Options) {
  const platform = usePlatform();
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const memberships = useWorkspace((s) => s.memberships);
  const selfId = useWorkspace((s) => s.self?.id);
  const [query, setQuery] = useState<Query | null>(null);
  // Every emoji arrives on first use; usually the workspace has fetched it already.
  const emoji = useEmoji(query?.kind === "emoji");

  const options = useMemo((): Suggestion[] => {
    if (!query) return [];
    if (query.kind === "person") {
      const q = query.query.toLowerCase();
      // A room-wide mention has no meaning in a DM, so it is not offered there.
      const rooms: Suggestion[] = room
        ? BROADCASTS.filter((b) => b.token.startsWith(q)).map((b) => ({ kind: "broadcast", ...b }))
        : [];
      const people = rankPeople(Object.values(users), query.query, selfId).map(
        (user): Suggestion => ({ kind: "user", user }),
      );
      return [...rooms, ...people].slice(0, SHOWN);
    }
    if (query.kind === "channel")
      return rankChannels(Object.values(channels), query.query, (id) => id in memberships)
        .slice(0, SHOWN)
        .map((channel) => ({ kind: "channel", channel }));
    if (!emoji) return [];
    return emoji
      .emojiStartingWith(
        query.query,
        emoji.likedBy(emoji.emojiPreferences(platform).getState().used),
      )
      .map((e) => ({ kind: "emoji", emoji: e }));
  }, [query, users, channels, memberships, selfId, room, emoji, platform]);

  const list = useListbox(options.length);
  const open = query !== null && options.length > 0;

  function choose(option: Suggestion) {
    if (!query || !box.current) return;
    const insert =
      option.kind === "user"
        ? `<@${option.user.id}> `
        : option.kind === "broadcast"
          ? `<!${option.token}> `
          : option.kind === "channel"
            ? `<#${option.channel.id}> `
            : emoji
              ? `${emoji.writeEmoji(platform, option.emoji)} `
              : null;
    if (insert === null) return;
    // Shown as the name at once; kept as the id it stands for.
    const next = field.replaceSelection(insert, query.start, box.current.selectionStart);
    setQuery(null);
    apply(next.stored, next.caret);
  }

  /**
   * Turns a shortcode written out in full, as ":tada:", into its emoji when
   * its closing colon is typed, as Slack does. Not in code, where colons are
   * code. Says whether it did.
   */
  function finishShortcode(value: string, caret: number): boolean {
    if (!emoji) return false;
    const line = value.slice(value.lastIndexOf("\n", caret - 1) + 1, caret);
    const typed = /(^|\s):([a-z0-9_+-]+):$/i.exec(line);
    if (!typed || insideCodeBlock(value, caret) || line.split("`").length % 2 === 0) return false;
    const named = emoji.emojiNamed(typed[2]!);
    if (!named) return false;
    const next = field.replaceSelection(
      emoji.writeEmoji(platform, named),
      caret - typed[2]!.length - 2,
      caret,
    );
    setQuery(null);
    apply(next.stored, next.caret);
    return true;
  }

  return {
    open,
    options,
    list,
    kind: query?.kind,
    choose,
    /** After the box changed: what is being typed now, and a finished `:shortcode:`. */
    update(value: string, caret: number, shown: MentionDocument) {
      const next = queryAt(value, caret, field, shown);
      setQuery(next);
      if (next) list.choose(0);
      if (!next || next.kind !== "person") finishShortcode(value, caret);
    },
    close: () => setQuery(null),
    /** Arrows move the choice, Enter or Tab takes it, Esc closes the list. Says whether it used the key. */
    keyDown(e: React.KeyboardEvent): boolean {
      if (!open) return false;
      if (list.move(e)) return true;
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(options[list.active]!);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setQuery(null);
        return true;
      }
      return false;
    },
  };
}

type Suggestions = ReturnType<typeof useSuggestions>;

const LABELS: Record<Kind, string> = { person: "Mentions", channel: "Channels", emoji: "Emoji" };

/** The open list of suggestions, above the box. */
export function SuggestionList({
  suggestions: s,
  className = "left-5 right-5",
}: {
  suggestions: Suggestions;
  className?: string;
}) {
  const platform = usePlatform();
  const selfId = useWorkspace((s) => s.self?.id);
  const memberships = useWorkspace((s) => s.memberships);
  const emoji = useEmoji(s.kind === "emoji");
  if (!s.open) return null;
  return (
    <ul
      {...s.list.listProps}
      aria-label={LABELS[s.kind!]}
      className={`surface-float absolute bottom-full z-10 mb-2 origin-bottom-left animate-menu-in overflow-hidden rounded-xl p-1 ${className}`}
    >
      {s.options.map((option, i) => (
        <li
          key={
            option.kind === "user"
              ? option.user.id
              : option.kind === "broadcast"
                ? option.token
                : option.kind === "channel"
                  ? option.channel.id
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
