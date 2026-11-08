import type { ApiError } from "@ownbase/client-core";

/**
 * What did not happen, and why when that is known; `otherwise` when it is
 * not. A refusal often carries only a code ("not_found") as its message,
 * which is no sentence to show.
 */
export function failureText(failure: string, error: ApiError, otherwise?: string): string {
  const why = reasonOf(error) ?? otherwise;
  return why ? `${failure} ${why}` : failure;
}

function reasonOf(error: ApiError): string | null {
  if (error.code === "network_error") return "Check your connection and try again.";
  if (error.code === "too_many_requests") return "Wait a moment, then try again.";
  if (error.status >= 500)
    return "The workspace's server ran into a problem. Try again in a moment.";
  const text = error.message === error.code ? "" : error.message.trim();
  if (!/\s/.test(text)) return null;
  return text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? "" : ".");
}
