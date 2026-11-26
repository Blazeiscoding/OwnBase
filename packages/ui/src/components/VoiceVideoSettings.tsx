import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { useStore } from "zustand";
import {
  RELEASE_DELAYS_MS,
  callKeyCombo,
  callKeyFromEvent,
  cameraConstraints,
  canChooseSpeaker,
  captureFailure,
  type CallKeyAction,
  type CaptureKind,
  type MediaDeviceOption,
} from "@ownbase/client-core";
import { useClient, usePlatform } from "../context.js";
import { isApple, modKey, shortcutLabel } from "../lib/shortcuts.js";
import { takenCallKeys } from "./CallKeys.js";
import { Kbd } from "./Kbd.js";
import { microphoneOf, useCallPreferences, type CallDevices } from "../lib/callPreferences.js";
import { chooseDevices, useMediaDevices, useSpeaker } from "../lib/mediaDevices.js";
import { useSaved } from "../lib/savedNote.js";
import { settingMark } from "../lib/accountSections.js";
import { inputCls } from "./TextField.js";
import { MicrophoneCheck } from "./MicrophoneCheck.js";
import { buttonClass } from "./Button.js";

/** How much background noise to take out, as Discord offers it. */
const NOISE = [
  {
    level: "strong",
    label: "Strong",
    hint: "Takes out typing, clicks and clatter as well as fans and hum. Uses a little more of your computer.",
    patch: { noiseSuppression: true, noiseFilter: true },
  },
  {
    level: "standard",
    label: "Standard",
    hint: "Uses your browser's built-in filter. Takes out steady sound such as fans and hum.",
    patch: { noiseSuppression: true, noiseFilter: false },
  },
  {
    level: "off",
    label: "Off",
    hint: "Sends your microphone's sound as it is. Good for music, or a microphone that removes noise itself.",
    patch: { noiseSuppression: false, noiseFilter: false },
  },
] as const;

/** Which of those is chosen; strong unless someone chose otherwise. */
function noiseLevel(devices: CallDevices): (typeof NOISE)[number]["level"] {
  if (devices.noiseSuppression === false) return "off";
  return devices.noiseFilter === false ? "standard" : "strong";
}

/** The other ways the browser can clean up a microphone's sound, on unless turned off. */
const PROCESSING = [
  {
    key: "echoCancellation",
    label: "Echo cancellation",
    hint: "Stops others hearing themselves when you use speakers rather than headphones.",
  },
  {
    key: "autoGainControl",
    label: "Automatic volume",
    hint: "Evens out your voice when you lean in or away.",
  },
] as const;

/**
 * Voice & video: which microphone, speaker and camera huddles use, how the
 * microphone's sound is cleaned up, and a way to hear and see each before a
 * call. Each choice is kept on this device for every workspace, and changes
 * a huddle in progress at once. The page around it names it.
 */
