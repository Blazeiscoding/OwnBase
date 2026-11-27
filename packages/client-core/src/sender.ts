import {
  SEND_RETRY_WINDOW_MS,
  isInAppCommand,
  parseCommand,
  type ForwardReference,
  type ID,
  type InAppCommandName,
  type Message,
  type ParsedCommand,
  type ReplyReference,
  type SendMessageBody,
} from "@ownbase/protocol";
import type { StoreApi } from "zustand/vanilla";
import { fileRefusal } from "./answers.js";
import { ApiError, type Api } from "./api.js";
import type { Commands } from "./commands.js";
import type { LocalLedger, LocalOutcome } from "./localWork.js";
import { newNonce, storedPending, type OutgoingSend, type StoredPending } from "./outbox.js";
import type { PollDraft } from "./polls.js";
import type { LocalAttachment, PendingMessage, WorkspaceState } from "./workspaceState.js";

/**
 * How many unsent messages one account can have waiting at once. A send past
 * this is refused before the composer lets go of it, rather than being kept
 * only in memory where a restart would lose it.
 */
export const OUTBOX_LIMIT = 50;

/** What `send` did with what it was given. */
export type SendAnswer =
  /** Waiting in the outbox; `kept` settles once this device holds its words, null when nothing keeps them. */
  | { kind: "queued"; nonce: string; kept: Promise<LocalOutcome> | null }
  /** A command the server runs: anything it says comes back as a private answer. */
  | { kind: "command" }
  /** A command the app runs itself, which `send` does not: nothing was sent. */
  | ({ kind: "in_app"; name: InAppCommandName } & Omit<ParsedCommand, "name">)
  /** Nothing was taken. */
  | { kind: "refused"; reason: "empty" | "outbox_full" | "not_connected" };

/** The wait after "too much at once" from a server that did not say how long. */
const RATE_LIMIT_WAIT_MS = 2000;
/** However long a server asks for, a send is tried again within this. */
const RATE_LIMIT_WAIT_MAX_MS = 60_000;

const MISSING_ATTACHMENTS =
  "The attached files were not kept when the app closed. Attach them again to send this.";

const STALE_SEND =
  `Not sent. You wrote this more than ${SEND_RETRY_WINDOW_MS / 86_400_000} days ago, ` +
  "so it may already be posted. Press Retry to send it anyway.";

/**
 * Whether a failed send was answered and refused by the server, as opposed to
 * lost on the way or refused for reasons that pass (signing in, rate limits,
 * a server fault), after which sending the same request again is safe.
 */
function isRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![401, 408, 429].includes(error.status)
  );
}

function sendFailureReason(error: unknown): string {
  // Status 0: an upload that never had an answer (no connection, timed out).
  // The workspace was reached, so waiting to be back online would wait forever.
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "The workspace did not answer in time. Press Retry to send it again.";
  }
  if (error instanceof SyntaxError) {
    return "The workspace's answer could not be read. Press Retry to send it again.";
  }
  if (!(error instanceof ApiError) || error.status === 0) {
    return "Could not reach the workspace. It is sent again once you're back online.";
  }
  if (error.status === 429) return "Too much sent at once. It is sent again in a moment.";
  switch (error.code) {
    case "channel_archived":
      return "This conversation is archived.";
    case "channel_not_found":
      return "You no longer have access to this conversation.";
    case "bad_thread_root":
      return "The message this replies to is gone.";
    case "bad_reply_target":
      return "The message this answers is not in this conversation.";
    case "invalid_attachments":
      return "The attached files are no longer available.";
    case "attachments_scheduled":
      return "One of the attached files is part of a scheduled message.";
    case "message_not_found":
      return "The message this forwards is no longer there.";
    case "forward_unavailable":
      return "What this forwards is private or deleted, so it cannot be passed on.";
    case "file_too_large":
      return `${fileRefusal(error)} Discard this and attach a smaller one.`;
    case "storage_quota_exceeded":
      return `${fileRefusal(error)} Ask whoever hosts it to free space or raise the limit, then press Retry.`;
    case "nonce_conflict":
    case "message_deleted":
      return "This was already sent once. Discard it to clear it.";
    case "account_deactivated":
      return "This account is deactivated.";
    default:
      return error.status >= 500
        ? "The workspace could not save this. Press Retry to try again."
        : "This message was refused.";
  }
}

