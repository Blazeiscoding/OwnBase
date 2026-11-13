// Shows the notifications a page is not allowed to make itself (Android's
// Chrome throws from a page's `new Notification`), and hands a click on one
// back to the page, which knows what it was about. The page's side is
// packages/ui/src/lib/workerNotifications.ts, and
// packages/ui/test/notificationWorker.test.ts checks this file.
//
// It also shows what the server pushes while no page of the app is open
// (packages/server/src/push/). A click on one of those opens the message.
//
// It handles no fetches: the app works the same with it or without it.
self.addEventListener("install", function () {
  // A new copy takes over at once; it has nothing to hand over.
  self.skipWaiting();
});

// Channel and message ids never contain anything else.
var TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
function isToken(value) {
  return typeof value === "string" && TOKEN.test(value);
}

self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = (event.data && event.data.json()) || {};
  } catch (error) {
    data = {};
  }
  var link =
    isToken(data.channelId) && isToken(data.messageId)
      ? self.registration.scope + "#/c/" + data.channelId + "/m/" + data.messageId
      : self.registration.scope;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (pages) {
      // Someone with the app in front sees the message there, or its page
      // notifies as it does for every message.
      for (var i = 0; i < pages.length; i++) if (pages[i].focused) return;
      return self.registration.showNotification(String(data.title || "OwnBase"), {
        body: String(data.body || ""),
        // A newer push about the same conversation replaces the older one.
        tag: typeof data.tag === "string" ? data.tag : undefined,
        data: { link: link },
      });
    }),
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var data = event.notification.data || {};
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (pages) {
      if (typeof data.link === "string") {
        // A push: the page used last opens the message, or a new one does.
        if (pages.length === 0) return self.clients.openWindow(data.link);
        pages[0].postMessage({ type: "ownbase:open-link", link: data.link });
        return pages[0].focus();
      }
      // The page that showed it is gone: open the app instead.
      if (pages.length === 0) return self.clients.openWindow(self.registration.scope);
      // Each page hears it, and only the one that showed it answers. The page
      // used last comes first.
      for (var i = 0; i < pages.length; i++) {
        pages[i].postMessage({ type: "ownbase:notification-click", click: data.click });
      }
      return pages[0].focus();
    }),
  );
});
