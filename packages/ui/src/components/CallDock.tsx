import { createPortal } from "react-dom";
import { captureFailure } from "@ownbase/client-core";
import { useClient, useWorkspace } from "../context.js";
import { shortcutLabel } from "../lib/shortcuts.js";
import { Icon } from "./Icon.js";
import { useDialogOpen } from "./Modal.js";
import { useOptionalToast } from "./Toast.js";
import { Tooltip } from "./Tooltip.js";

/**
 * The call's own buttons while a dialog covers the huddle bar: microphone,
 * camera and Leave, at the foot of the window, which dialogs leave clear for it. On the
 * body and marked as part of the call, so the dialog leaves it usable and Tab
 * comes to it after the dialog's own controls (Modal.tsx).
 */
export function CallDock({ where }: { where: string }) {
  const client = useClient();
  const toast = useOptionalToast();
  const open = useDialogOpen();
  const huddle = useWorkspace((s) => s.huddle);
  if (!open || !huddle) return null;
  const toggle = (on: boolean, onCls: string) =>
    `flex size-9 shrink-0 items-center justify-center rounded-full transition-colors ${
      on ? onCls : "text-ink-dim hover:bg-ink/[0.08] hover:text-ink"
    }`;
  return createPortal(
    <div
      data-ownbase-call=""
      // Placed in theme.css, with the room it takes from dialogs.
      className="call-dock pointer-events-none fixed inset-x-0 z-[66] flex justify-center px-3"
    >
      <div
        role="group"
        aria-label={`Huddle in ${where}`}
        className="pointer-events-auto flex max-w-full animate-pop-in items-center gap-1 rounded-full border border-edge bg-raised py-1 pl-3 pr-1 shadow-lg"
      >
        <Icon name="headphones" size={16} className="shrink-0 text-online" />
        <span
          className="mx-1 min-w-0 truncate text-[13px] font-medium"
          title={`Huddle in ${where}`}
        >
          {where}
        </span>
        <Tooltip
          label={huddle.micMuted ? "Unmute" : "Mute"}
          keys={shortcutLabel("Mod+Shift+Space")}
        >
          <button
            type="button"
            aria-label="Mute microphone"
            aria-pressed={huddle.micMuted}
            onClick={() => client.toggleMic()}
            className={toggle(huddle.micMuted, "bg-alert/15 text-alert hover:bg-alert/25")}
          >
            <Icon name={huddle.micMuted ? "micOff" : "mic"} size={18} />
          </button>
        </Tooltip>
        <Tooltip label={huddle.cameraOn ? "Turn your camera off" : "Turn your camera on"}>
          <button
            type="button"
            aria-label="Camera"
            aria-pressed={huddle.cameraOn}
            onClick={() =>
              void client.toggleCamera().catch((err: unknown) => {
                // Closing the browser's own prompt says nothing, as in the bar.
                const message = captureFailure("camera", err);
                if (message) toast?.({ message, kind: "error" });
              })
            }
            className={toggle(huddle.cameraOn, "bg-ink text-ground hover:bg-ink/85")}
          >
            <Icon name="camera" size={18} />
          </button>
        </Tooltip>
        <button
          type="button"
          onClick={() => client.leaveHuddle()}
          className="ml-1 flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-alert px-3 text-[13px] font-semibold text-ground transition-colors hover:bg-alert/85"
        >
          <Icon name="leave" size={14} />
          Leave
        </button>
      </div>
    </div>,
    document.body,
  );
}
