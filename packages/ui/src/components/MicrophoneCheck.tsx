import { useContext, useEffect, useRef, useState } from "react";
import {
  captureFailure,
  testMicrophone,
  wantsNoiseFilter,
  type MicrophoneSettings,
  type MicrophoneTest,
} from "@ownbase/client-core";
import { PlatformContext } from "../context.js";
import { useSpeaker } from "../lib/mediaDevices.js";
import { noiseFilter } from "../lib/noiseFilter.js";
import { systemMicrophoneOpener } from "../lib/systemMicrophone.js";
import { buttonClass } from "./Button.js";

type Check =
  | { phase: "idle" }
  | { phase: "starting" }
  | {
      phase: "listening";
      label: string;
      metered: boolean;
      filtered: boolean;
      system: boolean;
      level: number;
    }
  | { phase: "failed"; message: string };

/**
 * Hearing whether the microphone works before a huddle (CALL-01): which one
 * the browser opened, a meter that moves when someone speaks, and their own
 * voice played back if they ask. It opens the microphone and processing
 * chosen in settings, and opens it again when they change. Nothing is sent
 * anywhere, and the microphone closes when the check stops or the settings
 * close.
 */
export function MicrophoneCheck({
  settings = {},
  speakerId = "",
  onOpened,
  autoStart = false,
}: {
  settings?: MicrophoneSettings;
  /** Where to play the voice back; "" for the system's default. */
  speakerId?: string;
  /** Told once a microphone opens, as the browser then gives devices' names. */
  onOpened?: () => void;
  /** Listens at once rather than waiting to be asked. */
  autoStart?: boolean;
}) {
  // Read without insisting: the check also stands alone, as in the gallery.
  const platform = useContext(PlatformContext);
  const [check, setCheck] = useState<Check>({ phase: "idle" });
  const [playback, setPlayback] = useState(false);
  const test = useRef<MicrophoneTest | null>(null);
  const alive = useRef(true);
  const attempt = useRef(0);
  const echo = useRef<HTMLAudioElement>(null);
  useSpeaker(echo, speakerId);

  useEffect(() => {
    alive.current = true;
    if (autoStart) void start();
    return () => {
      alive.current = false;
      attempt.current++;
      test.current?.stop();
      test.current = null;
    };
    // Only on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    const mine = ++attempt.current;
    test.current?.stop();
    test.current = null;
    setCheck({ phase: "starting" });
    try {
      const opened = await testMicrophone(
        (level) => {
          if (alive.current && attempt.current === mine)
            setCheck((now) => (now.phase === "listening" ? { ...now, level } : now));
        },
        settings,
        noiseFilter,
        systemMicrophoneOpener(platform),
      );
      if (!alive.current || attempt.current !== mine) {
        opened.stop();
        return;
      }
      test.current = opened;
      if (echo.current) echo.current.srcObject = opened.stream;
      setCheck({
        phase: "listening",
        label: opened.label,
        metered: opened.metered,
        filtered: opened.filtered,
        system: opened.system,
        level: 0,
      });
      onOpened?.();
    } catch (err) {
      if (alive.current && attempt.current === mine)
        setCheck({
          phase: "failed",
          message: captureFailure("microphone", err) ?? "Your microphone could not start.",
        });
    }
  }

  function stop() {
    attempt.current++;
    test.current?.stop();
    test.current = null;
    if (echo.current) echo.current.srcObject = null;
    setCheck({ phase: "idle" });
  }

  // Another microphone, or other processing, is a different thing to hear:
  // open that one in place of the one being heard.
  const chosen = JSON.stringify(settings);
  const heard = useRef(chosen);
  useEffect(() => {
    if (heard.current === chosen) return;
    heard.current = chosen;
    if (test.current) void start();
    // Only a change of choice restarts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen]);

  useEffect(() => {
    const element = echo.current;
    if (!element) return;
    element.muted = !playback;
    if (playback) void Promise.resolve(element.play?.()).catch(() => {});
  }, [playback, check.phase]);

  // A peak of half the range already reads as speaking loudly.
  const percent = check.phase === "listening" ? Math.min(100, Math.round(check.level * 200)) : 0;
  return (
    <div className="mt-4 space-y-2">
      <audio ref={echo} autoPlay muted hidden />
      {check.phase === "listening" ? (
        <>
          <p className="text-sm">
            Listening to {check.label ? <strong>{check.label}</strong> : "your default microphone"}.
            {check.metered
              ? " Say something: the bar should move."
              : " It opened, but this browser cannot show how loud it is."}{" "}
            Nothing is sent to anyone.
          </p>
          {check.system && (
            <p className="text-sm text-ink-dim">
              OwnBase hears it as other apps on this computer do, with any sound effects set up in
              Windows.
            </p>
          )}
          {wantsNoiseFilter(settings) && !check.filtered && (
            <p className="text-sm text-ink-dim">
              Strong noise suppression could not start here, so this is your browser's own. A huddle
              does the same.
            </p>
          )}
          {check.metered && (
            <div
              role="meter"
              aria-label="Microphone level"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-2 w-full overflow-hidden rounded bg-lifted"
            >
              <div className="h-full bg-online" style={{ width: `${percent}%` }} />
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={playback}
              onChange={(event) => setPlayback(event.target.checked)}
            />
            Play my voice back to me
          </label>
          {playback && (
            <p className="text-xs text-ink-dim">
              Use headphones, or the speakers feed back into the microphone.
            </p>
          )}
          <button type="button" className={buttonClass("secondary")} onClick={stop}>
            Stop test
          </button>
        </>
      ) : (
        <button
          type="button"
          className={buttonClass("secondary")}
          disabled={check.phase === "starting"}
          onClick={() => void start()}
        >
          {check.phase === "starting" ? "Opening the microphone…" : "Test microphone"}
        </button>
      )}
      {check.phase === "failed" && (
        <p role="alert" className="text-sm text-alert">
          {check.message}
        </p>
      )}
    </div>
  );
}
