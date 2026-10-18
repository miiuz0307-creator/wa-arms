// Service worker: makes the app installable and shows phone notifications (web push).
// All data is live, so no offline caching of API calls.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { title: 'התראה', body: e.data ? e.data.text() : '' };
  }
  // the level the sender chose shows in the title (a web notification cannot have its own colour)
  const level = d.level || (d.urgent ? 'urgent' : 'info');
  const mark = level === 'urgent' ? '🔴 ' : level === 'warning' ? '🟠 ' : '';
  const strong = level !== 'info';
  e.waitUntil(
    self.registration.showNotification(mark + (d.title || 'התראה מהמערכת'), {
      body: d.body || '',
      // same logo as the login screen; the badge is the small white mark in the phone's top bar
      icon: '/notify-icon.png',
      badge: '/notify-badge.png',
      vibrate: strong ? [300, 120, 300, 120, 300] : [200],
      silent: false,
      dir: 'rtl',
      lang: 'he',
      tag: d.tag,
      renotify: !!d.tag,
      requireInteraction: level === 'urgent',
      data: { url: d.url || '/notifications' },
    }),
  );
});

// tap on the notification: open (or focus) the app on the right screen
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/notifications', self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin) && 'focus' in c) {
          c.navigate(url).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
