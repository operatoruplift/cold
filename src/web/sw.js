/*
 * The COLD service worker. The server fills in VERSION and SHELL when it
 * starts. It keeps the app's shell (page, scripts, styles, font, icons) so the
 * installed app opens offline, and loads pages from the network first so a
 * new version shows up as soon as you are online. It never touches /api:
 * your data is always live, and never sits in a cache.
 */
const VERSION = "__VERSION__";
const SHELL = __SHELL__;
const CACHE = `cold-${VERSION}`;
const CACHEABLE = /^\/(assets|fonts|brand|icons)\//;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith("cold-") && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

// The page asks a waiting worker to take over when you choose "Reload" on the update notice.
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    if (!url.pathname.startsWith("/app")) return;
    event.respondWith(fetch(request).catch(async () => (await caches.match("/app/", { cacheName: CACHE })) ?? Response.error()));
    return;
  }

  if (!CACHEABLE.test(url.pathname) && url.pathname !== "/manifest.webmanifest" && url.pathname !== "/favicon.svg") return;
  event.respondWith(
    (async () => {
      const hit = await caches.match(request, { cacheName: CACHE });
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok && CACHEABLE.test(url.pathname)) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
      }
      return response;
    })(),
  );
});
