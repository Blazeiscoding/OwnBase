import type { Platform } from "../platform.js";

interface TrustedAddresses {
  version: 1;
  addresses: string[];
}

export interface WorkspaceAddressAccess {
  address: string;
  addresses: string[];
  allowed: boolean;
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

export function workspaceAddressTrustKey(workspaceId: string, userId: string): string {
  return `local:v1:${encodeURIComponent(workspaceId)}:${encodeURIComponent(userId)}:trusted-addresses`;
}

function parseAddresses(stored: unknown): string[] {
  if (
    !stored ||
    typeof stored !== "object" ||
    !("version" in stored) ||
    stored.version !== 1 ||
    !("addresses" in stored) ||
    !Array.isArray(stored.addresses) ||
    stored.addresses.length === 0 ||
    !stored.addresses.every(
      (address) => typeof address === "string" && normalizeWorkspaceAddress(address) === address,
    )
  ) {
    throw new Error("Could not read trusted workspace addresses.");
  }
  return [...new Set(stored.addresses as string[])];
}

const queues = new WeakMap<Platform, Map<string, Promise<void>>>();

function serialized<T>(platform: Platform, key: string, operation: () => Promise<T>): Promise<T> {
  const queue = queues.get(platform) ?? new Map<string, Promise<void>>();
  queues.set(platform, queue);
  const result = (queue.get(key) ?? Promise.resolve()).then(operation);
  const settled = result.then(
    () => {},
    () => {},
  );
  queue.set(key, settled);
  void settled.then(() => {
    if (queue.get(key) === settled) queue.delete(key);
  });
  return result;
}

async function readAddresses(platform: Platform, key: string): Promise<string[] | null> {
  const stored = await platform.storage.get<unknown>(key, { strict: true });
  return stored === null ? null : parseAddresses(stored);
}

/**
 * Register the first address before any stable workspace data is created.
 * Public workspace/user IDs alone never approve a subsequent address.
 */
export function checkWorkspaceAddress(
  platform: Platform,
  workspaceId: string,
  userId: string,
  baseUrl: string,
): Promise<WorkspaceAddressAccess> {
  const key = workspaceAddressTrustKey(workspaceId, userId);
  return serialized(platform, key, async () => {
    const address = normalizeWorkspaceAddress(baseUrl);
    let addresses = await readAddresses(platform, key);
    if (addresses === null) {
      const first = { version: 1, addresses: [address] } satisfies TrustedAddresses;
      // Stored only if nothing is, in one step across windows, and what is
      // stored then is what counts. Two windows that each read nothing, each
      // at a different address, would otherwise each trust its own: the one
      // that stored second took the first's place without anyone approving
      // it, and went on to read that address's local work (Q02). The queue
      // above orders this window's own checks only.
      if (platform.storage.initialize) {
        addresses = parseAddresses(await platform.storage.initialize(key, first));
      } else {
        addresses = first.addresses;
        await platform.storage.set(key, first);
      }
    }
    return { address, addresses, allowed: addresses.includes(address) };
  });
}

/** Call only after the person explicitly approves sharing local work with this address. */
export function trustWorkspaceAddress(
  platform: Platform,
  workspaceId: string,
  userId: string,
  baseUrl: string,
): Promise<WorkspaceAddressAccess> {
  const key = workspaceAddressTrustKey(workspaceId, userId);
  return serialized(platform, key, async () => {
    const address = normalizeWorkspaceAddress(baseUrl);
    const previous = (await readAddresses(platform, key)) ?? [];
    const addresses = previous.includes(address) ? previous : [...previous, address];
    await platform.storage.set(key, { version: 1, addresses } satisfies TrustedAddresses);
    return { address, addresses, allowed: true };
  });
}

/**
 * The addresses this device has linked to a workspace for an account, without
 * recording any: nothing when there are none or they cannot be read.
 */
export async function trustedWorkspaceAddresses(
  platform: Platform,
  workspaceId: string,
  userId: string,
): Promise<string[]> {
  try {
    return (await readAddresses(platform, workspaceAddressTrustKey(workspaceId, userId))) ?? [];
  } catch {
    return [];
  }
}
