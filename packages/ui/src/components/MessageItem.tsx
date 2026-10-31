import {
  lazy,
  memo,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { writeClipboard } from "../lib/useCopy.js";
import { browserLink } from "../lib/deeplink.js";
import type { FileMeta, ID, Message } from "@ownbase/protocol";
import { forwardSource, type ForwardSource } from "@ownbase/client-core";
import { OpenMessageContext, useClient, useWorkspace } from "../context.js";
import { onlyEmoji } from "../lib/emoji.js";
import { formatFull, formatTime } from "../lib/format.js";
import { formatReminderTime, reminderPresets } from "../lib/schedule.js";
import { useMessageReferences } from "../lib/messageReferences.js";
import { conversationKey, startReply } from "../lib/replyTarget.js";
import { useEditRequest } from "../lib/editRequest.js";
import { Avatar } from "./Avatar.js";
import { MessageAttachments } from "./Attachments.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { useShareableServer } from "./ShareableServer.js";
import { Dialog } from "./Dialog.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { Icon } from "./Icon.js";
import { Menu, type MenuItem } from "./Menu.js";
import { CountBadge, useChanges } from "./Motion.js";
import { ReplyQuote } from "./ReplyQuote.js";
import { ForwardCard } from "./ForwardCard.js";
import { LinkPreviews } from "./LinkPreviews.js";
import { LinkedMessages } from "./LinkedMessages.js";
import { PollCard } from "./PollCard.js";
import { CallNote } from "./CallNote.js";
import { LazyDialog } from "./LazyView.js";
import { useConfirm } from "./Confirm.js";
import { Tooltip } from "./Tooltip.js";
import { useToast } from "./Toast.js";

// Editing a sent message is now and then, so the editor loads on first use.
const MessageEditor = lazy(() =>
  import("./MessageEditor.js").then((module) => ({ default: module.MessageEditor })),
);
// So is a reaction beyond the three the toolbar offers, and so does its picker.
const ReactionPicker = lazy(() =>
  import("./ReactionPicker.js").then((module) => ({ default: module.ReactionPicker })),
);
// And forwarding a message somewhere else.
const ForwardDialog = lazy(() =>
  import("./ForwardDialog.js").then((module) => ({ default: module.ForwardDialog })),
);
const TimePopover = lazy(() =>
  import("./TimePopover.js").then((module) => ({ default: module.TimePopover })),
);
// Reporting a message is rarer still (E12).
const ReportMessageDialog = lazy(() =>
  import("./ReportMessageDialog.js").then((module) => ({ default: module.ReportMessageDialog })),
);

/** The three reactions most messages get; the picker has the rest. */
const QUICK_REACTIONS = ["👍", "❤️", "😂"];
/** The row a long press offers on a phone, where a thumb has room for more. */
const SHEET_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "🙏"];
/** How long a press lasts before it opens the message's actions. */
const LONG_PRESS_MS = 450;

interface Props {
  message: Message;
  compact: boolean;
  inThread?: boolean;
  onOpenThread?: (rootId: ID) => void;
  onChannelClick?: (id: ID) => void;
  onOpenImage?: (file: FileMeta) => void;
  onOpenProfile?: (userId: ID) => void;
  /** Briefly flagged after jumping here from search, pins or a link. */
  highlighted?: boolean;
}

/**
 * A message; or, from someone this account blocked (E12), a line saying so,
 * which shows it on request. It keeps its place for the arrow keys and links.
 */
export const MessageItem = memo(function MessageItem(props: Props) {
  const blocked = useWorkspace((s) => s.blocked?.includes(props.message.userId) === true);
  const [shown, setShown] = useState(false);
  if (!blocked || shown) return <MessageRow {...props} />;
  return (
    <div
      role="article"
      data-message-id={props.message.id}
      aria-label="Message from someone you blocked"
      tabIndex={0}
      className={`message-row py-0.5 pl-4 pr-12 ${props.compact ? "" : "mt-4"}`}
    >
      <div className="flex items-center gap-4">
        <span aria-hidden="true" className="flex w-10 shrink-0 justify-center text-ink-faint">
          <Icon name="ban" size={14} />
        </span>
        <p className="text-[13px] text-ink-faint">
          Message from someone you blocked ·{" "}
          <button
            type="button"
            onClick={() => setShown(true)}
            className="underline-offset-2 hover:text-ink hover:underline"
          >
            Show
          </button>
        </p>
      </div>
    </div>
  );
});

