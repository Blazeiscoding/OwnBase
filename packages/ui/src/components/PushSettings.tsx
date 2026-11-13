import { useEffect, useState } from "react";
import { ApiError } from "@ownbase/client-core";
import { useClient, usePlatform, useWorkspace } from "../context.js";
import { failureText } from "../lib/failure.js";
import { previewAccount, previewFor, useNotificationPreviews } from "../lib/notificationPreview.js";
import {
  browserPushEnvironment,
  browserSubscription,
  pushBlock,
  PUSH_BLOCK_TEXT,
  pushTurnedOn,
  setPushTurnedOn,
  subscribeBrowser,
  subscriptionBody,
  type PushBlock,
} from "../lib/webPush.js";

/**
 * Account settings, Notifications: "Notify me when OwnBase is closed", for
 * this account in this browser (G09). It asks for permission, subscribes the
 * browser and hands the subscription to the server, or says why it cannot.
 */
export function PushSettings() {
  const client = useClient();
  const platform = usePlatform();
  const selfId = useWorkspace((s) => s.self?.id ?? null);
  const previews = useNotificationPreviews();
  const account = selfId ? previewAccount(client.baseUrl, selfId) : null;
  const preview = previewFor(previews, account);
  const [block, setBlock] = useState<PushBlock>(() => pushBlock(browserPushEnvironment()));
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!account || block === "insecure" || block === "home-screen" || block === "unsupported") {
      setOn(false);
      return;
    }
    let live = true;
    void (async () => {
      const chosen = await pushTurnedOn(platform, account);
      const subscription = chosen
        ? await browserSubscription(navigator.serviceWorker).catch(() => null)
        : null;
      if (live) setOn(chosen && subscription !== null && Notification.permission === "granted");
    })();
    return () => {
      live = false;
    };
  }, [account, block, platform]);

  async function turnOn() {
    if (!account) return;
    if (Notification.permission === "default") await Notification.requestPermission();
    const now = pushBlock(browserPushEnvironment());
    setBlock(now);
    if (now !== null || Notification.permission !== "granted") return;
    const key = await client.account.pushKey();
    if (key instanceof ApiError) {
      setError(failureText("Could not turn this on.", key));
      return;
    }
    let body;
    try {
      body = subscriptionBody(await subscribeBrowser(navigator.serviceWorker, key), preview);
    } catch {
      body = null;
    }
    if (!body) {
      setError("This browser could not subscribe to notifications. Please try again.");
      return;
    }
    const failed = await client.account.keepPushSubscription(body);
    if (failed) {
      setError(failureText("Could not turn this on.", failed));
      return;
    }
    await setPushTurnedOn(platform, account, true);
    setOn(true);
  }

  async function turnOff() {
    if (!account) return;
    await setPushTurnedOn(platform, account, false);
    setOn(false);
    const failed = await client.account.stopPushes();
    // The browser forgets its subscription too, so nothing more can arrive.
    await (
      await browserSubscription(navigator.serviceWorker).catch(() => null)
    )
      ?.unsubscribe()
      .catch(() => false);
    if (failed) setError(failureText("Could not turn this off on the server.", failed));
  }

  async function toggle(wanted: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await (wanted ? turnOn() : turnOff());
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const checked = on === true;
  const unavailable = block === "insecure" || block === "home-screen" || block === "unsupported";
  return (
    <section
      aria-labelledby="account-closed-notifications-title"
      className="mt-6 border-t border-edge pt-5"
    >
      <h3 id="account-closed-notifications-title" className="font-semibold">
        When OwnBase is closed
      </h3>
      <label className="mt-3 flex cursor-pointer items-center gap-2.5 text-sm has-[:disabled]:cursor-default has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-copper">
        <input
          type="checkbox"
          role="switch"
          className="sr-only"
          checked={checked}
          disabled={on === null || busy || unavailable || !account}
          onChange={(event) => void toggle(event.target.checked)}
        />
        <span
          aria-hidden="true"
          className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
            checked ? "border-copper bg-copper" : "border-edge bg-deep/40"
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 size-3.5 rounded-full transition-transform ${
              checked ? "translate-x-4 bg-ground" : "bg-ink-faint"
            }`}
          />
        </span>
        <span>Notify me when OwnBase is closed</span>
      </label>
      <p className="mt-1 text-sm text-ink-dim">
        {block !== null
          ? PUSH_BLOCK_TEXT[block]
          : "For this workspace in this browser, with every tab closed. Notifications show what you chose below."}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-alert">
          {error}
        </p>
      )}
    </section>
  );
}
