import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { AuditEntry, ID, User } from "@ownbase/protocol";
import { useClient, useWorkspace } from "../context.js";
import { formatDay, formatTime } from "../lib/format.js";
import { ListStatus } from "./ListStatus.js";

/**
 * One entry as a sentence an administrator would say. Names are looked up at
 * the moment of reading, so a renamed person reads under their current name;
 * the record itself keeps only ids.
 */
export function describeAuditEntry(
  entry: AuditEntry,
  users: Record<ID, User>,
  selfId: ID | undefined,
): string {
  const name = (id: string | null | undefined, fallback: string) =>
    !id ? fallback : id === selfId ? "you" : (users[id]?.displayName ?? fallback);
  const actor = entry.actorId === null ? "The host" : capitalise(name(entry.actorId, "Someone"));
  const target = name(entry.targetId, "an account");
  const app = typeof entry.details.name === "string" ? entry.details.name : "an app";
  const d = entry.details;
  // Each detail read defensively: an entry written by a newer server, or one
  // missing a field, should read as a shorter sentence rather than "undefined".
  const has = (key: string) => typeof d[key] === "string" || typeof d[key] === "number";
  const at = (key: string, before: string) => (has(key) ? `${before}${d[key]}` : "");

  switch (entry.action) {
    case "user.role_changed":
      return has("from") && has("to")
        ? `${actor} changed ${possessive(target)} role from ${d.from} to ${d.to}`
        : `${actor} changed ${possessive(target)} role`;
    case "user.deactivated":
      return `${actor} deactivated ${target}`;
    case "user.reactivated":
      return `${actor} reactivated ${target}`;
    case "user.password_reset":
      return `${actor} reset ${possessive(target)} password`;
    case "user.two_step_reset":
      return `${actor} turned off ${possessive(target)} two-step sign-in`;
    case "report.resolved": {
      // How many reports it settled, and what was done (E12); never what it said.
      const reports =
        typeof d.reports === "number" && d.reports > 1 ? `${d.reports} reports` : "a report";
      return d.resolution === "dismiss"
        ? `${actor} dismissed ${reports} about ${possessive(target)} message`
        : `${actor} removed ${possessive(target)} message after ${reports}`;
    }
    case "user.invite_permission_granted":
      return `${actor} allowed ${target} to create invite codes`;
    case "user.invite_permission_removed":
      return `${actor} stopped ${target} creating invite codes`;
    case "account.recovered":
      return `The host recovered ${possessive(target)} account from the server's command line${
        d.madeOwner ? " and made them the owner" : ""
      }${d.twoStepCleared ? `${d.madeOwner ? "," : ""} and turned off their two-step sign-in` : ""}`;
    case "workspace.ownership_transferred":
      return `${actor} handed the workspace over to ${target}`;
    case "workspace.renamed":
      return has("to")
        ? `${actor} renamed the workspace${at("from", " from ")} to ${d.to}`
        : `${actor} renamed the workspace`;
    case "workspace.access_policy_changed":
      return typeof d.to === "string" && d.to in WHO_CAN_JOIN
        ? `${actor} changed who can join to ${WHO_CAN_JOIN[d.to]}`
        : `${actor} changed who can join`;
    case "workspace.icon_changed":
      return d.change === "removed"
        ? `${actor} removed the workspace's icon`
        : `${actor} changed the workspace's icon`;
    case "workspace.link_previews_changed":
      return d.to === false
        ? `${actor} turned off link previews`
        : `${actor} turned on link previews`;
    case "workspace.copy_made":
      return `${actor} made a copy of the workspace to download`;
    case "workspace.copy_downloaded":
      return `${actor} downloaded a copy of the workspace`;
    case "app.created":
      return `${actor} created the app ${app}`;
    case "app.deleted":
      return `${actor} deleted the app ${app}`;
    case "app.token_replaced":
      return `${actor} replaced ${possessive(app)} bot token`;
    case "app.signing_secret_replaced":
      return `${actor} replaced ${possessive(app)} signing secret`;
    case "app.interactivity_url_changed":
      return d.cleared
        ? `${actor} turned off ${possessive(app)} buttons and forms`
        : `${actor} changed where ${possessive(app)} buttons and forms go${at("host", ", to ")}`;
    case "app.scopes_changed": {
      // Scope names, as the app's own documentation gives them (E18c).
      const allowed = typeof d.added === "string" && d.added ? `allowed ${d.added}` : "";
      const taken = typeof d.removed === "string" && d.removed ? `took away ${d.removed}` : "";
      const what = [allowed, taken].filter(Boolean).join("; ");
      return `${actor} changed what ${app} may do${what ? `: ${what}` : ""}`;
    }
    case "webhook.created":
      return `${actor} added a webhook for ${app}`;
    case "webhook.url_replaced":
      return `${actor} replaced a webhook URL for ${app}`;
    case "webhook.deleted":
      return `${actor} removed a webhook from ${app}`;
    case "command.created":
      return `${actor} added ${has("command") ? d.command : "a command"} to ${app}${at("host", ", calling ")}`;
    case "command.deleted":
      return `${actor} removed ${typeof d.command === "string" ? d.command : "a command"} from ${app}`;
    case "subscription.created":
      return `${actor} started sending events to ${app}${at("host", " at ")}`;
    case "subscription.retried":
      return has("retried")
        ? `${actor} retried ${d.retried} failed ${d.retried === 1 ? "delivery" : "deliveries"} for ${app}`
        : `${actor} retried failed deliveries for ${app}`;
    case "subscription.deleted":
      return `${actor} stopped sending events to ${app}${at("host", " at ")}`;
    case "invite.created":
      return `${actor} created an invite code`;
    case "invite.revoked":
      return `${actor} revoked an invite code`;
  }
}

