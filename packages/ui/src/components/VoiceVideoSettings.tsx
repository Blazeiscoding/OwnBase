import { useEffect, useId, useRef, useState } from "react";
import {
  cameraConstraints,
  canChooseSpeaker,
  captureFailure,
  type CaptureKind,
  type MediaDeviceOption,
} from "@slackoss/client-core";
import { useClient } from "../context.js";
import { microphoneOf, useCallPreferences, type CallDevices } from "../lib/callPreferences.js";
import { chooseDevices, useMediaDevices, useSpeaker } from "../lib/mediaDevices.js";
import { useSaved } from "../lib/savedNote.js";
import { inputCls } from "./Dialog.js";
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
    hint: "Your browser's own: takes out steady sound such as fans and hum.",
    patch: { noiseSuppression: true, noiseFilter: false },
  },
  {
    level: "off",
    label: "Off",
    hint: "Sends your microphone as it is, for music or a microphone that cleans up its own sound.",
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
 * a huddle in progress at once. Untitled where the page around it already
 * names it.
 */
export function VoiceVideoSettings({ titled = true }: { titled?: boolean } = {}) {
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
    <section aria-labelledby={titled ? "account-calls-title" : undefined} className="space-y-6">
      {titled && (
        <h3 id="account-calls-title" className="font-semibold">
          Voice &amp; video
        </h3>
      )}

      {devices.listed && !devices.named && (
        <div className="rounded-lg border border-edge p-3 text-sm text-ink-dim">
          <p>Your browser keeps devices' names back until it is allowed to use one.</p>
          <button
            type="button"
            className={buttonClass("secondary", "mt-2")}
            onClick={() => void revealNames(devices.refresh)}
          >
            Show device names
          </button>
        </div>
      )}

      <div className="space-y-1">
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
        <div className="space-y-1">
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

      <fieldset className="space-y-3">
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

      <fieldset className="space-y-3">
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

      <div className="space-y-1">
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
        <label className="mt-2 flex items-center gap-2 text-sm">
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

      <p className="text-sm text-ink-dim">
        These apply to huddles in every workspace on this device, and to a huddle you are in now.
      </p>
      {calls.saving && (
        <p role="status" className="text-sm text-ink-dim">
          Saving preference…
        </p>
      )}
      {calls.error && (
        <p role="alert" className="text-sm text-alert">
          {calls.error}
        </p>
      )}
      {calls.unreadable && (
        <button
          type="button"
          disabled={!calls.loaded || calls.saving}
          onClick={() => void calls.retryLoad()}
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

  useEffect(() => {
    if (!on) return;
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
        if (video.current) video.current.srcObject = opened;
        setState("showing");
        onOpened();
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
      if (video.current) video.current.srcObject = null;
    };
    // A fresh `onOpened` is no reason to open the camera again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
