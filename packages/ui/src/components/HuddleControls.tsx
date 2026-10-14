import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { canChooseSpeaker, captureFailure, type MediaDeviceOption } from "@slackoss/client-core";
import { useClient, usePlatform, useWorkspace } from "../context.js";
import { useCallPreferences, type CallDevices } from "../lib/callPreferences.js";
import { chooseDevices, useMediaDevices } from "../lib/mediaDevices.js";
import { Icon } from "./Icon.js";
import { Menu, type MenuItem } from "./Menu.js";
import { Swap } from "./Motion.js";
import { ScreenShareDialog } from "./ScreenShareDialog.js";
import { Tooltip } from "./Tooltip.js";

/**
 * Whether the desktop app's screen picker is open. The bar's controls show
 * it. The controls in full screen leave full screen to open it, since a
 * dialog does not show over full screen, and they go away as it ends.
 */
const picker = createStore(() => ({ open: false }));

/** The system's default and then each device, the chosen one ticked. */
function deviceItems(
  kind: string,
  section: string,
  options: MediaDeviceOption[],
  chosen: string | undefined,
  systemDefault: string,
  onChoose: (id: string | undefined) => void,
): MenuItem[] {
  return [
    {
      id: `${kind}-default`,
      label: systemDefault ? `System default (${systemDefault})` : "System default",
      section,
      checked: !chosen,
      onSelect: () => onChoose(undefined),
    },
    ...options.map((option) => ({
      id: `${kind}-${option.id}`,
      label: option.label,
      checked: option.id === chosen,
      onSelect: () => onChoose(option.id),
    })),
  ];
}

/**
 * The small arrow beside the microphone and camera: which device the call
 * uses, changed without leaving it, and the way to the rest of Voice & video.
 */
function DeviceMenu({
  label,
  items,
  disabled,
}: {
  label: string;
  items: MenuItem[];
  disabled?: boolean;
}) {
  return (
    <Menu
      label={label}
      items={items}
      disabled={disabled}
      tooltip={label}
      align="start"
      width={320}
      triggerContent={
        <>
          <Icon name="chevronUp" size={14} />
          <span className="sr-only">{label}</span>
        </>
      }
      triggerClassName="-ml-1.5 flex h-10 w-6 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink disabled:opacity-40"
    />
  );
}

/**
 * Microphone, camera, screen and Leave. The huddle bar shows them, and so does
 * the stage in full screen, where the bar is out of sight.
 *
 * A toggle names what it controls, and aria-pressed, not the name, says whether
 * it is on: a screen reader hears the same button before and after a press.
 */
