import { normalizeServerUrl } from "@ownbase/client-core";

export { DEEP_LINK_PROTOCOL } from "@ownbase/protocol";

/** normalizeServerUrl, but null instead of throwing on junk input. */
export function normalizeServerUrlSafe(input: string): string | null {
  try {
    return normalizeServerUrl(input);
  } catch {
    return null;
  }
}
