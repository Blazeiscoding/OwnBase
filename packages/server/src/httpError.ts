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
