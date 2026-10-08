// Minimal service worker: makes the app installable. All data is live, so no offline caching of API calls.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
