import type { MouseEvent } from "react";

/**
 * For a list row whose actions can take rows away: Remove from Saved, Delete
 * draft, Mark read, Mark done. The rows after it move up, so the second click
 * of a double-click lands on whatever slid under the pointer, another row's
 * action or the row itself, and Chromium counts it as the second click even
 * there. Given to the row as onClickCapture, this stops that click before any
 * control in the row sees it. A key press has a detail of 0 and always goes
 * through.
 */
export function dropRepeatClick(event: MouseEvent) {
  if (event.detail > 1) event.stopPropagation();
}
