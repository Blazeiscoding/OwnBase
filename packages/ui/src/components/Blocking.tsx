import { useState } from "react";
import type { ID } from "@ownbase/protocol";
import { useClient, useWorkspace } from "../context.js";
import { Avatar } from "./Avatar.js";
import { Icon } from "./Icon.js";
import { buttonClass } from "./Button.js";

/** Unblocks someone, saying when it did not work (E12). */
function useUnblock(userId: ID) {
  const client = useClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function unblock() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await client.setBlocked(userId, false);
    setBusy(false);
    setFailed(!ok);
  }
  return { busy, failed, unblock };
}

/**
 * In place of the composer, in a direct message with someone this account
 * blocked (E12): nothing goes to them until they are unblocked.
 */
export function BlockedComposer({ userId }: { userId: ID }) {
  const name = useWorkspace((s) => s.users[userId]?.displayName ?? "this person");
  const { busy, failed, unblock } = useUnblock(userId);
  return (
    <div className="shrink-0 px-4 pb-5">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-edge bg-ink/[0.03] px-4 py-3">
        <Icon name="ban" size={16} className="shrink-0 text-ink-faint" />
        <p className="min-w-0 flex-1 text-sm text-ink-dim">
          You blocked {name}. Their messages are folded away, and you cannot write to them here
          until you unblock them.
        </p>
        <button
          type="button"
          className={buttonClass("secondary")}
          aria-disabled={busy || undefined}
          onClick={() => void unblock()}
        >
          {busy ? "Unblocking…" : "Unblock"}
        </button>
      </div>
      {failed && (
        <p role="alert" className="mt-2 text-sm text-alert">
          Could not unblock {name}. Check your connection and try again.
        </p>
      )}
    </div>
  );
}

/** One blocked person in Account settings, with Unblock. */
function BlockedRow({ userId }: { userId: ID }) {
  const user = useWorkspace((s) => s.users[userId]);
  const { busy, failed, unblock } = useUnblock(userId);
  const name = user?.displayName ?? "Someone who left";
  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5">
      <Avatar user={user} size={28} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name}</p>
        {user && <p className="truncate font-mono text-[11px] text-ink-faint">@{user.handle}</p>}
        {failed && (
          <p role="alert" className="text-xs text-alert">
            Not unblocked. Try again.
          </p>
        )}
      </div>
      <button
        type="button"
        className={buttonClass("secondary")}
        aria-label={`Unblock ${name}`}
        aria-disabled={busy || undefined}
        onClick={() => void unblock()}
      >
        {busy ? "Unblocking…" : "Unblock"}
      </button>
    </li>
  );
}

/**
 * Account settings > Security's list of the people this account blocked
 * (E12). Absent where the server does not block.
 */
export function BlockedPeople() {
  const blocked = useWorkspace((s) => s.blocked);
  if (blocked === null) return null;
  return (
    <section aria-labelledby="account-blocked-title" className="mt-6 border-t border-edge pt-5">
      <h3 id="account-blocked-title" className="font-semibold">
        Blocked people
      </h3>
      <p className="mt-1 text-sm text-ink-dim">
        You hear nothing from them: their messages fold away, they never notify you, and your direct
        messages with them close. They are not told.
      </p>
      {blocked.length === 0 ? (
        <p className="mt-3 text-sm text-ink-faint">
          You have not blocked anyone. Block someone from their profile.
        </p>
      ) : (
        <ul aria-label="Blocked people" className="mt-2 divide-y divide-edge">
          {blocked.map((id) => (
            <BlockedRow key={id} userId={id} />
          ))}
        </ul>
      )}
    </section>
  );
}
