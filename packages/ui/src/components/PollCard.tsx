import { useId } from "react";
import type { Channel, ID, Message, User } from "@slackoss/protocol";
import { shownPoll, type PollDraft } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import { Avatar } from "./Avatar.js";
import { useConfirm } from "./Confirm.js";
import { Icon } from "./Icon.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { useToast } from "./Toast.js";

/** How many faces an option shows before the rest are only counted. */
const FACES = 3;

const votesLabel = (n: number) => (n === 0 ? "No votes yet" : n === 1 ? "1 vote" : `${n} votes`);
const listFormat = (names: string[]) =>
  new Intl.ListFormat(undefined, { type: "conjunction" }).format(names);

/**
 * A poll in a message (E6): its question, and each choice with how many chose
 * it, a bar for its share of the voters and, unless the poll is anonymous,
 * the faces of who chose it. Pressing a choice votes for it, and pressing it
 * again takes it back; a poll that takes one choice moves the vote. A closed
 * poll, or one in an archived conversation, only shows how it went. Its
 * author can close it.
 */
export function PollCard({
  message,
  users,
  channels,
  onChannelClick,
}: {
  message: Message;
  users: Record<ID, User>;
  channels: Record<ID, Channel>;
  onChannelClick?: (channelId: ID) => void;
}) {
  const client = useClient();
  const toast = useToast();
  const confirm = useConfirm();
  const selfId = useWorkspace((s) => s.self?.id);
  const told = useWorkspace((s) => s.pollChoices);
  const picked = useWorkspace((s) => s.pollPicks);
  const archived = useWorkspace((s) => s.channels[message.channelId]?.archived ?? false);
  const questionId = useId();
  const shown = shownPoll(message, selfId, told, picked);
  if (!shown) return null;
  const { poll, mine } = shown;
  const chosen = new Set(mine);
  const open = poll.closedAt === null && !archived;
  const name = (id: ID) => (id === selfId ? "you" : (users[id]?.displayName ?? "someone"));

  function pick(option: number) {
    const next = chosen.has(option)
      ? mine.filter((c) => c !== option)
      : poll.multiple
        ? [...mine, option]
        : [option];
    void client.vote(message, next).then((ok) => {
      if (!ok)
        toast({
          message: "Your vote did not go through. The poll may have closed; check and try again.",
        });
    });
  }

  async function close() {
    const sure = await confirm({
      title: "Close this poll?",
      body: "Nobody can vote once it closes, and the votes so far are final.",
      confirmLabel: "Close poll",
    });
    if (sure && !(await client.closePoll(message)))
      toast({ message: "Could not close the poll. Check your connection and try again." });
  }

  return (
    <div
      role="group"
      aria-labelledby={questionId}
      className="poll-card mt-1 max-w-xl rounded-xl border border-edge bg-ink/[0.025] p-3"
    >
      <div id={questionId} className="message-text text-[16px] font-semibold leading-snug text-ink">
        <Mrkdwn
          text={message.text}
          users={users}
          channels={channels}
          selfId={selfId}
          onChannelClick={onChannelClick}
        />
      </div>
      <p className="mt-0.5 text-[13px] text-ink-faint">
        {open ? (poll.multiple ? "Choose any" : "Choose one") : "Closed"}
        {poll.anonymous && " · Anonymous"}
      </p>
      <ul className="mt-2.5 space-y-1.5">
        {poll.options.map((option, i) => {
          const isMine = chosen.has(i);
          // A share of the people who voted, so a poll taking many choices adds up past 100.
          const share = poll.voters > 0 ? Math.round((option.votes / poll.voters) * 100) : 0;
          const voterIds = option.voterIds ?? [];
          const who = voterIds.length > 0 ? `: ${listFormat(voterIds.map(name))}` : "";
          // Said after the choice's words; a press says itself as pressed.
          const details = `, ${votesLabel(option.votes).toLowerCase()}${who}${
            !open && isMine ? ", your choice" : ""
          }`;
          const body = (
            <>
              <span
                aria-hidden="true"
                className={`poll-bar absolute inset-y-0 left-0 transition-[width] duration-300 ease-out ${
                  isMine ? "bg-copper/20" : "bg-ink/[0.07]"
                }`}
                style={{ width: `${share}%` }}
              />
              <span
                aria-hidden="true"
                className={`relative flex size-[18px] shrink-0 items-center justify-center border-[1.5px] transition-colors ${
                  poll.multiple ? "rounded-[5px]" : "rounded-full"
                } ${isMine ? "border-copper bg-copper text-ground" : "border-ink-faint"}`}
              >
                {isMine && <Icon name="check" size={12} strokeWidth={3} />}
              </span>
              <span className="relative min-w-0 flex-1 break-words text-[15px] text-ink">
                {option.text}
                <span className="sr-only">{details}</span>
              </span>
              {voterIds.length > 0 && (
                <span aria-hidden="true" className="relative flex shrink-0 -space-x-1.5">
                  {voterIds.slice(0, FACES).map((id) => (
                    <span key={id} className="rounded-full ring-2 ring-[var(--color-ground)]">
                      <Avatar user={users[id]} size={18} />
                    </span>
                  ))}
                </span>
              )}
              <span
                aria-hidden="true"
                className="relative w-10 shrink-0 text-right text-[13px] tabular-nums text-ink-dim"
              >
                {share}%
              </span>
            </>
          );
          const row =
            "relative flex w-full items-center gap-2.5 overflow-hidden rounded-lg border px-3 py-2 text-left";
          return (
            <li key={i}>
              {open ? (
                <button
                  type="button"
                  aria-pressed={isMine}
                  onClick={() => pick(i)}
                  className={`${row} transition-colors ${
                    isMine
                      ? "border-copper/50"
                      : "border-edge hover:border-ink/25 hover:bg-ink/[0.03]"
                  }`}
                >
                  {body}
                </button>
              ) : (
                <div className={`${row} ${isMine ? "border-copper/40" : "border-edge"}`}>
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-faint">
        <span>{votesLabel(poll.voters)}</span>
        {open && message.userId === selfId && (
          <button
            type="button"
            onClick={() => void close()}
            className="font-medium text-ink-dim hover:text-ink hover:underline"
          >
            Close poll
          </button>
        )}
      </div>
    </div>
  );
}

/** A poll on its way: its question and choices, with nothing to press yet. */
export function PendingPoll({
  text,
  poll,
  users,
  channels,
}: {
  text: string;
  poll: PollDraft;
  users: Record<ID, User>;
  channels: Record<ID, Channel>;
}) {
  return (
    <div className="mt-1 max-w-xl rounded-xl border border-edge bg-ink/[0.025] p-3">
      <div className="message-text text-[16px] font-semibold leading-snug text-ink">
        <Mrkdwn text={text} users={users} channels={channels} />
      </div>
      <p className="mt-0.5 text-[13px] text-ink-faint">
        {poll.multiple ? "Choose any" : "Choose one"}
        {poll.anonymous && " · Anonymous"}
      </p>
      <ul className="mt-2.5 space-y-1.5">
        {poll.options.map((option, i) => (
          <li
            key={i}
            className="flex items-center gap-2.5 rounded-lg border border-edge px-3 py-2 text-[15px] text-ink"
          >
            <span
              aria-hidden="true"
              className={`size-[18px] shrink-0 border-[1.5px] border-ink-faint ${
                poll.multiple ? "rounded-[5px]" : "rounded-full"
              }`}
            />
            {option}
          </li>
        ))}
      </ul>
    </div>
  );
}
