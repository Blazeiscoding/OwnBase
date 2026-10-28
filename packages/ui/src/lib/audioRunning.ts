/** How long the audio may take to start before it counts as not starting. */
export const AUDIO_START_MS = 3000;

/** Resolves when the audio is running, or rejects rather than send silence. */
export async function running(context: AudioContext): Promise<void> {
  await Promise.race([
    context.resume(),
    new Promise((resolve) => setTimeout(resolve, AUDIO_START_MS)),
  ]);
  if (context.state !== "running") throw new Error("the browser did not let the audio start");
}