/** Who may join, as the record's sentences say it. */
const WHO_CAN_JOIN: Record<string, string> = {
  invite_only: "people with an invite",
  account_required: "anyone who creates an account",
  guest_allowed: "anyone, guests included",
};

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function possessive(text: string): string {
  if (text === "you") return "your";
  return text.endsWith("s") ? `${text}'` : `${text}'s`;
}

/**
 * What administrators have changed, for a workspace that has to be able to say
 * who deactivated someone or replaced an app's token. Closed until asked for:
 * it is something looked up, not something to read every time.
 */
export function AuditHistory() {
  const client = useClient();
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  const section = useRef<HTMLElement>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"initial" | "page" | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (open) section.current?.focus({ preventScroll: true });
  }, [open]);

  async function load(before?: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const page = await client.api.listAudit(before);
      if (!alive.current) return;
      setEntries((current) => {
        if (!before || !current) return page.entries;
        const seen = new Set(current.map((entry) => entry.id));
        return [...current, ...page.entries.filter((entry) => !seen.has(entry.id))];
      });
      setCursor(page.nextCursor);
      setError(null);
    } catch {
      if (alive.current) setError(before ? "page" : "initial");
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => {
          setOpen(true);
          void load();
        }}
        className="mt-3 text-[12px] text-ink-faint underline transition-colors hover:text-ink"
      >
        Show recent changes
      </button>
    );
  }

  return (
    <section ref={section} tabIndex={-1} className="mt-4 outline-none" aria-label="Recent changes">
      <div className="mb-2 text-[13px] font-medium text-ink-dim">Recent changes</div>
      <ListStatus
        loading={busy}
        placeholder={entries === null}
        loadingLabel={entries === null ? "Loading recent changes…" : "Loading older changes…"}
        error={
          error === "initial"
            ? "Could not load recent changes. Check your connection and try again."
            : error === "page"
              ? "Could not load older changes. Try again."
              : null
        }
        onRetry={error === "initial" ? () => void load() : undefined}
        empty={entries?.length === 0 && !cursor && !error ? "Nothing has been changed yet." : null}
      />
      {entries && entries.length > 0 && (
        <ul aria-busy={busy} className="max-h-64 space-y-1 overflow-y-auto text-[13px]">
          {entries.map((entry) => (
            <li key={entry.id} className="flex gap-3 rounded px-1 py-1">
              <span className="min-w-0 flex-1 text-ink-dim">
                {describeAuditEntry(entry, users, selfId)}
              </span>
              <time
                dateTime={new Date(entry.at).toISOString()}
                className="shrink-0 text-[11px] text-ink-faint"
              >
                {formatDay(entry.at)} {formatTime(entry.at)}
              </time>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex gap-3">
        {cursor && (
          <PaginationButton
            busy={busy}
            home={section}
            onClick={() => void load(cursor)}
            label={error === "page" ? "Retry older changes" : "Show older changes"}
          />
        )}
      </div>
    </section>
  );
}

/** Keep keyboard focus in the history section when the final page removes this button. */
function PaginationButton({
  busy,
  home,
  onClick,
  label,
}: {
  busy: boolean;
  home: RefObject<HTMLElement | null>;
  onClick: () => void;
  label: string;
}) {
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const element = button.current;
    return () => {
      if (document.activeElement === element) home.current?.focus({ preventScroll: true });
    };
  }, [home]);
  return (
    <button
      ref={button}
      type="button"
      aria-disabled={busy || undefined}
      onClick={() => {
        if (!busy) onClick();
      }}
      className="text-[12px] text-ink-faint underline transition-colors hover:text-ink aria-disabled:opacity-40"
    >
      {label}
    </button>
  );
}
