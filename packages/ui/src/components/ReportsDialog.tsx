import { useCallback, useEffect, useRef, useState } from "react";
import { readableText } from "@slackoss/client-core";
import type { ReportedMessage, ReportResolution, User } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { accountError } from "../lib/account.js";
import { REPORT_REASON_LABELS } from "../lib/blocking.js";
import { channelTitle, formatFull, formatWhen } from "../lib/format.js";
import { Avatar } from "./Avatar.js";
import { Dialog } from "./Dialog.js";
import { ListStatus } from "./ListStatus.js";
import { useConfirm } from "./Confirm.js";
import { buttonClass } from "./Button.js";

/**
 * The admins' queue of reported messages (E12): each with where and when it
 * was posted, who reported it and why, and what to do about it. It asks
 * again whenever the count of waiting reports moves, from any admin.
 */
export function ReportsDialog({ onClose }: { onClose: () => void }) {
  const client = useClient();
  const self = useWorkspace((s) => s.self);
  const users = useWorkspace((s) => s.users);
  const open = useWorkspace((s) => s.openReports);
  const confirm = useConfirm();
  const [reports, setReports] = useState<ReportedMessage[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  const version = useRef(0);

  const load = useCallback(async () => {
    const mine = ++version.current;
    setLoading(true);
    try {
      const result = await client.api.listReports();
      if (!alive.current || mine !== version.current) return;
      setReports(result.reports);
      setLoadError(false);
    } catch {
      if (alive.current && mine === version.current) setLoadError(true);
    } finally {
      if (alive.current && mine === version.current) setLoading(false);
    }
  }, [client]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // On opening, and each time a report arrives or another admin settles one.
  useEffect(() => void load(), [load, open]);

  async function settle(item: ReportedMessage, action: ReportResolution) {
    if (busy) return;
    const author = users[item.authorId];
    const name = author?.displayName ?? "its author";
    if (action !== "dismiss") {
      const go = await confirm({
        title: action === "remove" ? "Remove this message?" : `Remove it and deactivate ${name}?`,
        body:
          action === "remove"
            ? "Everyone in the conversation stops seeing it, and its thread's replies go with it."
            : `The message goes for everyone, and ${name} is signed out everywhere and cannot sign in again until an admin reactivates them in People.`,
        confirmLabel: action === "remove" ? "Remove" : "Remove and deactivate",
        destructive: true,
      });
      if (!go) return;
    }
    setBusy(item.messageId);
    setError(null);
    setNotice(null);
    try {
      await client.api.resolveReport(item.messageId, action);
      if (!alive.current) return;
      setReports((list) => list?.filter((other) => other.messageId !== item.messageId) ?? list);
      setNotice(
        action === "dismiss"
          ? "Dismissed. The message stays."
          : action === "remove"
            ? `${possessive(name)} message is removed.`
            : `${possessive(name)} message is removed, and ${name} is deactivated.`,
      );
    } catch (err) {
      if (alive.current) setError(accountError(err));
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  return (
    <Dialog title="Reported messages" onClose={onClose} width={640} dismissible={!busy}>
      <p className="mb-3 text-sm text-ink-dim">
        Messages people reported to the admins. Whoever wrote one is not told it was reported, or by
        whom.
      </p>
      {error && (
        <p
          role="alert"
          className="mb-3 rounded-lg border border-alert/30 bg-alert/10 p-3 text-sm text-alert"
        >
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-3 rounded-lg bg-online/10 p-3 text-sm text-online">
          {notice}
        </p>
      )}
      <ListStatus
        loading={loading && !reports}
        placeholder={!reports}
        loadingLabel="Loading reported messages…"
        error={loadError ? "Could not load reported messages." : null}
        retryLabel="Try again"
        onRetry={() => void load()}
        empty={
          reports && reports.length === 0
            ? "Nothing is waiting. Reports appear here as people send them."
            : null
        }
      />
      {reports && reports.length > 0 && (
        <ul aria-label="Reported messages" className="space-y-3">
          {reports.map((item) => (
            <Reported
              key={item.messageId}
              item={item}
              users={users}
              self={self}
              busy={busy === item.messageId}
              disabled={busy !== null}
              onSettle={(action) => void settle(item, action)}
            />
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** One reported message, its reports, and Dismiss, Remove and Remove and deactivate. */
function Reported({
  item,
  users,
  self,
  busy,
  disabled,
  onSettle,
}: {
  item: ReportedMessage;
  users: Record<string, User>;
  self: User | null;
  busy: boolean;
  disabled: boolean;
  onSettle: (action: ReportResolution) => void;
}) {
  const client = useClient();
  const author = users[item.authorId];
  const name = author?.displayName ?? "Someone who left";
  const where =
    item.channel.type === "public" || item.channel.type === "private"
      ? `#${item.channel.name}`
      : `${item.channel.type === "dm" ? "Direct message" : "Group DM"}: ${channelTitle(item.channel, users, undefined)}`;
  // People's rules for deactivating, so a button that would be refused is not offered.
  const deactivatable =
    !!author &&
    !author.deactivated &&
    author.id !== self?.id &&
    author.role !== "owner" &&
    (author.role !== "admin" || self?.role === "owner");
  return (
    <li
      aria-label={`${possessive(name)} message in ${where}`}
      className="rounded-xl border border-edge p-3.5"
    >
      <div className="flex gap-3">
        <Avatar user={author} size={32} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-medium">{name}</span>
            <span className="text-[12px] text-ink-faint">
              {where}
              {item.message && (
                <>
                  {" · "}
                  <time title={formatFull(item.message.createdAt)}>
                    {formatWhen(item.message.createdAt)}
                  </time>
                </>
              )}
            </span>
          </p>
          {item.message ? (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {readableText(client.state, item.message.text) ||
                (item.message.files.length > 0 ? "(files only)" : "(no text)")}
            </p>
          ) : (
            <p className="mt-1 text-sm italic text-ink-faint">Its author deleted it.</p>
          )}
        </div>
      </div>
      <ul aria-label="Reports" className="mt-3 space-y-1 border-t border-edge pt-2.5">
        {item.reports.map((report) => (
          <li key={report.id} className="text-[13px] text-ink-dim">
            <span className="font-medium text-ink">
              {users[report.reporterId]?.displayName ?? "Someone"}
            </span>
            : {REPORT_REASON_LABELS[report.reason] ?? report.reason}
            {report.note && <span className="text-ink-faint"> · &ldquo;{report.note}&rdquo;</span>}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className={buttonClass("secondary")}
          aria-disabled={disabled || undefined}
          onClick={() => onSettle("dismiss")}
        >
          {busy ? "Saving…" : "Dismiss"}
        </button>
        {item.message && (
          <button
            type="button"
            className={buttonClass("secondary")}
            aria-disabled={disabled || undefined}
            onClick={() => onSettle("remove")}
          >
            Remove message
          </button>
        )}
        {deactivatable && (
          <button
            type="button"
            className={buttonClass("danger")}
            aria-disabled={disabled || undefined}
            onClick={() => onSettle("deactivate")}
          >
            {item.message ? `Remove and deactivate ${name}` : `Deactivate ${name}`}
          </button>
        )}
      </div>
    </li>
  );
}

function possessive(name: string): string {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}
