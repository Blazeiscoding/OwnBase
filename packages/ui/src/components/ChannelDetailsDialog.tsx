import { useEffect, useId, useRef, useState } from "react";
import { UnsavedGuard } from "../lib/dismissGuard.js";
import {
  channelPermissions,
  canRemoveChannelMember,
  canSetChannelManager,
  type ID,
  DEFAULT_CHANNEL_PREFS,
  isDirect,
  type NotifyLevel,
} from "@ownbase/protocol";
import { ApiError } from "@ownbase/client-core";
import { useClient, useWorkspace } from "../context.js";
import { useToast } from "./Toast.js";
import { setMuted } from "../lib/conversationChoices.js";
import { useTabs } from "../lib/useTabs.js";
import { Avatar } from "./Avatar.js";
import { Dialog } from "./Dialog.js";
import { inputClass, TextField } from "./TextField.js";
import { ListStatus } from "./ListStatus.js";
import { buttonClass } from "./Button.js";
import { Menu, type MenuItem } from "./Menu.js";
import { Icon } from "./Icon.js";
import { AddPeople } from "./AddPeople.js";
import { NOTIFY_LEVELS, notifyLevelLabel } from "../lib/notifyLevels.js";

type Tab = "about" | "members" | "notifications";
const TABS: readonly Tab[] = ["about", "members", "notifications"];

/**
 * Why a change to the channel did not happen, in words. The server's refusals
 * carry a code and, often, no message of their own, so without this the
 * dialog showed "name_taken" or "Failed to fetch".
 */
