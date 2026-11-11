import { ApiError } from "./transport.js";

/**
 * A failure as the error a caller can describe: the server's, a request this
 * client stopped, or one for no answer.
 */
export function failureOf(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof DOMException && error.name === "AbortError")
    return new ApiError(0, "aborted", error.message);
  return new ApiError(0, "network_error", error instanceof Error ? error.message : undefined);
}

/** What the server answered, or why there was no answer. */
export async function answerOf<T>(request: () => Promise<T>): Promise<T | ApiError> {
  try {
    return await request();
  } catch (error) {
    return failureOf(error);
  }
}

/** Null once the server has done it; why it did not otherwise. */
export async function doneOf(request: () => Promise<unknown>): Promise<ApiError | null> {
  try {
    await request();
    return null;
  } catch (error) {
    return failureOf(error);
  }
}

/** Why a request was not sent: this client has no session or snapshot yet to send it with. */
export function notConnected(): ApiError {
  return new ApiError(0, "not_connected", "Not connected to the workspace yet.");
}

/**
 * Why something did not happen, as a sentence to show after saying what did
 * not; null when nothing is known. A refusal often carries only a code
 * ("not_found") as its message, which is no sentence to show.
 */
export function refusalReason(error: ApiError): string | null {
  if (error.code === "network_error") return "Check your connection and try again.";
  if (error.code === "too_many_requests") return "Wait a moment, then try again.";
  if (error.status >= 500)
    return "The workspace's server ran into a problem. Try again in a moment.";
  const text = error.message === error.code ? "" : error.message.trim();
  if (!/\s/.test(text)) return null;
  return text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? "" : ".");
}

/** Why the workspace would not take a file, as a sentence; null for any other refusal. */
export function fileRefusal(error: ApiError): string | null {
  if (error.code === "storage_quota_exceeded") return "The workspace has no room left for files.";
  if (error.code === "file_too_large") return "A file is over this workspace's size limit.";
  return null;
}
