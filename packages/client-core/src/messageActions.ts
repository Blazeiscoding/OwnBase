import type { ID, Message } from "@ownbase/protocol";
import type { StoreApi } from "zustand/vanilla";
import { doneOf, failureOf, notConnected } from "./answers.js";
import { ApiError, type Api } from "./api.js";
import { patchMessage, withReaction } from "./messageCache.js";
import type { OptimisticWrites } from "./optimisticWrites.js";
import { pollChoicesKey, pollChoicesOfKey, serverPollChoices } from "./polls.js";
import type { WorkspaceState } from "./workspaceState.js";

/**
 * What this account does to messages it sees: reactions, votes, pins, saves,
 * reminders and taking a link preview off, each shown at once where it can be.
 */
export class MessageActions {
  constructor(
    private readonly api: Api,
    private readonly store: StoreApi<WorkspaceState>,
    private readonly writes: OptimisticWrites,
  ) {}

  private get state(): WorkspaceState {
    return this.store.getState();
  }

  /** Shows a change to one held message at once, before the server has it. */
  private showOnMessage(messageId: ID, change: (message: Message) => Message): void {
    this.store.setState((s) => {
      const messages = patchMessage(s, messageId, change).messages;
      return messages === s.messages ? {} : { messages };
    });
  }

  private heldOr(message: Message): Message {
    return this.state.messages[message.id] ?? message;
  }

  toggleReaction(message: Message, emoji: string): Promise<ApiError | null> {
    const selfId = this.state.self?.id;
    if (!selfId) return Promise.resolve(notConnected());
    const mine = (m: Message) =>
      m.reactions.some((g) => g.emoji === emoji && g.userIds.includes(selfId));
    return this.writes.write(
      { kind: "reaction", messageId: message.id, emoji },
      !mine(this.heldOr(message)),
      {
        read: () => mine(this.heldOr(message)),
        show: (on) => this.showOnMessage(message.id, (m) => withReaction(m, emoji, selfId, on)),
        send: async (on) => {
          await (on
            ? this.api.addReaction(message.id, emoji)
            : this.api.removeReaction(message.id, emoji));
        },
      },
    );
  }

  vote(message: Message, choices: number[]): Promise<ApiError | null> {
    const messageId = message.id;
    const key = { kind: "poll", messageId } as const;
    const anonymous = message.poll?.anonymous ?? false;
    const shown = (s: WorkspaceState) =>
      pollChoicesKey(s.pollPicks[messageId] ?? this.serverChoicesIn(messageId, anonymous, s));
    return this.writes.write(key, pollChoicesKey(choices), {
      read: () => shown(this.state),
      show: (chosen) =>
        this.store.setState((s) => {
          const server = this.serverChoicesIn(messageId, anonymous, s);
          // Settled, and what the server is known to have: nothing to hold.
          if (!this.writes.isPending(key) && pollChoicesKey(server) === chosen) {
            if (!s.pollPicks[messageId]) return {};
            const { [messageId]: _settled, ...pollPicks } = s.pollPicks;
            return { pollPicks };
          }
          return { pollPicks: { ...s.pollPicks, [messageId]: pollChoicesOfKey(chosen) } };
        }),
      send: async (chosen) => {
        const answer = await this.api.votePoll(messageId, pollChoicesOfKey(chosen));
        if (anonymous)
          this.store.setState((s) => {
            const pollChoices = { ...s.pollChoices };
            if (answer.choices.length > 0) pollChoices[messageId] = answer.choices;
            else delete pollChoices[messageId];
            return { pollChoices };
          });
        return pollChoicesKey(answer.choices);
      },
    });
  }

  closePoll(message: Message): Promise<ApiError | null> {
    return doneOf(async () => {
      const { message: closed } = await this.api.closePoll(message.id);
      const closedAt = closed.poll?.closedAt ?? null;
      // Only that it closed: the counts are whatever was last heard.
      this.showOnMessage(message.id, (m) =>
        m.poll && m.poll.closedAt === null ? { ...m, poll: { ...m.poll, closedAt } } : m,
      );
    });
  }

  /** What the server has as this account's choices in a poll, from what is held of it. */
  private serverChoicesIn(messageId: ID, anonymous: boolean, s = this.state): number[] {
    if (anonymous) return s.pollChoices[messageId] ?? [];
    const message = s.messages[messageId];
    return message ? serverPollChoices(message, s.self?.id, null) : [];
  }

  /**
   * The server is heard to have `server` as this account's choices in a poll.
   * A pick made here and settled is dropped once it matches; one still being
   * sent stays shown until its answer.
   */
  settlePollPick(
    s: WorkspaceState,
    patch: Partial<WorkspaceState>,
    messageId: ID,
    server: number[],
  ): void {
    const picks = patch.pollPicks ?? s.pollPicks;
    const picked = picks[messageId];
    if (!picked || this.writes.isPending({ kind: "poll", messageId })) return;
    if (pollChoicesKey(picked) !== pollChoicesKey(server)) return;
    const { [messageId]: _settled, ...rest } = picks;
    patch.pollPicks = rest;
  }

  togglePin(message: Message): Promise<ApiError | null> {
    return this.writes.write({ kind: "pin", messageId: message.id }, !message.pinned, {
      read: () => this.heldOr(message).pinned,
      show: (pinned) =>
        this.showOnMessage(message.id, (m) => (m.pinned === pinned ? m : { ...m, pinned })),
      send: async (pinned) => {
        await (pinned ? this.api.pinMessage(message.id) : this.api.unpinMessage(message.id));
      },
    });
  }

  toggleSaved(messageId: ID, save = !this.state.saved[messageId]): Promise<ApiError | null> {
    return this.writes.write({ kind: "save", messageId }, save, {
      read: () => !!this.state.saved[messageId],
      show: (on) =>
        this.store.setState((s) =>
          !!s.saved[messageId] === on ? {} : { saved: withSaved(s.saved, messageId, on) },
        ),
      send: async (on) => {
        await (on ? this.api.saveMessage(messageId) : this.api.unsaveMessage(messageId));
      },
    });
  }

  setReminder(messageId: ID, at: number): Promise<ApiError | null> {
    return doneOf(async () => {
      const { reminder } = await this.api.setReminder(messageId, at);
      this.store.setState((s) => ({ reminders: { ...s.reminders, [messageId]: reminder } }));
    });
  }

  async cancelReminder(messageId: ID): Promise<ApiError | null> {
    try {
      await this.api.cancelReminder(messageId);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) return failureOf(error);
    }
    this.store.setState((s) => {
      if (!s.reminders[messageId]) return {};
      const { [messageId]: _gone, ...reminders } = s.reminders;
      return { reminders };
    });
    return null;
  }

  removeLinkPreview(message: Message, previewId: ID): Promise<ApiError | null> {
    const has = (m: Message) => m.previews.some((p) => p.id === previewId);
    return this.writes.write({ kind: "linkPreview", previewId }, false, {
      read: () => has(this.heldOr(message)),
      show: (shown) =>
        this.showOnMessage(message.id, (m) => {
          if (has(m) === shown) return m;
          return shown
            ? { ...m, previews: message.previews }
            : { ...m, previews: m.previews.filter((p) => p.id !== previewId) };
        }),
      send: async () => {
        await this.api.removeLinkPreview(previewId);
      },
    });
  }
}

export function withSaved(saved: Record<ID, true>, messageId: ID, on: boolean): Record<ID, true> {
  const next = { ...saved };
  if (on) next[messageId] = true;
  else delete next[messageId];
  return next;
}
