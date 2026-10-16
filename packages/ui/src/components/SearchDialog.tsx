import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError } from "@slackoss/client-core";
import type { FileMeta, FileType, ID, Message } from "@slackoss/protocol";
import { parseSearchQuery } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { useRecentSearches, type RecentSearch } from "../lib/recentSearches.js";
import { channelTitle, formatBytes, formatFull, formatWhen } from "../lib/format.js";
import { usePagedList } from "../lib/pagedList.js";
import {
  DATE_PRESETS,
  FILE_TYPE_LABELS,
  filterLabel,
  kindOf,
  localDay,
  takeFilters,
  withFilter,
} from "../lib/searchFilters.js";
import { useTabs } from "../lib/useTabs.js";
import { Dialog, DialogScroll } from "./Dialog.js";
import { inputCls } from "./TextField.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { isImeKey } from "../lib/textInput.js";
import { Icon } from "./Icon.js";
import { ListStatus } from "./ListStatus.js";
import { LoadMore } from "./LoadMore.js";
import { Menu, type MenuItem } from "./Menu.js";
import { Popover } from "./Popover.js";
import { Tooltip } from "./Tooltip.js";
import { iconFor } from "./Attachments.js";

/** How long typing pauses before what is typed is searched. */
const LIVE_DELAY = 250;
/** How many results each read brings. */
const PAGE_SIZE = 30;

const MODIFIER_HELP = [
  { token: "from:@name", what: "by one person" },
  { token: "in:#channel", what: "in one channel" },
  { token: "has:link", what: "contains a link" },
  { token: "has:file", what: "has an attachment" },
  { token: "type:pdf", what: "has one kind of file" },
  { token: "after:2026-01-01", what: "after a day" },
  { token: "before:2026-02-01", what: "before a day" },
];

const RESULT_TABS = ["messages", "files"] as const;
type ResultTab = (typeof RESULT_TABS)[number];

/** A filter that is not chosen yet, as a small pill that opens its choices. */
const ADD_FILTER =
  "inline-flex h-7 items-center gap-1 rounded-full border border-edge px-2.5 text-[12px] font-medium text-ink-dim transition-colors hover:bg-ink/[0.05] hover:text-ink aria-expanded:bg-ink/[0.05] aria-expanded:text-ink";

/** A file's name with the words searched for marked, as message text marks them. */
function markTerms(value: string, terms: readonly string[]): ReactNode {
  const words = [...new Set(terms.filter((term) => term.trim()))].sort(
    (a, b) => b.length - a.length,
  );
  if (words.length === 0) return value;
  const pattern = new RegExp(
    words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "giu",
  );
  const parts: ReactNode[] = [];
  let previous = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > previous) parts.push(value.slice(previous, match.index));
    parts.push(
      <mark key={match.index} className="rounded bg-copper/25 text-ink">
        {match[0]}
      </mark>,
    );
    previous = match.index + match[0].length;
  }
  if (previous < value.length) parts.push(value.slice(previous));
  return parts;
}

/** The files attached to a result, by name, so one found by its name shows why. */
function Attachments({ files, terms }: { files: FileMeta[]; terms: readonly string[] }) {
  if (files.length === 0) return null;
  return (
    <ul aria-label="Attachments" className="mt-2 flex flex-wrap gap-1.5">
      {files.map((file) => (
        <li
          key={file.id}
          className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-edge px-2 py-1 text-xs"
        >
          <Icon name="file" size={13} />
          <span className="truncate">{markTerms(file.name, terms)}</span>
          <span className="shrink-0 text-ink-faint">{formatBytes(file.size)}</span>
        </li>
      ))}
    </ul>
  );
}

/** A filter in force, with the one click that takes it away. */
function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex h-7 max-w-full items-center gap-0.5 rounded-full border border-copper/40 bg-copper/[0.1] pl-2.5 pr-0.5 text-[12px] font-medium text-ink">
      <span className="truncate">{label}</span>
      <button
        type="button"
        aria-label={`Remove filter: ${label}`}
        onClick={onRemove}
        className="grid size-6 shrink-0 place-items-center rounded-full text-ink-dim transition-colors hover:bg-ink/[0.08] hover:text-ink"
      >
        <Icon name="close" size={12} />
      </button>
    </span>
  );
}

