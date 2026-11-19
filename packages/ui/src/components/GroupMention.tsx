import { useRef, useState } from "react";
import { groupMentionLabel, type ID, type User, type UserGroup } from "@ownbase/protocol";
import { useWorkspace } from "../context.js";
import { groupSize } from "../lib/userGroups.js";
import { Avatar } from "./Avatar.js";
import { Popover } from "./Popover.js";

/**
 * A user group named in a message (J13): a chip with its handle now, which
 * opens the list of who is in it. One the reader is in is drawn as
 * addressing them. A group that is gone, or one a guest is not shown, reads
 * as the label it was sent with, as plain text.
 */
export function GroupMention({
  group,
  label,
  selfId,
}: {
  group: UserGroup | undefined;
  label: string | null;
  selfId?: ID;
}) {
  const chip = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const shown = groupMentionLabel(group, label);
  if (!group) return <>{shown}</>;
  const mine = !!selfId && group.memberIds.includes(selfId);
  return (
    <>
      <button
        ref={chip}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={`rounded px-1 font-medium text-ink hover:underline ${mine ? "bg-copper/25" : "bg-ink/[0.07]"}`}
      >
        {shown}
      </button>
      {open && (
        <Popover
          label={`Who is in ${shown}`}
          anchor={chip}
          align="start"
          onClose={() => setOpen(false)}
        >
          <GroupMembers group={group} shown={shown} selfId={selfId} />
        </Popover>
      )}
    </>
  );
}

/**
 * Who is in a group, by name. Read from every person the workspace knows: a
 * message picks only the people it names.
 */
function GroupMembers({ group, shown, selfId }: { group: UserGroup; shown: string; selfId?: ID }) {
  const users = useWorkspace((s) => s.users);
  const people = group.memberIds
    .map((id) => users[id])
    .filter((user): user is User => !!user && !user.deactivated)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return (
    <div className="p-3">
      <p className="text-sm font-semibold text-ink">{group.name}</p>
      <p className="text-xs text-ink-faint">
        {shown}, {groupSize(group)}
      </p>
      {group.description && <p className="mt-1.5 text-xs text-ink-dim">{group.description}</p>}
      {people.length > 0 && (
        <ul className="mt-2 space-y-1">
          {people.map((user) => (
            <li key={user.id} className="flex items-center gap-2 text-sm">
              <Avatar user={user} size={20} />
              <span className="truncate">{user.displayName}</span>
              {user.id === selfId && <span className="text-xs text-ink-faint">(you)</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
