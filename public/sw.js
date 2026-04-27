// Service Worker for TurnEM Push Notifications v4-minimal

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
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
