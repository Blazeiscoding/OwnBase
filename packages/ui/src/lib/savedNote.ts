import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

/**
 * Says that a setting which saves itself as it is changed was kept, so the
 * page it is on can say "Saved" quietly (UX-60). Outside such a page it does
 * nothing: a choice made in a huddle's menu shows for itself.
 */
export const SavedContext = createContext<() => void>(() => {});

/** The function to call once a choice has been kept. */
export function useSaved(): () => void {
  return useContext(SavedContext);
}

/** How long "Saved" stays after a choice is kept. */
const SAVED_FOR_MS = 2000;

/**
 * For a settings page: whether to say "Saved" now, the function its settings
 * call once a choice is kept (give it to them through `SavedContext`), and
 * one to stop saying it at once, as when another section is chosen.
 */
export function useSavedNote(): [saved: boolean, markSaved: () => void, clear: () => void] {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const markSaved = useCallback(() => {
    setSaved(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaved(false), SAVED_FOR_MS);
  }, []);
  const clear = useCallback(() => {
    clearTimeout(timer.current);
    setSaved(false);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [saved, markSaved, clear];
}
