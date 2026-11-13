import type { PushSubscriptionBody } from "@ownbase/protocol";
import type { Platform } from "../platform.js";
import { NOTIFICATION_WORKER } from "./workerNotifications.js";
import type { NotificationPreview } from "./notificationPreview.js";

/**
 * Notifications while OwnBase is closed, in a browser (G09). The server
 * pushes through the browser's own push service to the notification worker,
 * apps/web/public/notification-worker.js, which shows them. The desktop app
 * notifies on its own and uses none of this.
 */

/** Why this browser cannot be pushed to, or null when it can. */
export type PushBlock = "insecure" | "home-screen" | "unsupported" | "denied" | null;

/** The parts of the browser this reads, so a test can stand in for them. */
export interface PushEnvironment {
  isSecureContext: boolean;
  userAgent: string;
  maxTouchPoints: number;
  /** Opened from the home screen, as an app, rather than in a browser tab. */
  standalone: boolean;
  hasPush: boolean;
  permission: NotificationPermission | "unsupported";
}

export function browserPushEnvironment(): PushEnvironment {
  return {
    isSecureContext: window.isSecureContext,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    standalone:
      window.matchMedia?.("(display-mode: standalone)").matches === true ||
      (navigator as { standalone?: boolean }).standalone === true,
    hasPush: "serviceWorker" in navigator && "PushManager" in window,
    permission: typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  };
}

export function pushBlock(env: PushEnvironment): PushBlock {
  // A service worker runs only on HTTPS or this computer's own address, so a
  // workspace opened at http://192.168.x.x cannot be pushed to.
  if (!env.isSecureContext) return "insecure";
  // An iPhone or iPad pushes only to an app added to its home screen. iPadOS
  // says it is a Mac, but a Mac has no touch screen.
  const apple =
    /iPhone|iPad|iPod/.test(env.userAgent) ||
    (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1);
  if (apple && !env.standalone) return "home-screen";
  if (!env.hasPush || env.permission === "unsupported") return "unsupported";
  if (env.permission === "denied") return "denied";
  return null;
}

/** What each reason says under the switch. */
export const PUSH_BLOCK_TEXT: Record<Exclude<PushBlock, null>, string> = {
  insecure:
    "This works only when OwnBase is opened over HTTPS. Ask whoever runs this workspace for its https:// address.",
  "home-screen":
    "On an iPhone or iPad, add OwnBase to your home screen first: tap Share, then Add to Home Screen, and open it from there.",
  unsupported: "This browser cannot show notifications while OwnBase is closed.",
  denied:
    "This browser blocks notifications from OwnBase. Allow them in the browser's site settings, then reload the page.",
};

/** The server's key, as `pushManager.subscribe` takes it. */
export function pushKeyBytes(publicKey: string): Uint8Array<ArrayBuffer> {
  const text = atob(publicKey.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

const sameBytes = (a: ArrayBuffer | null, b: Uint8Array) => {
  if (!a || a.byteLength !== b.length) return false;
  const view = new Uint8Array(a);
  return view.every((byte, i) => byte === b[i]);
};

/** This browser's subscription, if it has one; never registers the worker. */
export async function browserSubscription(
  container: ServiceWorkerContainer,
): Promise<PushSubscription | null> {
  const registration = await container.getRegistration(NOTIFICATION_WORKER);
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/**
 * Subscribes this browser to pushes signed with `publicKey`. One made for
 * another key, such as a workspace that was moved to a new server, cannot
 * receive them, so it is replaced.
 */
export async function subscribeBrowser(
  container: ServiceWorkerContainer,
  publicKey: string,
): Promise<PushSubscription> {
  await container.register(NOTIFICATION_WORKER);
  const registration = await container.ready;
  const key = pushKeyBytes(publicKey);
  const existing = await registration.pushManager.getSubscription();
  if (existing && sameBytes(existing.options.applicationServerKey, key)) return existing;
  await existing?.unsubscribe();
  // Every push shows a notification; browsers allow no other kind.
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

export function subscriptionBody(
  subscription: PushSubscription,
  preview: NotificationPreview,
): PushSubscriptionBody | null {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) return null;
  return { endpoint: json.endpoint, keys: { p256dh, auth }, preview };
}

/**
 * Which accounts turned the switch on in this browser. Kept on the device:
 * someone else signing in here is not pushed to until they turn it on.
 */
const KEY = "push-accounts";

export async function pushTurnedOn(platform: Platform, account: string): Promise<boolean> {
  try {
    const saved = await platform.storage.get<Record<string, string>>(KEY);
    return saved?.[account] === "on";
  } catch {
    return false;
  }
}

export async function setPushTurnedOn(
  platform: Platform,
  account: string,
  on: boolean,
): Promise<void> {
  const value = on ? "on" : "off";
  if (platform.storage.mergeRecord) {
    await platform.storage.mergeRecord(KEY, { [account]: value });
    return;
  }
  const saved = (await platform.storage.get<Record<string, string>>(KEY)) ?? {};
  await platform.storage.set(KEY, { ...saved, [account]: value });
}

/**
 * Sends this browser's subscription up again for an account that turned the
 * switch on: a new session after signing in needs it, and the server keeps how
 * much a push may say, which can change. Quiet when anything is missing.
 */
export async function keepPushCurrent(options: {
  platform: Platform;
  account: string;
  preview: NotificationPreview;
  send: (body: PushSubscriptionBody) => Promise<unknown>;
  env?: PushEnvironment;
}): Promise<void> {
  const env = options.env ?? browserPushEnvironment();
  if (pushBlock(env) !== null || env.permission !== "granted") return;
  if (!(await pushTurnedOn(options.platform, options.account))) return;
  const subscription = await browserSubscription(navigator.serviceWorker).catch(() => null);
  const body = subscription && subscriptionBody(subscription, options.preview);
  if (body) await options.send(body);
}
