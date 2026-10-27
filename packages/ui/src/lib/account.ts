import { ApiError } from "@ownbase/client-core";

export function accountError(error: unknown): string {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      invalid_credentials: "Your current password was not accepted.",
      credentials_changed: "Your password changed while this request was running. Sign in again.",
      unauthorized: "Your session has ended. Sign in again to continue.",
      auth_busy: "The workspace is handling other sign-ins. Try again in a moment.",
      invalid_request: "Check the fields. Passwords must contain 8 to 256 characters.",
      session_not_found: "That device is already signed out. Refresh the list.",
      admin_only: "You no longer have permission to manage accounts.",
      owner_only: "Only the current workspace owner can transfer ownership.",
      owner_is_protected: "An administrator cannot reset the owner's password.",
      admins_are_equals: "Only the owner can reset another administrator's password.",
      user_not_found: "That account is no longer available.",
      invalid_owner: "Choose an active person to own the workspace.",
      cannot_reset_self: "Use Account settings to change your own password.",
      bots_have_no_password: "App accounts do not use passwords.",
      invalid_two_step_code:
        "That code is not right. Enter the one your authenticator app shows now.",
      two_step_setup_expired: "Setting up took too long. Start again.",
      two_step_on: "Two-step sign-in is already on.",
      two_step_off: "Two-step sign-in was already off.",
      too_many_requests: "Too many tries for now. Wait a minute, then try again.",
    };
    return (
      messages[error.code] ?? "The workspace could not complete this change. Refresh and try again."
    );
  }
  return "The workspace did not confirm the change. Check your connection and refresh before trying again.";
}

export function deviceLabel(agent: string): string {
  const browser = /Electron/i.test(agent)
    ? "OwnBase desktop"
    : /Edg\//.test(agent)
      ? "Edge"
      : /Firefox\//.test(agent)
        ? "Firefox"
        : /(?:Chrome|CriOS)\//.test(agent)
          ? "Chrome"
          : /Safari\//.test(agent)
            ? "Safari"
            : "Other client";
  const system = /Android/.test(agent)
    ? "Android"
    : /iPhone|iPad/.test(agent)
      ? "iOS"
      : /Windows/.test(agent)
        ? "Windows"
        : /Macintosh|Mac OS/.test(agent)
          ? "macOS"
          : /Linux/.test(agent)
            ? "Linux"
            : null;
  return system ? `${browser} · ${system}` : browser;
}
