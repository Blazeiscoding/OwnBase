import { refusalReason, type ApiError } from "@ownbase/client-core";

/** What did not happen, and why when that is known; `otherwise` when it is not. */
export function failureText(failure: string, error: ApiError, otherwise?: string): string {
  const why = refusalReason(error) ?? otherwise;
  return why ? `${failure} ${why}` : failure;
}