/** The Date choices: a few spans of time, or a day on either side. */
function DateFilter(props: {
  after: string | null;
  before: string | null;
  onChange: (kind: "after" | "before", day: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={ADD_FILTER}
      >
        Date
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <Popover
          label="Date"
          anchor={trigger}
          align="start"
          side="below"
          width={320}
          onClose={() => setOpen(false)}
        >
          <div className="flex flex-col p-1">
            {DATE_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => {
                  props.onChange("after", localDay(preset.offset));
                  props.onChange("before", null);
                  setOpen(false);
                }}
                className="rounded-lg px-2.5 py-1.5 text-left text-sm text-ink-dim transition-colors hover:bg-copper/[0.12] hover:text-ink"
              >
                {preset.label}
              </button>
            ))}
            <div role="separator" className="mx-1.5 my-1 h-px bg-edge" />
            {/* A day counts as it is typed, so Enter only puts the choices away. */}
            <div
              className="grid grid-cols-2 gap-2 px-1.5 pb-1.5 pt-1"
              onKeyDown={(e) => {
                if (e.key !== "Enter" || isImeKey(e.nativeEvent)) return;
                e.preventDefault();
                setOpen(false);
              }}
            >
              <label className="min-w-0 text-xs text-ink-faint">
                After
                <input
                  type="date"
                  className={inputCls}
                  value={props.after ?? ""}
                  onChange={(e) => props.onChange("after", e.target.value || null)}
                />
              </label>
              <label className="min-w-0 text-xs text-ink-faint">
                Before
                <input
                  type="date"
                  className={inputCls}
                  value={props.before ?? ""}
                  onChange={(e) => props.onChange("before", e.target.value || null)}
                />
              </label>
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

/** One search's words and conversation as a single comparable value. */
const keyOf = (criteria: { query: string; channelId?: ID } | null) =>
  JSON.stringify(criteria ? [criteria.query, criteria.channelId ?? null] : null);

/**
 * What is searched for: the words, then the filters, in one order, so the same
 * search is always asked the same way. The Files tab asks only for messages
 * with files, unless a filter already does. Null when nothing is asked.
 */
function criteriaOf(
  text: string,
  filters: readonly string[],
  scope: string,
  tab: ResultTab,
): { query: string; channelId?: ID } | null {
  const words = [text.trim(), ...filters];
  if (
    tab === "files" &&
    !filters.some((filter) => filter === "has:file" || kindOf(filter) === "type")
  )
    words.push("has:file");
  const query = words.filter(Boolean).join(" ");
  if (!text.trim() && filters.length === 0 && !scope) return null;
  return { query, channelId: scope || undefined };
}

/** The latest change heard in any conversation these results come from. */
function latestChange(messages: readonly Message[], changedContent: Record<ID, number>): number {
  let latest = 0;
  for (const message of messages) latest = Math.max(latest, changedContent[message.channelId] ?? 0);
  return latest;
}

/**
 * Full-text search over the workspace's messages and the names of their
 * files (UX-51). Results come first, under the field and a row of filters as
 * chips: typed modifiers such as `from:@sam` become chips, and each chip is
 * one click to remove. It searches as it is typed, reads more as the end
 * scrolls into view, and stays current while open. Enter searches at once and
 * keeps the search among the recent ones, which show before anything is asked.
 */
