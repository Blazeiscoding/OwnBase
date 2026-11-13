import { useId, useRef, useState, type FormEvent } from "react";
import { MESSAGE_TEXT_MAX, type ID } from "@ownbase/protocol";
import {
  ApiError,
  blockedPartner,
  forwardOf,
  selfMay,
  type ForwardSource,
} from "@ownbase/client-core";
import { useClient, useWorkspace } from "../context.js";
import { matchTier } from "../lib/switcherRank.js";
import { useListbox } from "../lib/useListbox.js";
import { buttonClass } from "./Button.js";
import { Dialog } from "./Dialog.js";
import { ForwardCard, conversationName } from "./ForwardCard.js";
import { inputCls } from "./TextField.js";
import { useToast } from "./Toast.js";
import { isImeKey } from "../lib/textInput.js";

/** How many conversations the list shows at once; typing narrows it. */
const SHOWN = 8;

/**
 * Where a forward can go: a conversation, or a person there is no direct
 * conversation with yet, which sending starts.
 */
interface Target {
  key: string;
  label: string;
  channelId?: ID;
  userId?: ID;
}

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
  const [target, setTarget] = useState<Target | null>(null);
  const [sending, setSending] = useState(false);
  const [comment, setComment] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const problemId = useId();

  const startsDirect = useWorkspace((s) => selfMay(s, "createChannel"));
  const blocked = useWorkspace((s) => s.blocked);
  // Where this person can post: what they are in, and any public channel,
  // which posting joins; and anyone else, as the switcher offers them, in a
  // direct conversation that sending starts. Guests have no direct messages.
  const directWith = new Set<ID>();
  const places: Target[] = [];
  for (const c of Object.values(channels)) {
    if (c.archived || !(c.id in memberships || c.type === "public")) continue;
    if (blockedPartner(c, selfId, blocked)) continue;
    const others = (c.memberIds ?? []).filter((id) => id !== selfId);
    if (c.type === "dm" && others.length === 1) directWith.add(others[0]!);
    places.push({ key: c.id, label: conversationName(c, users, selfId), channelId: c.id });
  }
  if (startsDirect)
    for (const u of Object.values(users))
      if (u.id !== selfId && !u.deactivated && !directWith.has(u.id) && !blocked.includes(u.id))
        places.push({ key: `person:${u.id}`, label: u.displayName, userId: u.id });
  places.sort((a, b) => a.label.localeCompare(b.label));
  const typed = query.trim().toLowerCase().replace(/^[#@]/, "");
  // Ranked as Ctrl+K ranks them: the whole name, its start, a word's start,
  // anywhere; so "al" finds Alex before #general.
  const tierOf = (place: Target) => {
    const tiers = [matchTier(place.label.replace(/^#/, ""), typed)];
    if (place.userId) tiers.push(matchTier(users[place.userId]?.handle ?? "", typed));
    const found = tiers.filter((tier) => tier >= 0);
    return found.length ? Math.min(...found) : -1;
  };
  const results =
    target !== null
      ? []
      : places
          .map((place) => ({ place, tier: tierOf(place) }))
          .filter(({ tier }) => tier >= 0)
          .sort((a, b) => a.tier - b.tier)
          .map(({ place }) => place)
          .slice(0, SHOWN);
  const list = useListbox(results.length);
  const fromPublic = channels[source.channelId]?.type === "public";
  // A direct conversation still to start is somewhere else than the message's own.
  const card = forwardOf(source, target ? (target.channelId ?? "") : source.channelId, fromPublic);

  function pick(place: Target) {
    setTarget(place);
    setQuery(place.label);
    setProblem(null);
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (sending) return;
    if (target === null) {
      setProblem("Choose where to forward it.");
      field.current?.focus();
      return;
    }
    let channelId = target.channelId;
    if (!channelId) {
      setSending(true);
      const dm = await client.openDm([target.userId!]);
      setSending(false);
      if (dm instanceof ApiError) {
        setProblem(`Could not start a conversation with ${target.label}. Try again.`);
        return;
      }
      channelId = dm.id;
    }
    const sent = client.send(channelId, comment.trim(), {
      forward: forwardOf(source, channelId, fromPublic),
    });
    if (sent.kind === "refused") {
      setProblem("Too many messages are waiting to send. Try again after they go out.");
      return;
    }
    onClose();
    toast({ message: `Forwarded to ${target.label}.`, kind: "success" });
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
            placeholder="Search conversations and people"
            aria-invalid={problem !== null && target === null ? true : undefined}
            aria-errormessage={problem !== null ? problemId : undefined}
            aria-describedby={problem !== null ? problemId : undefined}
            onChange={(event) => {
              setQuery(event.target.value);
              setTarget(null);
              list.choose(0);
            }}
            onKeyDown={(event) => {
              // An input method's Enter picks a candidate, not whom to send to.
              if (isImeKey(event.nativeEvent)) return;
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
            aria-label="Conversations and people"
            className="max-h-64 overflow-y-auto rounded-lg border border-edge p-1"
          >
            {results.map((place, i) => (
              <li
                key={place.key}
                {...list.optionProps(i)}
                onClick={() => pick(place)}
                className={`flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-sm ${
                  i === list.active ? "bg-lifted text-ink" : "text-ink-dim"
                }`}
              >
                <span className="truncate">{place.label}</span>
                {place.userId && (
                  <span className="shrink-0 text-xs text-ink-faint">
                    @{users[place.userId]?.handle}
                  </span>
                )}
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
            dir="auto"
            rows={2}
            value={comment}
            maxLength={MESSAGE_TEXT_MAX}
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
          <button
            type="submit"
            aria-disabled={sending || undefined}
            className={buttonClass("primary")}
          >
            {sending ? "Forwarding…" : "Forward"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
