import { useCallback, useEffect, useRef, useState } from "react";
import type { HuddlePeer } from "@slackoss/client-core";
import { useSpeaker } from "../lib/mediaDevices.js";
import { gainOf, screenSoundKey, type PersonVolume } from "../lib/callVolumes.js";

type PlaybackFailure = "gesture" | "failed";

function playbackFailure(error: unknown): PlaybackFailure | null {
  // Replacing a stream can interrupt play without leaving anything to recover.
  if (error instanceof DOMException && error.name === "AbortError") return null;
  return error instanceof DOMException && error.name === "NotAllowedError" ? "gesture" : "failed";
}

/** What is played: someone's voice by their id, their shared screen's sound by `screenSoundKey`. */
type PlaybackCallbacks = {
  register: (id: string, retry: (() => void) | null) => void;
  report: (id: string, failure: PlaybackFailure | null) => void;
};

/** Someone's voice made louder than it arrives, and the graph that does it. */
interface Boost {
  /** What it boosts; a boost of an earlier stream is not used for the next. */
  source: MediaStream;
  context: AudioContext;
  gain: GainNode;
  /** What the element plays in place of the source. */
  stream: MediaStream;
}

/** How long a stopped audio graph is given to start before a gesture is asked for. */
const RESUME_WAIT_MS = 500;

/**
 * Louder than someone arrives, which an element's volume cannot go: their
 * stream through a gain, into a stream the element plays instead, so the
 * chosen speaker still applies. Only while `stream` is given.
 */
function useBoost(stream: MediaStream | null, gain: number): Boost | null {
  const [boost, setBoost] = useState<Boost | null>(null);
  useEffect(() => {
    const Context = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!stream || !Context) return;
    let context: AudioContext | null = null;
    try {
      context = new Context({ latencyHint: "interactive" });
      const amp = context.createGain();
      const out = context.createMediaStreamDestination();
      context.createMediaStreamSource(stream).connect(amp).connect(out);
      setBoost({ source: stream, context, gain: amp, stream: out.stream });
    } catch {
      // Played as it arrives, which is as loud as an element goes.
      void context?.close().catch(() => {});
      return;
    }
    return () => {
      setBoost(null);
      void context?.close().catch(() => {});
    };
  }, [stream]);
  const usable = boost && boost.source === stream ? boost : null;
  useEffect(() => {
    if (!usable) return;
    // Eased, so dragging the slider does not click.
    usable.gain.gain.setTargetAtTime(gain, usable.context.currentTime, 0.02);
  }, [usable, gain]);
  return usable;
}

/** Whether a stopped graph starts, without waiting on a resume that waits for a gesture. */
async function running(context: AudioContext): Promise<boolean> {
  if (context.state === "running") return true;
  await Promise.race([
    context.resume().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, RESUME_WAIT_MS)),
  ]);
  return (context.state as AudioContextState) === "running";
}

/**
 * Attach each microphone stream even when the call has no video, and a
 * shared screen's sound beside it, each as loud as you chose: `gain` times as
 * loud as it arrives.
 */
function PeerAudio({
  id,
  stream,
  speakerId,
  gain,
  register,
  report,
}: {
  id: string;
  stream: MediaStream | null;
  speakerId: string;
  gain: number;
} & PlaybackCallbacks) {
  const ref = useRef<HTMLAudioElement>(null);
  const keeper = useRef<HTMLAudioElement>(null);
  useSpeaker(ref, speakerId);
  const boost = useBoost(gain > 1 ? stream : null, gain);
  const playing = boost?.stream ?? stream;
  useEffect(() => {
    // Up to as loud as they arrive, the element's own volume does it.
    if (ref.current) ref.current.volume = boost ? 1 : Math.min(1, Math.max(0, gain));
  }, [boost, gain]);
  useEffect(() => {
    // Chromium gives an audio graph silence from a call's stream unless an
    // element is playing that stream too: this one, muted.
    const element = keeper.current;
    if (!element || !boost) return;
    element.srcObject = boost.source;
    void Promise.resolve(element.play()).catch(() => {});
    return () => {
      element.srcObject = null;
    };
  }, [boost]);
  useEffect(() => {
    const element = ref.current;
    if (!element || !playing) return;
    let active = true;
    let attempt = 0;
    element.srcObject = playing;
    const play = () => {
      const ticket = ++attempt;
      const settled = (failure: PlaybackFailure | null) => {
        if (active && ticket === attempt) report(id, failure);
      };
      try {
        // The retry calls play directly from the button's user gesture, and
        // starts a boost's graph from it too.
        const graph = boost ? running(boost.context) : Promise.resolve(true);
        void Promise.all([Promise.resolve(element.play()), graph]).then(
          ([, started]) => settled(started ? null : "gesture"),
          (error: unknown) => settled(playbackFailure(error)),
        );
      } catch (error) {
        settled(playbackFailure(error));
      }
    };
    register(id, play);
    play();
    return () => {
      active = false;
      register(id, null);
      report(id, null);
      element.srcObject = null;
    };
  }, [playing, boost, id, register, report]);
  return (
    <>
      <audio ref={ref} autoPlay hidden />
      {boost && <audio ref={keeper} autoPlay muted hidden />}
    </>
  );
}

