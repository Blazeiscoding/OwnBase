import type { KeyObject } from "node:crypto";
import { publicKeyFrom } from "./license.js";

/**
 * The public keys whose licenses this build accepts, newest first, each the
 * base64url raw Ed25519 key `node ee/scripts/license.mjs keygen` prints. The
 * private keys never come near this repository. Empty until the first key is
 * made: then no license is accepted and the server runs as the free edition.
 * A key that has issued licenses stays here for as long as they run.
 */
export const TRUSTED_LICENSE_KEYS: readonly string[] = [];

export function trustedLicenseKeys(): KeyObject[] {
  return TRUSTED_LICENSE_KEYS.map(publicKeyFrom);
}
