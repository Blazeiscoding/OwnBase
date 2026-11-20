import type { ScreenShareQuality } from "./devices.js";

/** What to ask a screen's capture for, at a quality: no taller or quicker than it. */
export function shareVideo(quality: ScreenShareQuality): MediaTrackConstraints {
  return {
    width: { max: (quality.height * 16) / 9 },
    height: { max: quality.height },
    frameRate: { ideal: quality.frameRate, max: quality.frameRate },
  };
}

/** Text stays sharp as detail; sixty frames a second is asked for motion. */
export function shareHint(quality: ScreenShareQuality): string {
  return quality.frameRate === 60 ? "motion" : "detail";
}

/**
 * A share's sound as it is: no echo cancellation, noise suppression or gain,
 * which are for a voice and spoil music. `restrictOwnAudio` leaves this
 * call's own sound out, so nobody hears themselves again a moment later.
 */
export const SCREEN_SOUND = {
  restrictOwnAudio: true,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
} as MediaTrackConstraints;

/** What Chrome's getDisplayMedia also takes, which the DOM types do not have yet. */
export interface ShareRequest extends DisplayMediaStreamOptions {
  systemAudio?: "include" | "exclude";
  windowAudio?: "exclude" | "window" | "system";
  selfBrowserSurface?: "include" | "exclude";
}

/**
 * Whether a share's sound can be asked for here with this call's own sound
 * left out of it: Chromium 141 and later. Elsewhere a share sends no sound,
 * since a screen's sound with the call in it would send everyone their own
 * voices back.
 */
export function canShareScreenSound(): boolean {
  const supported = navigator.mediaDevices?.getSupportedConstraints?.() as
    { restrictOwnAudio?: boolean } | undefined;
  return supported?.restrictOwnAudio === true;
}

/**
 * Whether the browser kept this call's own sound out of a share's: it says it
 * did, or it is another tab's sound, which never holds this page's. Checked
 * rather than trusted to the request, because sending the call back to
 * everyone in it is worse than sending no sound.
 */
export function leavesCallOut(sound: MediaStreamTrack, picture: MediaStreamTrack): boolean {
  const settings = sound.getSettings?.() as { restrictOwnAudio?: boolean } | undefined;
  if (settings?.restrictOwnAudio === true) return true;
  return picture.getSettings?.().displaySurface === "browser";
}

/** What the share's sound is encoded at, in stereo: enough for music, where a voice gets 32. */
const SCREEN_SOUND_KBPS = 96;

/**
 * A description of the call from the other side, marked to take the share's
 * sound (the fourth media section) in stereo at `SCREEN_SOUND_KBPS`. A sender
 * encodes what the receiver says it takes, and a browser says mono at a
 * voice's rate, so each side marks the other's description before using it.
 * Anything without that section, or without Opus in it, is left as it is.
 */
export function withStereoScreenSound(sdp: string): string {
  // The session part, then the microphone, camera, screen and screen sound.
  // Split before the line feed, so a CRLF's carriage return stays behind.
  const sections = sdp.split(/(?=\nm=)/);
  const sound = sections[4];
  if (!sound?.startsWith("\nm=audio ")) return sdp;
  const opus = /a=rtpmap:(\d+) opus\/48000/i.exec(sound)?.[1];
  if (!opus) return sdp;
  const wanted: Record<string, string> = {
    stereo: "1",
    "sprop-stereo": "1",
    maxaveragebitrate: String(SCREEN_SOUND_KBPS * 1000),
  };
  sections[4] = sound.replace(new RegExp(`(a=fmtp:${opus} )([^\\r\\n]*)`), (_, head, params) => {
    const kept = String(params)
      .split(";")
      .map((param) => param.trim())
      .filter((param) => param && !(param.split("=")[0]! in wanted));
    return head + [...kept, ...Object.entries(wanted).map(([k, v]) => `${k}=${v}`)].join(";");
  });
  return sections.join("");
}
