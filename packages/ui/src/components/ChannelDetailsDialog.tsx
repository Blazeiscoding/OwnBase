import { useEffect, useId, useRef, useState } from "react";
import {
  channelPermissions,
  canRemoveChannelMember,
  canSetChannelManager,
  type ID,
  type NotifyLevel,
} from "@slackoss/protocol";
import { ApiError } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import { useTabs } from "../lib/useTabs.js";
import { Avatar } from "./Avatar.js";
import { Dialog } from "./Dialog.js";
import { inputClass, TextField } from "./TextField.js";
import { ListStatus } from "./ListStatus.js";
import { buttonClass } from "./Button.js";
import { Menu, type MenuItem } from "./Menu.js";
import { Icon } from "./Icon.js";

type Tab = "about" | "members" | "notifications";
const TABS: readonly Tab[] = ["about", "members", "notifications"];

const DEFAULT_PREFS = { notifyLevel: "mentions" as NotifyLevel, muted: false };

/**
 * Why a change to the channel did not happen, in words. The server's refusals
 * carry a code and, often, no message of their own, so without this the
 * dialog showed "name_taken" or "Failed to fetch".
 */
function channelError(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return `${fallback} Check your connection and try again.`;
  switch (err.code) {
    case "name_taken":
      return "Another channel already has that name.";
    case "invalid_request":
      return "Check the name, topic and description, then try again.";
    case "channel_management_required":
      return "Only this channel's creator, its managers and workspace administrators can change it.";
    case "channel_invite_forbidden":
      return "You cannot add people to this channel.";
    case "channel_removal_forbidden":
      return "You cannot remove this person from this channel.";
    case "channel_manager_assignment_forbidden":
      return "You cannot change who manages this channel.";
    case "channel_membership_required":
      return "They need to be a member of this channel first.";
    case "channel_archived":
      return "This channel is archived. Reopen it first.";
    case "channel_not_found":
      return "This conversation is no longer available to you.";
    default:
      return fallback;
  }
}

const LEVELS: { value: NotifyLevel; label: string; hint: string }[] = [
  { value: "all", label: "Every message", hint: "Notify me whenever anyone posts here." },
  { value: "mentions", label: "Mentions only", hint: "Only when someone @-mentions me." },
  { value: "nothing", label: "Nothing", hint: "Never notify me about this channel." },
];

