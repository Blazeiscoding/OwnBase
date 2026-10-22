import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FileKind, FileMeta, ID, SharedFile } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle, formatBytes, formatFull, formatWhen } from "../lib/format.js";
import { usePagedList } from "../lib/pagedList.js";
import { usePanelFocus } from "../lib/usePanelFocus.js";
import { useTabs } from "../lib/useTabs.js";
import {
  Lightbox,
  iconFor,
  opensAsPicture,
  useFileDownload,
  useFileResource,
} from "./Attachments.js";
import { Icon } from "./Icon.js";
import { inputCls } from "./TextField.js";
import { ListStatus } from "./ListStatus.js";
import { LoadMore } from "./LoadMore.js";
import { Tooltip } from "./Tooltip.js";

type Kind = "all" | FileKind;
const KINDS: readonly Kind[] = ["all", "image", "document", "other"];
const KIND_NAMES: Record<Kind, string> = {
  all: "All",
  image: "Images",
  document: "Documents",
  other: "Other",
};
/** How long typing rests before the list is asked again. */
const SEARCH_REST_MS = 250;

/** A listed file, known by its own id as the paged list needs. */
type Row = SharedFile & { id: string };

/**
 * Every file shared in the conversations this person can read (E7), newest
 * first, from the server a page at a time. Narrowed by kind, by who shared it,
 * by conversation and by words in its name. A row opens the file, a picture in
 * the viewer and anything else saved, and Show in conversation goes to the
 * message that shared it.
 */