export function VoiceVideoSettings() {
  const client = useClient();
  const saved = useSaved();
  const calls = useCallPreferences();
  const devices = useMediaDevices();
  const [failure, setFailure] = useState<{ kind: CaptureKind; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const speakers = canChooseSpeaker();
  const { devices: chosen } = calls;
  const noise = noiseLevel(chosen);
  const noiseName = useId();

  async function choose(kind: CaptureKind, patch: CallDevices) {
    setBusy(true);
    setFailure(null);
    try {
      if (await chooseDevices(client, chosen, patch, calls.setDevices)) saved();
    } catch (err) {
      setFailure({
        kind,
        message: captureFailure(kind, err) ?? `That ${kind} could not start. Try again.`,
      });
    } finally {
      setBusy(false);
    }
  }

  const disabled = !calls.loaded || calls.saving || busy;
  const failed = (kind: CaptureKind) =>
    failure?.kind === kind && (
      <p role="alert" className="mt-2 text-sm text-alert">
        {failure.message}
      </p>
    );

  return (
    <section className="space-y-6">
      {devices.listed && !devices.named && (
        <div className="rounded-lg border border-edge p-3 text-sm text-ink-dim">
          <p>Your browser hides device names until you let OwnBase use your microphone.</p>
          <button
            type="button"
            className={buttonClass("secondary", "mt-2")}
            onClick={() => void revealNames(devices.refresh)}
          >
            Show device names
          </button>
        </div>
      )}

      <div {...settingMark("microphone")} className="space-y-1">
        <h4 className="text-sm font-semibold">Microphone</h4>
        <DeviceSelect
          label="Microphone"
          options={devices.microphones}
          value={chosen.microphoneId}
          systemDefault={devices.defaultMicrophone}
          disabled={disabled}
          onChange={(microphoneId) => void choose("microphone", { microphoneId })}
        />
        {failed("microphone")}
        <MicrophoneCheck
          settings={microphoneOf(chosen)}
          speakerId={chosen.speakerId ?? ""}
          onOpened={devices.refresh}
        />
      </div>

      {speakers && (
        <div {...settingMark("speaker")} className="space-y-1">
          <h4 className="text-sm font-semibold">Speaker</h4>
          <DeviceSelect
            label="Speaker"
            options={devices.speakers}
            value={chosen.speakerId}
            systemDefault={devices.defaultSpeaker}
            disabled={disabled}
            onChange={(speakerId) =>
              void calls.setDevices({ speakerId }).then((kept) => kept && saved())
            }
          />
          <SpeakerTest speakerId={chosen.speakerId ?? ""} />
        </div>
      )}

      <fieldset {...settingMark("noise-suppression")} className="space-y-3">
        <legend className="text-sm font-semibold">Noise suppression</legend>
        {NOISE.map(({ level, label, hint, patch }) => (
          <label key={level} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={noiseName}
              className="mt-1"
              checked={noise === level}
              disabled={disabled}
              onChange={() => void choose("microphone", patch)}
            />
            <span>
              {label}
              <span className="block text-xs text-ink-dim">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset {...settingMark("voice-processing")} className="space-y-3">
        <legend className="text-sm font-semibold">Voice processing</legend>
        {PROCESSING.map(({ key, label, hint }) => (
          <label key={key} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={chosen[key] ?? true}
              disabled={disabled}
              onChange={(event) => void choose("microphone", { [key]: event.target.checked })}
            />
            <span>
              {label}
              <span className="block text-xs text-ink-dim">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div {...settingMark("camera")} className="space-y-1">
        <h4 className="text-sm font-semibold">Camera</h4>
        <DeviceSelect
          label="Camera"
          options={devices.cameras}
          value={chosen.cameraId}
          disabled={disabled}
          onChange={(cameraId) => void choose("camera", { cameraId })}
        />
        {failed("camera")}
        <CameraPreview cameraId={chosen.cameraId} onOpened={devices.refresh} />
      </div>

      <div>
        <h4 className="text-sm font-semibold">Joining</h4>
        <label {...settingMark("join-muted")} className="mt-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={calls.joinMuted}
            disabled={!calls.loaded || calls.saving}
            onChange={(event) =>
              void calls.setJoinMuted(event.target.checked).then((kept) => kept && saved())
            }
          />
          Join huddles with my microphone off
        </label>
        <p className="mt-2 text-sm text-ink-dim">
          Nothing you say is sent until you turn the microphone on in the huddle.
        </p>
      </div>

      <TalkSettings />

      <p className="text-sm text-ink-dim">
        These settings apply to huddles in every workspace on this device, including a huddle you
        are in now.
      </p>
      {calls.error && (
        <p role="alert" className="text-sm text-alert">
          {calls.error}
        </p>
      )}
      {calls.unreadable && (
        <button
          type="button"
          disabled={!calls.loaded || calls.saving}
          onClick={() => void calls.retry()}
          className={buttonClass("secondary")}
        >
          Retry loading call preferences
        </button>
      )}
    </section>
  );
}

/**
 * Asks for the microphone for a moment, and lets it go: browsers give
 * devices' names only to a page that has been allowed one.
 */
async function revealNames(refresh: () => void) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
  } catch {
    // Refused: the devices keep their numbers.
  }
  refresh();
}

/**
 * One kind of device, with the system's default first. A device chosen
 * before and not connected now stays listed as such, so the choice is not
 * silently shown as another.
 */
export function DeviceSelect({
  label,
  options,
  value = "",
  systemDefault = "",
  disabled,
  onChange,
}: {
  label: string;
  options: MediaDeviceOption[];
  value?: string;
  systemDefault?: string;
  disabled: boolean;
  onChange: (id: string | undefined) => void;
}) {
  const missing = value !== "" && !options.some((option) => option.id === value);
  return (
    <label className="block text-sm">
      <span className="sr-only">{label}</span>
      <select
        className={inputCls}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        <option value="">
          {systemDefault ? `System default (${systemDefault})` : "System default"}
        </option>
        {missing && <option value={value}>A {label.toLowerCase()} that is not connected</option>}
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Two short notes through the chosen speaker, to hear that it is the right one. */
function SpeakerTest({ speakerId }: { speakerId: string }) {
  const sound = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  useSpeaker(sound, speakerId);

  async function play() {
    const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    const element = sound.current;
    if (!Ctx || !element) {
      setFailed(true);
      return;
    }
    setPlaying(true);
    setFailed(false);
    const context = new Ctx();
    try {
      const out = context.createMediaStreamDestination();
      const gain = context.createGain();
      gain.connect(out);
      const start = context.currentTime + 0.05;
      gain.gain.setValueAtTime(0, start);
      for (const [i, frequency] of [660, 880].entries()) {
        const at = start + i * 0.22;
        const tone = context.createOscillator();
        tone.frequency.value = frequency;
        tone.connect(gain);
        gain.gain.setTargetAtTime(0.25, at, 0.01);
        gain.gain.setTargetAtTime(0, at + 0.15, 0.03);
        tone.start(at);
        tone.stop(at + 0.22);
      }
      element.srcObject = out.stream;
      await element.play();
      await new Promise((resolve) => setTimeout(resolve, 700));
    } catch {
      setFailed(true);
    } finally {
      element.srcObject = null;
      void context.close().catch(() => {});
      setPlaying(false);
    }
  }

  return (
    <div className="mt-2 space-y-2">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a test tone, with no words to caption */}
      <audio ref={sound} hidden />
      <button
        type="button"
        className={buttonClass("secondary")}
        disabled={playing}
        onClick={() => void play()}
      >
        {playing ? "Playing…" : "Play test sound"}
      </button>
      {failed && (
        <p role="alert" className="text-sm text-alert">
          The test sound could not play.
        </p>
      )}
    </div>
  );
}

/**
 * The chosen camera's picture, as others would see it but mirrored like a
 * mirror; `autoStart` shows it at once rather than waiting to be asked.
 */
export function CameraPreview({
  cameraId,
  onOpened,
  autoStart = false,
}: {
  cameraId?: string;
  onOpened: () => void;
  autoStart?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(autoStart);
  const [state, setState] = useState<"idle" | "starting" | "showing">("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const descriptionId = useId();

  const told = useEffectEvent(() => onOpened());
  useEffect(() => {
    if (!on) return;
    // The video is shown while on, so it is there when this runs.
    const element = video.current;
    let alive = true;
    let stream: MediaStream | null = null;
    setState("starting");
    setFailure(null);
    navigator.mediaDevices
      .getUserMedia(cameraConstraints(cameraId))
      .then((opened) => {
        if (!alive) {
          opened.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = opened;
        if (element) element.srcObject = opened;
        setState("showing");
        told();
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setOn(false);
        setState("idle");
        setFailure(captureFailure("camera", err) ?? "Your camera could not start.");
      });
    return () => {
      alive = false;
      stream?.getTracks().forEach((track) => track.stop());
      if (element) element.srcObject = null;
    };
  }, [on, cameraId]);

  return (
    <div className="mt-2 space-y-2">
      {on && (
        <div className="aspect-video w-full max-w-sm overflow-hidden rounded-lg bg-black">
          <video
            ref={video}
            autoPlay
            playsInline
            muted
            aria-describedby={descriptionId}
            className="size-full -scale-x-100 object-cover"
          />
        </div>
      )}
      <p id={descriptionId} className="sr-only">
        Your camera's picture, shown only to you.
      </p>
      <button
        type="button"
        className={buttonClass("secondary")}
        disabled={state === "starting"}
        onClick={() => {
          setOn(!on);
          if (on) setState("idle");
        }}
      >
        {state === "starting" ? "Opening the camera…" : on ? "Stop preview" : "Preview camera"}
      </button>
      {failure && (
        <p role="alert" className="text-sm text-alert">
          {failure}
        </p>
      )}
    </div>
  );
}

/** What each call key does, as the settings and their notes name it. */
const KEY_ROWS: { action: CallKeyAction; label: string }[] = [
  { action: "mute", label: "Mute or unmute" },
  { action: "deafen", label: "Deafen or undeafen" },
  { action: "talk", label: "Push to talk" },
];

/**
 * How the microphone goes on (K16): whenever you talk, or only while a key is
 * held, Discord's Voice activity and Push to talk; and the keys for mute,
 * deafen and push to talk, with where they work.
 */
function TalkSettings() {
  const saved = useSaved();
  const platform = usePlatform();
  const calls = useCallPreferences();
  const taken = useStore(takenCallKeys, (s) => s.taken);
  const modeName = useId();
  const delayId = useId();
  const { talk, keys } = calls;
  const kept = (done: Promise<boolean>) => void done.then((ok) => ok && saved());
  const label = (combo: string) => shortcutLabel(callKeyCombo(combo));
  const desktop = !!platform.callKeys;

  return (
    <>
      <fieldset {...settingMark("push-to-talk")} className="space-y-3">
        <legend className="text-sm font-semibold">Talking</legend>
        {(
          [
            {
              mode: "voice",
              label: "Voice activity",
              hint: "Your microphone sends whenever you talk, unless you mute it.",
            },
            {
              mode: "push",
              label: "Push to talk",
              hint: `Your microphone sends only while you hold ${label(keys.talk)}, or the Hold to talk button in the huddle.`,
            },
          ] as const
        ).map(({ mode, label: name, hint }) => (
          <label key={mode} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={modeName}
              className="mt-1"
              checked={talk.mode === mode}
              disabled={!calls.loaded}
              onChange={() => kept(calls.setTalk({ mode }))}
            />
            <span>
              {name}
              <span className="block text-xs text-ink-dim">{hint}</span>
            </span>
          </label>
        ))}
        {talk.mode === "push" && (
          <div className="space-y-1 pl-6">
            <label htmlFor={delayId} className="block text-sm">
              Release delay
            </label>
            <select
              id={delayId}
              className={inputCls}
              value={talk.releaseMs}
              disabled={!calls.loaded}
              aria-describedby={`${delayId}-hint`}
              onChange={(event) => kept(calls.setTalk({ releaseMs: Number(event.target.value) }))}
            >
              {RELEASE_DELAYS_MS.map((ms) => (
                <option key={ms} value={ms}>
                  {ms === 0 ? "None" : ms < 1000 ? `${ms} ms` : `${ms / 1000} second`}
                </option>
              ))}
            </select>
            <p id={`${delayId}-hint`} className="text-xs text-ink-dim">
              How long your microphone stays on after you let go, so the end of your last word still
              goes.
            </p>
          </div>
        )}
      </fieldset>

      <div {...settingMark("call-keys")} className="space-y-3">
        <h4 className="text-sm font-semibold">Call keys</h4>
        <ul className="space-y-3">
          {KEY_ROWS.map(({ action, label: name }) => (
            <li key={action}>
              <CallKeyPicker
                label={name}
                value={keys[action]}
                usedBy={(combo) =>
                  KEY_ROWS.find((row) => row.action !== action && keys[row.action] === combo)?.label
                }
                onChange={(combo) => kept(calls.setKeys({ [action]: combo }))}
              />
              {desktop && taken.includes(keys[action]) && (
                <p role="status" className="mt-1 text-xs text-alert">
                  Another app is using {label(keys[action])}, so it works only while OwnBase is in
                  front. Choose another key to use it from other apps.
                </p>
              )}
            </li>
          ))}
        </ul>
        <p className="text-sm text-ink-dim">
          {desktop
            ? "In a huddle, these keys work from any app, a game included. With OwnBase in front, hold the push-to-talk key to talk. With another app in front, OwnBase cannot tell when you let go, so press it once to start talking and again to stop."
            : "These keys work only while this tab is in front. The OwnBase desktop app can use them from any app."}
        </p>
      </div>
    </>
  );
}

/**
 * One call key: what it is now, and Change, which takes the next keys
 * pressed. Escape keeps the key as it was.
 */
function CallKeyPicker({
  label,
  value,
  usedBy,
  onChange,
}: {
  label: string;
  value: string;
  /** What another call key with these keys does, if one has them. */
  usedBy: (combo: string) => string | undefined;
  onChange: (combo: string) => void;
}) {
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const problemId = useId();

  useEffect(() => {
    if (!listening) return;
    // Ahead of everything else, so the keys being chosen do not mute, deafen
    // or run one of the app's own shortcuts on the way.
    const take = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        setListening(false);
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type !== "keydown" || ["Control", "Meta", "Alt", "Shift"].includes(event.key))
        return;
      if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        setListening(false);
        return;
      }
      const combo = callKeyFromEvent(event);
      if (!combo) {
        setProblem(
          `Hold ${modKey()} or ${isApple() ? "⌥" : "Alt"} with the key, or use a function key such as F9, so typing never sets it off.`,
        );
        return;
      }
      const other = usedBy(combo);
      if (other) {
        setProblem(
          `${shortcutLabel(callKeyCombo(combo))} is already the key for ${other.toLowerCase()}. Choose another.`,
        );
        return;
      }
      setProblem(null);
      setListening(false);
      onChange(combo);
    };
    window.addEventListener("keydown", take, true);
    window.addEventListener("keyup", take, true);
    return () => {
      window.removeEventListener("keydown", take, true);
      window.removeEventListener("keyup", take, true);
    };
  }, [listening, usedBy, onChange]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <span className="min-w-36">{label}</span>
        <span className="flex items-center gap-1" aria-hidden={listening}>
          {shortcutLabel(callKeyCombo(value))
            .split(" ")
            .map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
        </span>
        <button
          type="button"
          aria-label={
            listening
              ? `Press the new keys for ${label.toLowerCase()}`
              : `Change the key for ${label.toLowerCase()}`
          }
          aria-describedby={problem ? problemId : undefined}
          className={buttonClass("secondary")}
          onClick={() => {
            setProblem(null);
            setListening((on) => !on);
          }}
          onBlur={() => setListening(false)}
        >
          {listening ? "Press keys…" : "Change"}
        </button>
      </div>
      {problem && (
        <p id={problemId} role="alert" className="mt-1 text-xs text-alert">
          {problem}
        </p>
      )}
    </div>
  );
}
