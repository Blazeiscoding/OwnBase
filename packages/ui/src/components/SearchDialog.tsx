import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError } from "@slackoss/client-core";
import type { FileMeta, FileType, ID, Message } from "@slackoss/protocol";
import { parseSearchQuery } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { useRecentSearches, type RecentSearch } from "../lib/recentSearches.js";
import { channelTitle, formatBytes, formatTime, formatWhen } from "../lib/format.js";
import { Dialog, inputCls } from "./Dialog.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { isImeKey } from "../lib/textInput.js";
import { Icon } from "./Icon.js";
import { ListStatus } from "./ListStatus.js";
import { buttonClass } from "./Button.js";

/** How long typing pauses before what is typed is searched. */
const LIVE_DELAY = 250;

const MODIFIER_HELP = [
  { token: "from:@name", what: "by one person" },
  { token: "in:#channel", what: "in one channel" },
  { token: "has:link", what: "contains a link" },
  { token: "has:file", what: "has an attachment" },
  { token: "type:pdf", what: "has one kind of file" },
  { token: "after:2026-01-01", what: "after a day" },
  { token: "before:2026-02-01", what: "before a day" },
];

/** Each kind of file `type:` asks for, as the Contains choice and the hints name it. */
const FILE_TYPE_LABELS: Record<FileType, string> = {
  image: "Images",
  video: "Videos",
  audio: "Audio",
  pdf: "PDFs",
  document: "Documents",
  spreadsheet: "Spreadsheets",
  presentation: "Presentations",
  archive: "Archives",
};

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

/** A YYYY-MM-DD day in the reader's own date style, without moving it a day. */
function dayLabel(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date)).toLocaleDateString(undefined, {
    timeZone: "UTC",
  });
}

/** Shows the modifiers, then what the current query was understood to mean. */
function SearchHints({ query }: { query: string }) {
  const parsed = useMemo(() => parseSearchQuery(query), [query]);
  const chips: string[] = [
    ...parsed.from.map((h) => `from @${h}`),
    ...parsed.in.map((c) => `in #${c}`),
    ...parsed.has.map((h) => (h === "link" ? "has a link" : "has a file")),
    ...parsed.types.map((type) => FILE_TYPE_LABELS[type].toLowerCase()),
    ...(parsed.afterDay ? [`after ${dayLabel(parsed.afterDay)}`] : []),
    ...(parsed.beforeDay ? [`before ${dayLabel(parsed.beforeDay)}`] : []),
  ];

  if (chips.length === 0 && parsed.invalid.length === 0) return null;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[12px]">
      <span className="text-ink-faint">Filtering:</span>
      {chips.map((c) => (
        <span
          key={c}
          className="rounded-full border border-edge bg-ink/[0.04] px-2 py-0.5 font-medium text-ink"
        >
          {c}
        </span>
      ))}
      {parsed.invalid.map((token) => (
        <span key={token} className="rounded-full border border-alert/40 px-2 py-0.5 text-alert">
          not a date: {token}
        </span>
      ))}
      {parsed.terms.length > 0 && (
        <span className="text-ink-faint">matching “{parsed.terms.join(" ")}”</span>
      )}
    </div>
  );
}

/** One search's words and conversation as a single comparable value. */
const keyOf = (criteria: { query: string; channelId?: ID }) =>
  JSON.stringify([criteria.query, criteria.channelId ?? null]);

/**
 * Full-text search over the workspace's messages and the names of their
 * files. It searches as it is typed; Enter searches at once and keeps the
 * search among the recent ones.
 */
/** The latest change heard in any conversation these results come from. */
function latestChange(found: { messages: Message[] }, changedContent: Record<ID, number>): number {
  let latest = 0;
  for (const message of found.messages)
    latest = Math.max(latest, changedContent[message.channelId] ?? 0);
  return latest;
}

