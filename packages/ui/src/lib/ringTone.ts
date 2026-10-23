/**
 * The sound of a direct message's huddle ringing this device (E10), made with
 * Web Audio so it needs no file: a two-note chime twice, then a pause, as a
 * phone rings, quiet enough to sit under whatever else is playing.
 */

/** How often the pattern starts again. */
const RING_EVERY_MS = 3000;

/** Each note: when it starts in the pattern, in seconds, and its pitch. */
const NOTES = [
  { at: 0, hz: 784 },
  { at: 0.16, hz: 659 },
  { at: 0.8, hz: 784 },
  { at: 0.96, hz: 659 },
] as const;

/** How long a note takes to fade, in seconds. */
const DECAY = 0.7;

/**
 * Starts ringing; the function it gives stops it. Silent where there is no
 * Web Audio, or where the browser will not play before someone has used the
 * page: the prompt on screen says it all the same.
 */
export function startRingTone(volume = 0.08): () => void {
  const Context = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Context) return () => {};
  let context: AudioContext;
  try {
    context = new Context();
  } catch {
    return () => {};
  }
  const out = context.createGain();
  out.gain.value = volume;
  out.connect(context.destination);
  const ring = () => {
    const now = context.currentTime;
    for (const note of NOTES) {
      const start = now + note.at;
      const level = context.createGain();
      level.gain.setValueAtTime(0.0001, start);
      level.gain.exponentialRampToValueAtTime(1, start + 0.012);
      level.gain.exponentialRampToValueAtTime(0.0001, start + DECAY);
      level.connect(out);
      const tone = context.createOscillator();
      tone.type = "sine";
      tone.frequency.value = note.hz;
      tone.connect(level);
      tone.start(start);
      tone.stop(start + DECAY + 0.05);
    }
  };
  void context.resume().catch(() => {});
  ring();
  const timer = setInterval(ring, RING_EVERY_MS);
  return () => {
    clearInterval(timer);
    void context.close().catch(() => {});
  };
}
