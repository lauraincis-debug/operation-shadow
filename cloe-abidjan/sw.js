const CACHE = 'Cloé-v38-certified-v6-2';
const ASSETS = ['./', './index.html', './cloe-bridge.js', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== location.origin) return;
  const isNav = req.mode === 'navigate' || u.pathname.endsWith('.html') || u.pathname === '/' || u.pathname.endsWith('cloe-bridge.js') || u.pathname.endsWith('.json');
  if (isNav) {
    e.respondWith(
      fetch(req, { cache: 'no-store' }).then(r => {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put(req, clone));
        return r;
      }).catch(() => caches.match(req).then(m => m || caches.match('./index.html')))
    );
    return;
  }
  e.respondWith(caches.match(req).then(m => m || fetch(req)));
});