export function SearchDialog(props: {
  onClose: () => void;
  onJump: (channelId: ID, messageId: ID) => void;
  channelId?: ID | null;
  /** Words to search for at once, as typed in the palette. */
  initialQuery?: string;
  /** Opens on `channelId` alone, from the conversation's own menu. */
  inConversation?: boolean;
}) {
  const client = useClient();
  const recent = useRecentSearches();
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const selfId = client.state.self?.id ?? "";
  const [opening] = useState(() => {
    const words = props.initialQuery?.trim().slice(0, 200) ?? "";
    const taken = takeFilters(words, words.length, true);
    const scope = props.inConversation && props.channelId ? props.channelId : "";
    const filters = taken.tokens.reduce<string[]>(withFilter, []);
    return {
      text: taken.text,
      filters,
      scope,
      criteria: words || scope ? criteriaOf(taken.text, filters, scope, "messages") : null,
    };
  });
  const [text, setText] = useState(opening.text);
  const [filters, setFilters] = useState<string[]>(opening.filters);
  const [scope, setScope] = useState(opening.scope);
  const [tab, setTab] = useState<ResultTab>("messages");
  const [help, setHelp] = useState(false);
  /** What was last asked of the server, which can lag what is typed by a pause. */
  const [asked, setAsked] = useState(opening.criteria);
  const [searchError, setSearchError] = useState<string | null>(null);
  /** The words of the question the results on show answer, which may not be the one out. */
  const [shownQuery, setShownQuery] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const helpId = useId();
  /** Where the caret goes once a modifier typed in the field has become a chip. */
  const caret = useRef<number | null>(null);
  /**
   * A search Enter settled on, to keep among the recent ones once it answers.
   * Words brought from the palette were settled on there; a conversation's own
   * menu only opens search on it.
   */
  const committed = useRef<string | null>(
    props.initialQuery?.trim() && opening.criteria ? keyOf(opening.criteria) : null,
  );
  /** The question the results showing answer. */
  const answered = useRef<string | null>(null);
  /** The results last scrolled to the top for, so only a new question moves them. */
  const scrolledFor = useRef<string | null>(null);
  /** How far changes had got in the results' conversations when they were asked for. */
  const heard = useRef(0);

  const criteria = criteriaOf(text, filters, scope, tab);
  const key = keyOf(criteria);
  const askedKey = keyOf(asked);
  const query = criteria?.query ?? "";
  const parsed = useMemo(() => parseSearchQuery(query), [query]);
  const unreadable = parsed.invalid.length > 0;
  const terms = useMemo(() => parseSearchQuery(shownQuery ?? "").terms, [shownQuery]);

  const paged = usePagedList<Message>(
    async (cursor, signal) => {
      if (!asked) {
        answered.current = null;
        return { items: [], nextCursor: null };
      }
      const known = client.state.changedContent;
      const question = keyOf(asked);
      try {
        const found = await client.api.search(asked.query, PAGE_SIZE, {
          cursor,
          channelId: asked.channelId,
          signal,
        });
        if (signal.aborted) return { items: [], nextCursor: null };
        // Measured against what was known when this was asked: a change that
        // arrived while it was out may not be in the answer, and asks once more.
        const latest = latestChange(found.messages, known);
        heard.current = cursor ? Math.max(heard.current, latest) : latest;
        if (!cursor) {
          answered.current = question;
          setShownQuery(asked.query);
          setSearchError(null);
          // Only a search someone settled on is kept, not each one typed on the way.
          if (committed.current === question) {
            committed.current = null;
            recent.remember(asked);
          }
        }
        return { items: found.messages, nextCursor: found.nextCursor };
      } catch (err) {
        if (!signal.aborted && !cursor)
          setSearchError(
            err instanceof ApiError && err.code === "invalid_search_date"
              ? err.message
              : "Could not search this workspace. Check your connection and try again.",
          );
        throw err;
      }
    },
    askedKey,
    undefined,
    // The answer to the last question stays on show until the next one's comes.
    { keep: true },
  );
  const { list: results } = paged;
  const messages = useMemo(
    () => (paged.items ?? []).filter((m) => !!channels[m.channelId]),
    [paged.items, channels],
  );

  // The results are a copy. When a conversation among them has had a message
  // edited or taken away since they were asked for, or has been left, they
  // are read again in place, so nothing deleted stays on show (Q07). A read
  // still out is left to finish: its answer is measured when it comes.
  const changed = useWorkspace((s) => latestChange(paged.items ?? [], s.changedContent));
  useEffect(() => {
    if (paged.loading || paged.refreshing || changed <= heard.current) return;
    heard.current = changed;
    results.refresh();
  }, [changed, paged.loading, paged.refreshing, results]);

  // A new question's answer is read from its top; one read again stays put.
  useLayoutEffect(() => {
    if (answered.current === scrolledFor.current) return;
    scrolledFor.current = answered.current;
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [paged.items]);

  useLayoutEffect(() => {
    if (caret.current === null || !field.current) return;
    field.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [text]);

  // Results follow what is typed and chosen, once typing pauses. A date still
  // being written is left alone: the hints already say it is not one yet.
  useEffect(() => {
    if (!criteria) {
      setAsked(null);
      return;
    }
    if (query.length > 200 || unreadable || key === askedKey) return;
    const timer = setTimeout(
      () => setAsked((before) => (keyOf(before) === key ? before : criteria)),
      LIVE_DELAY,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the criteria
  }, [key, unreadable]);

  function addFilter(token: string) {
    setFilters((before) => withFilter(before, token));
  }
  function removeFilter(token: string) {
    setFilters((before) => before.filter((filter) => filter !== token));
    field.current?.focus();
  }
  function setDay(kind: "after" | "before", day: string | null) {
    setFilters((before) => {
      const others = before.filter((filter) => kindOf(filter) !== kind);
      return day ? withFilter(others, `${kind}:${day}`) : others;
    });
  }

  function run(e: React.FormEvent) {
    e.preventDefault();
    // Enter takes every modifier left in the field, finished or not.
    const taken = takeFilters(text, field.current?.selectionStart ?? text.length, true);
    const nextFilters = taken.tokens.reduce(withFilter, filters);
    if (taken.tokens.length > 0) {
      setFilters(nextFilters);
      setText(taken.text);
    }
    const settled = criteriaOf(taken.text, nextFilters, scope, tab);
    if (!settled || settled.query.length > 200) return;
    const settledKey = keyOf(settled);
    committed.current = settledKey;
    if (settledKey !== askedKey) {
      setAsked(settled);
      return;
    }
    // Already asked as it was typed: keep it, wait for its answer, or ask again.
    if (paged.failed) results.retry();
    else if (!paged.loading && answered.current === settledKey) {
      committed.current = null;
      recent.remember(settled);
    }
  }

  function repeat(entry: RecentSearch) {
    const taken = takeFilters(entry.query, entry.query.length, true);
    const nextFilters = taken.tokens.reduce<string[]>(withFilter, []);
    setText(taken.text);
    setFilters(nextFilters);
    setScope(entry.channelId ?? "");
    setTab("messages");
    recent.remember(entry);
    setAsked(criteriaOf(taken.text, nextFilters, entry.channelId ?? "", "messages"));
  }

  const conversationName = (id: ID) => {
    const channel = channels[id];
    if (!channel) return "Unavailable conversation";
    return channel.name ? `#${channel.name}` : channelTitle(channel, users, selfId);
  };
  const after = filters.find((filter) => kindOf(filter) === "after")?.slice(6) ?? null;
  const before = filters.find((filter) => kindOf(filter) === "before")?.slice(7) ?? null;

  const people: MenuItem[] = Object.values(users)
    .filter((user) => !user.deactivated || filters.includes(`from:${user.handle.toLowerCase()}`))
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((user) => {
      const token = `from:${user.handle.toLowerCase()}`;
      return {
        id: user.id,
        label: user.displayName,
        hint: `@${user.handle}`,
        checked: filters.includes(token),
        onSelect: () => (filters.includes(token) ? removeFilter(token) : addFilter(token)),
      };
    });
  const here = props.channelId && channels[props.channelId] ? props.channelId : null;
  const places: MenuItem[] = [
    ...(here ? [here] : []),
    ...Object.values(channels)
      .filter((channel) => channel.id !== here)
      .sort((a, b) => conversationName(a.id).localeCompare(conversationName(b.id)))
      .map((channel) => channel.id),
  ].map((id, index) => ({
    id,
    label: conversationName(id),
    hint: id === here ? "This conversation" : undefined,
    section: here && index === 1 ? true : undefined,
    checked: scope === id,
    onSelect: () => setScope(scope === id ? "" : id),
  }));
  const kinds: MenuItem[] = (
    [
      ["has:file", "A file"],
      ["has:link", "A link"],
      ...(Object.entries(FILE_TYPE_LABELS) as [FileType, string][]).map(
        ([type, label]): [string, string] => [`type:${type}`, label],
      ),
    ] satisfies [string, string][]
  ).map(([token, label], index) => ({
    id: token,
    label,
    section: index === 2 ? "Kind of file" : undefined,
    checked: filters.includes(token),
    onSelect: () => (filters.includes(token) ? removeFilter(token) : addFilter(token)),
  }));

  const tabs = useTabs({
    label: "Results",
    tabs: RESULT_TABS,
    selected: tab,
    onSelect: (next) => {
      setTab(next);
      // Another tab is another question, asked at once rather than after a pause.
      const switched = criteriaOf(text, filters, scope, next);
      if (switched && switched.query.length <= 200 && !unreadable) setAsked(switched);
    },
  });
  const files = useMemo(
    () => messages.flatMap((m) => m.files.map((file) => ({ file, message: m }))),
    [messages],
  );
  const shown = tab === "files" ? files.length : messages.length;
  const answeredHere = !!asked && paged.items !== null;
  const chipCount = filters.length + (scope ? 1 : 0);

  function open(m: Message) {
    // A result someone opens is one they were looking for.
    if (asked) recent.remember(asked);
    props.onJump(m.channelId, m.id);
  }

  return (
    <Dialog title="Search messages" onClose={props.onClose} width={640} ownScroll>
      {/* The field and the filters stay in sight over what they found, to be
          changed from any way down the results. */}
      <form onSubmit={run} className="shrink-0 space-y-2 px-6 pb-3">
        <div className="flex gap-2">
          <input
            ref={field}
            autoFocus
            aria-label="Search messages"
            enterKeyHint="search"
            maxLength={200}
            value={text}
            onChange={(e) => {
              const typed = e.target.value;
              const taken = takeFilters(typed, e.target.selectionStart ?? typed.length);
              if (taken.tokens.length > 0) {
                setFilters((before) => taken.tokens.reduce(withFilter, before));
                caret.current = taken.caret;
              }
              setText(taken.text);
            }}
            onKeyDown={(e) => {
              // A form submits on Enter from a text field, which would run the
              // search on the Enter that picked an input method's candidate.
              if (e.key === "Enter" && isImeKey(e.nativeEvent)) e.preventDefault();
            }}
            placeholder="Search messages and file names"
            className={inputCls}
          />
          <Tooltip label="Search syntax">
            <button
              type="button"
              aria-label="Search syntax"
              aria-expanded={help}
              aria-controls={helpId}
              onClick={() => setHelp((open) => !open)}
              className="grid size-[38px] shrink-0 place-items-center rounded-lg border border-edge text-ink-dim transition-colors hover:bg-ink/[0.05] hover:text-ink aria-expanded:bg-ink/[0.05] aria-expanded:text-ink"
            >
              <Icon name="help" size={16} />
            </button>
          </Tooltip>
        </div>
        {query.length > 200 && (
          <p role="alert" className="text-xs text-ink-dim">
            Shorten the search or remove a filter (200 characters maximum).
          </p>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          {scope && (
            <FilterChip
              label={`In ${conversationName(scope)}`}
              onRemove={() => {
                setScope("");
                field.current?.focus();
              }}
            />
          )}
          {filters.map((filter) => (
            <FilterChip
              key={filter}
              label={filterLabel(filter, users)}
              onRemove={() => removeFilter(filter)}
            />
          ))}
          <Menu
            label="From"
            items={people}
            align="start"
            multiple
            width={260}
            triggerClassName={ADD_FILTER}
            triggerContent={
              <>
                From
                <Icon name="chevronDown" size={12} />
              </>
            }
          />
          <Menu
            label="In"
            items={places}
            align="start"
            width={260}
            triggerClassName={ADD_FILTER}
            triggerContent={
              <>
                In
                <Icon name="chevronDown" size={12} />
              </>
            }
          />
          <Menu
            label="Has"
            items={kinds}
            align="start"
            multiple
            width={220}
            triggerClassName={ADD_FILTER}
            triggerContent={
              <>
                Has
                <Icon name="chevronDown" size={12} />
              </>
            }
          />
          <DateFilter after={after} before={before} onChange={setDay} />
          {chipCount > 1 && (
            <button
              type="button"
              onClick={() => {
                setFilters([]);
                setScope("");
                field.current?.focus();
              }}
              className="h-7 px-1.5 text-[12px] font-medium text-ink-faint transition-colors hover:text-ink"
            >
              Clear all
            </button>
          )}
        </div>
        {parsed.invalid.length > 0 && (
          <p className="flex flex-wrap gap-1.5 text-[12px]">
            {parsed.invalid.map((token) => (
              <span
                key={token}
                className="rounded-full border border-alert/40 px-2 py-0.5 text-alert"
              >
                not a date: {token}
              </span>
            ))}
          </p>
        )}
        <div
          id={helpId}
          hidden={!help}
          className="rounded-xl border border-edge p-3 text-[12px] text-ink-faint"
        >
          <p className="mb-2">Type a filter, then a space, and it becomes a chip.</p>
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {MODIFIER_HELP.map((m) => (
              <li key={m.token}>
                <code className="rounded bg-ink/[0.06] px-1 font-mono text-ink-dim">{m.token}</code>{" "}
                {m.what}
              </li>
            ))}
          </ul>
        </div>
      </form>
      <DialogScroll ref={scroller}>
        {!asked ? (
          <RecentSearches recent={recent} onRepeat={repeat} name={conversationName} />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <div {...tabs.listProps} className="flex gap-1 rounded-lg bg-ink/[0.05] p-0.5">
                {RESULT_TABS.map((name) => (
                  <button
                    key={name}
                    {...tabs.tabProps(name)}
                    className="rounded-md px-2.5 py-1 text-[12px] font-medium text-ink-dim transition-colors hover:text-ink aria-selected:bg-ground aria-selected:text-ink aria-selected:shadow-sm"
                  >
                    {name === "messages" ? "Messages" : "Files"}
                  </button>
                ))}
              </div>
              {answeredHere && (
                <p role="status" className="text-xs text-ink-faint">
                  {shown}{" "}
                  {tab === "files"
                    ? shown === 1
                      ? "file"
                      : "files"
                    : shown === 1
                      ? "result"
                      : "results"}
                  {paged.nextCursor ? " so far" : ""} · Newest first
                  {terms.length > 0 ? ` · “${terms.join(" ")}”` : ""}
                </p>
              )}
            </div>
            <div {...tabs.panelProps}>
              <ListStatus
                loading={paged.loading}
                placeholder={paged.items === null}
                loadingLabel="Searching…"
                error={paged.failed ? searchError : null}
                onRetry={() => results.retry()}
                empty={
                  paged.items !== null && shown === 0 && !paged.nextCursor
                    ? tab === "files"
                      ? "No files matched. Try different words."
                      : "Nothing matched. Try different words."
                    : null
                }
                emptyIcon={tab === "files" ? "file" : "search"}
              />
              <ul
                ref={list}
                className="space-y-2"
                aria-busy={paged.loading || paged.refreshing}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                  const buttons = [
                    ...(list.current?.querySelectorAll<HTMLButtonElement>("[data-search-open]") ??
                      []),
                  ];
                  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                  if (index < 0) return;
                  e.preventDefault();
                  buttons[
                    Math.max(
                      0,
                      Math.min(buttons.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)),
                    )
                  ]?.focus();
                }}
              >
                {tab === "files"
                  ? files.map(({ file, message: m }) => (
                      <li key={file.id}>
                        <button
                          type="button"
                          data-search-open
                          onClick={() => open(m)}
                          className="flex w-full items-center gap-3 rounded-xl border border-edge p-3 text-left transition-colors hover:bg-ink/[0.025]"
                        >
                          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-ink/[0.05] text-ink-dim">
                            <Icon name={iconFor(file.mime, file.name)} size={16} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-ink">
                              {markTerms(file.name, terms)}
                            </span>
                            <span className="block truncate text-xs text-ink-faint">
                              {conversationName(m.channelId)} · {users[m.userId]?.displayName} ·{" "}
                              <time
                                dateTime={new Date(m.createdAt).toISOString()}
                                title={formatFull(m.createdAt)}
                              >
                                {formatWhen(m.createdAt)}
                              </time>
                            </span>
                          </span>
                          <span className="shrink-0 text-xs text-ink-faint">
                            {formatBytes(file.size)}
                          </span>
                        </button>
                      </li>
                    ))
                  : messages.map((m) => {
                      const ch = channels[m.channelId];
                      return (
                        <li
                          key={m.id}
                          className="rounded-xl border border-edge p-3 transition-colors hover:bg-ink/[0.025]"
                        >
                          <div className="mb-1 flex items-baseline gap-2 text-[12px] text-ink-faint">
                            <span className="font-semibold text-ink-dim">
                              {conversationName(m.channelId)}
                            </span>
                            {(!ch || ch.name) && <span>{users[m.userId]?.displayName}</span>}
                            <time
                              dateTime={new Date(m.createdAt).toISOString()}
                              title={formatFull(m.createdAt)}
                              className="ml-auto text-right"
                            >
                              {formatWhen(m.createdAt)}
                            </time>
                          </div>
                          <div className="text-sm">
                            <Mrkdwn
                              text={m.text}
                              users={users}
                              channels={channels}
                              highlightTerms={terms}
                            />
                          </div>
                          <Attachments files={m.files} terms={terms} />
                          <div className="mt-2 flex items-center justify-between gap-2 text-xs text-ink-faint">
                            <span>{m.threadRootId ? "Thread reply" : "Message"}</span>
                            <button
                              type="button"
                              data-search-open
                              className="inline-flex items-center gap-1 font-medium text-ink-dim hover:text-ink"
                              onClick={() => open(m)}
                            >
                              Open in conversation
                              <Icon name="arrow" size={12} />
                            </button>
                          </div>
                        </li>
                      );
                    })}
              </ul>
              {paged.items !== null && !paged.loading && (
                <LoadMore
                  more={!!paged.nextCursor}
                  loading={paged.loadingMore}
                  failed={paged.moreFailed}
                  count={paged.items.length}
                  onMore={() => results.loadMore()}
                  scroller={scroller}
                />
              )}
            </div>
          </>
        )}
      </DialogScroll>
    </Dialog>
  );
}

/** Before anything is asked: the searches kept on this device, to ask again in one click. */
function RecentSearches(props: {
  recent: ReturnType<typeof useRecentSearches>;
  onRepeat: (entry: RecentSearch) => void;
  name: (id: ID) => string;
}) {
  const { recent } = props;
  const heading = useId();
  if (recent.items.length === 0 && !recent.error)
    return (
      <p className="py-6 text-center text-sm text-ink-faint">
        Search messages and file names. Add a filter above, or type one such as{" "}
        <code className="rounded bg-ink/[0.06] px-1 font-mono text-ink-dim">from:@name</code>.
      </p>
    );
  return (
    <section aria-labelledby={heading}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 id={heading} className="flex items-center gap-2 text-[13px] font-medium text-ink-dim">
          <Icon name="clock" size={14} className="text-ink-faint" />
          Recent searches
        </h3>
        <button
          type="button"
          disabled={recent.busy}
          className="shrink-0 text-xs font-medium text-ink-dim underline disabled:opacity-40"
          onClick={recent.clear}
        >
          Clear recent searches
        </button>
      </div>
      <p className="mb-2 text-xs text-ink-faint">
        Saved on this device for this account and workspace.
      </p>
      {recent.error && (
        <p role="status" className="mb-2 text-xs text-ink-dim">
          {recent.error}
        </p>
      )}
      <ul aria-label="Recent searches" className="space-y-1">
        {recent.items.map((entry) => {
          const scopeLabel = entry.channelId ? props.name(entry.channelId) : "All conversations";
          const gone = scopeLabel === "Unavailable conversation";
          return (
            <li
              key={JSON.stringify([entry.query, entry.channelId])}
              className="flex items-center gap-2"
            >
              <button
                type="button"
                disabled={gone}
                className="min-w-0 flex-1 rounded-lg px-2 py-1 text-left text-sm hover:bg-ink/[0.05] disabled:opacity-40"
                onClick={() => props.onRepeat(entry)}
              >
                <span className="block truncate">{entry.query || "All messages"}</span>
                <span className="block truncate text-xs text-ink-faint">{scopeLabel}</span>
              </button>
              <button
                type="button"
                disabled={recent.busy}
                aria-label={`Remove recent search: ${entry.query || "All messages"} (${scopeLabel})`}
                className="rounded-md p-1.5 text-ink-faint hover:bg-ink/[0.06] hover:text-ink disabled:opacity-40"
                onClick={() => recent.remove(entry)}
              >
                <Icon name="close" size={14} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
