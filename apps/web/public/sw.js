const CACHE_NAME = 'friendstar-shell-v1';
const APP_SHELL = '/';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(APP_SHELL, { cache: 'reload' });
      if (response.ok) {
        await cache.put(APP_SHELL, response.clone());
        const html = await response.text();
        const assets = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)]
          .map((match) => new URL(match[1], self.location.origin).href)
          .filter((url) => new URL(url).origin === self.location.origin);
        await Promise.all(assets.map((url) => cache.add(url).catch(() => undefined)));
      }
    } catch {
      // The current visit may already be offline; keep the worker installable.
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('friendstar-shell-') && name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request);
        if (response.ok) {
          await cache.put(request, response.clone());
          await cache.put(APP_SHELL, response.clone());
        }
        return response;
      } catch {
        return (await cache.match(request)) || (await cache.match(APP_SHELL)) || new Response('FriendStar is not available offline yet. Open the app once while online.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  if (/\.(?:js|css|svg|png|jpe?g|webp|woff2?)$/i.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      } catch {
        return new Response('', { status: 504, statusText: 'Offline asset unavailable' });
      }
    })());
  }
});
