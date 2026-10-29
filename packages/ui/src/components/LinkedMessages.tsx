import { useContext, useEffect, useMemo, useState } from "react";
import { ApiError, type WorkspaceClient } from "@ownbase/client-core";
import type { FileMeta, ID, Message } from "@ownbase/protocol";
import { OpenMessageContext, useClient, useWorkspace } from "../context.js";
import { formatWhen } from "../lib/format.js";
import { linkedMessages, type LinkedMessage } from "../lib/linkedMessages.js";
import { useMessageReferences } from "../lib/messageReferences.js";
import { QuotedMessage, conversationName } from "./ForwardCard.js";
import { Icon } from "./Icon.js";
import { useOwnAddress } from "./ShareableServer.js";

/**
 * The messages a message links to, each in a card under its words, as Slack
 * shows a link to a message: who wrote it, when, what it says and where.
 * Each reader's own copy is asked for, so one in a conversation the reader
 * cannot see shows nothing, and neither does one deleted since.
 */
export function LinkedMessages(props: {
  message: Pick<Message, "id" | "text">;
  onOpenImage?: (file: FileMeta) => void;
  onChannelClick?: (id: ID) => void;
}) {
  const ours = useOwnAddress();
  const { id, text } = props.message;
  const targets = useMemo(
    () => linkedMessages(text, ours).filter((target) => target.messageId !== id),
    [text, id, ours],
  );
  if (targets.length === 0) return null;
  return (
    <>
      {targets.map((target) => (
        <LinkedMessageCard
          key={target.messageId}
          target={target}
          onOpenImage={props.onOpenImage}
          onChannelClick={props.onChannelClick}
        />
      ))}
    </>
  );
}

function LinkedMessageCard(props: {
  target: LinkedMessage;
  onOpenImage?: (file: FileMeta) => void;
  onChannelClick?: (id: ID) => void;
}) {
  const message = useLinkedMessage(props.target);
  // Someone this account blocked stays out of sight here too.
  const blocked = useWorkspace((s) => !!message && s.blocked?.includes(message.userId) === true);
  if (!message || blocked) return null;
  return (
    <Card message={message} onOpenImage={props.onOpenImage} onChannelClick={props.onChannelClick} />
  );
}

function Card(props: {
  message: Message;
  onOpenImage?: (file: FileMeta) => void;
  onChannelClick?: (id: ID) => void;
}) {
  const { message } = props;
  const openMessage = useContext(OpenMessageContext);
  const selfId = useWorkspace((s) => s.self?.id);
  const author = useWorkspace((s) => s.users[message.userId]);
  const { users, channels } = useMessageReferences(message);
  const where = useWorkspace((s) => {
    const channel = s.channels[message.channelId];
    if (!channel) return null;
    const name = conversationName(channel, s.users, s.self?.id);
    return channel.type === "public" || channel.type === "private"
      ? name
      : `a direct message with ${name}`;
  });
  return (
    <div className="mt-1.5 max-w-xl rounded-lg border border-edge border-l-2 border-l-ink-faint bg-ink/[0.025] px-3 py-2">
      <p className="flex items-center gap-1.5 text-xs text-ink-faint">
        <Icon name="link" size={12} />
        {message.threadRootId ? `Posted in a thread in ${where}` : `Posted in ${where}`}
      </p>
      <QuotedMessage
        message={message}
        author={author}
        users={users}
        channels={channels}
        selfId={selfId}
        when={formatWhen}
        onOpenImage={props.onOpenImage}
        onChannelClick={props.onChannelClick}
      />
      {openMessage && (
        <button
          type="button"
          onClick={() => openMessage(message.channelId, message.id)}
          className="mt-1 text-xs font-medium text-ink-dim hover:text-ink hover:underline"
        >
          View message
        </button>
      )}
    </div>
  );
}

/**
 * A linked message as this account can read it now. The copy this device
 * holds, when it holds one, so an edit shows as it is made; otherwise the
 * server's, asked for again whenever its conversation's content changes.
 * Null while it is asked for, and for one gone or out of this account's reach.
 */
function useLinkedMessage({ channelId, messageId }: LinkedMessage): Message | null {
  const client = useClient();
  const readable = useWorkspace((s) => !!s.channels[channelId]);
  const timeline = useWorkspace((s) => s.timelines[channelId]);
  const threads = useWorkspace((s) => s.threads);
  const held = useMemo(() => {
    const top = timeline?.items.find((m) => m.id === messageId);
    if (top) return top;
    for (const replies of Object.values(threads)) {
      const reply = replies.find((m) => m.id === messageId);
      if (reply) return reply.channelId === channelId ? reply : undefined;
    }
    return undefined;
  }, [timeline, threads, channelId, messageId]);
  const changed = useWorkspace((s) => s.changedContent[channelId] ?? 0);
  const [asked, setAsked] = useState<{ id: ID; message: Message | null } | null>(null);
  useEffect(() => {
    if (held || !readable) return;
    let live = true;
    askFor(client, channelId, messageId, changed).then(
      (message) => {
        if (live) setAsked({ id: messageId, message });
      },
      // Not heard, as when offline: what was shown stays.
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client, channelId, messageId, changed, held, readable]);
  if (!readable) return null;
  if (held) return held;
  // The last answer stays up while the next is asked for, so a card does not
  // blink each time something else in its conversation changes.
  return asked?.id === messageId ? asked.message : null;
}

/** Answers per client and message, kept until its conversation changes again. */
const answers = new WeakMap<
  WorkspaceClient,
  Map<ID, { changed: number; answer: Promise<Message | null> }>
>();

/**
 * Asks the server for one message, once for each change of its conversation
 * however many cards show it. Gone or unreadable is an answer, null; anything
 * else, such as being offline, fails and is asked again the next time.
 */
function askFor(
  client: WorkspaceClient,
  channelId: ID,
  messageId: ID,
  changed: number,
): Promise<Message | null> {
  let known = answers.get(client);
  if (!known) answers.set(client, (known = new Map()));
  const held = known.get(messageId);
  if (held && held.changed === changed) return held.answer;
  const answer: Promise<Message | null> = client.api.getMessage(channelId, messageId).then(
    ({ message }) => (message.channelId === channelId ? message : null),
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 404) return null;
      if (known.get(messageId)?.answer === answer) known.delete(messageId);
      throw error;
    },
  );
  known.set(messageId, { changed, answer });
  return answer;
}
