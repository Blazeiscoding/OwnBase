import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CallReaction } from "@ownbase/client-core";
import type { ID, User } from "@ownbase/protocol";
import { namesList } from "../lib/catchUp.js";
import { useKeyed } from "../lib/useKeyed.js";

/**
 * How long someone may be gone before leaving is news. A connection made
 * again (the server letting this device's place go, a network change) drops
 * and adds the same person within it, which is not them leaving.
 */
export const LEAVE_GRACE_MS = 2500;

/** What is read for people who came and went together. */
export function describeArrivals(joined: string[], left: string[]): string {
  const parts: string[] = [];
  if (joined.length) parts.push(`${namesList(joined)} joined the huddle.`);
  if (left.length) parts.push(`${namesList(left)} left the huddle.`);
  return parts.join(" ");
}

/** The least time between two reactions read out in one call, so a run of 👏 is one line (K17). */
export const REACTION_SAID_MS = 5000;

/**
 * Tells a screen reader who joins and leaves the huddle, which otherwise only
 * shows as a tile appearing, and who raises a hand or reacts (K17). On the
 * body, beside the notices, so it is heard over a dialog: the modal layer
 * makes the workspace inert, and an inert live region says nothing. Your own
 * hand and reactions are your own presses, and not read back.
 */
export function CallAnnouncer({
  peerIds,
  users,
  selfId,
  hands = [],
  reactions = [],
}: {
  peerIds: readonly ID[];
  users: Record<ID, User>;
  selfId?: ID;
  hands?: readonly ID[];
  reactions?: readonly CallReaction[];
}) {
  const [said, setSaid] = useState<{ id: number; text: string }[]>([]);
  const nextId = useRef(0);
  const known = useRef<Set<ID> | null>(null);
  const leaving = useRef(new Map<ID, ReturnType<typeof setTimeout>>());
  const nameOf = useRef((id: ID) => users[id]?.displayName ?? "Someone");
  nameOf.current = (id: ID) => users[id]?.displayName ?? "Someone";

  const say = useCallback(
    (text: string) => setSaid((prev) => [...prev.slice(-2), { id: nextId.current++, text }]),
    [],
  );

  const here = useKeyed([...peerIds].sort().join(" "), () => peerIds);
  useEffect(() => {
    const now = new Set(here);
    const before = known.current;
    known.current = now;
    // Who was already here when you joined is on the screen, not news.
    if (!before) return;
    const joined: string[] = [];
    for (const id of now) {
      if (before.has(id)) continue;
      const pending = leaving.current.get(id);
      if (pending) {
        clearTimeout(pending);
        leaving.current.delete(id);
      } else joined.push(nameOf.current(id));
    }
    for (const id of before) {
      if (now.has(id) || leaving.current.has(id)) continue;
      leaving.current.set(
        id,
        setTimeout(() => {
          leaving.current.delete(id);
          say(describeArrivals([], [nameOf.current(id)]));
        }, LEAVE_GRACE_MS),
      );
    }
    if (joined.length) say(describeArrivals(joined, []));
  }, [here, say]);

  // Hands already up when you joined are on the screen, as people are.
  const raised = useRef<Set<ID> | null>(null);
  const handsNow = useKeyed(hands.join(" "), () => hands);
  useEffect(() => {
    const before = raised.current;
    raised.current = new Set(handsNow);
    if (!before) return;
    for (const id of handsNow)
      if (!before.has(id) && id !== selfId) say(`${nameOf.current(id)} raised their hand`);
  }, [handsNow, selfId, say]);

  // Read when a new one comes, which the newest id says; the list changes as old ones go too.
  const heard = useRef<number | null>(null);
  const saidAt = useRef(-Infinity);
  const shown = useRef(reactions);
  shown.current = reactions;
  const newest = reactions.at(-1)?.id ?? 0;
  useEffect(() => {
    const last = heard.current;
    heard.current = newest;
    if (last === null) return;
    const fresh = shown.current.find((r) => r.id > last && r.userId !== selfId);
    const now = Date.now();
    if (!fresh || now - saidAt.current < REACTION_SAID_MS) return;
    saidAt.current = now;
    say(`${nameOf.current(fresh.userId)} reacted ${fresh.emoji}`);
  }, [newest, selfId, say]);

  useEffect(() => {
    const timers = leaving.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return createPortal(
    <div data-ownbase-call="" role="log" aria-label="Huddle updates" className="sr-only">
      {said.map((s) => (
        <p key={s.id}>{s.text}</p>
      ))}
    </div>,
    document.body,
  );
}
