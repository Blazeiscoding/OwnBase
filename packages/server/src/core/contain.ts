/**
 * Runs `work` so that a throw is handed to `failed` instead of passed on,
 * where passing it on would end the process: a socket callback, a timer, or
 * work that follows a change already committed. What `work` was doing may be
 * half done; callers decide what to undo. Reporting cannot end the process
 * either. Returns whether `work` finished.
 */
export function contain(work: () => void, failed: (err: unknown) => void): boolean {
  try {
    work();
    return true;
  } catch (err) {
    try {
      failed(err);
    } catch {
      // Nothing is left to tell.
    }
    return false;
  }
}
