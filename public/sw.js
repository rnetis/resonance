// Resonance service worker: app-shell precache + navigation fallback.
// Audio (/api/stream) is deliberately never intercepted — Range requests go
// straight to the network, and offline copies are handled by the Cache Storage
// API from the page (see public/js/offline.js).

const VERSION = "resonance-v8";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/js/app.js",
  "/js/player.js",
  "/js/util.js",
  "/js/offline.js",
  "/manifest.webmanifest",
  "/icons/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: "reload" }))))
      .catch(() => {})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== VERSION && !name.startsWith("resonance-audio")).map((name) => caches.delete(name)));

      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable().catch(() => {});
      }

      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  // API traffic (search, jobs, streaming, covers) always goes to the network.
  if (url.pathname.startsWith("/api/")) return;

  // Navigations: network first so updates land, cached shell as the offline fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(VERSION);
          cache.put("/index.html", response.clone());
          return response;
        } catch {
          const cache = await caches.open(VERSION);
          return (await cache.match("/index.html")) || (await cache.match("/")) || Response.error();
        }
      })()
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      const cached = await cache.match(request);

      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);

      if (cached) return cached;

      const response = await network;
      return response || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
    })()
  );
});
