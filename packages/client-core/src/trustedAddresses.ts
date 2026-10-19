/**
 * The addresses at which a workspace may use the work one account keeps on
 * this device (Q02): the first it was seen at, and each one the person
 * approved after that. Kept free of anything but plain data so the desktop
 * app's main process can make the same change for every window.
 */
export interface StoredTrustedAddresses {
  version: 1;
  addresses: string[];
}

/** Preserve protocol, port and path: each can identify a different server. */
export function normalizeWorkspaceAddress(address: string): string {
  const url = new URL(address);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid workspace address.");
  }
  return url.href.replace(/\/+$/, "");
}

/** Whether `address` is one, written as `normalizeWorkspaceAddress` writes it. */
function isWorkspaceAddress(address: unknown): address is string {
  if (typeof address !== "string") return false;
  try {
    return normalizeWorkspaceAddress(address) === address;
  } catch {
    return false;
  }
}

/** The addresses `stored` holds, once each, or null when it is not a list of them. */
export function readTrustedAddresses(stored: unknown): string[] | null {
  if (
    !stored ||
    typeof stored !== "object" ||
    !("version" in stored) ||
    stored.version !== 1 ||
    !("addresses" in stored) ||
    !Array.isArray(stored.addresses) ||
    stored.addresses.length === 0 ||
    !stored.addresses.every(isWorkspaceAddress)
  ) {
    return null;
  }
  return [...new Set(stored.addresses as string[])];
}

/**
 * Adds `address` to what is stored, as one step a store makes for every
 * window at once, and gives back the addresses then stored. With nothing
 * stored it is the first. What cannot be read is left as it is and the
 * answer is null: approving one address must not wipe out the others.
 */
export function addTrustedAddress(
  stored: unknown,
  address: string,
): { value: unknown; addresses: string[] | null } {
  if (!isWorkspaceAddress(address)) return { value: stored ?? null, addresses: null };
  if (stored === null || stored === undefined) {
    const value = { version: 1, addresses: [address] } satisfies StoredTrustedAddresses;
    return { value, addresses: value.addresses };
  }
  const addresses = readTrustedAddresses(stored);
  if (!addresses) return { value: stored, addresses: null };
  const next = addresses.includes(address) ? addresses : [...addresses, address];
  return {
    value: { version: 1, addresses: next } satisfies StoredTrustedAddresses,
    addresses: next,
  };
}
