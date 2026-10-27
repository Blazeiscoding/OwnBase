// Shows the notifications a page is not allowed to make itself (Android's
// Chrome throws from a page's `new Notification`), and hands a click on one
// back to the page, which knows what it was about. The page's side is
// packages/ui/src/lib/workerNotifications.ts, and
// packages/ui/test/notificationWorker.test.ts checks this file.
//
// It handles no fetches: the app works the same with it or without it.
self.addEventListener("install", function () {
  // A new copy takes over at once; it has nothing to hand over.
  self.skipWaiting();
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var data = event.notification.data || {};
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (pages) {
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
