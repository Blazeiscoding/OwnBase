import { normalizeServerUrl } from "@slackoss/client-core";

export {
  DEEP_LINK_PROTOCOL,
  DEEP_LINK_PROTOCOLS,
  OWNBASE_DEEP_LINK_PROTOCOL,
} from "@slackoss/protocol";

/** normalizeServerUrl, but null instead of throwing on junk input. */
export function normalizeServerUrlSafe(input: string): string | null {
  try {
    return normalizeServerUrl(input);
  } catch {
    return null;
  }
}
