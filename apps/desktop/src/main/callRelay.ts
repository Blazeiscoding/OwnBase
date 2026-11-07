import { callRelaySchema, type CallRelay } from "@ownbase/server";
import type { CallRelaySetting } from "@ownbase/protocol/desktop";
import { DesktopError } from "../shared/desktopError.js";
import type { CredentialProtector } from "./credentials.js";

/** The settings key for the TURN relay that calls hosted on this computer are given. */
export const CALL_RELAY_KEY = "callRelay";

/** How the relay is kept in the settings file: its secret encrypted by the OS. */
interface StoredCallRelay {
  kind: "ownbase.call-relay";
  version: 1;
  relay: "cloudflare" | "custom";
  keyId?: string;
  urls?: string[];
  username?: string;
  secret: string;
}

/** What the hosting window is shown of the relay: everything but its secret. */
export function summarize(relay: CallRelay | null): CallRelaySetting {
  if (!relay) return { kind: "none" };
  if (relay.kind === "cloudflare") return { kind: "cloudflare", keyId: relay.keyId };
  return { kind: "custom", urls: relay.urls, username: relay.username };
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** The relay a draft describes, with a saved secret filled in where the draft keeps it. */
export function resolveDraft(draft: unknown, saved: CallRelay | null): CallRelay | null {
  const kind = (draft as { kind?: unknown } | null)?.kind;
  if (kind === "none") return null;
  if (kind === "cloudflare") {
    const { keyId, apiToken } = draft as Record<string, unknown>;
    const id = text(keyId);
    if (!id) throw new DesktopError("relay-key-id", "Enter the TURN key ID.");
    const token =
      text(apiToken) || (saved?.kind === "cloudflare" && saved.keyId === id ? saved.apiToken : "");
    if (!token) throw new DesktopError("relay-api-token", "Enter the TURN key's API token.");
    const parsed = callRelaySchema.safeParse({ kind, keyId: id, apiToken: token });
    if (!parsed.success)
      throw parsed.error.issues.some((issue) => issue.path[0] === "keyId")
        ? new DesktopError(
            "relay-key-id",
            "A TURN key ID has only letters, digits, hyphens and underscores.",
          )
        : new DesktopError("relay-api-token", "An API token has no spaces.");
    return parsed.data;
  }
  if (kind === "custom") {
    const { urls, username, credential } = draft as Record<string, unknown>;
    const addresses = (Array.isArray(urls) ? urls : []).map(text).filter(Boolean);
    if (addresses.length === 0) throw new DesktopError("relay-urls", "Enter the relay's address.");
    if (addresses.some((url) => !/^turns?:\S+$/.test(url)))
      throw new DesktopError(
        "relay-urls",
        "A relay address starts with turn: or turns:, like turn:relay.example.org:3478.",
      );
    if (addresses.length > 8)
      throw new DesktopError("relay-urls", "Enter at most eight relay addresses.");
    const user = text(username);
    if (!user) throw new DesktopError("relay-username", "Enter the relay's username.");
    const password =
      text(credential) ||
      (saved?.kind === "custom" && saved.username === user ? saved.credential : "");
    if (!password) throw new DesktopError("relay-credential", "Enter the relay's password.");
    const parsed = callRelaySchema.safeParse({
      kind,
      urls: addresses,
      username: user,
      credential: password,
    });
    if (!parsed.success) throw new Error("A username or password has no spaces.");
    return parsed.data;
  }
  throw new Error("Choose a kind of relay.");
}

function requireProtection(protector: CredentialProtector): void {
  let available = false;
  try {
    available = protector.isAvailable();
  } catch {
    // A locked or missing key store must not mean keeping the secret in plain text.
  }
  if (!available)
    throw new Error(
      "OwnBase cannot keep the relay's secret safe because this computer's password store is locked or unavailable. Unlock it and try again.",
    );
}

export function encodeRelay(relay: CallRelay, protector: CredentialProtector): StoredCallRelay {
  requireProtection(protector);
  const secret = relay.kind === "cloudflare" ? relay.apiToken : relay.credential;
  let ciphertext: Buffer;
  try {
    ciphertext = protector.encryptString(secret);
  } catch {
    throw new Error(
      "OwnBase could not protect the relay's secret. Unlock this computer's password store and try again.",
    );
  }
  return relay.kind === "cloudflare"
    ? {
        kind: "ownbase.call-relay",
        version: 1,
        relay: "cloudflare",
        keyId: relay.keyId,
        secret: ciphertext.toString("base64"),
      }
    : {
        kind: "ownbase.call-relay",
        version: 1,
        relay: "custom",
        urls: relay.urls,
        username: relay.username,
        secret: ciphertext.toString("base64"),
      };
}

/** The saved relay, or null when there is none. Throws, without its contents, when it cannot be read. */
export function decodeRelay(value: unknown, protector: CredentialProtector): CallRelay | null {
  if (value === null || value === undefined) return null;
  const stored = value as Partial<StoredCallRelay>;
  if (
    stored.kind !== "ownbase.call-relay" ||
    stored.version !== 1 ||
    typeof stored.secret !== "string" ||
    !stored.secret
  )
    throw new Error("The saved call relay is unreadable. Set it again in Manage hosting.");
  requireProtection(protector);
  let secret: string;
  try {
    secret = protector.decryptString(Buffer.from(stored.secret, "base64"));
  } catch {
    throw new Error(
      "OwnBase could not unlock the call relay's secret. Sign in to this computer with the account that saved it, or set the relay again.",
    );
  }
  const parsed = callRelaySchema.safeParse(
    stored.relay === "cloudflare"
      ? { kind: "cloudflare", keyId: stored.keyId, apiToken: secret }
      : { kind: "custom", urls: stored.urls, username: stored.username, credential: secret },
  );
  if (!parsed.success)
    throw new Error("The saved call relay is unreadable. Set it again in Manage hosting.");
  return parsed.data;
}
