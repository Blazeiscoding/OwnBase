import { lazy, useEffect, useState } from "react";
import { LazyDialog } from "./LazyView.js";

// Kept out of the entry until someone opens it.
const CustomEmojiDialog = lazy(() =>
  import("./CustomEmojiDialog.js").then((module) => ({ default: module.CustomEmojiDialog })),
);

let open: (() => void) | null = null;

/**
 * Opens the workspace's Custom emoji window (J12). The emoji picker asks for
 * it from inside a popover that closes as the window opens, so the window is
 * held here, above both, rather than by the picker.
 */
export function openCustomEmoji(): void {
  open?.();
}

/** Holds the Custom emoji window for the workspace on screen. */
export function CustomEmojiHost() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const show = () => setShown(true);
    open = show;
    return () => {
      if (open === show) open = null;
    };
  }, []);
  if (!shown) return null;
  return (
    <LazyDialog loading="Loading custom emoji" onClose={() => setShown(false)}>
      <CustomEmojiDialog onClose={() => setShown(false)} />
    </LazyDialog>
  );
}
