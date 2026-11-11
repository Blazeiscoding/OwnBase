import { parseSavedServers, type SavedServer } from "@ownbase/client-core/savedSignIns";

/** Electron's safeStorage adapter is supplied by the main process after app readiness. */
export interface CredentialProtector {
  isAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface ProtectedServers {
  kind: "ownbase.saved-servers";
  version: 1;
  ciphertext: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reads sign-ins the window saves, refusing anything else without saying what it held. */
function savedServers(value: unknown): SavedServer[] {
  if (!Array.isArray(value)) throw new Error("Could not read saved sign-ins.");
  return parseSavedServers(value);
}

export function validateProtectedServers(value: unknown): ProtectedServers {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["kind", "version", "ciphertext"].includes(key)) ||
    value.kind !== "ownbase.saved-servers" ||
    value.version !== 1 ||
    typeof value.ciphertext !== "string" ||
    value.ciphertext.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.ciphertext) ||
    Buffer.from(value.ciphertext, "base64").toString("base64") !== value.ciphertext
  )
    throw new Error("Saved workspace credentials are invalid or use an unsupported format.");
  return value as unknown as ProtectedServers;
}

/** Refuses, with `refusal`, while the system's password store cannot protect a secret. */
export function requireProtection(protector: CredentialProtector, refusal: string): void {
  let available = false;
  try {
    available = protector.isAvailable();
  } catch {
    // A locked or missing OS key store must not enable a plaintext fallback.
  }
  if (!available) throw new Error(refusal);
}

const STORE_LOCKED =
  "This computer's password store is locked or unavailable. Unlock it and try again.";

export function encodeSavedServers(
  value: unknown,
  protector: CredentialProtector,
): ProtectedServers | [] {
  const servers = savedServers(value);
  if (servers.length === 0) return [];
  requireProtection(protector, STORE_LOCKED);
  let ciphertext: Buffer;
  try {
    ciphertext = protector.encryptString(JSON.stringify(servers));
  } catch {
    throw new Error(
      "OwnBase could not protect your saved sign-ins. Unlock this computer's password store and try again.",
    );
  }
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0)
    throw new Error("OwnBase could not protect your saved sign-ins.");
  return {
    kind: "ownbase.saved-servers",
    version: 1,
    ciphertext: ciphertext.toString("base64"),
  };
}

/** Legacy arrays are accepted here; the settings layer migrates them before returning them. */
export function decodeSavedServers(value: unknown, protector: CredentialProtector): SavedServer[] {
  if (Array.isArray(value)) return savedServers(value);
  const envelope = validateProtectedServers(value);
  requireProtection(protector, STORE_LOCKED);
  let decrypted: unknown;
  try {
    decrypted = JSON.parse(protector.decryptString(Buffer.from(envelope.ciphertext, "base64")));
  } catch {
    throw new Error(
      "OwnBase could not unlock your saved sign-ins. Sign in to this computer with the account that saved them, then try again.",
    );
  }
  return savedServers(decrypted);
}
