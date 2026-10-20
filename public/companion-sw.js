// Only immutable build assets are cached. API data, HTML, pairing links, and
// terminal output always use the network and are never persisted here.
const CACHE = 'agent-hq-static-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('agent-hq-static-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !/^\/assets\/[\w.-]+\.(js|css)$/.test(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok) { await cache.put(event.request, response.clone()); const keys = await cache.keys(); for (const key of keys.slice(0, Math.max(0, keys.length - 40))) await cache.delete(key); }
    return response;
  })());
});
