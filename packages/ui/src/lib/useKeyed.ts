import { useState } from "react";

/**
 * What `make` gave when `key` last changed. A new array or object that says
 * the same thing keeps the identity of the one before, so the effects and
 * memos that depend on it run only for a real change; `make` runs only then.
 */
export function useKeyed<T>(key: string, make: () => T): T {
  const [held, setHeld] = useState(() => ({ key, value: make() }));
  if (held.key === key) return held.value;
  const next = { key, value: make() };
  setHeld(next);
  return next.value;
}
