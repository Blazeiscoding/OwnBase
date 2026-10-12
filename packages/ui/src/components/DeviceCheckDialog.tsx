import { useEffect, useId, useRef, useState } from "react";
import { Button } from "./Button.js";
import { Dialog } from "./Dialog.js";
import { MicrophoneCheck } from "./MicrophoneCheck.js";
import { CameraPreview, DeviceSelect } from "./VoiceVideoSettings.js";
import { microphoneOf, useCallPreferences } from "../lib/callPreferences.js";
import { useMediaDevices } from "../lib/mediaDevices.js";

/**
 * Asked once on this device, before the first huddle with more than one
 * microphone or camera to choose from: which of each to use, heard and seen
 * here before anyone else does. Joining keeps the choice for every later
 * call, and Voice & video settings change it; Cancel joins nothing and asks
 * again next time. Nothing is sent until the huddle starts, and the camera
 * stays off when it does.
 */
export function DeviceCheckDialog() {
  const calls = useCallPreferences();
  const devices = useMediaDevices();
  const [microphoneId, setMicrophoneId] = useState(calls.devices.microphoneId);
  const [cameraId, setCameraId] = useState(calls.devices.cameraId);
  const descriptionId = useId();
  const { finishDeviceCheck } = calls;

  // Closed by the workspace going rather than by an answer, the join waiting
  // on it is called off. React mounts this twice in development, so only one
  // still gone a moment later counts; one that answered leaves any question
  // asked since alone.
  const mounted = useRef(false);
  const answered = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setTimeout(() => {
        if (!mounted.current && !answered.current) finishDeviceCheck(null);
      });
    };
  }, [finishDeviceCheck]);
  const finish = (choice: Parameters<typeof finishDeviceCheck>[0]) => {
    answered.current = true;
    finishDeviceCheck(choice);
  };

  return (
    <Dialog
      title="Choose your microphone and camera"
      onClose={() => finish(null)}
      width={devices.cameras.length > 0 ? 680 : 440}
      describedBy={descriptionId}
    >
      <p id={descriptionId} className="text-sm text-ink-dim">
        You have more than one to choose from. Pick the ones huddles use; you can change them any
        time in Voice &amp; video settings.
      </p>

      {/* Side by side, so Join stays in sight without scrolling. */}
      <div className={`mt-5 grid gap-6 ${devices.cameras.length > 0 ? "sm:grid-cols-2" : ""}`}>
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-semibold">Microphone</h3>
          <DeviceSelect
            label="Microphone"
            options={devices.microphones}
            value={microphoneId}
            systemDefault={devices.defaultMicrophone}
            disabled={false}
            onChange={setMicrophoneId}
          />
          <MicrophoneCheck
            settings={microphoneOf({ ...calls.devices, microphoneId })}
            speakerId={calls.devices.speakerId ?? ""}
            onOpened={devices.refresh}
            autoStart
          />
        </div>

        {devices.cameras.length > 0 && (
          <div className="min-w-0 space-y-1">
            <h3 className="text-sm font-semibold">Camera</h3>
            <DeviceSelect
              label="Camera"
              options={devices.cameras}
              value={cameraId}
              disabled={false}
              onChange={setCameraId}
            />
            <CameraPreview cameraId={cameraId} onOpened={devices.refresh} autoStart />
            <p className="text-xs text-ink-dim">
              Only you see this. In the huddle your camera stays off until you turn it on.
            </p>
          </div>
        )}
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Button onClick={() => finish(null)}>Cancel</Button>
        <Button variant="primary" onClick={() => finish({ microphoneId, cameraId })}>
          Join huddle
        </Button>
      </div>
    </Dialog>
  );
}