/**
 * Gets what this account writes to the server: the outbox shown at once,
 * uploads, retries, waits after "too much at once", and refusals, which wait
 * for their author.
 */
export class Sender {
  constructor(
    private readonly api: Api,
    private readonly store: StoreApi<WorkspaceState>,
    private readonly kept: LocalLedger,
    private readonly commands: Commands,
    private readonly settleSent: (message: Message) => void,
    private readonly isStopped: () => boolean,
  ) {}

  private get state(): WorkspaceState {
    return this.store.getState();
  }

  private get stopped(): boolean {
    return this.isStopped();
  }

  /** Files held for a retry, keyed by nonce — never exposed to the store. */
  private retryFiles = new Map<string, File[]>();
  private uploadedFiles = new Map<string, ID[]>();

  send(
    channelId: ID,
    text: string,
    opts: {
      threadRootId?: ID;
      files?: File[];
      alsoSendToChannel?: boolean;
      /** The message this one answers in place; see `quoteOf`. */
      replyTo?: ReplyReference;
      /** The message this one passes on, words of its own or none; see `forwardOf`. */
      forward?: ForwardReference;
      /** Makes it a poll, `text` its question (E6); alone, without files or a forward. */
      poll?: PollDraft;
    } = {},
  ): SendAnswer {
    const self = this.state.self;
    if (!self) return { kind: "refused", reason: "not_connected" };
    const files = opts.files ?? [];
    const forward = opts.forward;
    if (!text.trim() && files.length === 0 && !forward) return { kind: "refused", reason: "empty" };
    // A poll carries nothing else.
    const poll = opts.poll;
    if (poll && (files.length > 0 || forward)) return { kind: "refused", reason: "empty" };

    const command = !poll && !forward && files.length === 0 ? parseCommand(text) : null;
    if (command) {
      // Unless an app had the name first: the server lists it as the app's then.
      if (
        isInAppCommand(command.name) &&
        !this.state.commands.some((c) => c.command === command.name && !c.builtin)
      )
        return { kind: "in_app", name: command.name, args: command.args };
      void this.commands.runCommand(channelId, text.trim(), command.name, opts.threadRootId);
      return { kind: "command" };
    }
    if (this.ownPending() >= OUTBOX_LIMIT) return { kind: "refused", reason: "outbox_full" };

    const nonce = newNonce();
    const attachments: LocalAttachment[] = files.map((f) => ({
      name: f.name,
      size: f.size,
      mime: f.type,
      previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : null,
    }));
    const pendingMsg: PendingMessage = {
      nonce,
      channelId,
      threadRootId: opts.threadRootId ?? null,
      broadcast: !!opts.threadRootId && !!opts.alsoSendToChannel,
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      ...(forward ? { forward } : {}),
      ...(poll ? { poll } : {}),
      text,
      userId: self.id,
      createdAt: Date.now(),
      failed: false,
      failureReason: null,
      attachments,
      uploadProgress: files.length > 0 ? 0 : null,
    };
    this.store.setState((s) => ({ pending: [...s.pending, pendingMsg] }));
    if (files.length > 0) this.retryFiles.set(nonce, files);
    const kept = text.trim() ? this.kept.whenKept(nonce) : null;

    void this.deliver(pendingMsg, files);
    return { kind: "queued", nonce, kept };
  }

  private ownPending(): number {
    const self = this.state.self?.id;
    return this.state.pending.filter((p) => p.userId === self).length;
  }

