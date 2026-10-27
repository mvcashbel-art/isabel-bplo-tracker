// Isabel BPLO Field Tracker - service worker
//
// Bump VERSION whenever you change THIS file or the CDN URLs below.
// Changes to index.html do NOT need a bump: the page refreshes itself in the
// background and the new version shows the next time the app is opened.

const VERSION = 'v7';
const APP_CACHE = `isabel-bplo-app-${VERSION}`;
const TILE_CACHE = 'isabel-bplo-tiles';   // kept across versions
const MAX_TILES = 400;                    // oldest tiles are dropped beyond this

// Our own files: install fails (and the old worker stays) if any of these are missing.
const LOCAL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

// Third-party files: best effort, so one slow or blocked CDN cannot break installation.
const CDN_ASSETS = [
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

// Try a normal CORS fetch first (real response, honest storage size);
// fall back to no-cors, which always works for <script> and <link> tags.
async function fetchForCache(url) {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (res.ok) return res;
  } catch (_) { /* fall through */ }
  return fetch(url, { mode: 'no-cors' });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    await cache.addAll(LOCAL_ASSETS);
    await Promise.allSettled(
      CDN_ASSETS.map(async (url) => cache.put(url, await fetchForCache(url)))
    );
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key !== APP_CACHE && key !== TILE_CACHE)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

// Open instantly from cache, refresh the cached copy in the background.
async function appShell(event) {
  const cache = await caches.open(APP_CACHE);
  const cached = await cache.match('./index.html');

  const refresh = fetch(event.request)
    .then((res) => {
      if (res.ok && !res.redirected) cache.put('./index.html', res.clone());
      return res;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  return (await refresh) || new Response('Offline and not yet cached.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain' }
  });
}

// Everything else: cache first, then network. Only our own files are saved at runtime.
async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok && new URL(req.url).origin === self.location.origin) {
      const cache = await caches.open(APP_CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch (_) {
    return Response.error();
  }
}

// Map tiles: show what has been seen before, even with no signal.
async function mapTile(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) {
      await cache.put(req, res.clone());
      trimTiles(cache);
    }
    return res;
  } catch (_) {
    return Response.error();   // blank tile
  }
}

async function trimTiles(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_TILES) {
    await Promise.all(keys.slice(0, keys.length - MAX_TILES).map((k) => cache.delete(k)));
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Never touch writes. The form POSTs to Google Apps Script must reach the
  // network untouched; answering them with a cached page makes a failed save
  // look like a successful one.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Google Sheets / Apps Script traffic always goes straight to the network.
  if (url.hostname.endsWith('google.com') || url.hostname.endsWith('googleusercontent.com')) return;

  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    event.respondWith(mapTile(req));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(appShell(event));
    return;
  }

  event.respondWith(cacheFirst(req));
});
