import type { DesktopErrorCode, DesktopFailure } from "@ownbase/protocol/desktop";

/** A failure the main process names by its code, for the window to act on. */
export class DesktopError extends Error {
  constructor(
    readonly code: DesktopErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DesktopError";
  }
}

/** What crosses the bridge of a failure: its code and its message, nothing else. */
export function toFailure(error: unknown): DesktopFailure {
  if (error instanceof DesktopError) return { code: error.code, message: error.message };
  return { code: "failed", message: error instanceof Error ? error.message : String(error) };
}