/** One gesture retries all blocked peers, without restarting audible streams. */
export function HuddleAudio({
  peers,
  speakerId = "",
  volumes = {},
}: {
  peers: HuddlePeer[];
  /** The speaker chosen in Voice & video settings; "" for the system's default. */
  speakerId?: string;
  /**
   * How loud you chose each person, and each one's shared screen, to be;
   * anything missing is as it arrives.
   */
  volumes?: Record<string, PersonVolume>;
}) {
  const retries = useRef(new Map<string, () => void>());
  const [blocked, setBlocked] = useState<Map<string, PlaybackFailure>>(() => new Map());
  const register = useCallback<PlaybackCallbacks["register"]>((id, retry) => {
    if (retry) retries.current.set(id, retry);
    else retries.current.delete(id);
  }, []);
  const report = useCallback<PlaybackCallbacks["report"]>((id, value) => {
    setBlocked((previous) => {
      if (previous.get(id) === (value ?? undefined)) return previous;
      const next = new Map(previous);
      if (value) next.set(id, value);
      else next.delete(id);
      return next;
    });
  }, []);
  const retry = useCallback(() => {
    for (const id of blocked.keys()) retries.current.get(id)?.();
  }, [blocked]);
  const heldBack = [...blocked.values()].includes("gesture");
  useEffect(() => {
    if (!heldBack) return;
    // A fullscreen stage can hide the bar. Its next gesture also releases
    // autoplay, while the button itself retries once in its click handler.
    const onGesture = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("[data-huddle-audio-retry]"))
        return;
      for (const [id, failure] of blocked) {
        if (failure === "gesture") retries.current.get(id)?.();
      }
    };
    document.addEventListener("pointerdown", onGesture, true);
    document.addEventListener("keydown", onGesture, true);
    return () => {
      document.removeEventListener("pointerdown", onGesture, true);
      document.removeEventListener("keydown", onGesture, true);
    };
  }, [blocked, heldBack]);
  return (
    <>
      {peers.flatMap((peer) => {
        const screen = screenSoundKey(peer.userId);
        return [
          <PeerAudio
            key={peer.userId}
            id={peer.userId}
            stream={peer.audioStream}
            speakerId={speakerId}
            gain={gainOf(volumes[peer.userId])}
            register={register}
            report={report}
          />,
          // Their share's sound, apart from their voice: its own volume, and
          // muting either leaves the other.
          peer.screenSoundStream && (
            <PeerAudio
              key={screen}
              id={screen}
              stream={peer.screenSoundStream}
              speakerId={speakerId}
              gain={gainOf(volumes[screen])}
              register={register}
              report={report}
            />
          ),
        ];
      })}
      {blocked.size > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span role={heldBack ? "alert" : "status"} className="text-xs text-ink-dim">
            {heldBack
              ? "Your browser is holding back the huddle's sound."
              : "Call audio could not start."}
          </span>
          <button
            type="button"
            data-huddle-audio-retry
            onClick={retry}
            className="h-11 rounded-xl border border-edge px-3 text-sm text-ink hover:border-ink-faint"
          >
            Turn on sound
          </button>
        </div>
      )}
    </>
  );
}
