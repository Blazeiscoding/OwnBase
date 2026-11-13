import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  isRoom,
  MESSAGE_TEXT_MAX,
  parseCommand,
  type ID,
  type InAppCommandName,
  type ScheduleMessageBody,
} from "@ownbase/protocol";
import {
  OUTBOX_LIMIT,
  draftKey as draftKeyOf,
  quoteOf,
  threadReplies,
  timelineMessages,
} from "@ownbase/client-core";
import { useClient, usePlatform, useWorkspace } from "../context.js";
import { formatBytes } from "../lib/format.js";
import { useComposerPreferences } from "../lib/composerPreferences.js";
import { formatScheduleShort, formatScheduleTime, schedulePresets } from "../lib/schedule.js";
import { cancelReply, setReplyPing, useReplyTarget } from "../lib/replyTarget.js";
import { Icon } from "./Icon.js";
import { Menu } from "./Menu.js";
import { iconFor } from "./Attachments.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { Tooltip } from "./Tooltip.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { MentionTags } from "./MentionTags.js";
import { insideCodeBlock, isImeKey, linkOverSelection } from "../lib/textInput.js";
import { pasteRich } from "../lib/richPaste.js";
import { lastEditable, requestEdit } from "../lib/editRequest.js";
import { shortcutLabel } from "../lib/shortcuts.js";
import { useMaxFileBytes, withinLimit } from "../lib/fileLimit.js";
import { useConnectionDown } from "../lib/online.js";
import { useMentionField } from "../lib/useMentionField.js";
import { useListbox } from "../lib/useListbox.js";
import { SuggestionList, useSuggestions } from "./Suggestions.js";
import { offeredCommands, runAppCommand } from "../lib/appCommands.js";
import { useToast } from "./Toast.js";
import { ScheduledSends, type ScheduleAnswer } from "@ownbase/client-core";
import {
  FormattingToolbar,
  formatList,
  formatText,
  formattingShortcut,
  listShortcut,
  type ListKind,
} from "./FormattingToolbar.js";

// Choosing a time to send is now and then, so its picker loads on first use.
const TimePopover = lazy(() =>
  import("./TimePopover.js").then((module) => ({ default: module.TimePopover })),
);
// So is making a poll (E6).
const PollDialog = lazy(() =>
  import("./PollDialog.js").then((module) => ({ default: module.PollDialog })),
);

interface Props {
  channelId: ID;
  threadRootId?: ID;
  placeholder: string;
  autoFocus?: boolean;
  /** After /leave: somewhere else to be, as leaving from channel details goes. */
  onLeft?: () => void;
}