/** Channel topic and description, plus who's in it. */
export function ChannelDetailsDialog(props: {
  channelId: ID;
  /** The tab it opens on: Members, to add someone, from a private channel's row. */
  initialTab?: Tab;
  onClose: () => void;
  onLeft: () => void;
  onOpenProfile: (userId: ID) => void;
  onChangeParticipants: (memberIds: ID[]) => void;
}) {
  const client = useClient();
  const channel = useWorkspace((s) => s.channels[props.channelId]);
  const users = useWorkspace((s) => s.users);
  const presence = useWorkspace((s) => s.presence);
  const self = useWorkspace((s) => s.self);
  const selfId = self?.id;
  const membership = useWorkspace((s) => props.channelId in s.memberships);
  const [tab, setTab] = useState<Tab>(props.initialTab ?? "about");
  const tabs = useTabs({ label: "Channel details", tabs: TABS, selected: tab, onSelect: setTab });
  const [memberIds, setMemberIds] = useState<ID[]>([]);
  const [topic, setTopic] = useState(channel?.topic ?? "");
  const [name, setName] = useState(channel?.name ?? "");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [description, setDescription] = useState(channel?.description ?? "");
  /** What the last Save did, said quietly under it until something is changed. */
  const [aboutNote, setAboutNote] = useState<"saved" | "unchanged" | null>(null);
  /** What is wrong with the name, said under it once the form is sent. */
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [membersError, setMembersError] = useState(false);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const [membersAttempt, setMembersAttempt] = useState(0);
  const [removingId, setRemovingId] = useState<ID | null>(null);
  const [membersLoading, setMembersLoading] = useState(true);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [managerChange, setManagerChange] = useState<{ userId: ID; manager: boolean } | null>(null);
  const fieldId = useId();

  useEffect(() => {
    let active = true;
    setMembersLoading(true);
    void client.api
      .channelMembers(props.channelId)
      .then((r) => {
        if (active) {
          setMemberIds(r.memberIds);
          setMembersLoaded(true);
          setMembersError(false);
        }
      })
      .catch(() => {
        if (active) setMembersError(true);
      })
      .finally(() => {
        if (active) setMembersLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, props.channelId, membersAttempt]);

  if (!channel) return null;
  const isRoom = channel.type === "public" || channel.type === "private";
  const permissions = channelPermissions(self ?? undefined, channel, !!membership);
  const changed =
    name.trim() !== channel.name || topic !== channel.topic || description !== channel.description;

  // Save always answers: sent with no name, it says so under the name; sent
  // unchanged, it says there is nothing to save rather than writing the same
  // details to everyone in the channel again.
  async function saveAbout(e: React.FormEvent) {
    e.preventDefault();
    if (!permissions.manage || busy) return;
    setError(null);
    setAboutNote(null);
    if (!name.trim()) {
      setNameProblem("Give the channel a name.");
      nameField.current?.focus();
      return;
    }
    setNameProblem(null);
    if (!changed) {
      setAboutNote("unchanged");
      return;
    }
    setBusy(true);
    try {
      await client.api.updateChannel(props.channelId, { name: name.trim(), topic, description });
      setAboutNote("saved");
    } catch (err) {
      // A name in use belongs to the name; anything else to the whole form.
      if (err instanceof ApiError && err.code === "name_taken") {
        setNameProblem(channelError(err, ""));
        nameField.current?.focus();
      } else setError(channelError(err, "Could not save channel details."));
    } finally {
      setBusy(false);
    }
  }

  async function addMember(userId: ID) {
    if (!permissions.invite || busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.api.inviteMember(props.channelId, userId);
      setMemberIds((prev) => [...new Set([...prev, userId])]);
    } catch (err) {
      setError(channelError(err, "Could not add this person."));
    } finally {
      setBusy(false);
    }
  }

  async function setArchived(archived: boolean) {
    if (!permissions.manage || busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.api.updateChannel(props.channelId, { archived });
      setConfirmArchive(false);
    } catch (err) {
      setError(channelError(err, "Could not change archive status."));
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(userId: ID) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.api.removeChannelMember(props.channelId, userId);
      setMemberIds((ids) => ids.filter((id) => id !== userId));
      setRemovingId(null);
    } catch (err) {
      setError(channelError(err, "Could not remove this person."));
    } finally {
      setBusy(false);
    }
  }

  async function changeManager(userId: ID, manager: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.api.setChannelManager(props.channelId, userId, manager);
      setManagerChange(null);
    } catch (err) {
      setError(channelError(err, "Could not change channel manager."));
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.api.leaveChannel(props.channelId);
      props.onLeft();
    } catch (err) {
      setError(
        channelError(err, isRoom ? "Could not leave channel." : "Could not leave conversation."),
      );
    } finally {
      setBusy(false);
    }
  }

  const notMembers = Object.values(users).filter(
    (u) => !memberIds.includes(u.id) && !u.deactivated && !u.isBot,
  );

  return (
    <Dialog
      title={isRoom ? `#${channel.name}` : "Conversation"}
      onClose={props.onClose}
      width={480}
    >
      {error && (
        <p role="alert" className="mb-3 text-sm text-alert">
          {error}
        </p>
      )}
      <div {...tabs.listProps} className="mb-4 flex gap-1 rounded-lg bg-ground p-1">
        {TABS.map((t) => (
          <button
            key={t}
            {...tabs.tabProps(t)}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
              tab === t ? "bg-lifted text-ink" : "text-ink-dim hover:text-ink"
            }`}
          >
            {t === "members"
              ? membersLoaded
                ? `Members (${memberIds.length})`
                : "Members"
              : t === "notifications"
                ? "Notifications"
                : "About"}
          </button>
        ))}
      </div>

      {/* Tall enough for the tallest tab, so switching tabs does not resize the dialog. */}
      <div {...tabs.panelProps} className="sm:min-h-[424px]">
        {tab === "notifications" ? (
          <NotificationSettings channelId={props.channelId} />
        ) : tab === "about" ? (
          isRoom ? (
            <form onSubmit={saveAbout} noValidate className="space-y-3">
              <TextField
                ref={nameField}
                label="Channel name"
                error={nameProblem}
                value={name}
                required={permissions.manage}
                maxLength={80}
                readOnly={!permissions.manage || busy}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameProblem(null);
                  setAboutNote(null);
                }}
              />
              {!permissions.manage && (
                <p className="text-sm text-ink-faint">
                  Channel details are managed by its creator, channel managers and workspace
                  administrators.
                </p>
              )}
              <TextField
                label="Topic"
                maxLength={250}
                value={topic}
                readOnly={!permissions.manage || busy}
                onChange={(e) => {
                  setTopic(e.target.value);
                  setAboutNote(null);
                }}
                placeholder="What's this channel about right now?"
              />
              <div>
                <label
                  htmlFor={`${fieldId}-description`}
                  className="mb-1.5 block text-[13px] font-medium text-ink-dim"
                >
                  Description
                </label>
                <textarea
                  id={`${fieldId}-description`}
                  maxLength={500}
                  value={description}
                  readOnly={!permissions.manage || busy}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    setAboutNote(null);
                  }}
                  rows={3}
                  placeholder="The longer story, shown to anyone who opens the channel."
                  className={inputClass("regular", "resize-none")}
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {/* Never off until something changes: sent as it is, it says so. */}
                {permissions.manage && (
                  <button
                    type="submit"
                    aria-disabled={busy || undefined}
                    className={buttonClass("primary")}
                  >
                    {busy ? "Saving…" : "Save changes"}
                  </button>
                )}
                {membership && channel.name !== "general" && !confirmLeave && (
                  <button
                    type="button"
                    disabled={busy}
                    // A public channel can be joined again; a private one only
                    // by invitation, so leaving it asks first.
                    onClick={() =>
                      channel.type === "private" ? setConfirmLeave(true) : void leave()
                    }
                    className="rounded-lg border border-edge px-4 py-2.5 text-sm text-ink-dim transition-colors hover:border-alert hover:text-alert"
                  >
                    Leave channel
                  </button>
                )}
              </div>
              <p role="status" className="text-[13px] text-ink-dim empty:hidden">
                {aboutNote === "saved"
                  ? "Saved."
                  : aboutNote === "unchanged"
                    ? "Nothing to save: the name, topic and description are as they were."
                    : ""}
              </p>
              {confirmLeave && channel.type === "private" && (
                <div className="rounded-lg border border-edge p-3 text-sm">
                  <p className="mb-2">
                    Leave #{channel.name}? It is private, so you will lose its history and call
                    until someone in it invites you back.
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    className="text-alert underline"
                    onClick={() => void leave()}
                  >
                    Confirm leave
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className="ml-3"
                    onClick={() => setConfirmLeave(false)}
                  >
                    Cancel
                  </button>
                </div>
              )}
              <div className="rounded-lg border border-edge p-3 text-sm">
                <p className="mb-2 text-ink-dim">
                  {channel.archived
                    ? "Archived. History remains available; new posts and replies are paused."
                    : "Archiving keeps history and drafts. Scheduled messages wait until the channel is reopened."}
                </p>
                {permissions.manage &&
                  (channel.archived ? (
                    <button
                      type="button"
                      disabled={busy}
                      className={buttonClass("primary")}
                      onClick={() => void setArchived(false)}
                    >
                      Reopen channel
                    </button>
                  ) : confirmArchive ? (
                    <div>
                      <p className="mb-2">Archive #{channel.name} for everyone?</p>
                      <button
                        type="button"
                        disabled={busy}
                        className={buttonClass("primary")}
                        onClick={() => void setArchived(true)}
                      >
                        Confirm archive
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className="ml-3"
                        onClick={() => setConfirmArchive(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      className="text-alert underline"
                      onClick={() => setConfirmArchive(true)}
                    >
                      Archive channel
                    </button>
                  ))}
              </div>
            </form>
          ) : (
            <p className="py-4 text-center text-sm text-ink-faint">
              Direct conversations have no topic to set.
            </p>
          )
        ) : tab === "members" ? (
          <div>
            {!isRoom && membership && (
              <div className="mb-3 text-sm">
                <p className="mb-2 text-ink-dim">
                  Changing participants opens a conversation for the selected people. This
                  conversation's history stays here.
                </p>
                <button
                  disabled={busy || membersLoading || membersError}
                  className={buttonClass("primary")}
                  onClick={() => props.onChangeParticipants(memberIds)}
                >
                  Change participants
                </button>
              </div>
            )}
            {channel.type === "group_dm" && membership && (
              <div className="mb-3 text-sm">
                {confirmLeave ? (
                  <>
                    <p className="mb-2 text-ink-dim">
                      Leave this group conversation? You will lose access to its history and call.
                      Other participants keep their history. Starting again with these people will
                      not restore access to this history.
                    </p>
                    <button
                      disabled={busy}
                      className="text-alert underline"
                      onClick={() => void leave()}
                    >
                      Confirm leave
                    </button>
                    <button disabled={busy} className="ml-3" onClick={() => setConfirmLeave(false)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    className="text-alert underline"
                    disabled={busy}
                    onClick={() => setConfirmLeave(true)}
                  >
                    Leave group conversation
                  </button>
                )}
              </div>
            )}
            <div className="mb-2 flex justify-end">
              <button
                disabled={membersLoading || busy}
                onClick={() => setMembersAttempt((n) => n + 1)}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink disabled:opacity-40"
              >
                <Icon name="refresh" size={12} />
                Refresh members
              </button>
            </div>
            <ListStatus
              loading={membersLoading}
              placeholder={!membersLoaded}
              loadingLabel="Loading members…"
              error={
                membersError ? "Could not load members. Check your connection and try again." : null
              }
              onRetry={() => setMembersAttempt((n) => n + 1)}
              empty={
                membersLoaded && !membersError && memberIds.length === 0
                  ? "No members were returned. Refresh to check this conversation."
                  : null
              }
            />
            <ul
              aria-label="Channel members"
              aria-busy={membersLoading}
              className="mb-4 max-h-[260px] space-y-0.5 overflow-y-auto"
            >
              {memberIds.map((id) => {
                const u = users[id];
                const manager = channel.managerIds?.includes(id) ?? false;
                const canManage =
                  channel.managerIds !== undefined &&
                  canSetChannelManager(self ?? undefined, u, channel, !!membership, !manager);
                const canRemove = canRemoveChannelMember(
                  self ?? undefined,
                  u,
                  channel,
                  !!membership,
                );
                // What can be done to someone is in one menu at the end of their row,
                // as in People, rather than two links under every name.
                const actions: MenuItem[] = [
                  ...(canManage
                    ? [
                        {
                          id: "manager",
                          label: manager ? "Remove manager role" : "Make channel manager",
                          icon: "user" as const,
                          onSelect: () => {
                            setRemovingId(null);
                            setManagerChange({ userId: id, manager: !manager });
                          },
                        },
                      ]
                    : []),
                  ...(canRemove
                    ? [
                        {
                          id: "remove",
                          label: `Remove from ${isRoom ? `#${channel.name}` : "this conversation"}`,
                          icon: "trash" as const,
                          destructive: true,
                          section: canManage ? (true as const) : undefined,
                          onSelect: () => {
                            setManagerChange(null);
                            setRemovingId(id);
                          },
                        },
                      ]
                    : []),
                ];
                return (
                  <li key={id}>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => props.onOpenProfile(id)}
                        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-ink/[0.05]"
                      >
                        <Avatar user={u} size={28} />
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {u?.displayName ?? "unknown"}
                          {id === selfId && <span className="text-ink-faint"> (you)</span>}
                          {id === channel.creatorId && (
                            <span className="ml-2 text-xs text-ink-faint">Creator</span>
                          )}
                          {manager && (
                            <span className="ml-2 text-xs text-copper">Channel manager</span>
                          )}
                        </span>
                        {u?.statusEmoji && <span>{u.statusEmoji}</span>}
                        <span
                          className={`size-2 rounded-full ${
                            presence[id] === "online" ? "bg-online" : "bg-edge"
                          }`}
                        />
                      </button>
                      {actions.length > 0 ? (
                        <Menu
                          label={`Actions for ${u?.displayName ?? "unknown"}`}
                          items={actions}
                          disabled={busy || membersLoading || membersError}
                          width={280}
                          triggerClassName="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink disabled:opacity-40"
                        />
                      ) : (
                        <span aria-hidden="true" className="size-8 shrink-0" />
                      )}
                    </div>
                    {managerChange?.userId === id && (
                      <div className="mb-2 mt-1 rounded-lg border border-edge p-3 text-sm">
                        <p className="mb-2">
                          {managerChange.manager
                            ? `Make ${u?.displayName} a manager of #${channel.name}? They can edit, rename and archive this room and remove ordinary members. They cannot appoint other managers.`
                            : `Remove ${u?.displayName}'s manager role? They remain a member of this channel.`}
                        </p>
                        <button
                          disabled={busy || membersLoading || membersError}
                          className="font-medium text-ink underline decoration-ink-faint/60 hover:decoration-ink"
                          onClick={() => void changeManager(id, managerChange.manager)}
                        >
                          Confirm role change
                        </button>
                        <button
                          disabled={busy}
                          className="ml-3"
                          onClick={() => setManagerChange(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                    {removingId === id && (
                      <div className="mb-2 mt-1 rounded-lg border border-edge p-3 text-sm">
                        <p className="mb-2">
                          Remove {u?.displayName} from #{channel.name}?{" "}
                          {channel.type === "public"
                            ? "This public channel remains readable, and they can rejoin."
                            : "They will lose access to this private channel and its call until invited back."}{" "}
                          Their messages remain.
                        </p>
                        <button
                          disabled={busy || membersLoading || membersError}
                          onClick={() => void removeMember(id)}
                          className="text-alert underline"
                        >
                          Confirm removal
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => setRemovingId(null)}
                          className="ml-3"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {permissions.invite && !membersLoading && !membersError && notMembers.length > 0 && (
              <div>
                <div className="mb-1.5 text-[13px] font-semibold text-ink">Add someone</div>
                <ul className="flex flex-wrap gap-1.5">
                  {notMembers.map((u) => (
                    <li key={u.id}>
                      <button
                        onClick={() => addMember(u.id)}
                        disabled={busy}
                        className="rounded-full border border-edge px-2.5 py-1 text-xs text-ink-dim transition-colors hover:border-ink-faint/50 hover:text-ink"
                      >
                        + {u.displayName}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function NotificationSettings({ channelId }: { channelId: ID }) {
  const client = useClient();
  // Select the stored value only — a fallback object built inside the selector
  // would be a new reference every render and spin the store subscription.
  const stored = useWorkspace((s) => s.prefs[channelId]);
  const prefs = stored ?? DEFAULT_PREFS;
  const write = useWorkspace((s) => s.prefsWrites[channelId]);
  // A refused star says so where it was chosen; this speaks for these choices only.
  const failed = write?.failed && ("notifyLevel" in write.failed || "muted" in write.failed);

  return (
    <div className="space-y-4">
      {failed ? (
        <div role="alert" className="rounded-lg border border-alert/40 bg-alert/10 p-3 text-sm">
          <p>
            Your notification choice was not saved, so this shows what the workspace has.{" "}
            <button
              type="button"
              onClick={() => client.retryChannelPrefs(channelId)}
              className="font-medium text-ink underline decoration-ink-faint/60 hover:decoration-ink"
            >
              Try again
            </button>
          </p>
        </div>
      ) : (
        <p role="status" aria-live="polite" className="sr-only">
          {write?.saving ? "Saving…" : ""}
        </p>
      )}
      <fieldset className="space-y-1.5" disabled={prefs.muted}>
        <legend className="mb-1.5 text-[13px] font-semibold text-ink">Notify me about</legend>
        {LEVELS.map((level) => (
          <label
            key={level.value}
            className={`flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2.5 transition-colors ${
              prefs.notifyLevel === level.value
                ? "border-copper bg-copper/10"
                : "border-edge hover:border-ink-faint"
            } ${prefs.muted ? "cursor-not-allowed opacity-50" : ""}`}
          >
            <input
              type="radio"
              name="notify-level"
              checked={prefs.notifyLevel === level.value}
              onChange={() => client.setChannelPrefs(channelId, { notifyLevel: level.value })}
              className="mt-0.5 accent-copper"
            />
            <span>
              <span className="block text-sm font-medium">{level.label}</span>
              <span className="block text-xs text-ink-faint">{level.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-edge px-3 py-2.5">
        <input
          type="checkbox"
          checked={prefs.muted}
          onChange={(e) => client.setChannelPrefs(channelId, { muted: e.target.checked })}
          className="mt-0.5 accent-copper"
        />
        <span>
          <span className="block text-sm font-medium">Mute this channel</span>
          <span className="block text-xs text-ink-faint">
            It stays in your sidebar but never notifies you, and unread messages don't stand out.
          </span>
        </span>
      </label>
    </div>
  );
}
