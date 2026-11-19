import { useMemo, useRef, useState } from "react";
import { handleSchema, type ID, type User, type UserGroup } from "@ownbase/protocol";
import { ApiError } from "@ownbase/client-core";
import { useClient, useWorkspace } from "../context.js";
import { failureText } from "../lib/failure.js";
import { groupSize } from "../lib/userGroups.js";
import { Avatar } from "./Avatar.js";
import { buttonClass } from "./Button.js";
import { useConfirm } from "./Confirm.js";
import { inputCls, TextField } from "./TextField.js";

/** What the form is open for: a new group, or one being changed. */
type Editing = { kind: "new" } | { kind: "edit"; group: UserGroup };

/**
 * User groups (J13), for admins in People: make one, rename it, choose who is
 * in it, delete it. Mentioning a group notifies its people who are in the
 * conversation, so the list says how many each holds.
 */
export function UserGroupsSection() {
  const client = useClient();
  const confirm = useConfirm();
  const groups = useWorkspace((s) => s.userGroups);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sorted = useMemo(
    () => Object.values(groups).sort((a, b) => a.handle.localeCompare(b.handle)),
    [groups],
  );

  async function remove(group: UserGroup) {
    const go = await confirm({
      title: `Delete @${group.handle}?`,
      body: `It holds ${groupSize(group)}. Messages that mention it keep the words @${group.handle}, and mentioning it notifies nobody from now on.`,
      confirmLabel: "Delete group",
      destructive: true,
    });
    if (!go) return;
    setBusy(true);
    setError(null);
    const failed = await client.deleteUserGroup(group.id);
    setBusy(false);
    if (failed) setError(failureText(`@${group.handle} was not deleted.`, failed));
  }

  if (editing)
    return (
      <GroupForm
        editing={editing}
        onDone={() => setEditing(null)}
        save={(fields) =>
          editing.kind === "new"
            ? client.createUserGroup(fields)
            : client.updateUserGroup(editing.group.id, fields)
        }
      />
    );

  return (
    <section aria-labelledby="user-groups-heading" className="mt-6 border-t border-edge pt-4">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 id="user-groups-heading" className="text-sm font-semibold">
          Groups
        </h3>
        <button
          type="button"
          className={buttonClass("secondary")}
          onClick={() => {
            setError(null);
            setEditing({ kind: "new" });
          }}
        >
          New group
        </button>
      </div>
      <p className="mb-3 text-sm text-ink-dim">
        Mention a group, such as @design, to notify everyone in it who is in the conversation.
      </p>
      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-alert/10 p-3 text-sm text-alert">
          {error}
        </p>
      )}
      {sorted.length === 0 ? (
        <p className="text-sm text-ink-faint">No groups yet.</p>
      ) : (
        <ul className="space-y-1">
          {sorted.map((group) => (
            <li key={group.id} className="flex flex-wrap items-center gap-3 rounded-lg px-2 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium">{group.name}</span>
                  <span className="truncate font-mono text-[11px] text-ink-faint">
                    @{group.handle}
                  </span>
                </div>
                <div className="text-[11px] text-ink-faint">{groupSize(group)}</div>
              </div>
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass("secondary")}
                  aria-label={`Edit @${group.handle}`}
                  onClick={() => {
                    setError(null);
                    setEditing({ kind: "edit", group });
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass("danger")}
                  aria-label={`Delete @${group.handle}`}
                  onClick={() => void remove(group)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface Fields {
  handle: string;
  name: string;
  description: string;
  memberIds: ID[];
}

function GroupForm({
  editing,
  onDone,
  save,
}: {
  editing: Editing;
  onDone: () => void;
  save: (fields: Fields) => Promise<UserGroup | ApiError>;
}) {
  const users = useWorkspace((s) => s.users);
  const before = editing.kind === "edit" ? editing.group : null;
  const [handle, setHandle] = useState(before?.handle ?? "");
  const [name, setName] = useState(before?.name ?? "");
  const [description, setDescription] = useState(before?.description ?? "");
  const [members, setMembers] = useState<Set<ID>>(new Set(before?.memberIds ?? []));
  const [find, setFind] = useState("");
  const [handleError, setHandleError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const handleField = useRef<HTMLInputElement>(null);
  const nameField = useRef<HTMLInputElement>(null);

  // People only: apps cannot be in a group, and someone deactivated stays
  // listed only while they are in it, so they can be taken out.
  const people = useMemo(() => {
    const needle = find.trim().toLowerCase().replace(/^@/, "");
    return Object.values(users)
      .filter((user: User) => !user.isBot && (!user.deactivated || members.has(user.id)))
      .filter(
        (user) =>
          !needle ||
          user.displayName.toLowerCase().includes(needle) ||
          user.handle.toLowerCase().includes(needle),
      )
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [users, find, members]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const cleanHandle = handle.trim().toLowerCase().replace(/^@/, "");
    const handleOk = handleSchema.safeParse(cleanHandle).success;
    const nameOk = name.trim().length > 0;
    setHandleError(
      handleOk
        ? null
        : "Use 2 to 32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit.",
    );
    setNameError(nameOk ? null : "Give the group a name.");
    if (!handleOk) return handleField.current?.focus();
    if (!nameOk) return nameField.current?.focus();
    setBusy(true);
    setError(null);
    const answer = await save({
      handle: cleanHandle,
      name: name.trim(),
      description: description.trim(),
      memberIds: [...members],
    });
    setBusy(false);
    if (answer instanceof ApiError) {
      if (answer.code === "handle_taken") {
        setHandleError(`@${cleanHandle} is taken by a person or another group. Choose another.`);
        handleField.current?.focus();
      } else setError(failureText("The group was not saved.", answer));
      return;
    }
    onDone();
  }

  return (
    <section aria-labelledby="group-form-heading" className="mt-6 border-t border-edge pt-4">
      <h3 id="group-form-heading" className="mb-3 text-sm font-semibold">
        {before ? `Edit @${before.handle}` : "New group"}
      </h3>
      <form onSubmit={(event) => void submit(event)} noValidate className="space-y-3">
        {error && (
          <p role="alert" className="rounded-lg bg-alert/10 p-3 text-sm text-alert">
            {error}
          </p>
        )}
        <TextField
          ref={handleField}
          label="Handle"
          hint="What people type after @ to mention it."
          error={handleError ?? undefined}
          value={handle}
          maxLength={33}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setHandle(event.target.value)}
        />
        <TextField
          ref={nameField}
          label="Name"
          error={nameError ?? undefined}
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
        />
        <TextField
          label="Description"
          hint="Optional."
          value={description}
          maxLength={250}
          onChange={(event) => setDescription(event.target.value)}
        />
        <fieldset>
          <legend className="mb-1 text-sm font-medium">
            People in it <span className="font-normal text-ink-faint">({members.size})</span>
          </legend>
          <label className="mb-2 block text-sm">
            <span className="sr-only">Find a person to add</span>
            <input
              type="search"
              value={find}
              maxLength={80}
              placeholder="Search by name or handle"
              onChange={(event) => setFind(event.target.value)}
              className={inputCls}
            />
          </label>
          <ul className="max-h-60 space-y-0.5 overflow-y-auto">
            {people.map((user) => (
              <li key={user.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-ink/[0.05]">
                  <input
                    type="checkbox"
                    checked={members.has(user.id)}
                    onChange={(event) => {
                      const next = new Set(members);
                      if (event.target.checked) next.add(user.id);
                      else next.delete(user.id);
                      setMembers(next);
                    }}
                  />
                  <Avatar user={user} size={20} />
                  <span className="truncate">{user.displayName}</span>
                  <span className="truncate font-mono text-[11px] text-ink-faint">
                    @{user.handle}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" className={buttonClass("secondary")} onClick={onDone}>
            Cancel
          </button>
          <button
            type="submit"
            className={buttonClass("primary")}
            aria-disabled={busy || undefined}
          >
            {busy ? "Saving…" : before ? "Save group" : "Make group"}
          </button>
        </div>
      </form>
    </section>
  );
}
