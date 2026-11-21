import { Api, ApiError } from "@ownbase/client-core";

const confirmedListeners = new Set<() => void>();

/** Calls `listener` each time this window confirms an address; returns the way to stop. */
export function onEmailConfirmed(listener: () => void): () => void {
  confirmedListeners.add(listener);
  return () => confirmedListeners.delete(listener);
}

/**
 * Opens a mailed link that confirms an email address (G10), from whichever
 * device it was clicked on: the token is all it needs. What to tell the
 * person, as a notice.
 */
export async function confirmEmailLink(
  serverUrl: string,
  token: string,
): Promise<{ message: string; ok: boolean }> {
  try {
    const { email } = await new Api(serverUrl).confirmEmail(token);
    for (const listener of confirmedListeners) listener();
    return {
      message: `Your email address ${email} is confirmed. A link to set a new password can go to it now.`,
      ok: true,
    };
  } catch (err) {
    if (err instanceof ApiError && err.code === "email_link_gone")
      return {
        message:
          "This link was already used or is too old. If your address isn't confirmed yet, send a new link from Account settings, under Security.",
        ok: false,
      };
    return { message: emailLinkError(err), ok: false };
  }
}

/** Why a mailed link did not work, in words for the person who opened it. */
export function emailLinkError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "email_link_gone":
        return "This link no longer works. It may have been used already or be too old. Ask for a new one.";
      case "email_taken":
        return "That address already belongs to another account here. Remove it from that account first, then ask for a new link.";
      case "email_off":
        return "This workspace no longer sends email. Ask an admin of the workspace instead.";
      case "too_many_requests":
        return "Too many tries for now. Wait a minute, then try again.";
      default:
        break;
    }
    if (err.message && err.message !== err.code) return err.message;
    return "The workspace's server turned that down. Try again, or ask whoever runs it.";
  }
  return "Could not reach the workspace's server. Check your connection, then try again.";
}
