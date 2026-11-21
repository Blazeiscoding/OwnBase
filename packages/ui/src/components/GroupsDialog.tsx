import { useId, useMemo, useRef, useState } from "react";
import {
  HANDLE_MAX,
  HANDLE_MIN,
  isHandle,
  USER_GROUP_DESCRIPTION_MAX,
  USER_GROUP_NAME_MAX,
  RESERVED_HANDLES,
  type ID,
  type User,
  type UserGroup,
} from "@ownbase/protocol";
import { ApiError } from "@ownbase/client-core";
import { useClient, useWorkspace } from "../context.js";
import { UnsavedGuard } from "../lib/dismissGuard.js";
import { failureText } from "../lib/failure.js";
import { groupSize } from "../lib/userGroups.js";
import { AddPeople } from "./AddPeople.js";
import { Avatar } from "./Avatar.js";
import { buttonClass } from "./Button.js";
import { useConfirm } from "./Confirm.js";
import { Dialog, DialogScroll } from "./Dialog.js";
import { EmptyState } from "./EmptyState.js";
import { Icon } from "./Icon.js";
import { Menu } from "./Menu.js";
import { inputClass, TextField } from "./TextField.js";

/** What the window shows: the list, or one group being made or changed. */
type View = { kind: "list" } | { kind: "new" } | { kind: "edit"; group: UserGroup };

/**
 * User groups (J13), for admins: a list of them, and a view of its own for
 * making or changing one. Mentioning a group notifies its people who are in
 * the conversation, so the list says how many each holds.
 */