export function FilesPanel({
  channelId: initialChannelId,
  onClose,
  onJump,
}: {
  /** A conversation to start in, as its menu's Files does. */
  channelId?: ID;
  onClose: () => void;
  onJump: (channelId: ID, messageId: ID) => void;
}) {
  const client = useClient();
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const memberships = useWorkspace((s) => s.memberships);
  const selfId = useWorkspace((s) => s.self?.id);
  const changedContent = useWorkspace((s) => s.changedContent);
  const [kind, setKind] = useState<Kind>("all");
  const [userId, setUserId] = useState("");
  const [channelId, setChannelId] = useState(initialChannelId ?? "");
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [viewing, setViewing] = useState<FileMeta | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const fromId = useId();
  const inId = useId();
  const { panel, heading } = usePanelFocus({ takeFocus: true });
  const tabs = useTabs({ label: "Kind of file", tabs: KINDS, selected: kind, onSelect: setKind });

  useEffect(() => {
    const rest = setTimeout(() => setSearch(typed.trim()), SEARCH_REST_MS);
    return () => clearTimeout(rest);
  }, [typed]);

  const filter = {
    ...(kind === "all" ? {} : { kind }),
    ...(userId ? { userId } : {}),
    ...(channelId ? { channelId } : {}),
    ...(search ? { q: search } : {}),
  };
  const filtered = Object.keys(filter).length > 0;
  const paged = usePagedList<Row>(
    (cursor, signal) =>
      client.api.listSharedFiles(filter, cursor, signal).then((page) => ({
        items: page.files.map((f) => ({ ...f, id: f.file.id })),
        nextCursor: page.nextCursor,
      })),
    JSON.stringify(filter),
  );
  const { list, items } = paged;

  useEffect(() => {
    // Another list starts at its top.
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [kind, userId, channelId, search]);

  // A message listed here was edited or deleted, or its conversation lost
  // history: what is listed may be out of date.
  const heardChanges = useRef(changedContent);
  useEffect(() => {
    const before = heardChanges.current;
    heardChanges.current = changedContent;
    if (items?.some((f) => changedContent[f.channelId] !== before[f.channelId])) list.refresh();
  }, [list, changedContent, items]);

  const people = useMemo(
    () =>
      Object.values(users)
        .filter((u) => !u.deactivated || u.id === userId)
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [users, userId],
  );
  const name = (id: ID) => channelTitle(channels[id]!, users, selfId);
  const places = useMemo(
    () =>
      Object.values(channels)
        .filter((c) => c.id in memberships || c.type === "public")
        .map((c) => ({ id: c.id, title: channelTitle(c, users, selfId) }))
        .sort((a, b) => a.title.localeCompare(b.title)),
    [channels, memberships, users, selfId],
  );

  function clearFilters() {
    setKind("all");
    setUserId("");
    setChannelId("");
    setTyped("");
    setSearch("");
  }

  const select =
    "h-8 w-full min-w-0 rounded-lg border border-edge bg-transparent px-2 text-[13px] text-ink outline-none transition-colors hover:border-ink/25 focus-visible:border-copper";

  return (
    <aside
      ref={panel}
      aria-label="Files"
      className="flex w-[380px] max-w-full shrink-0 flex-col border-l border-edge"
    >
      <header className="flex h-12 shrink-0 items-center gap-1 pl-4 pr-2 shadow-[0_1px_0_var(--color-edge)]">
        <h2 ref={heading} tabIndex={-1} className="flex-1 text-[15px] font-semibold outline-none">
          Files
        </h2>
        <button
          onClick={onClose}
          aria-label="Close Files"
          className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="space-y-2 px-3 pt-3">
        <div className="relative">
          <Icon
            name="search"
            size={15}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint"
          />
          <input
            type="search"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="Search by name"
            aria-label="Search files by name"
            className={`${inputCls} h-9 pl-8`}
          />
        </div>
        <div
          {...tabs.listProps}
          className="flex gap-1 rounded-xl border border-edge bg-deep/40 p-1"
        >
          {KINDS.map((value) => (
            <button
              key={value}
              {...tabs.tabProps(value)}
              className={`flex-1 rounded-md px-2 py-1.5 text-[13px] font-medium transition-colors ${
                kind === value
                  ? "bg-lifted text-ink shadow-[0_1px_2px_rgb(0_0_0/0.2)]"
                  : "text-ink-faint hover:text-ink"
              }`}
            >
              {KIND_NAMES[value]}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="min-w-0">
            <label htmlFor={fromId} className="mb-1 block text-[12px] text-ink-faint">
              From
            </label>
            <select
              id={fromId}
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              className={select}
            >
              <option value="">Anyone</option>
              {people.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.id === selfId ? `${u.displayName} (you)` : u.displayName}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-0">
            <label htmlFor={inId} className="mb-1 block text-[12px] text-ink-faint">
              In
            </label>
            <select
              id={inId}
              value={channelId}
              onChange={(event) => setChannelId(event.target.value)}
              className={select}
            >
              <option value="">Anywhere</option>
              {places.map((place) => (
                <option key={place.id} value={place.id}>
                  {place.title}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      <div
        {...tabs.panelProps}
        ref={scroller}
        className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-3"
        aria-busy={paged.loading || paged.refreshing}
      >
        <ListStatus
          loading={paged.loading}
          placeholder={items === null}
          loadingLabel="Loading files…"
          error={
            paged.failed ? `Could not load files.${items ? " What was shown is kept." : ""}` : null
          }
          onRetry={() => list.retry()}
          empty={
            items?.length === 0 && !paged.nextCursor
              ? filtered
                ? "No files match. Try other words, or another person, conversation or kind."
                : "No files shared yet. Files sent in conversations you can read show here."
              : null
          }
          emptyIcon="file"
          emptyAction={filtered ? { label: "Clear filters", run: clearFilters } : undefined}
        />
        <ul aria-label="Files" className="space-y-0.5">
          {(items ?? []).map((shared) => (
            <FileRow
              key={shared.id}
              shared={shared}
              who={users[shared.userId]?.displayName ?? "someone"}
              where={channels[shared.channelId] ? name(shared.channelId) : "a conversation"}
              onView={setViewing}
              onJump={() => onJump(shared.channelId, shared.messageId)}
            />
          ))}
        </ul>
        <LoadMore
          more={!!paged.nextCursor}
          loading={paged.loadingMore}
          failed={paged.moreFailed}
          count={items?.length ?? 0}
          onMore={() => list.loadMore()}
          scroller={scroller}
        />
      </div>
      {viewing && <Lightbox file={viewing} onClose={() => setViewing(null)} />}
    </aside>
  );
}

/**
 * One file: pressing it opens it, a picture in the viewer and anything else
 * saved; beside it, Show in conversation. Its picture loads once it scrolls near.
 */
function FileRow({
  shared,
  who,
  where,
  onView,
  onJump,
}: {
  shared: SharedFile;
  who: string;
  where: string;
  onView: (file: FileMeta) => void;
  onJump: () => void;
}) {
  const { file } = shared;
  const picture = opensAsPicture(file);
  const download = useFileDownload(file);
  return (
    <li>
      <div className="group flex items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-ink/[0.04]">
        <button
          type="button"
          onClick={() => (picture ? onView(file) : void download.save())}
          aria-label={`${picture ? "Open" : "Download"} ${file.name}, ${formatBytes(file.size)}, from ${who} in ${where}, ${formatWhen(shared.sharedAt)}`}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left"
        >
          {file.mime.startsWith("image/") ? (
            <Thumbnail file={file} />
          ) : (
            <span
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-lifted text-copper"
            >
              <Icon name={iconFor(file.mime, file.name)} size={18} />
            </span>
          )}
          <span aria-hidden="true" className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-ink">{file.name}</span>
            <span className="flex gap-1 text-[12px] text-ink-faint">
              <span className="truncate">
                {download.saving
                  ? download.native
                    ? "Preparing download…"
                    : "Downloading…"
                  : `${formatBytes(file.size)} · ${who} in ${where}`}
              </span>
              <time
                dateTime={new Date(shared.sharedAt).toISOString()}
                title={formatFull(shared.sharedAt)}
                className="ml-auto shrink-0 pl-1"
              >
                {formatWhen(shared.sharedAt)}
              </time>
            </span>
          </span>
        </button>
        <Tooltip label="Show in conversation">
          <button
            type="button"
            onClick={onJump}
            aria-label={`Show ${file.name} in conversation`}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.07] hover:text-ink"
          >
            <Icon name="arrow" size={15} />
          </button>
        </Tooltip>
      </div>
      {download.error && (
        <p role="alert" className="mx-2 mb-1 text-[13px] text-alert">
          {download.error}
        </p>
      )}
      {download.handedOff && (
        <p role="status" className="mx-2 mb-1 text-[12px] text-ink-dim">
          Download handed to your browser or device. Check its downloads.
        </p>
      )}
    </li>
  );
}

/** A picture's small square, loaded once it is near the screen. */
function Thumbnail({ file }: { file: FileMeta }) {
  const box = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = box.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setVisible(true);
      },
      { rootMargin: "120px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Only what a message would show inline is fetched; a larger picture keeps its mark.
  const { url } = useFileResource(file.id, visible && opensAsPicture(file));
  const [broken, setBroken] = useState(false);
  return (
    <span
      ref={box}
      aria-hidden="true"
      className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-lifted text-copper"
    >
      {url && !broken ? (
        <img
          src={url}
          alt=""
          decoding="async"
          onError={() => setBroken(true)}
          className="size-full object-cover"
        />
      ) : (
        <Icon name={iconFor(file.mime, file.name)} size={18} />
      )}
    </span>
  );
}
