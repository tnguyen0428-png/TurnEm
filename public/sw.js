// Service Worker for TurnEM — v5: push notifications + active cache cleanup.
//
// This SW intentionally does NOT cache app assets — the network is always the
// source of truth, so a normal page refresh always loads the latest deployed
// bundle. On activate it also PURGES any caches left behind by older,
// cache-first service worker versions. Those stale caches were the reason a
// deploy could look like "no change" on a device until the user manually
// cleared site data; this makes the new worker clean them up automatically.

const SW_VERSION = 'v5';

self.addEventListener('install', () => {
  // Take over as soon as possible instead of waiting for old tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Delete every Cache Storage entry from any prior version. We don't use
    // the Cache API at all, so nothing here should be kept.
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) {
      // Best-effort cleanup; ignore failures.
    }
    await self.clients.claim();
    console.log('[sw] activated', SW_VERSION, '— caches purged');
  })());
});

self.addEventListener('push', (event) => {
  let title = 'TurnEM';
  let body = "It's your turn!";
  if (event.data) {
    try {
      const json = event.data.json();
      title = json.title || title;
      body = json.body || body;
    } catch (e) {
      try {
        body = event.data.text() || body;
      } catch (_) {}
    }
  }
  event.waitUntil(self.registration.showNotification(title, { body }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
