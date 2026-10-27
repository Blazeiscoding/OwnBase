import type { SignInMethod } from "@ownbase/protocol";
import { Api, type SignedIn } from "@ownbase/client-core";
import type { Platform } from "../platform.js";

/**
 * Signing in with a workspace's single sign-on (P9). The button sends the
 * browser to the server with the SHA-256 of a secret kept here; the way back
 * brings a one-time code, which signs in only with that secret. A code
 * someone else passes on, by a link or a pasted address, finds no secret
 * here and signs nobody in.
 *
 * The secret waits in sessionStorage: in the browser it outlasts the trip to
 * the provider and back in the same tab, and in the desktop app the window
 * that opened the system's browser keeps it.
 */
const KEY = "ownbase-sso-pending";
/** As long as the server waits for a sign-in to come back, and a little more. */
const PENDING_MS = 15 * 60 * 1000;

interface Pending {
  serverUrl: string;
  verifier: string;
  redeem: string;
  at: number;
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** Whether this page can begin one: it needs WebCrypto, which plain http does not have. */
export function canSignInWithSso(): boolean {
  return typeof crypto !== "undefined" && !!crypto.subtle && typeof sessionStorage !== "undefined";
}

/** Off to the server's sign-in with `method`, keeping its secret for the way back. */
export async function beginSingleSignOn(
  platform: Pick<Platform, "kind">,
  serverUrl: string,
  method: SignInMethod,
): Promise<void> {
  if (!canSignInWithSso()) throw new Error("Single sign-on needs this page opened over https.");
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const pending: Pending = { serverUrl, verifier, redeem: method.redeem, at: Date.now() };
  sessionStorage.setItem(KEY, JSON.stringify(pending));
  const url = `${serverUrl}${method.start}?client=${platform.kind}&challenge=${challenge}`;
  // The desktop app opens http(s) windows in the system's browser, where
  // the person's provider already knows them; the way back is an ownbase:// link.
  if (platform.kind === "desktop") window.open(url, "_blank", "noopener");
  else window.location.assign(url);
}

/** The code came back to a device or tab that did not begin its sign-in, or began it too long ago. */
export class NotStartedHere extends Error {
  constructor() {
    super("This sign-in was not started here, or took too long. Press the sign-in button again.");
  }
}

/** Each code's one redeeming: a screen shown twice over asks once. */
const redeeming = new Map<string, Promise<SignedIn>>();

/** Signs in with the code the way back brought, and the secret this device began with. */
export function redeemSingleSignOn(serverUrl: string, code: string): Promise<SignedIn> {
  let running = redeeming.get(code);
  if (!running) {
    const pending = takeSingleSignOn(serverUrl);
    running = pending
      ? new Api(serverUrl).redeemSignIn(pending.redeem, { code, verifier: pending.verifier })
      : Promise.reject(new NotStartedHere());
    redeeming.set(code, running);
  }
  return running;
}

/**
 * The secret a sign-in to `serverUrl` began with here, once: null when none
 * did, or it was too long ago.
 */
export function takeSingleSignOn(serverUrl: string): { verifier: string; redeem: string } | null {
  let pending: Pending | null = null;
  try {
    pending = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Pending | null;
  } catch {
    pending = null;
  }
  if (!pending || pending.serverUrl !== serverUrl) return null;
  sessionStorage.removeItem(KEY);
  if (Date.now() - pending.at > PENDING_MS) return null;
  return { verifier: pending.verifier, redeem: pending.redeem };
}