export function SearchDialog(props: {
  onClose: () => void;
  onJump: (channelId: ID, messageId: ID) => void;
  channelId?: ID | null;
  /** Words to search for at once, as typed in the palette. */
  initialQuery?: string;
}) {
  const client = useClient();
  const recent = useRecentSearches();
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const [q, setQ] = useState(props.initialQuery ?? "");
  const [results, setResults] = useState<Awaited<ReturnType<typeof client.api.search>> | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState("");
  const [author, setAuthor] = useState("");
  /** The Contains choice, as the modifier it adds: has:file, type:pdf and so on. */
  const [contains, setContains] = useState("");
  const [after, setAfter] = useState("");
  const [before, setBefore] = useState("");
  const [submitted, setSubmitted] = useState<{ query: string; channelId?: ID } | null>(null);
  const highlightTerms = useMemo(
    () => parseSearchQuery(submitted?.query ?? "").terms,
    [submitted?.query],
  );
  const [cursors, setCursors] = useState<(ID | undefined)[]>([undefined]);
  const [page, setPage] = useState(0);
  const request = useRef<AbortController | null>(null);
  const failed = useRef<(() => void) | null>(null);
  const list = useRef<HTMLUListElement>(null);
  /** The first page last asked for, so the same question is not asked twice. */
  const asked = useRef<string | null>(null);
  /** A search Enter was pressed on before it answered, to remember when it does. */
  const committed = useRef<string | null>(null);
  // The results are a copy. When a conversation among them has had a message
  // edited or taken away since they were asked for, or has been left, the same
  // page is asked for again, so nothing deleted stays on show (Q07).
  const changed = useWorkspace((s) => (results ? latestChange(results, s.changedContent) : 0));
  /** How far those changes had got when the results showing were asked for. */
  const heard = useRef(0);
  const query = [
    q.trim(),
    author && `from:${author}`,
    contains,
    after && `after:${after}`,
    before && `before:${before}`,
  ]
    .filter(Boolean)
    .join(" ");
  const criteria = { query, channelId: scope || undefined };
  const key = keyOf(criteria);
  const unreadable = useMemo(() => parseSearchQuery(query).invalid.length > 0, [query]);

  useEffect(() => () => request.current?.abort(), []);

  useEffect(() => {
    // A search still out is left to finish: it may be a newer question, and
    // its answer is checked against the same changes when it arrives.
    if (busy || !submitted || changed <= heard.current) return;
    // Asked once for each change: an answer that fails says so and offers Retry.
    heard.current = changed;
    void search(submitted, cursors[page], page, cursors, { keepPlace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- asks again for what is showing
  }, [changed, busy]);

  // Words brought from the palette or the header are searched straight away.
  const initial = useRef(props.initialQuery?.trim().slice(0, 200));
  useEffect(() => {
    if (initial.current)
      void search({ query: initial.current }, undefined, 0, [undefined], { remember: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on opening
  }, []);

  // Results follow what is typed and chosen, once typing pauses. A date still
  // being written is left alone: the hints already say it is not one yet.
  useEffect(() => {
    if (!query && !scope) {
      request.current?.abort();
      asked.current = null;
      setResults(null);
      setSubmitted(null);
      setBusy(false);
      setError(null);
      return;
    }
    if (query.length > 200 || unreadable || asked.current === key) return;
    const timer = setTimeout(() => {
      if (asked.current !== key) void search(criteria, undefined, 0, [undefined]);
    }, LIVE_DELAY);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the criteria
  }, [key, unreadable]);

  async function search(
    criteria: { query: string; channelId?: ID },
    cursor: ID | undefined,
    nextPage: number,
    nextCursors: (ID | undefined)[],
    opts: { remember?: boolean; keepPlace?: boolean } = {},
  ) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const known = client.state.changedContent;
    failed.current = () => {
      void search(criteria, cursor, nextPage, nextCursors, opts);
    };
    if (nextPage === 0) asked.current = keyOf(criteria);
    setBusy(true);
    setError(null);
    try {
      const found = await client.api.search(criteria.query, 30, {
        cursor,
        channelId: criteria.channelId,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      // Measured against what was known when this was asked: a change that
      // arrived while it was out may not be in the answer, and asks once more.
      heard.current = latestChange(found, known);
      setResults(found);
      setSubmitted(criteria);
      setPage(nextPage);
      setCursors(nextCursors);
      // Only a search someone settled on is kept, not each one typed on the way.
      if (nextPage === 0 && (opts.remember || committed.current === keyOf(criteria))) {
        committed.current = null;
        recent.remember(criteria);
      }
      if (!opts.keepPlace) list.current?.closest('[role="dialog"]')?.scrollTo({ top: 0 });
    } catch (err) {
      if (!controller.signal.aborted)
        setError(
          err instanceof ApiError && err.code === "invalid_search_date"
            ? err.message
            : "Could not search this workspace. Check your connection and try again.",
        );
    } finally {
      if (request.current === controller && !controller.signal.aborted) setBusy(false);
    }
  }

  function run(e: React.FormEvent) {
    e.preventDefault();
    if ((!query && !scope) || query.length > 200) return;
    // Already asked as it was typed: wait for that answer, or keep it.
    if (asked.current === key && !error) {
      if (busy) committed.current = key;
      else if (submitted) recent.remember(submitted);
      return;
    }
    void search(criteria, undefined, 0, [undefined], { remember: true });
  }

  function repeat(entry: RecentSearch) {
    setQ(entry.query);
    setScope(entry.channelId ?? "");
    setAuthor("");
    setContains("");
    setAfter("");
    setBefore("");
    void search(entry, undefined, 0, [undefined], { remember: true });
  }

  return (
    <Dialog title="Search messages" onClose={props.onClose} width={640}>
      <form onSubmit={run} className="mb-3 space-y-3">
        <div className="flex gap-2">
          <input
            autoFocus
            aria-label="Search messages"
            maxLength={200}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // A form submits on Enter from a text field, which would run the
              // search on the Enter that picked an input method's candidate.
              if (e.key === "Enter" && isImeKey(e.nativeEvent)) e.preventDefault();
            }}
            placeholder="Search messages and file names"
            className={inputCls}
          />
          <button
            type="submit"
            className={buttonClass("primary")}
            disabled={(!query && !scope) || query.length > 200}
          >
            Search
          </button>
        </div>
        <details
          open={!!(scope || author || contains || after || before) || undefined}
          className="group rounded-xl border border-edge"
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px] font-medium text-ink-dim hover:text-ink">
            <Icon
              name="chevronDown"
              size={14}
              className="transition-transform group-open:rotate-180"
            />
            Filters
            {[scope, author, contains, after, before].filter(Boolean).length > 0 && (
              <span className="rounded-full bg-copper px-1.5 text-[11px] font-semibold leading-[18px] text-ground">
                {[scope, author, contains, after, before].filter(Boolean).length}
              </span>
            )}
            <span className="ml-auto text-[12px] font-normal text-ink-faint">
              Who, where, what, when
            </span>
          </summary>
          <div className="space-y-3 border-t border-edge p-3">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-ink-faint">
                Conversation
                <select
                  className={inputCls}
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                >
                  <option value="">All conversations</option>
                  {Object.values(channels).map((ch) => (
                    <option key={ch.id} value={ch.id}>
                      {channelTitle(ch, users, client.state.self?.id ?? "")}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-ink-faint">
                From
                <select
                  className={inputCls}
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                >
                  <option value="">Anyone</option>
                  {Object.values(users).map((user) => (
                    <option key={user.id} value={user.handle}>
                      {user.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-ink-faint">
                Contains
                <select
                  className={inputCls}
                  value={contains}
                  onChange={(e) => setContains(e.target.value)}
                >
                  <option value="">Anything</option>
                  <option value="has:file">Any file</option>
                  {(Object.entries(FILE_TYPE_LABELS) as [FileType, string][]).map(
                    ([type, label]) => (
                      <option key={type} value={`type:${type}`}>
                        {label}
                      </option>
                    ),
                  )}
                  <option value="has:link">Links</option>
                </select>
              </label>
              <div className="flex items-end">
                <button
                  type="button"
                  className="py-2 text-xs font-medium text-ink-dim hover:text-ink"
                  onClick={() => {
                    setScope("");
                    setAuthor("");
                    setContains("");
                    setAfter("");
                    setBefore("");
                  }}
                >
                  Clear filters
                </button>
              </div>
              <label className="min-w-0 text-xs text-ink-faint">
                After
                <input
                  type="date"
                  className={inputCls}
                  value={after}
                  onChange={(e) => setAfter(e.target.value)}
                />
              </label>
              <label className="min-w-0 text-xs text-ink-faint">
                Before
                <input
                  type="date"
                  className={inputCls}
                  value={before}
                  onChange={(e) => setBefore(e.target.value)}
                />
              </label>
            </div>
            {props.channelId && scope !== props.channelId && (
              <button
                type="button"
                className="text-xs font-medium text-ink-dim hover:text-ink"
                onClick={() => setScope(props.channelId!)}
              >
                Search this conversation
              </button>
            )}
            <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-edge pt-3 text-[11px] text-ink-faint">
              {MODIFIER_HELP.map((m) => (
                <span key={m.token}>
                  <code className="rounded bg-ink/[0.06] px-1 font-mono text-ink-dim">
                    {m.token}
                  </code>{" "}
                  {m.what}
                </span>
              ))}
            </div>
          </div>
        </details>
        {query.length > 200 && (
          <p role="alert" className="text-xs text-ink-dim">
            Shorten the search or remove a filter (200 characters maximum).
          </p>
        )}
      </form>
      {(recent.items.length > 0 || recent.error) && (
        <details open={!results} className="mb-3 rounded-xl border border-edge p-3">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] font-medium text-ink-dim hover:text-ink">
            <Icon name="clock" size={14} className="text-ink-faint" />
            Recent searches
          </summary>
          <div className="mb-2 mt-2 flex items-center justify-between gap-2 text-xs text-ink-faint">
            <span>Saved on this device for this account and workspace.</span>
            <button
              disabled={busy || recent.busy}
              className="shrink-0 font-medium text-ink-dim underline disabled:opacity-40"
              onClick={recent.clear}
            >
              Clear recent searches
            </button>
          </div>
          {recent.error && (
            <p role="status" className="mb-2 text-xs text-ink-dim">
              {recent.error}
            </p>
          )}
          <ul aria-label="Recent searches" className="space-y-1">
            {recent.items.map((entry) => {
              const channel = entry.channelId ? channels[entry.channelId] : undefined;
              const scopeLabel = entry.channelId
                ? channel
                  ? channelTitle(channel, users, client.state.self?.id ?? "")
                  : "Unavailable conversation"
                : "All conversations";
              return (
                <li
                  key={JSON.stringify([entry.query, entry.channelId])}
                  className="flex items-center gap-2"
                >
                  <button
                    disabled={busy || (!!entry.channelId && !channel)}
                    className="min-w-0 flex-1 rounded-lg px-2 py-1 text-left text-sm hover:bg-ink/[0.05] disabled:opacity-40"
                    onClick={() => repeat(entry)}
                  >
                    <span className="block truncate">{entry.query || "All messages"}</span>
                    <span className="block truncate text-xs text-ink-faint">{scopeLabel}</span>
                  </button>
                  <button
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
        </details>
      )}
      <SearchHints query={query} />
      {results && (
        <p role="status" className="mb-2 text-xs text-ink-faint">
          {results.messages.length} results · Page {page + 1} · Newest first
          {submitted?.query ? ` · “${submitted.query}”` : ""}
        </p>
      )}
      <ListStatus
        loading={busy}
        placeholder={!results}
        loadingLabel="Searching…"
        error={error}
        onRetry={() => failed.current?.()}
        empty={results?.messages.length === 0 ? "Nothing matched. Try different words." : null}
        emptyIcon="search"
      />
      {results && (
        <>
          <ul
            ref={list}
            className="space-y-2"
            aria-busy={busy}
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              const buttons = [
                ...(list.current?.querySelectorAll<HTMLButtonElement>("[data-search-open]") ?? []),
              ];
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              if (index < 0) return;
              e.preventDefault();
              buttons[
                Math.max(0, Math.min(buttons.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)))
              ]?.focus();
            }}
          >
            {results.messages
              .filter((m) => !!channels[m.channelId])
              .map((m) => {
                const ch = channels[m.channelId];
                return (
                  <li
                    key={m.id}
                    className="rounded-xl border border-edge p-3 transition-colors hover:bg-ink/[0.025]"
                  >
                    <div className="mb-1 flex items-baseline gap-2 text-[12px] text-ink-faint">
                      <span className="font-semibold text-ink-dim">
                        {ch
                          ? ch.name
                            ? `#${ch.name}`
                            : channelTitle(ch, users, client.state.self?.id ?? "")
                          : "Unavailable conversation"}
                      </span>
                      {(!ch || ch.name) && <span>{users[m.userId]?.displayName}</span>}
                      <time
                        dateTime={new Date(m.createdAt).toISOString()}
                        title={`${new Date(m.createdAt).toLocaleDateString()} ${formatTime(m.createdAt)}`}
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
                        highlightTerms={highlightTerms}
                      />
                    </div>
                    <Attachments files={m.files} terms={highlightTerms} />
                    <div className="mt-2 flex items-center justify-between gap-2 text-xs text-ink-faint">
                      <span>{m.threadRootId ? "Thread reply" : "Message"}</span>
                      <button
                        data-search-open
                        className="inline-flex items-center gap-1 font-medium text-ink-dim hover:text-ink"
                        disabled={busy || !ch}
                        onClick={() => {
                          // A result someone opens is one they were looking for.
                          if (submitted) recent.remember(submitted);
                          props.onJump(m.channelId, m.id);
                        }}
                      >
                        Open in conversation
                        <Icon name="arrow" size={12} />
                      </button>
                    </div>
                  </li>
                );
              })}
          </ul>
          <div
            hidden={page === 0 && !results.nextCursor}
            className="mt-4 flex justify-between text-sm font-medium text-ink-dim"
          >
            <button
              disabled={busy || page === 0}
              onClick={() =>
                submitted &&
                void search(submitted, cursors[page - 1], page - 1, cursors.slice(0, page))
              }
            >
              Previous page
            </button>
            <button
              disabled={busy || !results.nextCursor}
              onClick={() =>
                submitted &&
                results.nextCursor &&
                void search(submitted, results.nextCursor, page + 1, [
                  ...cursors,
                  results.nextCursor,
                ])
              }
            >
              Next page
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