export function HuddleControls({
  overlay = false,
  onOpenSettings,
}: {
  overlay?: boolean;
  /** Opens Voice & video settings, from the device menus. */
  onOpenSettings?: () => void;
}) {
  const client = useClient();
  const platform = usePlatform();
  const huddle = useWorkspace((s) => s.huddle);
  const calls = useCallPreferences();
  const devices = useMediaDevices();
  const [busy, setBusy] = useState<"screen" | "camera" | "microphone" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const choosingScreen = useStore(picker, (s) => s.open);
  // The picker goes with the huddle, and does not open again with the next one.
  useEffect(() => {
    if (overlay) return;
    return () => picker.setState({ open: false });
  }, [overlay]);
  if (!huddle) return null;

  /**
   * A closed picker says nothing. A blocked permission, a missing device or a
   * page that cannot ask says what to do about it, where it used to say
   * nothing either (CALL-01).
   */
  const guarded = async (which: "screen" | "camera" | "microphone", run: () => Promise<void>) => {
    setBusy(which);
    setFailure(null);
    try {
      await run();
    } catch (err) {
      setFailure(captureFailure(which, err));
    } finally {
      setBusy(null);
    }
  };

  const off = overlay
    ? "border-white/15 bg-black/45 text-white hover:bg-black/65"
    : "border-edge text-ink-dim hover:border-ink-faint hover:text-ink";
  const toggleCls = (on: boolean, onCls: string) =>
    `flex size-10 items-center justify-center rounded-full border transition-colors disabled:opacity-50 ${
      on ? onCls : off
    }`;
  const lit = overlay
    ? "border-transparent bg-white/90 text-black"
    : "border-transparent bg-ink text-ground";

  const shareScreen = () => {
    // A browser shows its own picker, and stopping needs none.
    if (huddle.sharingScreen || !platform.screenShare) {
      void guarded("screen", () => client.toggleScreenShare());
      return;
    }
    setFailure(null);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    picker.setState({ open: true });
  };

  const choose = (kind: "microphone" | "camera", patch: CallDevices) =>
    void guarded(kind, () => chooseDevices(client, calls.devices, patch, calls.setDevices));
  const settings: MenuItem[] = onOpenSettings
    ? [
        {
          id: "settings",
          label: "Voice & video settings",
          icon: "settings",
          section: true,
          onSelect: onOpenSettings,
        },
      ]
    : [];
  const pickerDisabled = busy !== null || !calls.loaded || calls.saving;
  // Full screen shows only what is inside the stage, and menus open on the
  // page beneath it, so devices are changed from the bar.
  const micMenu = !overlay && (
    <DeviceMenu
      label="Microphone and speaker"
      disabled={pickerDisabled}
      items={[
        ...deviceItems(
          "mic",
          "Microphone",
          devices.microphones,
          calls.devices.microphoneId,
          devices.defaultMicrophone,
          (microphoneId) => choose("microphone", { microphoneId }),
        ),
        ...(canChooseSpeaker()
          ? deviceItems(
              "speaker",
              "Speaker",
              devices.speakers,
              calls.devices.speakerId,
              devices.defaultSpeaker,
              (speakerId) => void calls.setDevices({ speakerId }),
            )
          : []),
        ...settings,
      ]}
    />
  );
  const cameraMenu = !overlay && (
    <DeviceMenu
      label="Camera options"
      disabled={pickerDisabled}
      items={[
        ...deviceItems(
          "camera",
          "Camera",
          devices.cameras,
          calls.devices.cameraId,
          "",
          (cameraId) => choose("camera", { cameraId }),
        ),
        ...settings,
      ]}
    />
  );

  return (
    <>
      <div
        role="group"
        aria-label="Huddle controls"
        className={`flex shrink-0 items-center gap-2 ${
          overlay ? "rounded-2xl bg-black/35 p-2 backdrop-blur" : "ml-auto"
        }`}
      >
        <Tooltip label={huddle.micMuted ? "Unmute" : "Mute"}>
          <button
            aria-label="Mute microphone"
            aria-pressed={huddle.micMuted}
            onClick={() => client.toggleMic()}
            className={toggleCls(
              huddle.micMuted,
              overlay ? "border-alert bg-black/45 text-alert" : "border-alert text-alert",
            )}
          >
            <Swap on={huddle.micMuted}>
              <Icon name={huddle.micMuted ? "micOff" : "mic"} />
            </Swap>
          </button>
        </Tooltip>
        {micMenu}
        <Tooltip label={huddle.cameraOn ? "Turn your camera off" : "Turn your camera on"}>
          <button
            aria-label="Camera"
            aria-pressed={huddle.cameraOn}
            onClick={() => void guarded("camera", () => client.toggleCamera())}
            disabled={busy !== null}
            className={toggleCls(huddle.cameraOn, lit)}
          >
            <Icon name="camera" />
          </button>
        </Tooltip>
        {cameraMenu}
        <Tooltip label={huddle.sharingScreen ? "Stop sharing" : "Share your screen"}>
          <button
            aria-label="Share screen"
            aria-pressed={huddle.sharingScreen}
            onClick={shareScreen}
            disabled={busy !== null}
            className={toggleCls(huddle.sharingScreen, lit)}
          >
            <Icon name="screen" />
          </button>
        </Tooltip>
        {/* Leave keeps its word: an arrow out of a door reads as signing out just as easily. */}
        <button
          onClick={() => client.leaveHuddle()}
          className="flex h-10 items-center gap-2 rounded-full border border-alert/40 px-4 text-sm font-semibold text-alert transition-colors hover:bg-alert hover:text-ground"
        >
          <Icon name="leave" size={16} />
          Leave
        </button>
      </div>
      {huddle.micLost && (
        <p
          role="alert"
          className={`flex basis-full items-center justify-end gap-3 text-xs ${
            overlay ? "mt-2 rounded-lg bg-black/60 px-3 py-2 text-white" : "text-alert"
          }`}
        >
          <span>
            Your microphone stopped, so nobody can hear you. Connect one, and it is used as soon as
            it is found.
          </span>
          <button
            type="button"
            onClick={() => client.retryMicrophone()}
            className="shrink-0 rounded-lg border border-current px-2 py-1 font-medium"
          >
            Try again
          </button>
        </p>
      )}
      {choosingScreen && !overlay && (
        <ScreenShareDialog onClose={() => picker.setState({ open: false })} />
      )}
      {failure && (
        <p
          role="alert"
          className={`flex basis-full items-start justify-end gap-2 text-xs ${
            overlay ? "mt-2 rounded-lg bg-black/60 px-3 py-2 text-white" : "text-alert"
          }`}
        >
          <span>{failure}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setFailure(null)}
            className="shrink-0 opacity-70 hover:opacity-100"
          >
            <Icon name="close" size={12} />
          </button>
        </p>
      )}
    </>
  );
}
