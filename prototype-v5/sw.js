/* REEP v5 prototype service worker: cache the static shell so it installs and
   opens offline. There is no API here, and nothing but these files is cached. */
const V = 'reep-v5-proto-1';
const FILES = ['./', 'index.html', 'components.html', 'manifest.webmanifest', 'css/tokens.css', 'css/app.css',
  'js/core.js', 'js/data.js', 'js/app.js', 'js/screens-public.js', 'js/screens-student.js', 'js/screens-faculty.js',
  'js/screens-shared.js', 'js/screens-admin-1.js', 'js/screens-admin-2.js', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(V).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
