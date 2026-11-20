// PageSecretary — Service Worker
// Added 2026-08-19 (Phase 1). Replaces the old inline blob-URL service worker,
// which registered a fetch handler that called caches.match() but never put
// anything into the cache — so it always missed and fell through to network,
// meaning the app did NOT actually work offline despite the UI implying it did.
// This version pre-caches the app shell on install so the app can genuinely
// open and be used (existing data, existing UI) with no connection.

const CACHE_NAME = 'pagesecretary-shell-v4-gemini';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Never cache or intercept AI/email API calls — always go to network.
  if (url.includes('onrender.com') || url.includes('emailjs') || url.includes('api.anthropic.com') || new URL(url).pathname === '/ai') {
    return;
  }

  // App shell: cache-first, so the app still opens with no connection.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((res) => {
          // Opportunistically cache same-origin GETs as they're seen.
          if (event.request.method === 'GET' && res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => new Response('', { status: 503, statusText: 'Offline' }));
    })
  );
});
