/**
 * What the camera sends each of the others: a share of its 960 by 540, at
 * most so many frames a second and bits a second; no limits where absent.
 */
interface CameraEncoding {
  scaleResolutionDownBy: number;
  maxFramerate?: number;
  maxBitrate?: number;
}

/**
 * What the camera sends each of the others, by how many others there are
 * (E13). Every connection in the mesh has an encoder of its own, so each
 * person costs everyone else another one: at the full picture, half a core of
 * a six-core desktop and 2 Mbit/s of upload each, and four people on cameras
 * already stalled one such desktop running all of them. With more than one
 * other, the picture each gets is smaller and slower, keeping the upload near
 * 2.4 Mbit/s however many join; a tile in a grid of four or six is no bigger
 * than it anyway. Measured with `scripts/measure-calls.mts`; see "How many
 * people a call holds" in docs/DEPLOYMENT.md.
 */
export function cameraEncoding(others: number): CameraEncoding {
  if (others <= 1) return { scaleResolutionDownBy: 1 };
  if (others === 2) return { scaleResolutionDownBy: 1, maxFramerate: 24, maxBitrate: 1_200_000 };
  if (others <= 5)
    return {
      scaleResolutionDownBy: 1.5,
      maxFramerate: others === 3 ? 20 : 15,
      maxBitrate: Math.floor(2_400_000 / others),
    };
  return {
    scaleResolutionDownBy: 2,
    maxFramerate: 15,
    maxBitrate: Math.max(250_000, Math.floor(2_400_000 / others)),
  };
}

/**
 * The heights someone asks for a camera or a share at, by how tall they draw
 * it (E13b). Rounding to these keeps a window being resized from changing
 * what is sent at every step.
 */
const VIEW_HEIGHTS = [180, 270, 360, 540, 720, 1080, 1440, 2160] as const;

/** How tall someone draws a person's camera and share, in device pixels; 0 where not at all. */
export interface CallView {
  camera: number;
  screen: number;
}

/**
 * The height to ask for a picture drawn `drawn` device pixels tall: the
 * smallest of `VIEW_HEIGHTS` that is at least seven eighths of it, since a
 * picture an eighth smaller than its tile still looks sharp, and 0 for one
 * not drawn.
 */
export function viewHeight(drawn: number): number {
  if (!(drawn > 0)) return 0;
  return VIEW_HEIGHTS.find((height) => height >= (drawn * 7) / 8) ?? 2160;
}

/** What one connection's camera or share is set to send; see `cameraEncodingFor`. */
export interface SentEncoding extends CameraEncoding {
  /** False to send nothing at all: they draw none of it. */
  active: boolean;
}

/**
 * What a camera or a share is set to send someone while it sends them
 * nothing: they draw none of it, or it is off. Not sending is not enough.
 * The browser keeps an encoder for every connection once a picture has gone
 * over it, with its working pictures at whatever size the sender is set to,
 * for the rest of the call: at 640 by 360 that is 12 MiB a connection and at
 * 960 by 540 28 MiB, and a share's picture is larger than either. Set to an
 * eighth of the picture's size it keeps about 1 MiB. Measured with
 * `scripts/measure-memory.mts`.
 */
export const IDLE_ENCODING: SentEncoding = { active: false, scaleResolutionDownBy: 8 };

/**
 * What the camera sends someone who draws it `view` tall (`viewHeight`), in a
 * call with `others` besides you, from a camera whose picture is `height`
 * tall. A small tile gets a picture no bigger than it, at a rate that suits
 * it, and a tile not drawn gets nothing, so the encoder for it stops and
 * shrinks (`IDLE_ENCODING`). Each limit is the stricter of that and the
 * call's size (`cameraEncoding`). Until they first say how they draw it, they
 * get the call's size.
 */
export function cameraEncodingFor(
  others: number,
  view: number | undefined,
  height: number,
): SentEncoding {
  const bySize = cameraEncoding(others);
  if (view === undefined) return { active: true, ...bySize };
  if (view === 0) return IDLE_ENCODING;
  // Smaller pictures move less and carry less.
  const byView =
    view <= 180
      ? { maxFramerate: 15, maxBitrate: 200_000 }
      : view <= 270
        ? { maxFramerate: 15, maxBitrate: 350_000 }
        : view <= 360
          ? { maxFramerate: 20, maxBitrate: 600_000 }
          : {};
  const sent: SentEncoding = {
    active: true,
    scaleResolutionDownBy: Math.max(bySize.scaleResolutionDownBy, height / view),
  };
  const maxFramerate = stricter(bySize.maxFramerate, byView.maxFramerate);
  if (maxFramerate !== undefined) sent.maxFramerate = maxFramerate;
  const maxBitrate = stricter(bySize.maxBitrate, byView.maxBitrate);
  if (maxBitrate !== undefined) sent.maxBitrate = maxBitrate;
  return sent;
}

/**
 * What the share sends someone who draws it `view` tall, from a share whose
 * picture is `height` tall: no bigger than that, and nothing while it is not
 * drawn. Its rate stays the sharer's choice. As it comes until they first
 * say how they draw it.
 */
export function screenEncodingFor(view: number | undefined, height: number): SentEncoding {
  if (view === undefined) return { active: true, scaleResolutionDownBy: 1 };
  if (view === 0) return IDLE_ENCODING;
  return { active: true, scaleResolutionDownBy: Math.max(1, height / view) };
}

/** The lower of two limits, where either is set. */
function stricter(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/**
 * How tall a track's picture is where a tile shows it: a camera fills a 16:9
 * tile, so a phone's upright picture is cut to that shape first. Missing for a
 * track that cannot say.
 */
export function pictureHeight(track: MediaStreamTrack | null, fill: boolean): number | undefined {
  const { width, height } = track?.getSettings?.() ?? {};
  if (!height) return undefined;
  return fill && width ? Math.min(height, (width * 9) / 16) : height;
}