/** Enter follows the device preference; @ opens mention autocomplete. */
export function Composer({ channelId, threadRootId, placeholder, autoFocus, onLeft }: Props) {
  const client = useClient();
  const platform = usePlatform();
  const { enterSends } = useComposerPreferences();
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const commands = useWorkspace((s) => s.commands);
  const selfId = useWorkspace((s) => s.self?.id);
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const channelType = useWorkspace((s) => s.channels[channelId]?.type);
  const archived = useWorkspace((s) => s.channels[channelId]?.archived ?? false);
  const room = isRoom(channelType);
  // A guest writes, but does not upload, schedule or run an app's commands.
  const guest = useWorkspace((s) => s.self?.role === "guest");
  /** The question the poll window opens with; null while it is closed. */
  const [pollQuestion, setPollQuestion] = useState<string | null>(null);
  const draftKey = draftKeyOf(channelId, threadRootId);
  /** The message the next send answers in place, chosen with Reply. */
  const replyTarget = useReplyTarget(client, draftKey);
  const replyName = replyTarget
    ? (users[replyTarget.message.userId]?.displayName ?? "unknown")
    : "";
  const schedules = useMemo(() => new ScheduledSends(client, platform), [client, platform]);
  /** Whose request for which composer the device is asked for: it is kept per account. */
  const scheduleScope = selfId ? `${workspaceId ?? ""} ${selfId} ${draftKey}` : null;
  const [scheduleLoadedKey, setScheduleLoadedKey] = useState<string | null>(null);
  const [pendingSchedule, setPendingSchedule] = useState<ScheduleMessageBody | null>(null);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const scheduleReady = scheduleScope !== null && scheduleLoadedKey === scheduleScope;
  const recoveryBlocksSend = !scheduleReady || pendingSchedule !== null;
  const savedDraft = useWorkspace((s) => s.drafts[draftKey] ?? "");
  const [text, setText] = useState(savedDraft);
  const [attached, setAttached] = useState<File[]>([]);
  const maxFileBytes = useMaxFileBytes(client, !guest);
  const [dragging, setDragging] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const scheduleButton = useRef<HTMLButtonElement>(null);
  const [scheduleNote, setScheduleNote] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const scheduleLock = useRef(false);
  const scheduleContext = useRef<object>({});
  const uploadController = useRef<AbortController | null>(null);
  const [preview, setPreview] = useState(false);
  /** Replies only: also show this one in the channel's own timeline. */
  const [alsoToChannel, setAlsoToChannel] = useState(false);
  const [attachmentNote, setAttachmentNote] = useState<string | null>(null);
  /** Why the last send was not taken, while the draft waits in the box. */
  const [sendRefusal, setSendRefusal] = useState<string | null>(null);
  /**
   * A send whose words this box keeps until the device has them (GL-02):
   * its draft key, so a send from another conversation is never cleared here.
   */
  const [saving, setSaving] = useState<{ draftKey: string; nonce: string } | null>(null);
  /**
   * This box's words wait for the device, so typing is refused. Not by making
   * the box read only: a phone drops its keyboard from a read-only box, and it
   * stays down once the box takes typing again.
   */
  const held = saving?.draftKey === draftKey;
  const box = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  /** Where files dragged over the conversation would land, while they are. */
  const [dropArea, setDropArea] = useState<DOMRect | null>(null);
  /** True once the user has edited this conversation's draft in this session. */
  const edited = useRef(false);
  /** The conversation this box writes to now, for a send that settles later. */
  const currentDraftKey = useRef(draftKey);
  currentDraftKey.current = draftKey;
  const toast = useToast();
  /** A command the app runs, still running: Enter again waits for it. */
  const runningCommand = useRef(false);
  /** The saved draft as this composer last wrote or took it; typing since is unsaved. */
  const synced = useRef(savedDraft);

  // Switching conversations swaps in that conversation's draft and clears attachments.
  useEffect(() => {
    edited.current = false;
    synced.current = client.state.drafts[draftKey] ?? "";
    setText(synced.current);
    setAttached([]);
    suggestions.close();
    setPreview(false);
    setAttachmentNote(null);
    setSendRefusal(null);
    setScheduleOpen(false);
    setScheduleNote(null);
    setScheduleError(null);
    setScheduling(false);
    scheduleLock.current = false;
    scheduleContext.current = {};
    return () => {
      scheduleContext.current = {};
      uploadController.current?.abort();
    };
  }, [client, draftKey, scheduleScope]);

  useEffect(() => {
    let active = true;
    setPendingSchedule(null);
    setScheduleLoadedKey(null);
    if (!scheduleScope) return;
    void schedules.saved({ channelId, threadRootId }).then((saved) => {
      if (!active) return;
      if ("failed" in saved) {
        setScheduleError(saved.failed);
        return;
      }
      setPendingSchedule(saved.request);
      setScheduleLoadedKey(scheduleScope);
      if (saved.request && !client.state.drafts[draftKey]) {
        setText(saved.request.text);
        client.setDraft(draftKey, saved.request.text);
      }
    });
    return () => {
      active = false;
    };
  }, [client, schedules, scheduleScope, channelId, threadRootId, restoreAttempt]);

  // Drafts load from disk asynchronously, so they can arrive after this mounts,
  // and another window can change or clear this conversation's draft. Either
  // is taken on unless there is typing here not saved yet, never over it: that
  // typing is saved in turn, and the later edit is the draft.
  useEffect(() => {
    const untouched = !edited.current || typed.current.text === synced.current;
    synced.current = savedDraft;
    if (untouched) setText(savedDraft);
  }, [savedDraft]);

  // Persist as the user types. Guarded by `edited` so a freshly mounted empty
  // composer can't blank out a draft that hasn't loaded yet.
  useEffect(() => {
    if (!edited.current || text === savedDraft) return;
    const timer = setTimeout(() => client.setDraft(draftKey, text), 250);
    return () => clearTimeout(timer);
  }, [client, draftKey, text, savedDraft]);

  // That debounce is cancelled by every keystroke, including the last one
  // before the composer unmounts or the conversation changes. This effect only
  // re-runs when the conversation does, so its cleanup still closes over the
  // conversation being left, while the refs hold what was typed into it.
  const typed = useRef({ text, savedDraft });
  typed.current = { text, savedDraft };
  useLayoutEffect(() => {
    return () => {
      if (edited.current && typed.current.text !== typed.current.savedDraft) {
        client.setDraft(draftKey, typed.current.text);
      }
    };
  }, [client, draftKey]);

  // Nor may it hold back the last keystrokes from a page being hidden or
  // closed, which writes its unsent work at once (F01). Capturing, so this
  // runs before that write does.
  useEffect(() => {
    const handOver = () => {
      if (edited.current && typed.current.text !== typed.current.savedDraft) {
        client.setDraft(draftKey, typed.current.text);
      }
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") handOver();
    };
    window.addEventListener("pagehide", handOver, true);
    document.addEventListener("visibilitychange", onHide, true);
    const stopPreparing = platform.onPrepareClose?.("capture", handOver);
    return () => {
      window.removeEventListener("pagehide", handOver, true);
      document.removeEventListener("visibilitychange", onHide, true);
      stopPreparing?.();
    };
  }, [client, draftKey, platform]);

  /** Attaches files, up to ten; `note` is said beside any word about the limit. */
  function addFiles(files: FileList | File[] | null, note?: string) {
    if (!files || scheduleLock.current || recoveryBlocksSend) return;
    const incoming = [...files];
    if (guest) {
      if (incoming.length > 0)
        setAttachmentNote("Guests cannot attach files. Create an account to share them.");
      return;
    }
    // One over the workspace's limit would only fail once uploaded.
    const { ok, over } = withinLimit(incoming, maxFileBytes);
    if (over.length > 0 && maxFileBytes !== null) {
      const names = over.map((f) => f.name).join(", ");
      note = [
        note,
        `${names} ${over.length === 1 ? "is" : "are"} over this workspace's ${formatBytes(maxFileBytes)} limit per file and ${over.length === 1 ? "was" : "were"} not attached.`,
      ]
        .filter(Boolean)
        .join(" ");
      incoming.splice(0, incoming.length, ...ok);
      if (incoming.length === 0) setAttachmentNote(note);
    }
    if (incoming.length > 0) {
      const notes = [
        note,
        attached.length + incoming.length > 10
          ? "A message can have up to 10 files. The extra files were not attached."
          : undefined,
      ].filter(Boolean);
      setAttachmentNote(notes.length ? notes.join(" ") : null);
      setAttached((prev) => [...prev, ...incoming].slice(0, 10));
    }
  }

  // Files dropped anywhere on the conversation, or on the thread, come here,
  // not only those that hit this box.
  const latest = useRef({ addFiles, archived });
  latest.current = { addFiles, archived };
  useEffect(() => {
    const own = shell.current;
    if (!own) return;
    const zone = own.closest<HTMLElement>("main, aside") ?? own;
    let depth = 0;
    const carriesFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const end = () => {
      depth = 0;
      setDragging(false);
      setDropArea(null);
    };
    const enter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth++;
      setDragging(true);
      setDropArea(zone.getBoundingClientRect());
    };
    const over = (e: DragEvent) => {
      if (carriesFiles(e)) e.preventDefault();
    };
    // Nested elements fire leave events; only the outermost one ends the drag.
    const leave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) end();
    };
    const drop = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      end();
      if (!latest.current.archived) latest.current.addFiles(e.dataTransfer!.files);
    };
    zone.addEventListener("dragenter", enter);
    zone.addEventListener("dragover", over);
    zone.addEventListener("dragleave", leave);
    zone.addEventListener("drop", drop);
    return () => {
      zone.removeEventListener("dragenter", enter);
      zone.removeEventListener("dragover", over);
      zone.removeEventListener("dragleave", leave);
      zone.removeEventListener("drop", drop);
    };
  }, []);

  useLayoutEffect(() => {
    if (!box.current) return;
    box.current.style.height = "auto";
    box.current.style.height = `${Math.min(box.current.scrollHeight, 220)}px`;
  }, [text]);

  // The box shows mentions as names; `text` keeps them as ids, as sent.
  const field = useMentionField(
    text,
    box,
    (next) => {
      setText(next);
      edited.current = true;
    },
    users,
    channels,
  );
  const suggestions = useSuggestions({
    field,
    box,
    apply: (next, caret) => rewrite(next, caret),
    room,
  });

  /** Rewrites the draft, selecting `start..end` of the new text. */
  function rewrite(next: string, start?: number, end = start) {
    if (scheduleLock.current || recoveryBlocksSend || held) return;
    suggestions.close();
    field.edit(next, start, end);
  }

  function format(marker: string, placeholderText: string, block = false) {
    if (!box.current) return;
    const { start, end } = field.selection();
    const next = formatText(text, start, end, marker, placeholderText, block);
    rewrite(next.text, next.selectionStart, next.selectionEnd);
  }

  function list(kind: ListKind) {
    if (!box.current) return;
    const { start, end } = field.selection();
    const next = formatList(text, start, end, kind);
    rewrite(next.text, next.selectionStart, next.selectionEnd);
  }

  function insertEmoji(emoji: string) {
    const next = field.replaceSelection(emoji);
    rewrite(next.stored, next.caret);
  }

  // The box is disabled until its saved scheduling state has loaded, and a
  // disabled box refuses focus. Signing in, or opening a thread, used to leave
  // focus nowhere or on the button pressed. So a refused request waits, holding
  // what had focus then, and is granted once the box can take it, unless
  // somebody has moved on meanwhile.
  const focusWanted = useRef<Element | null | undefined>(undefined);
  useEffect(() => {
    if (!autoFocus) return;
    const before = document.activeElement;
    box.current?.focus();
    focusWanted.current = document.activeElement === box.current ? undefined : before;
  }, [autoFocus, channelId, threadRootId]);

  // Choosing Reply, even again on the same message, brings the box to hand.
  const replyAsked = replyTarget ? `${replyTarget.message.id}:${replyTarget.asked}` : null;
  useEffect(() => {
    if (replyAsked) box.current?.focus();
  }, [replyAsked]);

  const blocked = archived || recoveryBlocksSend;
  useEffect(() => {
    if (blocked || focusWanted.current === undefined) return;
    const before = focusWanted.current;
    focusWanted.current = undefined;
    const now = document.activeElement;
    if (!now || now === document.body || now === before) box.current?.focus();
  }, [blocked]);

  /**
   * Commands are offered only while the first word is still being typed —
   * once there is an argument the list would just be in the way.
   */
  const commandCandidates = useMemo(() => {
    const m = /^\/([a-zA-Z0-9_-]*)$/.exec(text);
    if (!m || guest) return [];
    const q = m[1]!.toLowerCase();
    return offeredCommands(commands, room).filter((c) => c.command.startsWith(q));
  }, [text, commands, guest, room]);
  const commandList = useListbox(commandCandidates.length);
  function insertCommand(command: string) {
    const next = `/${command} `;
    rewrite(next, next.length);
  }

  const chooseCommand = commandList.choose;
  useEffect(() => chooseCommand(0), [commandCandidates.length, chooseCommand]);

  function send() {
    // Only this conversation's send waiting to be kept holds this one back.
    if (archived || scheduleLock.current || recoveryBlocksSend || held) return;
    const trimmed = text.trim();
    if ((!trimmed && attached.length === 0) || text.length > MESSAGE_TEXT_MAX) return;
    if (runningCommand.current) return;
    const answer = client.send(channelId, trimmed, {
      threadRootId,
      files: attached,
      alsoSendToChannel: alsoToChannel,
      ...(replyTarget ? { replyTo: quoteOf(replyTarget.message, replyTarget.ping) } : {}),
    });
    if (answer.kind === "refused") {
      // Nothing was taken, so the words stay here rather than only in memory.
      setSendRefusal(
        answer.reason === "outbox_full"
          ? `${OUTBOX_LIMIT} messages are already waiting to send. You can send this one once they go out, or after you discard some.`
          : "Could not send this message. Your text is still here. Try again.",
      );
      return;
    }
    if (answer.kind === "in_app") return runInApp(answer.name, answer.args);
    setSendRefusal(null);
    // A deliberate choice per reply, not a mode to get stuck in.
    setAlsoToChannel(false);
    cancelReply(client, draftKey);
    setAttached([]);
    suggestions.close();
    setAttachmentNote(null);
    // The words stay here, and in the saved draft, until the device keeps the
    // send itself: until then a closed window would lose them (GL-02).
    if (answer.kind !== "queued" || !answer.kept) return clearSent(draftKey);
    const { kept } = answer;
    const sending = { draftKey, nonce: answer.nonce };
    setSaving(sending);
    void kept.then((outcome) => {
      setSaving((now) => (now?.nonce === sending.nonce ? null : now));
      if (sending.draftKey !== currentDraftKey.current) {
        // The conversation changed meanwhile: its draft still goes with the send.
        if (client.state.drafts[sending.draftKey]?.trim() === trimmed)
          client.setDraft(sending.draftKey, "");
        return;
      }
      clearSent(sending.draftKey);
      if (outcome === "unsaved")
        setSendRefusal(
          "Your message is sending, but this device could not save a copy. Keep this window open until it has sent.",
        );
    });
  }

  /** A command the app runs itself (U4); /poll opens the poll window, its words the question. */
  function runInApp(name: InAppCommandName, args: string) {
    if (guest) {
      setSendRefusal(
        name === "poll"
          ? "Guests cannot make polls. Create an account to make one."
          : `Guests cannot use /${name}. Create an account to use it.`,
      );
      return;
    }
    setSendRefusal(null);
    if (name === "poll") return setPollQuestion(args);
    runningCommand.current = true;
    const key = draftKey;
    void runAppCommand(name, args, { client, channelId })
      .then((outcome) => {
        if (!outcome.ok) {
          setSendRefusal(outcome.said);
          return;
        }
        toast({ message: outcome.said, kind: "success" });
        if (key === currentDraftKey.current) {
          suggestions.close();
          clearSent(key);
        } else client.setDraft(key, "");
        if (name === "leave") onLeft?.();
      })
      .finally(() => (runningCommand.current = false));
  }

  /** Empties the box after a send is taken, and the draft it came from. */
  function clearSent(key: string) {
    setText("");
    edited.current = false;
    client.setDraft(key, "");
    if (box.current) box.current.style.height = "auto";
  }

  async function schedule(at: Date) {
    if (archived) return;
    if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) {
      setScheduleError("Choose a date and time in the future.");
      return;
    }
    if (
      scheduleLock.current ||
      recoveryBlocksSend ||
      (!text.trim() && attached.length === 0) ||
      text.length > MESSAGE_TEXT_MAX
    )
      return;
    scheduleLock.current = true;
    setScheduling(true);
    setScheduleOpen(false);
    setScheduleError(null);
    const context = scheduleContext.current;
    const controller = new AbortController();
    uploadController.current = controller;
    // Keep the draft if the user leaves while the request is in flight.
    client.setDraft(draftKey, text);
    const answer = await schedules.schedule(
      { channelId, threadRootId },
      { text, files: attached, sendAt: at.getTime(), alsoToChannel },
      controller.signal,
    );
    if (scheduleContext.current !== context) return;
    uploadController.current = null;
    scheduled(answer);
  }

  async function recoverSchedule(dismiss = false) {
    if (scheduleLock.current || !scheduleScope) return;
    const context = scheduleContext.current;
    scheduleLock.current = true;
    setScheduling(true);
    setScheduleError(null);
    const place = { channelId, threadRootId };
    if (dismiss) {
      const forgotten = await schedules.forget(place);
      if (scheduleContext.current !== context) return;
      if (forgotten) {
        setPendingSchedule(null);
        setScheduleLoadedKey(scheduleScope);
      } else
        setScheduleError(
          "Could not check if the message was scheduled. Your message is still saved here. Try again when you're back online.",
        );
      scheduleLock.current = false;
      setScheduling(false);
      return;
    }
    if (!pendingSchedule) {
      scheduleLock.current = false;
      setScheduling(false);
      return;
    }
    const answer = await schedules.check(place, pendingSchedule);
    if (scheduleContext.current === context) scheduled(answer);
  }

  /** Shows what scheduling came to, in the composer it was asked from. */
  function scheduled(answer: ScheduleAnswer) {
    scheduleLock.current = false;
    setScheduling(false);
    if (!answer.ok) {
      setPendingSchedule(answer.saved);
      setScheduleError(answer.reason);
      return;
    }
    const { scheduled, request } = answer;
    setPendingSchedule(null);
    if (typed.current.text.trim() === request.text) {
      setText("");
      edited.current = false;
      client.setDraft(draftKey, "");
    }
    setAttached([]);
    // As after sending: a deliberate choice per reply, not a mode.
    setAlsoToChannel(false);
    setScheduleError(null);
    setScheduleNote(
      scheduled.status === "sent"
        ? "This message was already sent."
        : `Scheduled for ${formatScheduleTime(scheduled.sendAt)}. Change or remove it in Scheduled.`,
    );
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter confirms an IME candidate; it must not send an unfinished message.
    if (isImeKey(e.nativeEvent)) return;
    field.onKeyDown(e);
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const marker = formattingShortcut(e.key, e.shiftKey);
      if (marker) {
        e.preventDefault();
        format(marker, "text");
        return;
      }
      const listed = listShortcut(e);
      if (listed) {
        e.preventDefault();
        list(listed);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        send();
        return;
      }
    }
    if (commandCandidates.length > 0) {
      if (commandList.move(e)) return;
      if (e.key === "Tab") {
        e.preventDefault();
        insertCommand(commandCandidates[commandList.active]!.command);
        return;
      }
      // Enter follows the send preference, rather than choosing a command.
    }
    if (suggestions.keyDown(e)) return;
    if (
      e.key === "ArrowUp" &&
      !e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      e.currentTarget.value === "" &&
      attached.length === 0
    ) {
      // Up in an empty box edits your last message here, as in Slack.
      const s = client.store.getState();
      const items = threadRootId ? threadReplies(s, threadRootId) : timelineMessages(s, channelId);
      const mine = lastEditable(items, s.self?.id);
      if (mine) {
        e.preventDefault();
        requestEdit(mine.id);
        return;
      }
    }
    if (e.key === "Escape" && replyTarget) {
      // Before the panel behind it takes Escape to close.
      e.preventDefault();
      e.stopPropagation();
      cancelReply(client, draftKey);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && enterSends) {
      // A new line of the code, not half a code block sent; Ctrl/Cmd+Enter sends.
      if (insideCodeBlock(e.currentTarget.value, e.currentTarget.selectionStart)) return;
      e.preventDefault();
      send();
    }
  }

  /** Discord's round plus: the way to add anything to a message. */
  const plus = (
    <span className="flex size-6 items-center justify-center rounded-full bg-ink-dim text-lifted transition-colors group-hover/attach:bg-ink">
      <Icon name="plus" size={14} strokeWidth={2.6} />
    </span>
  );

  return (
    <div ref={shell} className="composer-shell @container relative shrink-0 px-4 pb-5">
      {dropArea && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-40 animate-fade-in p-2"
          style={{
            top: dropArea.top,
            left: dropArea.left,
            width: dropArea.width,
            height: dropArea.height,
          }}
        >
          {/* A quiet dropzone: a dotted field, the file icon on a raised tile, two lines. */}
          <div className="drop-field flex size-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-ink-faint/50 bg-ground/90 backdrop-blur-sm">
            <span className="mb-2 flex size-12 items-center justify-center rounded-xl border border-edge bg-raised text-copper shadow-[var(--shadow-float)]">
              <Icon name="attach" size={22} />
            </span>
            <p className="text-[15px] font-semibold text-ink">
              {guest
                ? "Guests cannot attach files"
                : archived
                  ? "This channel is archived"
                  : `Drop to share in ${placeholder.startsWith("Message ") ? placeholder.slice(8) : "this thread"}`}
            </p>
            {!guest && !archived && (
              <p className="text-[13px] text-ink-dim">Up to 10 files in one message</p>
            )}
          </div>
        </div>
      )}
      <ConnectionNotice />
      {archived && (
        <p role="status" className="mb-3 rounded-lg border border-edge p-3 text-sm text-ink-dim">
          This channel is archived, so nobody can post or reply. Your draft is still here. A channel
          manager can reopen it in channel details.
        </p>
      )}
      {!scheduling && commandCandidates.length > 0 && (
        <ul
          {...commandList.listProps}
          aria-label="Commands"
          // Every command, scrolling past eight or so, so "/" shows what there is.
          className="surface-float absolute bottom-full left-5 right-5 z-10 mb-2 max-h-80 origin-bottom-left animate-menu-in overflow-y-auto rounded-xl p-1"
        >
          {commandCandidates.map((c, i) => (
            <li
              key={c.command}
              {...commandList.optionProps(i)}
              onClick={() => insertCommand(c.command)}
              className={`flex w-full cursor-pointer items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm ${
                i === commandList.active ? "bg-ink/[0.07]" : ""
              }`}
            >
              <span className="font-mono font-medium text-ink">/{c.command}</span>
              {c.usageHint && (
                <span className="font-mono text-xs text-ink-faint">{c.usageHint}</span>
              )}
              <span className="min-w-0 flex-1 truncate text-xs text-ink-dim">{c.description}</span>
            </li>
          ))}
        </ul>
      )}
      {!scheduling && <SuggestionList suggestions={suggestions} />}
      {scheduleError && (
        <p role="alert" className="mb-2 text-sm text-ink-dim">
          {scheduleError}
        </p>
      )}
      {sendRefusal && (
        <p role="alert" className="mb-2 text-sm text-ink-dim">
          {sendRefusal}
        </p>
      )}
      {pendingSchedule && (
        <div className="mb-2 space-y-2 rounded-lg border border-edge p-3 text-sm text-ink-dim">
          <p>
            OwnBase could not tell if this message was scheduled. Check again uses the same{" "}
            {!pendingSchedule.fileIds?.length
              ? "text and time"
              : pendingSchedule.fileIds.length === 1
                ? "text, time and file"
                : `text, time and ${pendingSchedule.fileIds.length} files`}
            . It cannot schedule the message twice.
          </p>
          <button
            disabled={scheduling}
            className="mr-3 font-medium text-ink underline decoration-ink-faint/60 hover:decoration-ink"
            onClick={() => void recoverSchedule()}
          >
            Check again
          </button>
          <details className="group">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 hover:text-ink">
              <Icon
                name="chevronDown"
                size={14}
                className="-rotate-90 transition-transform group-open:rotate-0"
              />
              Keep this draft instead
            </summary>
            <p className="my-2">
              Look in Scheduled first. Keeping the draft does not cancel a message that is already
              scheduled. If you send it again, it could go out twice.
            </p>
            <button
              disabled={scheduling}
              className="font-medium text-ink underline decoration-ink-faint/60 hover:decoration-ink"
              onClick={() => void recoverSchedule(true)}
            >
              Keep the draft and stop checking
            </button>
          </details>
        </div>
      )}
      {!scheduleReady && scheduleError && (
        <div className="mb-2 text-sm">
          <button
            className="mr-3 font-medium text-ink underline decoration-ink-faint/60 hover:decoration-ink"
            onClick={() => setRestoreAttempt((attempt) => attempt + 1)}
          >
            Try again
          </button>
          <details className="group">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 hover:text-ink">
              <Icon
                name="chevronDown"
                size={14}
                className="-rotate-90 transition-transform group-open:rotate-0"
              />
              Keep this draft instead
            </summary>
            <p>
              Look in Scheduled before you send this draft again. Keeping it does not cancel a
              message that is already scheduled.
            </p>
            <button
              disabled={scheduling}
              className="font-medium text-ink underline decoration-ink-faint/60 hover:decoration-ink"
              onClick={() => void recoverSchedule(true)}
            >
              Keep the draft and stop checking
            </button>
          </details>
        </div>
      )}
      {scheduling && (
        <p role="status" className="mb-2 text-sm text-ink-faint">
          Scheduling your message…
        </p>
      )}
      {scheduleNote && (
        <p role="status" className="mb-2 text-sm text-ink-dim">
          {scheduleNote}
        </p>
      )}
      <fieldset
        disabled={archived || scheduling || recoveryBlocksSend}
        className={`composer-box min-w-0 rounded-xl border bg-lifted transition-[border-color,box-shadow] duration-150 ${
          dragging ? "border-copper bg-copper/5" : "border-[var(--card-edge)]"
        }`}
      >
        {replyTarget && (
          <div className="flex items-center gap-2 border-b border-edge py-1 pl-4 pr-1.5 text-[13px] text-ink-dim">
            <Icon name="reply" size={14} className="shrink-0 text-ink-faint" />
            <span className="min-w-0 flex-1 truncate">
              Replying to <span className="font-semibold text-ink">{replyName}</span>
            </span>
            {replyTarget.message.userId !== selfId && (
              <Tooltip
                label={
                  replyTarget.ping
                    ? `${replyName} is notified. Click to reply without notifying them.`
                    : `${replyName} is not notified. Click to notify them.`
                }
              >
                <button
                  type="button"
                  aria-pressed={replyTarget.ping}
                  aria-label={`Notify ${replyName}`}
                  onClick={() => setReplyPing(client, draftKey, !replyTarget.ping)}
                  className={`flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] font-medium transition-colors hover:bg-ink/[0.07] ${
                    replyTarget.ping ? "text-copper" : "text-ink-faint"
                  }`}
                >
                  <Icon name="at" size={13} />
                  {replyTarget.ping ? "On" : "Off"}
                </button>
              </Tooltip>
            )}
            <Tooltip label="Cancel reply" keys="Esc">
              <button
                type="button"
                aria-label="Cancel reply"
                onClick={() => {
                  cancelReply(client, draftKey);
                  box.current?.focus();
                }}
                className="flex size-6 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.07] hover:text-ink"
              >
                <Icon name="close" size={14} />
              </button>
            </Tooltip>
          </div>
        )}
        {preview && (
          <div
            aria-label="Message preview"
            className="bidi-text max-h-36 overflow-y-auto border-b border-edge px-4 py-3 text-sm"
          >
            {text.trim() ? (
              <Mrkdwn text={text} users={users} channels={channels} selfId={selfId} />
            ) : (
              <span className="text-ink-faint">Your formatted message will appear here.</span>
            )}
          </div>
        )}
        {attached.length > 0 && (
          <ul className="flex flex-wrap gap-2 border-b border-edge p-2.5">
            {attached.map((f, i) => (
              <StagedFile
                key={`${f.name}-${i}`}
                file={f}
                onRemove={() => setAttached((prev) => prev.filter((_, j) => j !== i))}
              />
            ))}
          </ul>
        )}
        <div className="relative">
          <MentionTags doc={field.doc} box={box} />
          <textarea
            dir="auto"
            ref={box}
            value={field.doc.shown}
            aria-readonly={held}
            aria-busy={held}
            rows={1}
            placeholder={dragging ? "Drop files to attach" : placeholder}
            aria-label={placeholder}
            {...(suggestions.open ? suggestions.list : commandList).ownerProps}
            onPaste={(e) => {
              const data = e.clipboardData;
              // Some browsers offer a pasted image only as an item, not among the files.
              const files =
                data.files.length > 0
                  ? [...data.files]
                  : [...data.items]
                      .filter((item) => item.kind === "file")
                      .map((item) => item.getAsFile())
                      .filter((file): file is File => file !== null);
              if (files.length === 0) {
                const { start, end } = field.selection();
                const linked =
                  linkOverSelection(text, start, end, data.getData("text/plain")) ??
                  pasteRich(text, start, end, data.getData("text/html"));
                if (linked) {
                  e.preventDefault();
                  rewrite(linked.text, linked.caret);
                }
                return;
              }
              // A clipboard holding a file is pasted as the file, even when it
              // holds text as well, as a copy from an office app does (a
              // picture of the selection beside its text). Saying so keeps the
              // text from going missing unremarked.
              e.preventDefault();
              addFiles(
                files,
                data.getData("text/plain").trim()
                  ? "The file from the clipboard is attached. The text copied with it was not pasted."
                  : undefined,
              );
            }}
            onChange={(e) => {
              // Left unstored, the change is undone: the box shows what it holds.
              if (held) return;
              const next = field.fromInput(e);
              edited.current = true;
              // What was scheduled has been said; the next message starts afresh.
              setScheduleNote(null);
              setText(next.stored);
              if (!scheduleLock.current && !recoveryBlocksSend)
                suggestions.update(e.target.value, e.target.selectionStart, next);
              if (e.target.value.trim()) client.sendTyping(channelId);
            }}
            onKeyDown={onKeyDown}
            onBlur={suggestions.close}
            className="relative block max-h-[220px] w-full resize-none bg-transparent px-4 pb-1 pt-3 text-[15px] leading-normal outline-none placeholder:text-ink-faint"
          />
        </div>
        {attachmentNote && (
          <p role="alert" className="px-4 pb-2 text-xs text-ink-dim">
            {attachmentNote}
          </p>
        )}
        {text.length > MESSAGE_TEXT_MAX - 1000 && (
          <p
            aria-live="polite"
            className={`px-4 pb-2 text-right text-xs ${text.length > MESSAGE_TEXT_MAX ? "text-alert" : "text-ink-faint"}`}
          >
            {text.length.toLocaleString()} / {MESSAGE_TEXT_MAX.toLocaleString()} characters
            {text.length > MESSAGE_TEXT_MAX ? " · Shorten your message to send it." : ""}
          </p>
        )}
        {threadRootId && (
          // On a line of its own, as in Slack: in a thread panel the toolbar
          // row has no width to spare, and the checkbox wrapped beside it.
          <label className="mx-4 mb-1 flex w-fit cursor-pointer items-center gap-2 text-[13px] text-ink-dim">
            <input
              type="checkbox"
              checked={alsoToChannel}
              onChange={(e) => setAlsoToChannel(e.target.checked)}
              className="accent-[var(--color-copper)]"
            />
            Also send to channel
          </label>
        )}
        <div className="relative flex flex-wrap items-center gap-0.5 px-2 pb-2">
          {!guest && (
            // Discord's round plus, opening what can be added: a file, or a poll.
            <Menu
              label="Add to message"
              triggerLabel="Add to message"
              tooltip="Add to message"
              align="start"
              triggerClassName="group/attach flex size-8 items-center justify-center rounded-md"
              triggerContent={plus}
              items={[
                {
                  id: "upload",
                  label: "Upload a file",
                  icon: "attach",
                  onSelect: () => filePicker.current?.click(),
                },
                {
                  id: "poll",
                  label: "Create a poll",
                  icon: "poll",
                  onSelect: () => setPollQuestion(""),
                },
              ]}
            />
          )}
          <FormattingToolbar
            key={draftKey}
            placement="inline"
            onFormat={format}
            onList={list}
            onInsert={insertEmoji}
            preview={preview}
            onTogglePreview={() => setPreview((v) => !v)}
          />
          <span className="ml-auto flex min-w-0 items-center gap-0.5">
            {/* Only where it fits whole: a narrow composer, such as a thread's, cut it off mid-word. */}
            <span className="composer-hint mr-2 hidden min-w-0 truncate text-[12px] text-ink-faint @lg:inline">
              {scheduleNote ??
                (text.trim() || attached.length > 0
                  ? enterSends
                    ? `${shortcutLabel("Enter")} to send · ${shortcutLabel("Shift+Enter")} for a new line`
                    : `${shortcutLabel("Mod+Enter")} to send · ${shortcutLabel("Enter")} for a new line`
                  : "")}
            </span>
            {/* A scheduled send cannot answer in place, so it is not offered while replying. */}
            {!guest && !replyTarget && (text.trim() || attached.length > 0) && (
              <Tooltip label="Send later">
                <button
                  ref={scheduleButton}
                  onClick={() => setScheduleOpen((v) => !v)}
                  aria-label="Send later"
                  aria-haspopup="dialog"
                  aria-expanded={scheduleOpen}
                  className={`flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-ink/[0.07] hover:text-ink ${
                    scheduleOpen ? "bg-ink/[0.08] text-ink" : "text-ink-faint"
                  }`}
                >
                  <Icon name="clock" size={17} />
                </button>
              </Tooltip>
            )}
            <Tooltip label="Send message" keys={shortcutLabel(enterSends ? "Enter" : "Mod+Enter")}>
              <button
                // Focus stays in the box, so a phone's keyboard stays up for the next message.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  send();
                  box.current?.focus();
                }}
                disabled={(!text.trim() && attached.length === 0) || text.length > MESSAGE_TEXT_MAX}
                aria-label="Send message"
                className="btn-shape flex size-8 items-center justify-center bg-copper text-ground hover:bg-copper-deep disabled:bg-transparent disabled:text-ink-faint/60"
              >
                <Icon name="send" size={16} />
              </button>
            </Tooltip>
          </span>
          {scheduleOpen && !replyTarget && (
            <ErrorBoundary
              fallback={
                <p role="alert" className="px-2 pt-1 text-xs text-ink-dim">
                  Send later could not load. Reload the app to try again.
                </p>
              }
            >
              <Suspense fallback={null}>
                <TimePopover
                  label="Send later"
                  presets={schedulePresets()}
                  submitLabel={(at) =>
                    at ? `Schedule for ${formatScheduleShort(at.getTime())}` : "Schedule message"
                  }
                  anchor={scheduleButton}
                  onClose={() => setScheduleOpen(false)}
                  onPick={(at) => void schedule(at)}
                />
              </Suspense>
            </ErrorBoundary>
          )}
        </div>
        <input
          ref={filePicker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </fieldset>
      {pollQuestion !== null && (
        <ErrorBoundary
          fallback={
            <p role="alert" className="px-2 pt-1 text-xs text-ink-dim">
              The poll window could not load. Reload the app to try again.
            </p>
          }
        >
          <Suspense fallback={null}>
            <PollDialog
              channelId={channelId}
              threadRootId={threadRootId}
              question={pollQuestion}
              onClose={() => setPollQuestion(null)}
              onSent={() => {
                // The /poll that opened it is done with.
                if (parseCommand(text)?.name === "poll") clearSent(draftKey);
              }}
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </div>
  );
}

/** How long the connection may be down before the message box says so: a blip says nothing. */
export const CONNECTION_NOTICE_MS = 3000;

/**
 * Says above the message box that the workspace cannot be reached, where
 * someone writing looks, rather than only in the sidebar, which a phone keeps
 * in its drawer. What is sent meanwhile waits and goes once it is back.
 */
function ConnectionNotice() {
  const down = useConnectionDown();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!down) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), CONNECTION_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [down]);
  if (!down || !shown) return null;
  return (
    <p
      role="status"
      className="mb-2 flex items-center gap-2 rounded-lg bg-copper/10 px-3 py-2 text-[13px] text-ink-dim"
    >
      <span
        aria-hidden="true"
        className="fc-fill size-1.5 shrink-0 animate-pulse rounded-full bg-copper"
      />
      <span>
        <span className="font-medium text-ink">
          {down === "offline" ? "You're offline." : "Reconnecting to the workspace…"}
        </span>{" "}
        Anything you send now goes out once you're connected again.
      </span>
    </p>
  );
}

