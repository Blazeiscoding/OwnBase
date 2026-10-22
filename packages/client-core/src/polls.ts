import type { ID, Message, Poll } from "@slackoss/protocol";

/** A poll before it is sent: its choices and how it is answered (E6). */
export interface PollDraft {
  options: string[];
  multiple: boolean;
  anonymous: boolean;
}

/** Choices as one comparable value: option places, in order, each once. */
export const pollChoicesKey = (choices: readonly number[]): string =>
  [...new Set(choices)].sort((a, b) => a - b).join(",");

export const pollChoicesOfKey = (key: string): number[] =>
  key === "" ? [] : key.split(",").map(Number);

/**
 * What the server has as this account's choices in a poll: on its options,
 * or for an anonymous poll, as it told this account alone (`told`).
 */
export function serverPollChoices(
  message: Pick<Message, "id" | "poll">,
  selfId: ID | undefined,
  told: Record<ID, number[]> | null,
): number[] {
  const poll = message.poll;
  if (!poll || !selfId) return [];
  if (poll.anonymous) return told?.[message.id] ?? [];
  return poll.options.flatMap((option, i) => (option.voterIds?.includes(selfId) ? [i] : []));
}

/**
 * A poll as this account sees it: the server's counts, moved for choices made
 * here that it has not yet heard back about (`picked`), and what is chosen.
 */
export function shownPoll(
  message: Pick<Message, "id" | "poll">,
  selfId: ID | undefined,
  told: Record<ID, number[]> | null,
  picked: Record<ID, number[]>,
): { poll: Poll; mine: number[] } | null {
  const poll = message.poll;
  if (!poll) return null;
  const server = serverPollChoices(message, selfId, told);
  const mine = picked[message.id] ?? server;
  if (!selfId || pollChoicesKey(mine) === pollChoicesKey(server)) return { poll, mine };
  const had = new Set(server);
  const has = new Set(mine);
  return {
    mine,
    poll: {
      ...poll,
      options: poll.options.map((option, i) => {
        const moved = (has.has(i) ? 1 : 0) - (had.has(i) ? 1 : 0);
        if (moved === 0) return option;
        return {
          ...option,
          votes: Math.max(0, option.votes + moved),
          ...(option.voterIds
            ? {
                voterIds:
                  moved > 0
                    ? [...option.voterIds, selfId]
                    : option.voterIds.filter((id) => id !== selfId),
              }
            : {}),
        };
      }),
      voters: Math.max(0, poll.voters + (has.size > 0 ? 1 : 0) - (had.size > 0 ? 1 : 0)),
    },
  };
}
