/**
 * Vamor service worker. It shows notifications when the app is closed, and
 * reloads copies of the app left open across a deploy. It caches nothing;
 * the app is always fetched fresh.
 */

/* The wording comes from the registration URL, so it can be changed in
   config.js without editing this file. A worker can't read config.js itself —
   it runs in its own context with no access to the page. */
const params = new URL(self.location.href).searchParams;
const TITLE = params.get('t') || 'Vamor';
const BODY = params.get('b') || '';

self.addEventListener('install', () => self.skipWaiting());

/* A copy of the app left open across a deploy keeps running the old code
   until something reloads it, and nothing in that old code knows to. The
   browser installs a changed worker the next time it checks — on any page
   load, or after a notification once a day has passed — so this is the one
   piece of new code that runs while an old page is still up. It asks each
   open window whether it is current; app.js answers, anything older stays
   silent and is reloaded once. */
self.addEventListener('activate', (e) =>
  e.waitUntil(
    (async () => {
      await self.clients.claim();
      const open = await self.clients.matchAll({ type: 'window' });
      await Promise.all(
        open.map(async (win) => {
          if (await isCurrent(win)) return;
          try {
            await win.navigate(win.url);
          } catch {
            /* the browser may refuse; the next open catches it up anyway */
          }
        })
      );
    })()
  )
);

/** Ask a window whether it runs code new enough to answer. */
function isCurrent(win) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 3000);
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      resolve(true);
    };
    win.postMessage({ type: 'vamor-current?' }, [channel.port2]);
  });
}

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
