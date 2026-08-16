/**
 * Vamor service worker — exists purely to show notifications when the app
 * is closed. It caches nothing; the app is always fetched fresh.
 */

/* The wording comes from the registration URL, so it can be changed in
   config.js without editing this file. A worker can't read config.js itself —
   it runs in its own context with no access to the page. */
const params = new URL(self.location.href).searchParams;
const TITLE = params.get('t') || 'Vamor';
const BODY = params.get('b') || '';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  // The text is always the same, so the push carries no payload — nothing
  // about the conversation ever leaves the database to reach a push service.
  event.waitUntil(
    self.registration.showNotification(TITLE, {
      body: BODY,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: 'vamor',      // replace the previous one instead of stacking
      renotify: true,    // ...but still buzz
      vibrate: [90, 60, 90],
      data: { url: '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of open) {
        if (client.url.startsWith(self.location.origin)) return client.focus();
      }
      return self.clients.openWindow('/');
    })()
  );
});
