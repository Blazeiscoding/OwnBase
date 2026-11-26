import { useEffect, useMemo, useState } from "react";
import type React from "react";
import {
  groupMentionToken,
  type Channel,
  type CustomEmoji,
  type User,
  type UserGroup,
} from "@ownbase/protocol";
import { usePlatform, useWorkspace } from "../context.js";
import { useEmoji } from "../lib/emoji.js";
import type { Emoji } from "../lib/emojiSet.js";
import { insideCodeBlock } from "../lib/textInput.js";
import type { MentionDocument } from "../lib/mentionDocument.js";
import { preloadable } from "../lib/preloadable.js";
import { useListbox } from "../lib/useListbox.js";

/**
 * What a message box offers while a word is being typed: people and user
 * groups after `@`, channels after `#`, emoji after `:`. The composer and the message editor
 * both use it, so editing a message finishes names as writing one does.
 *
 * The ranking and the list itself are in SuggestionChoices, fetched as the
 * workspace opens. Until they arrive nothing is offered, as when nothing
 * matches, and the list opens once they have.
 */
const choices = preloadable(() => import("./SuggestionChoices.js"));

/** SuggestionChoices once it has arrived, or null. It is asked for while `wanted`. */
function useChoices(wanted: boolean) {
  const [, arrived] = useState(false);
  useEffect(() => {
    if (!wanted || choices.loaded()) return;
    let current = true;
    choices.load().then(
      () => current && arrived(true),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [wanted]);
  return choices.loaded();
}

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

export type SuggestionKind = "person" | "channel" | "emoji";
interface Query {
  kind: SuggestionKind;
  /** Where the `@`, `#` or `:` is, in the shown text. */
  start: number;
  query: string;
}

export type Suggestion =
  | { kind: "user"; user: User }
  | { kind: "group"; group: UserGroup }
  | { kind: "broadcast"; token: "channel" | "here"; description: string }
  | { kind: "channel"; channel: Channel }
  | { kind: "emoji"; emoji: Emoji }
  | { kind: "custom"; emoji: CustomEmoji };

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
  const custom = useWorkspace((s) => s.customEmoji);
  // A guest is offered no groups: a group can reach people a guest cannot see.
  const groups = useWorkspace((s) => (s.self?.role === "guest" ? null : s.userGroups));
  const [query, setQuery] = useState<Query | null>(null);
  // Every emoji arrives on first use; usually the workspace has fetched it already.
  const emoji = useEmoji(query?.kind === "emoji");

  const ranked = useChoices(query !== null);

  const options = useMemo(
    (): Suggestion[] =>
      query && ranked
        ? ranked.suggestionsFor(query.kind, query.query, {
            users,
            groups,
            channels,
            memberships,
            selfId,
            custom,
            room,
            emoji,
            platform,
          })
        : [],
    [query, ranked, users, groups, channels, memberships, selfId, room, emoji, platform, custom],
  );

  const list = useListbox(options.length);
  const open = query !== null && options.length > 0;

  function choose(option: Suggestion) {
    if (!query || !box.current) return;
    const insert =
      option.kind === "user"
        ? `<@${option.user.id}> `
        : option.kind === "group"
          ? `${groupMentionToken(option.group)} `
          : option.kind === "broadcast"
            ? `<!${option.token}> `
            : option.kind === "channel"
              ? `<#${option.channel.id}> `
              : option.kind === "custom"
                ? `:${option.emoji.name}: `
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

export type Suggestions = ReturnType<typeof useSuggestions>;

/** The open list of suggestions, above the box. */
export function SuggestionList({
  suggestions,
  className = "left-5 right-5",
}: {
  suggestions: Suggestions;
  className?: string;
}) {
  // Open only once SuggestionChoices has ranked something, so it is here.
  const List = choices.loaded()?.SuggestionChoices;
  if (!suggestions.open || !List) return null;
  return <List suggestions={suggestions} className={className} />;
}