function channelError(err: ApiError, fallback: string): string {
  if (err.status === 0) return `${fallback} Check your connection and try again.`;
  switch (err.code) {
    case "name_taken":
      return "Another channel already has that name.";
    case "invalid_request":
      return "Check the name, topic and description, then try again.";
    case "channel_management_required":
      return "Only the person who made this channel, its managers and workspace admins can change it.";
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

/** A conversation's own levels, named as the account's default names them, said of it. */
const LEVELS: { value: NotifyLevel; label: string; hint: string }[] = NOTIFY_LEVELS.map((l) => ({
  ...l,
  hint:
    l.value === "all"
      ? "Whenever anyone posts here."
      : l.value === "nothing"
        ? "Never notify me about this conversation."
        : l.hint,
}));

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
    void client.channelMembers(props.channelId).then((ids) => {
      if (!active) return;
      setMembersLoading(false);
      if (ids instanceof ApiError) {
        setMembersError(true);
        return;
      }
      setMemberIds(ids);
      setMembersLoaded(true);
      setMembersError(false);
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
    const refused = await client.updateChannel(props.channelId, {
      name: name.trim(),
      topic,
      description,
    });
    setBusy(false);
    if (!refused) setAboutNote("saved");
    // A name in use belongs to the name; anything else to the whole form.
    else if (refused.code === "name_taken") {
      setNameProblem(channelError(refused, ""));
      nameField.current?.focus();
    } else setError(channelError(refused, "Could not save channel details."));
  }

  async function addMember(userId: ID): Promise<boolean> {
    if (!permissions.invite || busy) return false;
    setBusy(true);
    setError(null);
    const refused = await client.addToChannel(props.channelId, userId);
    setBusy(false);
    if (refused) {
      const name = users[userId]?.displayName;
      setError(
        channelError(refused, name ? `Could not add ${name}.` : "Could not add this person."),
      );
      return false;
    }
    setMemberIds((prev) => [...new Set([...prev, userId])]);
    return true;
  }

  async function setArchived(archived: boolean) {
    if (!permissions.manage || busy) return;
    setBusy(true);
    setError(null);
    const refused = await client.updateChannel(props.channelId, { archived });
    setBusy(false);
    if (!refused) setConfirmArchive(false);
    else
      setError(
        channelError(
          refused,
          archived ? "Could not archive the channel." : "Could not reopen the channel.",
        ),
      );
  }

  async function removeMember(userId: ID) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const refused = await client.removeFromChannel(props.channelId, userId);
    setBusy(false);
    if (refused) {
      setError(channelError(refused, "Could not remove this person."));
      return;
    }
    setMemberIds((ids) => ids.filter((id) => id !== userId));
    setRemovingId(null);
  }

  async function changeManager(userId: ID, manager: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const refused = await client.setChannelManager(props.channelId, userId, manager);
    setBusy(false);
    if (refused) setError(channelError(refused, "Could not change channel manager."));
    else setManagerChange(null);
  }

  async function leave() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const refused = await client.leaveChannel(props.channelId);
    setBusy(false);
    if (!refused) props.onLeft();
    else
      setError(
        channelError(
          refused,
          isRoom ? "Could not leave channel." : "Could not leave conversation.",
        ),
      );
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
      <UnsavedGuard dirty={changed && permissions.manage && !busy} what="channel changes" />
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
                  Only the person who made this channel, its managers and workspace admins can
                  change these details.
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
                  dir="auto"
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
                    // As tall as Save changes beside it; red only when pointed at.
                    className="btn-shape inline-flex h-9 items-center justify-center border border-edge px-3.5 text-sm font-medium text-ink-dim hover:border-alert hover:text-alert disabled:opacity-40"
                  >
                    Leave channel
                  </button>
                )}
              </div>
              <p role="status" className="text-[13px] text-ink-dim empty:hidden">
                {aboutNote === "saved"
                  ? "Saved."
                  : aboutNote === "unchanged"
                    ? "Nothing to save. The name, topic and description have not changed."
                    : ""}
              </p>
              {confirmLeave && channel.type === "private" && (
                <div className="rounded-lg border border-edge p-3 text-sm">
                  <p className="mb-2">
                    Leave #{channel.name}? It is private, so you will not see its messages or join
                    its call until someone in it invites you back.
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
                    ? "This channel is archived. You can still read it, but no one can post or reply until someone reopens it."
                    : "Archiving stops new messages and keeps the history and drafts. Scheduled messages wait until someone reopens the channel."}
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
                  Changing who is in it starts a conversation with the people you choose. The
                  messages so far stay here.
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
                      Leave this group conversation? You will no longer see its messages or join its
                      call. The others still can. Starting a new conversation with the same people
                      will not bring these messages back.
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
                  ? "No members showed up. Press Refresh members to check again."
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
                            ? `Make ${u?.displayName} a manager of #${channel.name}? They can edit, rename and archive this channel and remove members. They cannot make anyone else a manager.`
                            : `Remove ${u?.displayName}'s manager role? They stay a member of this channel.`}
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
                            ? "They can still read this public channel and join it again."
                            : "They will not see this private channel or join its call until someone invites them back."}{" "}
                          Their messages stay.
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
              <AddPeople
                candidates={notMembers}
                where={isRoom ? `#${channel.name}` : "the conversation"}
                disabled={busy}
                autoFocus={props.initialTab === "members"}
                onAdd={addMember}
              />
            )}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function NotificationSettings({ channelId }: { channelId: ID }) {
  const client = useClient();
  const toast = useToast();
  const direct = useWorkspace((s) => isDirect(s.channels[channelId]?.type));
  // Select the stored value only — a fallback object built inside the selector
  // would be a new reference every render and spin the store subscription.
  const stored = useWorkspace((s) => s.prefs[channelId]);
  const prefs = stored ?? DEFAULT_CHANNEL_PREFS;
  const write = useWorkspace((s) => s.prefsWrites[channelId]);
  // A refused star or mute says so in a notice; this speaks for the level only.
  const failed = write?.failed && ("notifyLevel" in write.failed || "notifyChosen" in write.failed);
  // A conversation not set on its own follows the account's default (v53).
  const notifyDefault = useWorkspace((s) => s.notifyDefault);
  const following = notifyDefault !== null && prefs.notifyChosen === false;
  const options: { value: NotifyLevel | "default"; label: string; hint: string }[] = [
    ...(notifyDefault !== null
      ? [
          {
            value: "default" as const,
            label: "Use my default",
            hint: `Now: ${notifyLevelLabel(notifyDefault).toLowerCase()}. Change it in Account settings, under Notifications.`,
          },
        ]
      : []),
    ...LEVELS,
  ];
  const isChosen = (value: NotifyLevel | "default") =>
    value === "default" ? following : !following && prefs.notifyLevel === value;

  return (
    <div className="space-y-4">
      {failed ? (
        <div role="alert" className="rounded-lg border border-alert/40 bg-alert/10 p-3 text-sm">
          <p>
            Your notification choice was not saved. This shows the setting the workspace still has.{" "}
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
        {options.map((level) => (
          <label
            key={level.value}
            className={`flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2.5 transition-colors ${
              isChosen(level.value)
                ? "border-copper bg-copper/10"
                : "border-edge hover:border-ink-faint"
            } ${prefs.muted ? "cursor-not-allowed opacity-50" : ""}`}
          >
            <input
              type="radio"
              name="notify-level"
              checked={isChosen(level.value)}
              onChange={() =>
                client.setChannelPrefs(
                  channelId,
                  level.value === "default"
                    ? { notifyChosen: false }
                    : { notifyLevel: level.value },
                )
              }
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
          onChange={(e) =>
            setMuted(
              client,
              toast,
              { id: channelId, noun: direct ? "conversation" : "channel" },
              e.target.checked,
            )
          }
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
