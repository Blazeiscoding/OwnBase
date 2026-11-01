import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ID, User } from "@ownbase/protocol";
import { namesList } from "../lib/catchUp.js";

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

/**
 * Tells a screen reader who joins and leaves the huddle, which otherwise only
 * shows as a tile appearing. On the body, beside the notices, so it is heard
 * over a dialog: the modal layer makes the workspace inert, and an inert live
 * region says nothing.
 */
export function CallAnnouncer({
  peerIds,
  users,
}: {
  peerIds: readonly ID[];
  users: Record<ID, User>;
}) {
  const [said, setSaid] = useState<{ id: number; text: string }[]>([]);
  const nextId = useRef(0);
  const known = useRef<Set<ID> | null>(null);
  const leaving = useRef(new Map<ID, ReturnType<typeof setTimeout>>());
  const nameOf = useRef((id: ID) => users[id]?.displayName ?? "Someone");
  nameOf.current = (id: ID) => users[id]?.displayName ?? "Someone";

  const say = (text: string) =>
    setSaid((prev) => [...prev.slice(-2), { id: nextId.current++, text }]);

  const key = [...peerIds].sort().join(" ");
  useEffect(() => {
    const now = new Set(peerIds);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the ids
  }, [key]);

  useEffect(() => {
    const timers = leaving.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return createPortal(
    <div data-ownbase-call="" role="log" aria-label="Huddle arrivals" className="sr-only">
      {said.map((s) => (
        <p key={s.id}>{s.text}</p>
      ))}
    </div>,
    document.body,
  );
}