export function GroupsDialog({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<View>({ kind: "list" });
  const [notice, setNotice] = useState<string | null>(null);
  const title =
    view.kind === "list"
      ? "Groups"
      : view.kind === "new"
        ? "New group"
        : `Edit @${view.group.handle}`;
  return (
    <Dialog title={title} onClose={onClose} width={560} ownScroll>
      {view.kind === "list" ? (
        <DialogScroll>
          <GroupList
            notice={notice}
            onNotice={setNotice}
            onOpen={(next) => {
              setNotice(null);
              setView(next);
            }}
          />
        </DialogScroll>
      ) : (
        <GroupForm
          group={view.kind === "edit" ? view.group : null}
          onDone={(said) => {
            setNotice(said);
            setView({ kind: "list" });
          }}
        />
      )}
    </Dialog>
  );
}

function GroupList({
  notice,
  onNotice,
  onOpen,
}: {
  notice: string | null;
  onNotice: (said: string | null) => void;
  onOpen: (view: View) => void;
}) {
  const client = useClient();
  const confirm = useConfirm();
  const groups = useWorkspace((s) => s.userGroups);
  const users = useWorkspace((s) => s.users);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sorted = useMemo(
    () => Object.values(groups).sort((a, b) => a.name.localeCompare(b.name)),
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
    onNotice(null);
    const failed = await client.deleteUserGroup(group.id);
    setBusy(false);
    if (failed) setError(failureText(`@${group.handle} was not deleted.`, failed));
    else onNotice(`Deleted @${group.handle}.`);
  }

  const newGroup = { label: "New group", run: () => onOpen({ kind: "new" }) };

  return (
    <>
      {notice && (
        <p role="status" className="mb-3 rounded-lg bg-online/10 p-3 text-sm text-online">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-alert/10 p-3 text-sm text-alert">
          {error}
        </p>
      )}
      {sorted.length === 0 ? (
        <EmptyState icon="members" action={newGroup}>
          <p className="text-sm font-medium text-ink">No groups yet</p>
          <p className="mt-1 text-sm text-ink-dim">
            A group lets anyone mention several people at once, such as @design. Only those in the
            conversation are notified.
          </p>
        </EmptyState>
      ) : (
        <>
          <div className="mb-3 flex items-start justify-between gap-3">
            <p className="text-sm text-ink-dim">
              Mention a group, such as @design, to notify everyone in it who is in the conversation.
            </p>
            <button
              type="button"
              className={buttonClass("primary", "shrink-0")}
              onClick={newGroup.run}
            >
              New group
            </button>
          </div>
          <ul className="space-y-0.5">
            {sorted.map((group) => {
              const faces = group.memberIds
                .map((id) => users[id])
                .filter((user): user is User => !!user && !user.deactivated)
                .slice(0, 4);
              return (
                <li
                  key={group.id}
                  className="group/row flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-ink/[0.04]"
                >
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onOpen({ kind: "edit", group })}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <span className="sr-only">Edit </span>
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink/[0.07] text-ink-dim">
                      <Icon name="members" size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">
                        {group.name}
                      </span>
                      <span className="block truncate text-[11px] text-ink-faint">
                        <span className="font-mono">@{group.handle}</span>
                        {` · ${groupSize(group)}`}
                        {group.description ? ` · ${group.description}` : ""}
                      </span>
                    </span>
                    {faces.length > 0 && (
                      <span aria-hidden="true" className="hidden shrink-0 items-center sm:flex">
                        {faces.map((user, i) => (
                          <span key={user.id} className={i > 0 ? "-ml-1.5" : ""}>
                            <span className="block rounded-full ring-2 ring-raised">
                              <Avatar user={user} size={22} />
                            </span>
                          </span>
                        ))}
                      </span>
                    )}
                  </button>
                  <Menu
                    label={`Actions for @${group.handle}`}
                    disabled={busy}
                    items={[
                      {
                        id: "edit",
                        label: "Edit group",
                        onSelect: () => onOpen({ kind: "edit", group }),
                      },
                      {
                        id: "delete",
                        label: "Delete group",
                        destructive: true,
                        onSelect: () => void remove(group),
                      },
                    ]}
                  />
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}

/** A handle made from a name until someone types one: "Design ops" is design-ops. */
export function handleFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-._]+$/, "")
    .slice(0, HANDLE_MAX);
}

/**
 * What is wrong with a handle, said before Save: its form, or who has it. The
 * client knows every person (an admin's snapshot holds them all) and every
 * group, so a taken one is found as it is typed. The server checks again.
 */
export function handleProblem(
  handle: string,
  users: Record<ID, User>,
  groups: Record<ID, UserGroup>,
  ownId: ID | null,
): string | null {
  if (!handle) return "Give the group a handle, the word people type after @.";
  if (!isHandle(handle))
    return `Use ${HANDLE_MIN} to ${HANDLE_MAX} lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit.`;
  if (RESERVED_HANDLES.includes(handle))
    return `@${handle} already means everyone in a conversation. Choose another.`;
  const person = Object.values(users).find((user) => user.handle === handle);
  if (person) return `@${handle} is ${person.displayName}'s handle. Choose another.`;
  const group = Object.values(groups).find((g) => g.handle === handle && g.id !== ownId);
  if (group) return `@${handle} is the group ${group.name}. Choose another.`;
  return null;
}

function GroupForm({
  group,
  onDone,
}: {
  group: UserGroup | null;
  onDone: (said: string | null) => void;
}) {
  const client = useClient();
  const confirm = useConfirm();
  const users = useWorkspace((s) => s.users);
  const groups = useWorkspace((s) => s.userGroups);
  const [name, setName] = useState(group?.name ?? "");
  // A new group's handle follows its name until someone types one.
  const [typedHandle, setTypedHandle] = useState<string | null>(group ? group.handle : null);
  const [description, setDescription] = useState(group?.description ?? "");
  const [memberIds, setMemberIds] = useState<ID[]>(group?.memberIds ?? []);
  const [tried, setTried] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [handleTakenHere, setHandleTakenHere] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  const handleField = useRef<HTMLInputElement>(null);
  const handleId = useId();
  const handleHintId = useId();
  const handleErrorId = useId();

  const handle = (typedHandle ?? handleFromName(name)).trim().toLowerCase().replace(/^@/, "");
  const nameProblem = name.trim() ? null : "Give the group a name.";
  const handleIssue =
    handleTakenHere === handle
      ? `@${handle} is taken. Choose another.`
      : handleProblem(handle, users, groups, group?.id ?? null);
  // Said as it is typed once there is something to judge; an empty one only on Save.
  const shownHandleIssue = handle || tried ? handleIssue : null;

  const people = memberIds
    .map((id) => users[id])
    .filter((user): user is User => !!user)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const candidates = useMemo(
    () =>
      Object.values(users).filter(
        (user) => !user.isBot && !user.deactivated && !memberIds.includes(user.id),
      ),
    [users, memberIds],
  );

  const dirty = group
    ? name !== group.name ||
      handle !== group.handle ||
      description !== group.description ||
      memberIds.length !== group.memberIds.length ||
      memberIds.some((id) => !group.memberIds.includes(id))
    : name.trim() !== "" || description.trim() !== "" || memberIds.length > 0;

  /** Back to the list, asking first when something typed would be lost, as closing does. */
  async function leave() {
    if (dirty && !busy) {
      const go = await confirm({
        title: group ? "Discard changes to the group?" : "Discard the new group?",
        body: "What you changed here is not saved yet.",
        confirmLabel: "Discard",
      });
      if (!go) return;
    }
    onDone(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setTried(true);
    if (nameProblem) return nameField.current?.focus();
    if (handleIssue) return handleField.current?.focus();
    setBusy(true);
    setServerError(null);
    const fields = {
      handle,
      name: name.trim(),
      description: description.trim(),
      memberIds,
    };
    const answer = group
      ? await client.updateUserGroup(group.id, fields)
      : await client.createUserGroup(fields);
    setBusy(false);
    if (answer instanceof ApiError) {
      if (answer.code === "handle_taken") {
        setHandleTakenHere(handle);
        handleField.current?.focus();
      } else setServerError(failureText("The group was not saved.", answer));
      return;
    }
    onDone(
      group
        ? `Saved @${answer.handle}.`
        : `Made @${answer.handle}. Anyone can mention it in a conversation now.`,
    );
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex min-h-0 flex-col">
      <DialogScroll>
        <div className="space-y-4">
          <UnsavedGuard
            dirty={dirty && !busy}
            what={group ? "changes to the group" : "the new group"}
          />
          <button
            type="button"
            onClick={() => void leave()}
            className="-ml-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-[13px] text-ink-faint hover:text-ink"
          >
            <Icon name="chevronLeft" size={14} />
            All groups
          </button>
          {serverError && (
            <p role="alert" className="rounded-lg bg-alert/10 p-3 text-sm text-alert">
              {serverError}
            </p>
          )}
          <TextField
            ref={nameField}
            label="Name"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the form's first field, in a view opened to fill it
            autoFocus
            placeholder="Design"
            error={tried && nameProblem ? nameProblem : undefined}
            value={name}
            maxLength={USER_GROUP_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
          />
          <div>
            <label htmlFor={handleId} className="mb-1 block text-[13px] font-medium text-ink-dim">
              Handle
            </label>
            <div className="relative">
              <span
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-ink-faint"
              >
                @
              </span>
              <input
                ref={handleField}
                id={handleId}
                value={handle}
                maxLength={HANDLE_MAX + 1}
                autoComplete="off"
                spellCheck={false}
                placeholder="design"
                aria-invalid={shownHandleIssue ? true : undefined}
                aria-describedby={
                  shownHandleIssue ? `${handleErrorId} ${handleHintId}` : handleHintId
                }
                onChange={(event) => {
                  setTypedHandle(event.target.value);
                  setHandleTakenHere(null);
                }}
                className={inputClass("regular", "pl-7 font-mono")}
              />
            </div>
            {shownHandleIssue && (
              <p id={handleErrorId} className="mt-1 text-[12px] text-alert">
                {shownHandleIssue}
              </p>
            )}
            <p id={handleHintId} className="mt-1 text-[12px] text-ink-faint">
              What people type after @ to mention the group.
              {typedHandle === null && name.trim()
                ? " Made from the name until you change it."
                : ""}
            </p>
          </div>
          <TextField
            label="Description"
            hint="Optional. Who it is for, shown beside its name."
            value={description}
            maxLength={USER_GROUP_DESCRIPTION_MAX}
            onChange={(event) => setDescription(event.target.value)}
          />
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-ink-dim">
              People in it <span className="font-normal text-ink-faint">({memberIds.length})</span>
            </legend>
            {people.length === 0 ? (
              <p className="mb-3 text-[13px] text-ink-faint">
                No one yet. A group can be saved empty and filled later.
              </p>
            ) : (
              <ul aria-label="People in the group" className="mb-3 space-y-0.5">
                {people.map((user) => (
                  <li
                    key={user.id}
                    className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-ink/[0.04]"
                  >
                    <Avatar user={user} size={24} />
                    <span className="min-w-0 flex-1 truncate">
                      {user.displayName}{" "}
                      <span className="text-[12px] text-ink-faint">@{user.handle}</span>
                      {user.deactivated && (
                        <span className="ml-2 text-[11px] text-ink-faint">Deactivated</span>
                      )}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${user.displayName}`}
                      onClick={() => setMemberIds((ids) => ids.filter((id) => id !== user.id))}
                      className="flex size-7 items-center justify-center rounded-md text-ink-faint hover:bg-ink/[0.06] hover:text-ink"
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <AddPeople
              candidates={candidates}
              where={`@${handle || "the group"}`}
              label="Add people"
              quiet
              onAdd={async (userId) => {
                setMemberIds((ids) => (ids.includes(userId) ? ids : [...ids, userId]));
                return true;
              }}
            />
          </fieldset>
        </div>
      </DialogScroll>
      <div className="dialog-foot flex flex-wrap justify-end gap-2">
        <button type="button" className={buttonClass("secondary")} onClick={() => void leave()}>
          Cancel
        </button>
        <button type="submit" className={buttonClass("primary")} aria-disabled={busy || undefined}>
          {busy ? "Saving…" : group ? "Save changes" : "Make group"}
        </button>
      </div>
    </form>
  );
}