const MessageRow = memo(function MessageRow({
  message,
  compact,
  inThread,
  onOpenThread,
  onChannelClick,
  onOpenImage,
  onOpenProfile,
  highlighted,
}: Props) {
  const client = useClient();
  const confirm = useConfirm();
  // Only what this row shows, so a change to anyone or anything else does not
  // render it again; your own role decides what you may do to it.
  const { users, channels } = useMessageReferences(message);
  const selfId = useWorkspace((s) => s.self?.id);
  const selfRole = useWorkspace((s) => s.self?.role);
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  // What the dialog passes on, as it was when Forward was chosen.
  const [forwarding, setForwarding] = useState<ForwardSource | null>(null);
  // Offered only where the server forwards; an older one would drop the card.
  const canForward = useWorkspace((s) => s.forwards);
  const canMute = useWorkspace((s) => s.threadMutes);
  const threadMuted = useWorkspace((s) => s.threadFollows[message.id]?.muted === true);
  // Offered where the server keeps reminders; an older one has none.
  const canRemind = useWorkspace((s) => s.reminders !== null);
  const reminder = useWorkspace((s) => s.reminders?.[message.id] ?? null);
  /** Choosing when to be reminded, from the menu. */
  const [reminding, setReminding] = useState(false);
  // Offered where the server takes reports (E12), which an older one does not.
  const canReport = useWorkspace((s) => s.blocked !== null);
  const [reporting, setReporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  // The toolbar shows on hover; while its menu is open it stays, so the menu
  // has a trigger to hang from and focus has somewhere to return to.
  const [moreOpen, setMoreOpen] = useState(false);
  /** The touch menu, opened by its button or by holding the message. */
  const [touchMenu, setTouchMenu] = useState(false);
  /** The reactions it had when drawn; any other one pops in as it comes. */
  const [firstReactions] = useState(() => new Set(message.reactions.map((g) => g.emoji)));
  const row = useRef<HTMLDivElement>(null);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const cancelPress = () => {
    if (!press.current) return;
    clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => cancelPress, []);
  const shareable = useShareableServer();
  const isSaved = useWorkspace((s) => !!s.saved[message.id]);
  const author = users[message.userId];
  const profileLabel = author ? `View ${author.displayName}'s profile` : "View profile";
  const mine = message.userId === selfId;
  // People voted on a poll's question as it was, so it is not edited.
  // A poll's question was voted on as it was; a call's note says what happened.
  const editable = mine && !message.poll && !message.call;
  // The Drafts list asks for this to finish an unsaved edit.
  useEditRequest(message.id, editable, () => setEditing(true));
  const canDelete = mine || selfRole === "owner" || selfRole === "admin";
  // Named in it, or answered by it with a notification, as Discord marks both.
  const mentionsMe = selfId
    ? message.text.includes(`<@${selfId}>`) ||
      (message.replyTo?.ping === true && message.replyTo.userId === selfId)
    : false;
  const toast = useToast();
  const openMessage = useContext(OpenMessageContext);
  // Answered in place in the conversation it is shown in: the channel, or
  // inside a thread its replies. The thread's first message is the thread.
  const canReply =
    useWorkspace((s) => s.inlineReplies) && !(inThread && message.threadRootId === null);
  /** Shift, as in Discord, answers without notifying the author. */
  function reply(ping = true) {
    startReply(
      client,
      conversationKey(message.channelId, inThread ? message.threadRootId : null),
      message,
      ping,
    );
  }
  /** Brings the message this one answers into view: in place when it is shown, else by a jump. */
  function showOriginal(byKeyboard: boolean) {
    const id = message.replyTo!.id;
    const shown = row.current
      ?.closest("main, aside")
      ?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
    if (!shown) {
      openMessage?.(message.channelId, id);
      return;
    }
    shown.scrollIntoView({ block: "center" });
    shown.classList.remove("reply-flash");
    void shown.offsetWidth;
    shown.classList.add("reply-flash");
    if (byKeyboard) shown.focus({ preventScroll: true });
  }

  /**
   * These toggles are optimistic and undo themselves when the server refuses.
   * The row that started one is hover-only and may be gone by the time the
   * refusal arrives, so the notice carries the news and the second attempt.
   */
  function reportRefusal(failure: string, run: () => Promise<boolean>) {
    void run().then((ok) => {
      if (ok) return;
      toast({
        message: failure,
        action: { label: "Try again", run: () => reportRefusal(failure, run) },
      });
    });
  }

  /** A link that opens anywhere: in a browser at the web client, and in place inside the app. */
  const link = () =>
    browserLink(shareable.serverUrl, {
      kind: "message",
      channelId: message.channelId,
      messageId: message.id,
    });
  function react(emoji: string) {
    reportRefusal("That reaction did not go through.", () => client.toggleReaction(message, emoji));
  }
  const saveLabel = isSaved ? "Remove from Saved" : "Save for later";
  function toggleSaved() {
    // Trying again repeats this intent, whatever the state is by then.
    const save = !isSaved;
    reportRefusal(
      save ? "Could not save that for later." : "Could not remove that from Saved.",
      () => client.toggleSaved(message.id, save),
    );
  }
  const unreadLabel = inThread ? "Mark unread from this reply" : "Mark unread from this message";
  function markUnread() {
    // Inside a thread this is the thread's own unread state, and the root
    // shown at the top of the panel is itself the thread.
    if (inThread) client.markThreadUnread(message.threadRootId ?? message.id, message.seq);
    else client.markUnread(message.channelId, message.seq);
  }
  function remind(at: Date) {
    setReminding(false);
    const when = at.getTime();
    void client.setReminder(message.id, when).then((ok) =>
      toast(
        ok
          ? { message: `Reminder set for ${formatReminderTime(when)}.`, kind: "success" }
          : {
              message: "Could not set that reminder.",
              action: { label: "Try again", run: () => remind(at) },
            },
      ),
    );
  }
  function finishReminder() {
    void client.cancelReminder(message.id).then((ok) => {
      if (!ok)
        toast({
          message: "Could not remove that reminder.",
          action: { label: "Try again", run: finishReminder },
        });
    });
  }
  const remindItems: MenuItem[] = !canRemind
    ? []
    : reminder
      ? [
          {
            id: "remind",
            label: "Change reminder…",
            icon: "clock",
            onSelect: () => setReminding(true),
          },
          {
            id: "remind-done",
            label: reminder.dueAt === null ? "Cancel reminder" : "Mark reminder done",
            icon: reminder.dueAt === null ? "close" : "check",
            onSelect: finishReminder,
          },
        ]
      : [
          {
            id: "remind",
            label: "Remind me about this…",
            icon: "clock",
            onSelect: () => setReminding(true),
          },
        ];
  const pinLabel = message.pinned ? "Unpin from channel" : "Pin to channel";
  function togglePin() {
    reportRefusal(
      message.pinned ? "Could not unpin that message." : "Could not pin that message.",
      () => client.togglePin(message),
    );
  }
  async function deleteMessage() {
    if (deleting) return;
    const go = await confirm({
      title: "Delete this message?",
      body: "Everyone in the conversation stops seeing it.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!go) return;
    setDeleting(true);
    setDeleteError(false);
    try {
      await client.api.deleteMessage(message.id);
    } catch {
      setDeleteError(true);
    } finally {
      setDeleting(false);
    }
  }
  const copyItem: MenuItem = {
    id: "link",
    label: "Copy link to message",
    icon: "link",
    // The menu has closed by now, so a notice says whether it worked.
    onSelect: () =>
      void writeClipboard(link()).then((ok) =>
        toast(
          ok
            ? { message: "Link copied.", kind: "success" }
            : { message: "Could not copy the link." },
        ),
      ),
  };
  // A forward of something hidden here or deleted has nothing to pass on.
  const forwarded = canForward ? forwardSource(message) : null;
  const forwardItems: MenuItem[] = forwarded
    ? [
        {
          id: "forward",
          label: "Forward…",
          icon: "forward",
          onSelect: () => setForwarding(forwarded),
        },
      ]
    : [];
  const unreadItem: MenuItem = {
    id: "unread",
    label: unreadLabel,
    icon: "markUnread",
    onSelect: markUnread,
  };
  // A thread is muted from its first message in the channel once it has
  // replies, and unmuted there whatever it has; the thread's own header has both.
  const muteItems: MenuItem[] =
    canMute && !inThread && (message.replyCount > 0 || threadMuted)
      ? [
          {
            id: "mute",
            label: threadMuted ? "Unmute thread" : "Mute thread",
            icon: "bellOff",
            onSelect: () => client.setThreadMute(message.id, !threadMuted),
          },
        ]
      : [];
  // Pinning changes the channel for everyone, which a guest may not.
  const pinItems: MenuItem[] =
    selfRole === "guest" ? [] : [{ id: "pin", label: pinLabel, icon: "pin", onSelect: togglePin }];
  // Someone else's message, to the workspace's admins (E12).
  const reportItems: MenuItem[] =
    canReport && !mine
      ? [
          {
            id: "report",
            label: "Report message…",
            icon: "flag",
            onSelect: () => setReporting(true),
          },
        ]
      : [];
  const deleteItems: MenuItem[] = canDelete
    ? [
        {
          id: "delete",
          label: "Delete message",
          icon: "trash",
          destructive: true,
          section: true,
          disabled: deleting,
          onSelect: () => void deleteMessage(),
        },
      ]
    : [];
  /** What the message says as shown, names rather than ids. */
  const copyTextItem: MenuItem = {
    id: "copy-text",
    label: "Copy text",
    onSelect: () => {
      const shown = row.current?.querySelector<HTMLElement>(".message-text");
      const text = shown?.innerText ?? shown?.textContent ?? "";
      void writeClipboard(text).then((ok) =>
        toast(
          ok
            ? { message: "Text copied.", kind: "success" }
            : { message: "Could not copy the text." },
        ),
      );
    },
  };
  /** Everything, named, for a touchscreen, where there is no toolbar. */
  const menuItems: MenuItem[] = [
    ...(canReply
      ? [{ id: "answer", label: "Reply", icon: "reply" as const, onSelect: () => reply() }]
      : []),
    ...(inThread
      ? []
      : [
          {
            id: "reply",
            label: "Reply in thread",
            icon: "thread" as const,
            onSelect: () => onOpenThread?.(message.id),
          },
        ]),
    { id: "react", label: "Add a reaction…", icon: "smile", onSelect: () => setPicking(true) },
    // Holding a message opens this menu rather than selecting its words.
    ...(message.text ? [{ ...copyTextItem, icon: "fileText" as const }] : []),
    copyItem,
    ...forwardItems,
    { id: "save", label: saveLabel, icon: "bookmark", onSelect: toggleSaved },
    ...remindItems,
    unreadItem,
    ...muteItems,
    ...pinItems,
    ...(editable
      ? [
          {
            id: "edit",
            label: "Edit message",
            icon: "edit" as const,
            onSelect: () => setEditing(true),
          },
        ]
      : []),
    ...reportItems,
    ...deleteItems.map((item) => ({ ...item, section: undefined })),
  ];
  /** What the toolbar keeps behind its last button: the less frequent half. */
  const moreItems: MenuItem[] = [
    copyItem,
    ...forwardItems,
    ...remindItems,
    unreadItem,
    ...muteItems,
    ...pinItems,
    ...reportItems,
    ...deleteItems,
  ];

  return (
    <div
      ref={row}
      role="article"
      data-message-id={message.id}
      aria-label={`Message from ${author?.displayName ?? "unknown"}`}
      tabIndex={0}
      // Holding a message opens its actions, as phones do everywhere else.
      // A press on a control or a link stays that control's.
      onTouchStart={(event) => {
        cancelPress();
        if (editing || event.touches.length !== 1 || !matchMedia("(hover: none)").matches) return;
        if ((event.target as Element).closest("button, a, input, textarea, video, audio")) return;
        const touch = event.touches[0]!;
        press.current = {
          x: touch.clientX,
          y: touch.clientY,
          timer: window.setTimeout(() => {
            press.current = null;
            navigator.vibrate?.(8);
            setTouchMenu(true);
          }, LONG_PRESS_MS),
        };
      }}
      onTouchMove={(event) => {
        const touch = event.touches[0];
        if (!press.current || !touch) return;
        if (Math.hypot(touch.clientX - press.current.x, touch.clientY - press.current.y) > 10)
          cancelPress();
      }}
      onTouchEnd={cancelPress}
      onTouchCancel={cancelPress}
      className={`message-row group relative py-0.5 pl-4 pr-12 transition-colors duration-75 hover:bg-ink/[0.03] ${
        compact ? "" : "mt-4"
      } ${moreOpen ? "bg-ink/[0.03]" : ""} ${
        mentionsMe ? "bg-mention shadow-[inset_2px_0_var(--color-copper)] hover:bg-mention" : ""
      } ${highlighted ? "bg-copper/15 hover:bg-copper/15" : ""}`}
    >
      {message.replyTo && (
        <ReplyQuote
          quote={message.replyTo}
          users={users}
          channels={channels}
          onOpen={showOriginal}
        />
      )}
      <div className="flex gap-4">
        <div className="relative w-10 shrink-0 pt-0.5">
          {!compact && (
            <Tooltip label={profileLabel}>
              <button
                aria-label={profileLabel}
                onClick={() => onOpenProfile?.(message.userId)}
                className="rounded-full transition-opacity hover:opacity-80"
              >
                <Avatar user={author} size={40} />
              </button>
            </Tooltip>
          )}
          {compact && (
            // Out of the flow and on one line, so showing it cannot make the
            // row taller. A time that wrapped to two lines here grew the row
            // under a resting pointer, and the timeline then lost its place
            // at the bottom when a side panel opened.
            <time
              dateTime={new Date(message.createdAt).toISOString()}
              title={formatFull(message.createdAt)}
              className="absolute right-0 top-0.5 hidden select-none whitespace-nowrap pt-[3px] text-[11px] text-ink-faint group-hover:block"
            >
              {formatTime(message.createdAt)}
            </time>
          )}
        </div>
        <div className="min-w-0 flex-1">
          {(message.pinned || isSaved) && (
            <div className="mb-0.5 flex items-center gap-3 text-[12px] text-ink-faint">
              {message.pinned && (
                <span className="flex items-center gap-1">
                  <Icon name="pin" size={12} />
                  Pinned to this channel
                </span>
              )}
              {isSaved && (
                <span className="flex items-center gap-1">
                  <Icon name="bookmark" size={12} />
                  Saved for later
                </span>
              )}
            </div>
          )}
          {!compact && (
            <div className="flex items-baseline gap-2">
              <button
                onClick={() => onOpenProfile?.(message.userId)}
                className="text-[16px] font-medium leading-snug hover:underline"
              >
                {author?.displayName ?? "unknown"}
              </button>
              {author?.role === "guest" && <GuestTag />}
              {author?.statusEmoji && (
                <span title={author.statusText} className="text-[13px]">
                  {author.statusEmoji}
                </span>
              )}
              <time
                dateTime={new Date(message.createdAt).toISOString()}
                title={formatFull(message.createdAt)}
                className="text-[12px] text-ink-faint"
              >
                {formatTime(message.createdAt)}
              </time>
            </div>
          )}
          {editing ? (
            <ErrorBoundary
              fallback={
                <p role="alert" className="mt-1 text-sm text-ink-dim">
                  The editor could not load. Reload the app to try again.{" "}
                  <button
                    className="font-medium text-ink underline"
                    onClick={() => setEditing(false)}
                  >
                    Cancel
                  </button>
                </p>
              }
            >
              <Suspense
                fallback={
                  <p role="status" className="mt-1 text-sm text-ink-faint">
                    Opening the editor…
                  </p>
                }
              >
                <MessageEditor message={message} onClose={() => setEditing(false)} />
              </Suspense>
            </ErrorBoundary>
          ) : message.poll ? (
            <PollCard
              message={message}
              users={users}
              channels={channels}
              onChannelClick={onChannelClick}
            />
          ) : message.call ? (
            <CallNote message={message} />
          ) : (
            message.text && (
              <div
                className={`message-text text-[16px] leading-[1.375] text-ink/90 ${
                  onlyEmoji(message.text) ? "message-jumbo" : ""
                }`}
              >
                <Mrkdwn
                  text={message.text}
                  users={users}
                  channels={channels}
                  selfId={selfId}
                  onChannelClick={onChannelClick}
                />
                {message.editedAt && (
                  <span className="ml-1.5 text-[11px] text-ink-faint">(edited)</span>
                )}
              </div>
            )
          )}
          {/* An edit changes only the words, so the files and a forwarded
              message stay in view under the editor. */}
          <MessageAttachments files={message.files} onOpenImage={(f) => onOpenImage?.(f)} />
          {!editing && (
            <>
              <LinkPreviews message={message} canRemove={!!selfId && message.userId === selfId} />
              <LinkedMessages
                message={message}
                onOpenImage={onOpenImage}
                onChannelClick={onChannelClick}
              />
            </>
          )}
          {message.forwardedFrom && (
            <ForwardCard
              forward={message.forwardedFrom}
              users={users}
              channels={channels}
              selfId={selfId}
              onOpenImage={onOpenImage}
              onChannelClick={onChannelClick}
            />
          )}
          {!editing && (
            <>
              <MessageActions message={message} />
              {deleteError && (
                <p role="alert" className="mt-2 text-xs text-alert">
                  Could not confirm whether the message was deleted. Check your connection before
                  trying again.
                </p>
              )}
            </>
          )}

          {message.reactions.length > 0 && (
            <div role="group" aria-label="Reactions" className="mt-1.5 flex flex-wrap gap-1">
              {message.reactions.map((g) => {
                const reacted = selfId ? g.userIds.includes(selfId) : false;
                // "you" last, as people say it, and never your own name.
                const others = g.userIds
                  .filter((id) => id !== selfId)
                  .map((id) => users[id]?.displayName ?? "someone");
                const names = new Intl.ListFormat(undefined, { type: "conjunction" }).format(
                  reacted ? [...others, "you"] : others,
                );
                const count = g.userIds.length;
                return (
                  <ReactionChip
                    key={g.emoji}
                    emoji={g.emoji}
                    count={count}
                    reacted={reacted}
                    fresh={!firstReactions.has(g.emoji)}
                    title={names}
                    aria-label={`${g.emoji} ${count} ${count === 1 ? "reaction" : "reactions"}, from ${names}`}
                    onClick={() => react(g.emoji)}
                  />
                );
              })}
            </div>
          )}

          {!inThread && message.threadRootId && (
            <button
              onClick={() => onOpenThread?.(message.threadRootId!)}
              className="mt-1 inline-flex items-center gap-1.5 rounded-md text-left text-[12px] text-ink-faint transition-colors hover:text-ink"
            >
              <Icon name="thread" size={13} />
              <span>
                Also sent to the channel from a thread ·{" "}
                <span className="font-medium text-ink-dim">View thread</span>
              </span>
            </button>
          )}

          {!inThread && message.replyCount > 0 && (
            <button
              onClick={() => onOpenThread?.(message.id)}
              aria-label={
                threadMuted
                  ? `${message.replyCount} ${message.replyCount === 1 ? "reply" : "replies"}, muted`
                  : undefined
              }
              className="-ml-1.5 mt-1 flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[13px] font-medium text-copper transition-colors hover:bg-ink/[0.04]"
            >
              <Icon name="thread" size={14} />
              {message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
              {threadMuted && <Icon name="bellOff" size={12} className="text-ink-faint" />}
              <Icon name="arrow" size={12} className="text-ink-faint" />
            </button>
          )}
        </div>
      </div>

      {!editing && (
        <div
          className={`message-toolbar surface-float absolute -top-4 right-4 z-10 max-w-[calc(100%-32px)] items-center gap-px overflow-x-auto rounded-lg p-0.5 ${
            moreOpen ? "flex" : "hidden group-hover:flex group-focus-within:flex"
          }`}
        >
          {QUICK_REACTIONS.map((e) => (
            <ToolbarButton key={e} label={e} onClick={() => react(e)} />
          ))}
          <ToolbarButton
            label={<Icon name="smile" size={18} strokeWidth={2} />}
            title="Add a reaction"
            onClick={() => setPicking(true)}
          />
          <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-edge" />
          {canReply && (
            <ToolbarButton
              label={<Icon name="reply" size={18} strokeWidth={2} />}
              title="Reply"
              onClick={(event) => reply(!event.shiftKey)}
            />
          )}
          {!inThread && (
            <ToolbarButton
              label={<Icon name="thread" size={18} strokeWidth={2} />}
              title="Reply in thread"
              onClick={() => onOpenThread?.(message.id)}
            />
          )}
          <ToolbarButton
            label={<Icon name="bookmark" size={18} strokeWidth={2} />}
            title={saveLabel}
            active={isSaved}
            onClick={toggleSaved}
          />
          {editable && (
            <ToolbarButton
              label={<Icon name="edit" size={18} strokeWidth={2} />}
              title="Edit message"
              onClick={() => setEditing(true)}
            />
          )}
          <Menu
            label="More actions"
            triggerLabel="More actions"
            triggerContent={<Icon name="dots" size={18} strokeWidth={2} />}
            tooltip="More actions"
            items={moreItems}
            // Wide enough that "Mark unread from this message" stays on one line.
            width={272}
            onOpenChange={setMoreOpen}
            triggerClassName="icon-live flex size-7 items-center justify-center rounded-md text-ink-dim transition-colors hover:bg-ink/[0.08] hover:text-ink"
          />
        </div>
      )}
      {/* A touchscreen has no hover to raise the toolbar, so each message
          offers the same actions, with their names, in a menu of its own. */}
      {!editing && (
        <div className="message-more absolute right-1 top-0.5">
          <Menu
            label={`Actions for message from ${author?.displayName ?? "unknown"}`}
            items={menuItems}
            open={touchMenu}
            onOpenChange={setTouchMenu}
            sheet
            header={(close) => (
              <div className="flex items-center justify-between">
                {SHEET_REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    aria-label={`React with ${emoji}`}
                    onClick={() => {
                      close();
                      react(emoji);
                    }}
                    className="flex size-11 items-center justify-center rounded-full text-2xl transition-transform active:scale-90"
                  >
                    {emoji}
                  </button>
                ))}
                <button
                  type="button"
                  aria-label="Add a reaction"
                  onClick={() => {
                    close();
                    setPicking(true);
                  }}
                  className="flex size-11 items-center justify-center rounded-full bg-ink/[0.06] text-ink-dim"
                >
                  <Icon name="smile" size={20} />
                </button>
              </div>
            )}
            triggerClassName="flex size-9 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
          />
        </div>
      )}
      {picking && (
        <ErrorBoundary
          fallback={
            <Dialog title="Add a reaction" onClose={() => setPicking(false)}>
              <p role="alert" className="text-sm text-ink-dim">
                The emoji picker could not load. Reload the app to try again.
              </p>
            </Dialog>
          }
        >
          <Suspense fallback={null}>
            <ReactionPicker anchor={row} onPick={react} onClose={() => setPicking(false)} />
          </Suspense>
        </ErrorBoundary>
      )}
      {reminding && (
        <ErrorBoundary
          fallback={
            <Dialog title="Remind me" onClose={() => setReminding(false)}>
              <p role="alert" className="text-sm text-ink-dim">
                Reminders could not load. Reload the app to try again.
              </p>
            </Dialog>
          }
        >
          <Suspense fallback={null}>
            <TimePopover
              label="Remind me"
              presets={reminderPresets()}
              submitLabel={(at) =>
                at ? `Remind me ${formatReminderTime(at.getTime())}` : "Set reminder"
              }
              anchor={row}
              onClose={() => setReminding(false)}
              onPick={remind}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      {forwarding && (
        <LazyDialog loading="Loading Forward message" onClose={() => setForwarding(null)}>
          <ForwardDialog source={forwarding} onClose={() => setForwarding(null)} />
        </LazyDialog>
      )}
      {reporting && (
        <LazyDialog loading="Loading Report message" onClose={() => setReporting(false)}>
          <ReportMessageDialog message={message} onClose={() => setReporting(false)} />
        </LazyDialog>
      )}
    </div>
  );
});

/**
 * One reaction under a message. A new one pops in, its count rolls when it
 * changes, and the emoji gives under your press when you add yours.
 */
function ReactionChip({
  emoji,
  count,
  reacted,
  fresh,
  ...button
}: {
  emoji: string;
  count: number;
  reacted: boolean;
  /** Came after the message was drawn. */
  fresh: boolean;
} & ComponentProps<"button">) {
  const pressed = useChanges(reacted);
  return (
    <button
      {...button}
      type="button"
      aria-pressed={reacted}
      className={`flex h-6 items-center gap-1.5 rounded-lg border px-1.5 text-[15px] transition-[color,background-color,border-color,scale] active:scale-95 ${
        reacted
          ? "border-copper/60 bg-copper/15"
          : "border-transparent bg-lifted hover:border-ink-faint/40"
      } ${fresh ? "animate-badge-in" : ""}`}
    >
      <span key={pressed} className={reacted && pressed ? "inline-block animate-press" : undefined}>
        {emoji}
      </span>
      <CountBadge
        count={count}
        className={`tabular text-[12px] font-medium ${reacted ? "text-copper" : "text-ink-dim"}`}
      />
    </button>
  );
}

function ToolbarButton(props: {
  label: ReactNode;
  title?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: (event: React.MouseEvent) => void;
}) {
  const button = (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={props.title}
      // One colour or the other: of two text colours on one element, the stylesheet's order picks.
      className={`icon-live flex size-7 items-center justify-center rounded-md text-[15px] transition-colors hover:bg-ink/[0.08] disabled:opacity-40 ${
        props.active ? "text-copper" : "text-ink-dim hover:text-ink"
      }`}
    >
      {props.label}
    </button>
  );
  return props.title ? <Tooltip label={props.title}>{button}</Tooltip> : button;
}

/**
 * The buttons an app attached to a message. A link button is an ordinary
 * anchor; everything else calls the app back and waits, because the answer
 * usually rewrites the very message the button sits on.
 */
function MessageActions({ message }: { message: Message }) {
  const client = useClient();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (message.actions.length === 0) return null;

  // An app's primary is drawn as the app's own primary is. Danger stays quiet
  // until pointed at: a message is not where anything is confirmed.
  const styles: Record<string, string> = {
    primary: "border-copper bg-copper text-ground hover:border-copper-deep hover:bg-copper-deep",
    danger: "border-edge text-alert hover:border-alert/60",
    default: "border-edge text-ink-dim hover:border-ink-faint hover:text-ink",
  };

  async function press(actionId: string) {
    setError(null);
    setPending(actionId);
    try {
      const res = await client.api.runMessageAction(message.id, actionId);
      if (!res.ok) setError("That did not go through.");
    } catch {
      setError("That did not go through.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {message.actions.map((action) =>
        action.url ? (
          <a
            key={action.actionId}
            href={action.url}
            target="_blank"
            rel="noreferrer noopener"
            className={`rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors ${styles.default}`}
          >
            {action.text}
          </a>
        ) : (
          <button
            key={action.actionId}
            disabled={pending !== null}
            onClick={() => void press(action.actionId)}
            className={`rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-50 ${
              styles[action.style] ?? styles.default
            }`}
          >
            {pending === action.actionId ? "…" : action.text}
          </button>
        ),
      )}
      {error && (
        <span role="alert" className="text-[12px] text-alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** Says a guest wrote it: somebody who joined with a name alone, for a day. */
export function GuestTag() {
  return (
    <span
      title="Joined as a guest"
      className="rounded border border-edge px-1 text-[11px] font-medium text-ink-faint"
    >
      Guest
    </span>
  );
}
