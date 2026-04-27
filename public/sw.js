// Service Worker for TurnEM Push Notifications v3

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('push', (event) => {
  const promise = (async () => {
    let title = 'TurnEM';
    let body = "It's your turn!";
    try {
      if (event.data) {
        const json = event.data.json();
        title = json.title || title;
        body = json.body || body;
      }
    } catch (e) {
      // fallback to defaults
    }
    await self.registration.showNotification(title, {
      body,
      icon: '/Turn_Em_Icon.png',
      badge: '/Turn_Em_Icon.png',
      tag: 'turnem-' + Date.now(),
      requireInteraction: false,
    });
  })();
  event.waitUntil(promise);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
