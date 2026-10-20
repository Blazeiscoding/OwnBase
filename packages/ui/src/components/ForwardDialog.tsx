import { useId, useRef, useState, type FormEvent } from "react";
import type { Channel, ID } from "@slackoss/protocol";
import { forwardOf, type ForwardSource } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import { useListbox } from "../lib/useListbox.js";
import { buttonClass } from "./Button.js";
import { Dialog } from "./Dialog.js";
import { ForwardCard, conversationName } from "./ForwardCard.js";
import { inputCls } from "./TextField.js";
import { useToast } from "./Toast.js";

/** How many conversations the list shows at once; typing narrows it. */
const SHOWN = 8;

/**
 * Forwards a message (E1): choose a conversation, as the switcher matches
 * them, add words of your own or none, and send. What it passes on
 * (`forwardSource`) goes as a card under them, showing what the server will
 * show there.
 */
export function ForwardDialog({ source, onClose }: { source: ForwardSource; onClose: () => void }) {
  const client = useClient();
  const toast = useToast();
  const channels = useWorkspace((s) => s.channels);
  const memberships = useWorkspace((s) => s.memberships);
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<ID | null>(null);
  const [comment, setComment] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const problemId = useId();

  const name = (c: Channel) => conversationName(c, users, selfId);
  // Where this person can post: what they are in, and any public channel,
  // which posting joins.
  const places = Object.values(channels)
    .filter((c) => !c.archived && (c.id in memberships || c.type === "public"))
    .sort((a, b) => name(a).localeCompare(name(b)));
  const typed = query.trim().toLowerCase().replace(/^[#@]/, "");
  const results =
    target !== null
      ? []
      : places
          .filter((c) => !typed || name(c).toLowerCase().replace(/^#/, "").includes(typed))
          .slice(0, SHOWN);
  const list = useListbox(results.length);
  const fromPublic = channels[source.channelId]?.type === "public";
  const card = forwardOf(source, target ?? source.channelId, fromPublic);

  function pick(channel: Channel) {
    setTarget(channel.id);
    setQuery(name(channel));
    setProblem(null);
  }

  function send(event: FormEvent) {
    event.preventDefault();
    if (target === null) {
      setProblem("Choose where to forward it.");
      field.current?.focus();
      return;
    }
    const sent = client.send(target, comment.trim(), {
      forward: forwardOf(source, target, fromPublic),
    });
    if (!sent) {
      setProblem("Too many messages are waiting to send. Try again once they have gone.");
      return;
    }
    onClose();
    toast({ message: `Forwarded to ${name(channels[target]!)}.`, kind: "success" });
  }

  return (
    <Dialog title="Forward message" onClose={onClose} width={520}>
      <form onSubmit={send} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-ink-dim">Forward to</span>
          <input
            ref={field}
            autoFocus
            value={query}
            placeholder="Search conversations"
            aria-invalid={problem !== null && target === null ? true : undefined}
            aria-errormessage={problem !== null ? problemId : undefined}
            aria-describedby={problem !== null ? problemId : undefined}
            onChange={(event) => {
              setQuery(event.target.value);
              setTarget(null);
              list.choose(0);
            }}
            onKeyDown={(event) => {
              if (list.move(event)) return;
              if (event.key === "Enter" && target === null && results[list.active]) {
                event.preventDefault();
                pick(results[list.active]!);
              }
            }}
            className={inputCls}
            {...list.comboboxProps}
          />
        </label>
        {results.length > 0 && (
          <ul
            {...list.listProps}
            aria-label="Conversations"
            className="max-h-64 overflow-y-auto rounded-lg border border-edge p-1"
          >
            {results.map((channel, i) => (
              <li
                key={channel.id}
                {...list.optionProps(i)}
                onClick={() => pick(channel)}
                className={`cursor-pointer truncate rounded-md px-2 py-1.5 text-sm ${
                  i === list.active ? "bg-lifted text-ink" : "text-ink-dim"
                }`}
              >
                {name(channel)}
              </li>
            ))}
          </ul>
        )}
        {problem && (
          <p id={problemId} role="alert" className="text-xs text-alert">
            {problem}
          </p>
        )}
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-ink-dim">
            Add a message (optional)
          </span>
          <textarea
            rows={2}
            value={comment}
            maxLength={12000}
            onChange={(event) => setComment(event.target.value)}
            className={`${inputCls} resize-none`}
          />
        </label>
        <ForwardCard
          forward={card}
          users={users}
          channels={channels}
          selfId={selfId}
          linked={false}
        />
        <div className="dialog-foot flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass("secondary")}>
            Cancel
          </button>
          <button type="submit" className={buttonClass("primary")}>
            Forward
          </button>
        </div>
      </form>
    </Dialog>
  );
}
