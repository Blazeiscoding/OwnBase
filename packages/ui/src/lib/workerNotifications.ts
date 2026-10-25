/**
 * Notifications shown by a service worker, where the browser will not let a
 * page make one: Android's Chrome throws "Illegal constructor" from `new
 * Notification` and shows only what a service worker asks for. The worker,
 * apps/web/public/notification-worker.js, hands a click back to the page as a
 * message naming the notification, and the page does what it was given to.
 */
export const NOTIFICATION_WORKER = "/notification-worker.js";
/** The message the worker sends a page when one of its notifications is clicked. */
export const NOTIFICATION_CLICK = "tandem:notification-click";
/** Clicks a page still answers, oldest dropped first. */
const KEPT_CLICKS = 50;

export interface WorkerNotifications {
  /** Shows a notification through the worker, registering it on first use. */
  show: (title: string, body: string, onClick?: () => void, tag?: string) => Promise<void>;
}

export function workerNotifications(container: ServiceWorkerContainer): WorkerNotifications {
  const clicks = new Map<string, () => void>();
  let registration: Promise<ServiceWorkerRegistration> | null = null;
  const registered = () => {
    if (!registration) {
      container.addEventListener("message", (event: MessageEvent) => {
        const data = event.data as { type?: unknown; click?: unknown } | null;
        if (data?.type !== NOTIFICATION_CLICK || typeof data.click !== "string") return;
        const click = clicks.get(data.click);
        clicks.delete(data.click);
        click?.();
      });
      registration = container.register(NOTIFICATION_WORKER).then(() => container.ready);
      // Refused once (a page served over plain HTTP, say), asked again next time.
      registration.catch(() => {
        registration = null;
      });
    }
    return registration;
  };
  return {
    show: async (title, body, onClick, tag) => {
      // Every page of this site hears every click, so each names its own.
      const click = crypto.randomUUID();
      if (onClick) {
        clicks.set(click, onClick);
        if (clicks.size > KEPT_CLICKS) clicks.delete(clicks.keys().next().value!);
      }
      try {
        await (await registered()).showNotification(title, { body, tag, data: { click } });
      } catch {
        clicks.delete(click);
      }
    },
  };
}
