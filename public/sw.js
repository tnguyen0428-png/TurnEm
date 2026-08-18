// Service Worker for TurnEM — v6: persistent notifications + active cache cleanup.
//
// This SW intentionally does NOT cache app assets — the network is always the
// source of truth, so a normal page refresh always loads the latest deployed
// bundle. On activate it also PURGES any caches left behind by older,
// cache-first service worker versions. Those stale caches were the reason a
// deploy could look like "no change" on a device until the user manually
// cleared site data; this makes the new worker clean them up automatically.

const SW_VERSION = 'v6';

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
  let tag;
  if (event.data) {
    try {
      const json = event.data.json();
      title = json.title || title;
      body = json.body || body;
      tag = json.tag;
    } catch (e) {
      try {
        body = event.data.text() || body;
      } catch (_) {}
    }
  }
  // requireInteraction keeps the notification on screen until it is dismissed
  // rather than auto-hiding after a few seconds. A turn alert the technician
  // misses is the whole point of sending it, and the owner's nightly report is
  // read whenever the phone is next picked up.
  //
  // Honoured by Chrome and Edge on desktop and Android. iOS Safari IGNORES it:
  // the banner still auto-hides there, though the notification stays in
  // Notification Center until cleared. There is no web API to hold an iOS
  // banner open, so on iPhone the reliable place to read it is the
  // notification list, not the banner.
  //
  // `tag` (optional, from the payload) lets a later notification REPLACE an
  // earlier one of the same kind instead of stacking. Left undefined by
  // default so nothing collapses unless a sender asks for it.
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    renotify: !!tag,
    requireInteraction: true,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
