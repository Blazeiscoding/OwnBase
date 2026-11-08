import type { ErrorCode } from "@ownbase/protocol";

/** A refusal a REST route answers with `{ error: code, message }` and its status. */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: ErrorCode,
    message?: string,
    /** Seconds until the same call could succeed, for a refusal that will lift. */
    public retryAfter?: number,
  ) {
    super(message ?? code);
  }
}

/**
 * Why an account still holding a password someone else chose is refused: by
 * every route not declared `whileLocked`, and by the socket, or a temporary
 * password would still hand over the whole workspace.
 */
export const PASSWORD_CHANGE_REQUIRED = "Choose a new password before using this workspace.";

export const passwordChangeRequired = () =>
  new HttpError(403, "password_change_required", PASSWORD_CHANGE_REQUIRED);