  private async deliver(send: OutgoingSend, files: File[]): Promise<void> {
    const { nonce, channelId, text, threadRootId, replyTo, forward, poll } = send;
    const setProgress = (fraction: number) =>
      this.store.setState((s) => ({
        pending: s.pending.map((p) => (p.nonce === nonce ? { ...p, uploadProgress: fraction } : p)),
      }));

    try {
      const fileIds = this.uploadedFiles.get(nonce) ?? [];
      this.uploadedFiles.set(nonce, fileIds);
      for (const [i, file] of files.entries()) {
        if (i < fileIds.length) continue;
        if (!this.stillSending(nonce)) return;
        const { file: uploaded } = await this.api.uploadFile(channelId, file, file.name, {
          onProgress: (fraction) => setProgress((i + fraction) / files.length),
        });
        fileIds.push(uploaded.id);
      }
      if (!this.stillSending(nonce)) return;
      if (files.length > 0) setProgress(1);

      const body: SendMessageBody = {
        text,
        nonce,
        ...(threadRootId ? { threadRootId } : {}),
        ...(threadRootId && send.broadcast ? { alsoSendToChannel: true } : {}),
        ...(fileIds.length > 0 ? { fileIds } : {}),
        ...(replyTo ? { replyToId: replyTo.id, replyPing: replyTo.ping } : {}),
        ...(forward ? { forwardFrom: forward.id } : {}),
        ...(poll ? { poll } : {}),
      };
      const { message } = await this.api.sendMessage(channelId, body);
      if (!this.stopped && this.state.status !== "auth_failed") {
        this.settleSent(message);
      }
    } catch (error) {
      const refused = isRefusal(error);
      // A refusal taken on from another window stays until its author's Retry;
      // not reaching the server from here says nothing new about it.
      if (!refused && this.state.pending.some((p) => p.nonce === nonce && p.refused)) return;
      this.failPending(nonce, sendFailureReason(error), refused);
      if (error instanceof ApiError && error.status === 429)
        this.waitOutRateLimit(nonce, error.retryAfterMs);
    }
  }

  /** Sends turned away for coming too fast, sent again once the wait is over. */
  private rateLimited = new Set<string>();
  private rateLimitTimer: ReturnType<typeof setTimeout> | null = null;
  private rateLimitUntil = 0;

  /**
   * Holds a send the workspace turned away for coming too fast until it said
   * to try again.
   */
  private waitOutRateLimit(nonce: string, waitMs = RATE_LIMIT_WAIT_MS): void {
    if (this.stopped) return;
    this.rateLimited.add(nonce);
    const wait = Math.min(Math.max(waitMs, 250), RATE_LIMIT_WAIT_MAX_MS);
    const until = Date.now() + wait;
    if (this.rateLimitTimer && until <= this.rateLimitUntil) return;
    if (this.rateLimitTimer) clearTimeout(this.rateLimitTimer);
    this.rateLimitUntil = until;
    this.rateLimitTimer = setTimeout(() => {
      this.rateLimitTimer = null;
      void this.resendRateLimited();
    }, wait);
  }

  /**
   * One at a time and in the order they were written, so they neither run
   * into the limit again all together nor arrive out of order. One turned
   * away again starts a new wait, and those after it wait with it.
   */
  private async resendRateLimited(): Promise<void> {
    const waiting = this.state.pending.filter((p) => this.rateLimited.has(p.nonce));
    this.rateLimited.clear();
    for (const p of waiting) {
      if (this.stopped) return;
      if (this.rateLimitTimer) {
        this.rateLimited.add(p.nonce);
        continue;
      }
      await this.resend(p.nonce);
    }
  }

  /** Whether a send is still wanted: not discarded, delivered or refused meanwhile. */
  private stillSending(nonce: string): boolean {
    return !this.stopped && this.state.pending.some((p) => p.nonce === nonce && !p.refused);
  }

  private failPending(nonce: string, failureReason: string, refused = false): void {
    this.store.setState((s) => ({
      pending: s.pending.map((p) =>
        p.nonce === nonce
          ? { ...p, failed: true, failureReason, refused, uploadProgress: null }
          : p,
      ),
    }));
  }

  /**
   * Sends that were lost on the way go again once the workspace answers, as
   * their notice promised. One the server refused waits for its author, and
   * one whose files this window no longer holds would go without them.
   */
  retryLostSends(): void {
    for (const p of this.state.pending) {
      if (!p.failed || p.refused) continue;
      const files = this.retryFiles.get(p.nonce) ?? [];
      if (p.attachments.length > 0 && files.length !== p.attachments.length) continue;
      this.retrySend(p.nonce);
    }
  }

  retrySend(nonce: string): void {
    void this.resend(nonce);
  }

