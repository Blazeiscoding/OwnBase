/** How long the audio may take to start before it counts as not starting. */
export const AUDIO_START_MS = 3000;

/**
 * Asks a stopped audio graph to start, and says whether it has within
 * `waitMs`. Without a gesture the browser may hold the resume rather than
 * refuse it, so it is waited on no longer than that.
 */
export async function startsWithin(context: AudioContext, waitMs: number): Promise<boolean> {
  if (context.state === "running") return true;
  await Promise.race([context.resume(), new Promise((resolve) => setTimeout(resolve, waitMs))]);
  return (context.state as AudioContextState) === "running";
}

/** Resolves when the audio is running, or rejects rather than send silence. */
export async function running(context: AudioContext): Promise<void> {
  if (!(await startsWithin(context, AUDIO_START_MS)))
    throw new Error("the browser did not let the audio start");
}
