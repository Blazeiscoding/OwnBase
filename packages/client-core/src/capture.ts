/** What a huddle asks the device for. */
export type CaptureKind = "microphone" | "camera" | "screen";

/**
 * What to tell someone whose microphone, camera or screen share did not
 * start, in words they can act on (CALL-01). Null when nothing went wrong
 * that they need to hear about: they closed the screen picker, or the
 * camera prompt, rather than share.
 *
 * Browsers name the failure, not the reason, so the name decides. A closed
 * screen picker and a refused one are both `NotAllowedError`; Chromium adds
 * "by system" when it was the operating system that refused.
 */
export function captureFailure(
  kind: CaptureKind,
  error: unknown,
  secure = (globalThis as { isSecureContext?: boolean }).isSecureContext !== false,
): string | null {
  const name =
    typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  const detail =
    typeof error === "object" && error !== null && "message" in error ? String(error.message) : "";
  const device = kind === "microphone" ? "Microphone" : kind === "camera" ? "Camera" : "Screen";
  const start =
    kind === "microphone"
      ? "Your microphone could not start"
      : kind === "camera"
        ? "Your camera could not start"
        : "Screen sharing could not start";
  switch (name) {
    case "NotSupportedError":
      if (!secure) {
        return `${kind === "screen" ? "Screen sharing" : `${device} access`} needs the desktop app, or a workspace address that starts with https://.`;
      }
      return kind === "screen"
        ? "This browser cannot share a screen."
        : `This browser cannot use a ${kind} here.`;
    case "NotAllowedError":
    case "SecurityError":
      if (kind === "screen") {
        return /system/i.test(detail)
          ? "Your system blocked screen sharing. Allow screen recording for this app in your system's privacy settings, then try again."
          : null;
      }
      // Closing the prompt is a choice not to, except that a huddle cannot be
      // joined without a microphone.
      if (kind === "camera" && /dismiss/i.test(detail)) return null;
      return kind === "microphone"
        ? "Joining a huddle needs your microphone, and access to it is blocked. Allow it in your browser or system settings, then try again."
        : "Camera access is blocked. Allow it in your browser or system settings, then try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return kind === "screen"
        ? "There is no screen to share."
        : `No ${kind} was found. Connect one, then try again.`;
    case "NotReadableError":
    case "AbortError":
      return kind === "screen"
        ? `${start}. Try again.`
        : `${start}. Another app may be using it. Close that app, then try again.`;
    default:
      return `${start}. Try again.`;
  }
}
