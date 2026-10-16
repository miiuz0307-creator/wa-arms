// Makes the page installable as an app. Everything is live data, so nothing is cached:
// requests go straight to the server; without a connection a short message is shown.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(
    fetch(e.request, { cache: 'no-store' }).catch(
      () =>
        new Response(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;display:grid;place-items:center;height:100vh;background:#0d2b25;color:#e8f3ef;font-family:system-ui;text-align:center" dir="rtl"><div><h2>אין חיבור לשרת</h2><p>מנסה שוב… האפליקציה תחזור לבד כשהחיבור יחזור.</p></div><script>setInterval(function(){fetch("/health",{cache:"no-store"}).then(function(r){if(r.ok)location.reload()}).catch(function(){})},3000);document.addEventListener("visibilitychange",function(){if(!document.hidden)location.reload()})</script>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        ),
    ),
  );
});
