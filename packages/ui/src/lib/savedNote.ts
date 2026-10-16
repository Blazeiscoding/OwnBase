import { createContext, useContext } from "react";

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
