// Makes the page installable as an app. Everything is live data, so nothing is cached:
// requests go straight to the server; without a connection a short message is shown.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(
    fetch(e.request).catch(
      () =>
        new Response(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;display:grid;place-items:center;height:100vh;background:#0d2b25;color:#e8f3ef;font-family:system-ui;text-align:center" dir="rtl"><div><h2>אין חיבור לאינטרנט</h2><p>האפליקציה תחזור לעבוד כשהחיבור יחזור.</p></div>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        ),
    ),
  );
});
