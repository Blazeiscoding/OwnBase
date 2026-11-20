import type { ID } from "@ownbase/protocol";
import type { StoreApi } from "zustand/vanilla";
import { answerOf, failureOf, refusalReason } from "./answers.js";
import { ApiError, type Api } from "./api.js";
import type { WorkspaceState } from "./workspaceState.js";

/**
 * A reply only this client can see — a slash command's private answer, or a
 * local note about one that failed. Never persisted; a reload clears them.
 */
export interface EphemeralMessage {
  id: ID;
  channelId: ID;
  /** The bot it is shown as coming from, or "" for a note from the app itself. */
  userId: ID;
  text: string;
  createdAt: number;
}

/**
 * How many private answers are kept (REV-04). They are never stored, but a
 * long session of commands would otherwise keep every one, in memory and on
 * screen. The newest are kept, per conversation and across the workspace;
 * what is let go is counted, so the conversation can say so, and none of its
 * text is kept. No answer expires by age: one stays until it is dismissed,
 * newer ones push it out, its conversation is left, or the app reloads.
 */
export const EPHEMERAL_LIMITS = {
  /** Answers kept in one conversation, which is also how many it shows. */
  perConversation: 20,
  /** Answers kept across the workspace. */
  total: 100,
  /** Characters of answer text kept across the workspace, about 0.8 MB. */
  totalChars: 400_000,
  /** Characters kept of one answer; a longer one is cut, and says so. */
  answerChars: 40_000,
} as const;

/** What replaces the end of an answer too long to keep whole. */
export const EPHEMERAL_CUT_NOTE = "\n\n_(The rest of this answer was too long to keep.)_";

/**
 * Adds a private answer within EPHEMERAL_LIMITS. An answer with an id already
 * shown replaces that one, in place in the same conversation, rather than
 * adding a second row.
 * Returns the answers kept and, per conversation, how many were let go.
 */
export function keepEphemeral(
  ephemerals: Record<ID, EphemeralMessage[]>,
  dropped: Record<ID, number>,
  incoming: EphemeralMessage,
): { ephemerals: Record<ID, EphemeralMessage[]>; ephemeralsDropped: Record<ID, number> } {
  const { perConversation, total, totalChars, answerChars } = EPHEMERAL_LIMITS;
  const message =
    incoming.text.length > answerChars
      ? { ...incoming, text: incoming.text.slice(0, answerChars) + EPHEMERAL_CUT_NOTE }
      : incoming;
  const next = { ...ephemerals };
  const counts = { ...dropped };
  // Ids are the server's and unique: one arriving again elsewhere moves here.
  for (const [channelId, list] of Object.entries(next)) {
    if (channelId === message.channelId || !list.some((e) => e.id === message.id)) continue;
    const kept = list.filter((e) => e.id !== message.id);
    if (kept.length > 0) next[channelId] = kept;
    else delete next[channelId];
  }
  const letGo = (channelId: ID, n: number) => {
    if (n > 0) counts[channelId] = (counts[channelId] ?? 0) + n;
  };
  const here = next[message.channelId] ?? [];
  const at = here.findIndex((e) => e.id === message.id);
  if (at >= 0) next[message.channelId] = here.map((e, i) => (i === at ? message : e));
  else {
    const added = [...here, message];
    letGo(message.channelId, added.length - perConversation);
    next[message.channelId] = added.slice(-perConversation);
  }
  // Across the workspace, the oldest go first; never the one just added.
  const all = Object.values(next)
    .flat()
    .sort((a, b) => a.createdAt - b.createdAt);
  let count = all.length;
  let chars = all.reduce((sum, e) => sum + e.text.length, 0);
  const gone = new Set<EphemeralMessage>();
  for (const e of all) {
    if (count <= total && chars <= totalChars) break;
    if (e === message) continue;
    gone.add(e);
    count--;
    chars -= e.text.length;
  }
  if (gone.size > 0) {
    for (const [channelId, list] of Object.entries(next)) {
      const kept = list.filter((e) => !gone.has(e));
      letGo(channelId, list.length - kept.length);
      if (kept.length > 0) next[channelId] = kept;
      else delete next[channelId];
    }
  }
  return { ephemerals: next, ephemeralsDropped: counts };
}

/** Slash commands: the hint list, running one, and the private answers that come back. */
export class Commands {
  private nonceCounter = 0;

  constructor(
    private readonly api: Api,
    private readonly store: StoreApi<WorkspaceState>,
    private readonly isStopped: () => boolean,
  ) {}

  private get stopped(): boolean {
    return this.isStopped();
  }

  /**
   * Runs a slash command. Anything it has to say comes back over the socket as
   * an ephemeral, so the only thing handled here is the command not working at
   * all — which is still worth telling the person who typed it.
   */
  async runCommand(channelId: ID, text: string, name: string, threadRootId?: ID): Promise<void> {
    try {
      await this.api.runCommand(channelId, {
        text,
        ...(threadRootId ? { threadRootId } : {}),
      });
    } catch (err) {
      const message =
        err instanceof ApiError && err.code === "unknown_command"
          ? `\`/${name}\` is not a command here.`
          : `\`/${name}\` could not run. ${refusalReason(failureOf(err)) ?? "The workspace turned it down."}`;
      this.addEphemeral({
        id: `local-${Date.now()}-${++this.nonceCounter}`,
        channelId,
        userId: "",
        text: message,
        createdAt: Date.now(),
      });
    }
  }

  addEphemeral(message: EphemeralMessage): void {
    this.store.setState((s) => keepEphemeral(s.ephemerals, s.ephemeralsDropped, message));
  }

  dismissDroppedEphemerals(channelId: ID): void {
    this.store.setState((s) => {
      if (!(channelId in s.ephemeralsDropped)) return {};
      const ephemeralsDropped = { ...s.ephemeralsDropped };
      delete ephemeralsDropped[channelId];
      return { ephemeralsDropped };
    });
  }

  dismissEphemeral(channelId: ID, id: ID): void {
    this.store.setState((s) => {
      const kept = (s.ephemerals[channelId] ?? []).filter((e) => e.id !== id);
      const ephemerals = { ...s.ephemerals };
      if (kept.length > 0) ephemerals[channelId] = kept;
      else delete ephemerals[channelId];
      return { ephemerals };
    });
  }

  /** Loads the `/` hint list. A failure keeps the list there was: hints are a convenience. */
  async loadCommands(): Promise<void> {
    const commands = await answerOf(async () => (await this.api.listCommands()).commands);
    if (!(commands instanceof ApiError) && !this.stopped) this.store.setState({ commands });
  }
}
