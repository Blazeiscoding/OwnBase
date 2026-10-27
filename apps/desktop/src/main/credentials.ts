/** Electron's safeStorage adapter is supplied by the main process after app readiness. */
export interface CredentialProtector {
  isAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface SavedCredentialServer {
  url: string;
  token: string;
  workspaceName: string;
  handle: string;
  lastUsedAt: number;
}

export interface ProtectedServers {
  kind: "ownbase.saved-servers";
  version: 1;
  ciphertext: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reject malformed data without including its contents in an error or log. */
export function validateSavedServers(value: unknown): SavedCredentialServer[] {
  if (!Array.isArray(value)) throw new Error("Saved workspace credentials are invalid.");
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.url !== "string" ||
      typeof entry.token !== "string" ||
      entry.token.length === 0 ||
      typeof entry.workspaceName !== "string" ||
      typeof entry.handle !== "string" ||
      typeof entry.lastUsedAt !== "number" ||
      !Number.isFinite(entry.lastUsedAt) ||
      entry.lastUsedAt < 0
    )
      throw new Error("Saved workspace credentials are invalid.");
    try {
      const url = new URL(entry.url);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new Error();
    } catch {
      throw new Error("A saved workspace address is invalid.");
    }
  }
  return value as SavedCredentialServer[];
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

function requireProtection(protector: CredentialProtector): void {
  let available = false;
  try {
    available = protector.isAvailable();
  } catch {
    // A locked or missing OS key store must not enable a plaintext fallback.
  }
  if (!available)
    throw new Error(
      "OS credential protection is unavailable. Unlock your system key store and try again.",
    );
}

export function encodeSavedServers(
  value: unknown,
  protector: CredentialProtector,
): ProtectedServers | [] {
  const servers = validateSavedServers(value);
  if (servers.length === 0) return [];
  requireProtection(protector);
  let ciphertext: Buffer;
  try {
    ciphertext = protector.encryptString(JSON.stringify(servers));
  } catch {
    throw new Error(
      "Could not protect saved workspace credentials. Unlock your system key store and try again.",
    );
  }
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0)
    throw new Error("Could not protect saved workspace credentials.");
  return {
    kind: "ownbase.saved-servers",
    version: 1,
    ciphertext: ciphertext.toString("base64"),
  };
}

/** Legacy arrays are accepted here; the settings layer migrates them before returning them. */
export function decodeSavedServers(
  value: unknown,
  protector: CredentialProtector,
): SavedCredentialServer[] {
  if (Array.isArray(value)) return validateSavedServers(value);
  const envelope = validateProtectedServers(value);
  requireProtection(protector);
  let decrypted: unknown;
  try {
    decrypted = JSON.parse(protector.decryptString(Buffer.from(envelope.ciphertext, "base64")));
  } catch {
    throw new Error(
      "Could not unlock saved workspace credentials. Use the original system account and key store, then try again.",
    );
  }
  return validateSavedServers(decrypted);
}
