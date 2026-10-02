// Keeps RV Notes working offline: the app's files are cached when it's
// installed, and map tiles are cached as they're viewed.
//
// VERSION and APP_FILES are filled in by `npm run stamp` (scripts/stamp-sw.js).
// A new VERSION makes browsers download the new files and offer to reload.

const VERSION = '117f50b58b84';
const APP_FILES = [
  // FILES-START
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/api.js',
  'js/app.js',
  'js/db.js',
  'js/i18n.js',
  'js/locale.js',
  'js/messages.js',
  'js/report.js',
  'js/scanner.js',
  'js/share.js',
  'js/store.js',
  'js/util.js',
  'vendor/bootstrap-icons/bootstrap-icons.min.css',
  'vendor/bootstrap-icons/fonts/bootstrap-icons.woff',
  'vendor/bootstrap-icons/fonts/bootstrap-icons.woff2',
  'vendor/jsQR.js',
  'vendor/jspdf.umd.min.js',
  'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/leaflet/leaflet-src.esm.js',
  'vendor/leaflet/leaflet.css',
  'vendor/marked.esm.js',
  'vendor/purify.es.mjs',
  'vendor/vue.esm-browser.prod.js',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-32.png',
  'icons/icon-512.png',
  'icons/maskable-512.png'
  // FILES-END
];

const APP_CACHE = `rv-notes-app-${VERSION}`;
const TILE_CACHE = 'rv-notes-tiles';
// About 30–60 MB of map tiles.
const MAX_TILES = 3000;
const TILE_HOST = 'tile.openstreetmap.org';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(APP_CACHE).then(cache =>
    // Skips the browser's HTTP cache so a new version gets new files.
    cache.addAll(APP_FILES.map(file => new Request(file, { cache: 'reload' })))));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith('rv-notes-app-') && name !== APP_CACHE)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

// The app asks the new version to take over when you tap Reload.
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    event.respondWith(appFile(request));
  } else if (url.hostname === TILE_HOST) {
    event.respondWith(tile(request));
  }
});

async function appFile(request) {
  const cache = await caches.open(APP_CACHE);
  // Every page of the app is index.html.
  const cached = request.mode === 'navigate'
    ? await cache.match(new URL('index.html', self.registration.scope).href)
    : await cache.match(request, { ignoreSearch: true });
  return cached || fetch(request);
}

let tilesAdded = 0;

async function tile(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'cors') {
    await cache.put(request, response.clone());
    if (++tilesAdded % 100 === 0) trimTiles(cache);
  }
  return response;
}

// Deletes the oldest tiles once there are too many.
async function trimTiles(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_TILES)).map(key => cache.delete(key)));
}