/**
 * A file waiting to be sent: a picture shows itself, so the right one is
 * attached before it goes, and anything else shows its kind.
 */
function StagedFile({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith("image/") || typeof URL.createObjectURL !== "function") return;
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => {
      setUrl(null);
      URL.revokeObjectURL(next);
    };
  }, [file]);
  return (
    <li className="flex items-center gap-2 rounded-lg border border-edge bg-ground p-1 pr-1 text-sm">
      {url ? (
        <img
          src={url}
          alt=""
          // A picture that will not decode shows its kind instead.
          onError={() => setUrl(null)}
          className="size-9 shrink-0 rounded-md object-cover"
        />
      ) : (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-ink/[0.06] text-ink-faint">
          <Icon name={iconFor(file.type, file.name)} size={16} />
        </span>
      )}
      <span className="min-w-0 leading-tight">
        <span className="block max-w-[160px] truncate">{file.name}</span>
        <span className="block font-mono text-[11px] text-ink-faint">{formatBytes(file.size)}</span>
      </span>
      <button
        onClick={onRemove}
        aria-label={`Remove ${file.name}`}
        className="self-start rounded p-0.5 text-ink-faint transition-colors hover:text-alert"
      >
        <Icon name="close" size={14} />
      </button>
    </li>
  );
}