  /** Sends a failed message again; settles once this try has its answer. */
  private async resend(nonce: string): Promise<void> {
    const p = this.state.pending.find((p) => p.nonce === nonce);
    if (!p?.failed) return;
    const files = this.retryFiles.get(nonce) ?? [];
    // Sending now would post the words without the files the author chose.
    if (p.attachments.length > 0 && files.length !== p.attachments.length) {
      this.failPending(nonce, MISSING_ATTACHMENTS);
      return;
    }
    this.store.setState((s) => ({
      pending: s.pending.map((item) =>
        item.nonce === nonce
          ? { ...item, failed: false, failureReason: null, refused: false }
          : item,
      ),
    }));
    await this.deliver(p, files);
  }

  /**
   * The whole outbox in a form that survives a restart: every send accepted
   * stays, and a known refusal keeps its reason. Preview URLs are not kept.
   */
  outboxSnapshot(): StoredPending[] {
    return this.state.pending.map((p) =>
      storedPending({
        ...p,
        ...(p.failed && p.refused
          ? { refusal: p.failureReason ?? "This message was refused." }
          : {}),
      }),
    );
  }

  /**
   * Puts back work the author had already committed to sending. Re-delivery is
   * safe because the server settles a repeated request key onto the same
   * message, so a send that did reach the server before the restart cannot
   * become a second one. Once retention has removed that message, the server
   * remembers its key only for a while, so a send older than
   * `SEND_RETRY_WINDOW_MS` is not sent again on its own: it waits, saying so,
   * for its author's Retry.
   * Attachments do not survive a restart, so those entries stop and say so
   * instead of posting the words without the files. A send the server refused
   * stays refused until the author chooses Retry: whatever made it refuse may
   * have changed since, and that is theirs to decide. Nothing is dropped for
   * being one too many; every entry here was accepted once.
   */
  restoreOutbox(entries: StoredPending[]): void {
    const self = this.state.self;
    if (!self) return;
    const now = Date.now();
    const restored = entries
      .filter((e) => e.userId === self.id && !this.state.pending.some((p) => p.nonce === e.nonce))
      .map(({ refusal, ...e }): PendingMessage => {
        const reason =
          refusal ??
          (e.attachments.length > 0
            ? MISSING_ATTACHMENTS
            : now - e.createdAt > SEND_RETRY_WINDOW_MS
              ? STALE_SEND
              : null);
        return {
          ...e,
          failed: reason !== null,
          failureReason: reason,
          refused: refusal !== undefined,
          attachments: e.attachments.map((a) => ({ ...a, previewUrl: null })),
          uploadProgress: null,
        };
      });
    if (restored.length === 0) return;
    this.store.setState((s) => ({ pending: [...s.pending, ...restored] }));
    for (const entry of restored) {
      if (entry.failed) continue;
      void this.deliver(entry, []);
    }
  }

  discardSend(nonce: string): void {
    this.dropPending(nonce);
  }

  /**
   * Takes on the refusal another window on this account was given for the
   * same send, so this one stops sending it too and waits for its author's
   * Retry instead of trying again on its own.
   */
  adoptRefusal(nonce: string, reason: string): void {
    const p = this.state.pending.find((x) => x.nonce === nonce);
    if (!p || p.refused) return;
    this.failPending(nonce, reason, true);
  }

  private dropPending(nonce: string): void {
    const p = this.state.pending.find((x) => x.nonce === nonce);
    if (p) {
      for (const a of p.attachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    this.retryFiles.delete(nonce);
    this.uploadedFiles.delete(nonce);
    this.store.setState((s) => ({ pending: s.pending.filter((x) => x.nonce !== nonce) }));
  }

  /** Sends waiting out a rate limit wait for nothing now. */
  stopWaiting(): void {
    if (this.rateLimitTimer) clearTimeout(this.rateLimitTimer);
    this.rateLimitTimer = null;
    this.rateLimited.clear();
  }

  dropFiles(): void {
    this.retryFiles.clear();
    this.uploadedFiles.clear();
  }

  /** A send the server has: its files are not needed for a retry. */
  forgetFiles(settled: PendingMessage): void {
    this.retryFiles.delete(settled.nonce);
    this.uploadedFiles.delete(settled.nonce);
  }
}
