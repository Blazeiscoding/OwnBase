import { useEffect, useMemo, useState } from "react";
import type { ID, User } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { usePanelFocus } from "../lib/usePanelFocus.js";
import { AvatarWithPresence } from "./Avatar.js";
import { Icon } from "./Icon.js";
import { ListStatus } from "./ListStatus.js";

/**
 * Who is in this conversation, Discord's member list: online first, then
 * everyone else, each by name with their status. A direct message knows its
 * people already; a channel asks the server when the panel opens, and again
 * when someone joins or leaves.
 */
export function MembersPanel(props: {
  channelId: ID;
  onClose: () => void;
  onOpenProfile: (userId: ID) => void;
}) {
  const client = useClient();
  const channel = useWorkspace((s) => s.channels[props.channelId]);
  const users = useWorkspace((s) => s.users);
  const presence = useWorkspace((s) => s.presence);
  const known = channel?.memberIds;
  /** Asked again, in place, when someone joins or leaves. */
  const moved = useWorkspace((s) => s.memberChanges[props.channelId] ?? 0);
  const [loaded, setLoaded] = useState<ID[] | null>(known ?? null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const { panel, heading } = usePanelFocus({ takeFocus: true });

  useEffect(() => {
    if (known) {
      setLoaded(known);
      return;
    }
    let active = true;
    setFailed(false);
    client.api
      .channelMembers(props.channelId)
      .then((r) => active && setLoaded(r.memberIds))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [client, props.channelId, known, attempt, moved]);

  const { online, offline } = useMemo(() => {
    const people = (loaded ?? [])
      .map((id) => users[id])
      .filter((u): u is User => !!u && !u.deactivated)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    // Away is here too (E9), with its own mark.
    const here = (u: User) => presence[u.id] === "online" || presence[u.id] === "away";
    return {
      online: people.filter(here),
      offline: people.filter((u) => !here(u)),
    };
  }, [loaded, users, presence]);

  return (
    <aside
      ref={panel}
      aria-label="Members"
      className="flex w-[240px] max-w-full shrink-0 flex-col border-l border-edge"
    >
      <header className="flex h-12 shrink-0 items-center gap-1 pl-4 pr-2 shadow-[0_1px_0_var(--color-edge)]">
        <h2 ref={heading} tabIndex={-1} className="flex-1 text-[15px] font-semibold outline-none">
          Members
        </h2>
        <button
          onClick={props.onClose}
          aria-label="Close Members"
          className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-4">
        <ListStatus
          loading={loaded === null && !failed}
          placeholder={loaded === null}
          loadingLabel="Loading members…"
          error={failed ? "Could not load who is here." : null}
          onRetry={() => setAttempt((n) => n + 1)}
        />
        {loaded !== null && (
          <>
            <MemberGroup
              title={`Online — ${online.length}`}
              people={online}
              online
              away={(id) => presence[id] === "away"}
              onOpen={props.onOpenProfile}
            />
            <MemberGroup
              title={`Offline — ${offline.length}`}
              people={offline}
              online={false}
              onOpen={props.onOpenProfile}
            />
          </>
        )}
      </div>
    </aside>
  );
}

function MemberGroup(props: {
  title: string;
  people: User[];
  online: boolean;
  /** Who of those here is away (E9). */
  away?: (id: ID) => boolean;
  onOpen: (userId: ID) => void;
}) {
  if (props.people.length === 0) return null;
  return (
    <section aria-label={props.title} className="mb-4">
      <h3 className="mb-1 px-2 text-[12px] font-semibold uppercase tracking-[0.04em] text-ink-faint">
        {props.title}
      </h3>
      <ul>
        {props.people.map((user) => (
          <li key={user.id}>
            <button
              onClick={() => props.onOpen(user.id)}
              // Away reads quieter in its words, not faded, so it stays readable.
              className={`group/member flex h-[42px] w-full items-center gap-3 rounded-lg px-2 text-left transition-colors duration-100 hover:bg-ink/[0.06] ${
                props.online ? "text-ink" : "text-ink-faint hover:text-ink-dim"
              }`}
            >
              <AvatarWithPresence
                user={user}
                online={props.online && !props.away?.(user.id)}
                away={props.away?.(user.id) ?? false}
                size={32}
                ring="var(--color-ground)"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-medium">{user.displayName}</span>
                {user.statusText || user.statusEmoji ? (
                  <span className="block truncate text-[12px] text-ink-faint">
                    {`${user.statusEmoji ?? ""} ${user.statusText ?? ""}`.trim()}
                  </span>
                ) : (
                  // Away is said in words too, not only by its ring (E9).
                  props.away?.(user.id) && (
                    <span className="block truncate text-[12px] text-ink-faint">Away</span>
                  )
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
