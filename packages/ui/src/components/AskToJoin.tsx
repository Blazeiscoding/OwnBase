import { useEffect, useId, useMemo, useState } from "react";
import { ApiError } from "@ownbase/client-core";
import type { ID, User } from "@ownbase/protocol";
import { useClient, useWorkspace } from "../context.js";
import { AddPeople } from "./AddPeople.js";
import { Avatar } from "./Avatar.js";
import { Dialog } from "./Dialog.js";

/**
 * Asks members of a channel into its call (K18). Each one chosen is rung,
 * as a direct call rings, and their card names the channel; how it went
 * shows beside each name here, and a decline in the call's own line.
 */
export function AskToJoin({ channelId, onClose }: { channelId: ID; onClose: () => void }) {
  const client = useClient();
  const name = useWorkspace((s) => s.channels[channelId]?.name);
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  const blocked = useWorkspace((s) => s.blocked);
  const inCall = useWorkspace((s) => s.huddles[channelId]);
  const ringing = useWorkspace((s) => s.rings[channelId]?.ringing);
  const [memberIds, setMemberIds] = useState<ID[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [asked, setAsked] = useState<ID[]>([]);
  const askedId = useId();

  useEffect(() => {
    let live = true;
    void client.channelMembers(channelId).then((ids) => {
      if (!live) return;
      if (ids instanceof ApiError) setFailed(true);
      else setMemberIds(ids);
    });
    return () => {
      live = false;
    };
  }, [client, channelId]);

  const where = `#${name ?? "this channel"}`;
  const candidates = useMemo(
    () =>
      (memberIds ?? []).flatMap((id): User[] => {
        const user = users[id];
        return user &&
          !user.isBot &&
          !user.deactivated &&
          id !== selfId &&
          !blocked.includes(id) &&
          !inCall?.includes(id) &&
          !ringing?.includes(id)
          ? [user]
          : [];
      }),
    [memberIds, users, selfId, blocked, inCall, ringing],
  );
  const state = (id: ID) =>
    inCall?.includes(id) ? "In the call" : ringing?.includes(id) ? "Ringing…" : "Not in the call";

  return (
    <Dialog title="Ask someone to join" onClose={onClose} width={440}>
      <p className="mb-4 text-sm text-ink-dim">
        Each person you choose gets a ring asking them to join the call in {where}.
      </p>
      {failed ? (
        <p role="alert" className="text-sm text-alert">
          Could not load who is in {where}. Check your connection, then try again.
        </p>
      ) : memberIds === null ? (
        <p role="status" className="text-sm text-ink-faint">
          Loading who is in {where}…
        </p>
      ) : (
        <AddPeople
          candidates={candidates}
          where={where}
          label={`Find someone in ${where}`}
          action="Ring"
          none={`Everyone in ${where} is in the call or being rung.`}
          quiet
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the dialog is opened to choose someone
          autoFocus
          onAdd={async (userId) => {
            client.ringIntoCall(userId);
            setAsked((before) => [userId, ...before.filter((id) => id !== userId)]);
            return true;
          }}
        />
      )}
      {asked.length > 0 && (
        <>
          <h3 id={askedId} className="mb-1.5 mt-5 text-[13px] font-semibold">
            Asked
          </h3>
          <ul aria-labelledby={askedId} className="space-y-0.5">
            {asked.map((id) => (
              <li
                key={id}
                className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-ink"
              >
                <Avatar user={users[id]} size={24} />
                <span className="min-w-0 flex-1 truncate">
                  {users[id]?.displayName ?? "Someone"}
                </span>
                <span className="shrink-0 text-[12px] text-ink-dim">{state(id)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}
