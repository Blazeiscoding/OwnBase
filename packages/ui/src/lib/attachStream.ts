/** How long an element may stay empty after its frames begin before it is given the stream again. */
const SETTLE_MS = 1000;
/** How many times it is given the stream again, at most. */
const TRIES = 3;

/**
 * Plays `stream` in `element`, and returns what lets go of it.
 *
 * A received camera's stream reaches its tile before any frame does: the
 * sender waits to hear how big the tile is. In WebKit, which every browser on
 * an iPhone uses, an element given a stream that way sometimes stays empty
 * (`readyState` 0) after the frames begin, though they are being decoded: 2 in
 * 300 runs of the huddle test (J18). So once a video track has frames, an
 * element that still has nothing a second later is given the stream again,
 * which starts it.
 */
export function attachStream(element: HTMLVideoElement, stream: MediaStream): () => void {
  const play = () => void element.play()?.catch(() => {});
  element.srcObject = stream;
  play();

  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hasFrames = () => stream.getVideoTracks().some((t) => t.readyState === "live" && !t.muted);
  const check = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (element.readyState !== 0 || !hasFrames() || tries >= TRIES) return;
      tries++;
      element.srcObject = null;
      element.srcObject = stream;
      play();
      check();
    }, SETTLE_MS);
  };
  const tracks = stream.getVideoTracks();
  for (const track of tracks) track.addEventListener("unmute", check);
  if (hasFrames()) check();

  return () => {
    clearTimeout(timer);
    for (const track of tracks) track.removeEventListener("unmute", check);
    element.srcObject = null;
  };
}
