/* Movie Maker (web) — service worker.
 *
 * - Precaches the app shell (every HTML/CSS/JS/icon file of the app) in a versioned cache so
 *   Movie Maker opens and works offline once it has been loaded.
 * - Same-origin GETs inside the app's scope are served cache-first and refreshed from the network
 *   in the background (stale-while-revalidate), so edits to the app reach users on the next load.
 * - Never touches cross-origin requests, blob:/data: URLs, range requests (media streaming) or
 *   non-GET requests (except the Web Share Target POST below).
 * - A new version waits until the page asks it to take over (the app shows "Update available —
 *   tap to reload", then posts {type:'SKIP_WAITING'}).
 * - Web Share Target (Android): files shared to the installed app are parked in a small cache and
 *   the app picks them up from "./?share-target=…".
 */
'use strict';

const VERSION = '2026-10-10.2';
const CACHE_PREFIX = 'movie-maker-shell-';
const CACHE = CACHE_PREFIX + VERSION;
const SHARE_CACHE = 'movie-maker-share';

// Relative to this file (= the app's scope). Keep in sync with docs/ARCHITECTURE.md.
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/moviemaker.css',
  './js/app.js',
  './js/model.js',
  './js/store.js',
  './js/persist.js',
  './js/media.js',
  './js/catalog.js',
  './js/renderer.js',
  './js/transitions.js',
  './js/effects.js',
  './js/text.js',
  './js/gallery.js',
  './js/audio.js',
  './js/player.js',
  './js/exporter.js',
  './js/commands.js',
  './js/automovie.js',
  './js/ui/dom.js',
  './js/ui/icons.js',
  './js/ui/ribbon.js',
  './js/ui/storyboard.js',
  './js/ui/preview.js',
  './js/ui/dialogs.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

// Runtime caching is limited to app-like files (never user media or test fixtures).
const CACHEABLE_EXT = /\.(?:html?|css|m?js|json|webmanifest|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/i;
const EXCLUDED_DIRS = ['tests/', 'docs/'];

const SCOPE = new URL(self.registration ? self.registration.scope : './', self.location.href);
const SCOPE_PATH = SCOPE.pathname.endsWith('/') ? SCOPE.pathname : SCOPE.pathname + '/';
const INDEX_URL = new URL('./index.html', SCOPE).href;
const SHARE_ACTION_PATH = new URL('./share-target', SCOPE).pathname;

function shellUrls() {
  return SHELL.map((p) => new URL(p, SCOPE).href);
}

// ---------------------------------------------------------------------------
// Install: precache the shell. One missing file must not brick the update, so fall back to
// caching file by file (the rest is filled in at runtime).
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const urls = shellUrls();
    const requests = urls.map((u) => new Request(u, { cache: 'reload', credentials: 'same-origin' }));
    try {
      await cache.addAll(requests);
    } catch (err) {
      const results = await Promise.allSettled(requests.map(async (req) => {
        const res = await fetch(req);
        if (!isCacheable(res)) throw new Error(`HTTP ${res.status} for ${req.url}`);
        await cache.put(req.url, res);
      }));
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length) {
        console.warn(`[Movie Maker SW] ${failed.length} file(s) could not be precached; they will be cached when used.`,
          failed.map((r) => String(r.reason && r.reason.message || r.reason)));
      }
      // Without the page itself the app cannot start offline: treat that as a failed install.
      const index = await cache.match(INDEX_URL) || await cache.match(SCOPE.href);
      if (!index) throw err;
    }
  })());
});

// Activate: drop old shell caches and take control of open pages.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE)
      .map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch (_) { /* ignore */ }
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (data.type === 'GET_VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: VERSION });
  }
});

// ---------------------------------------------------------------------------
// Fetch

function isCacheable(res) {
  return !!res && res.ok && res.status === 200 && res.type === 'basic' && !res.headers.has('Content-Range');
}

function inScope(url) {
  return url.origin === SCOPE.origin && url.pathname.startsWith(SCOPE_PATH);
}

function isExcluded(url) {
  const rel = url.pathname.slice(SCOPE_PATH.length);
  return EXCLUDED_DIRS.some((d) => rel.startsWith(d)) || url.pathname === SHARE_ACTION_PATH;
}

function isAppPage(url) {
  const rel = url.pathname.slice(SCOPE_PATH.length);
  return rel === '' || rel === 'index.html';
}

async function fetchFresh(url) {
  return fetch(url, { cache: 'no-cache', credentials: 'same-origin' });
}

/**
 * Stale-while-revalidate. Returns { response, update } synchronously so the caller can hand
 * `update` to event.waitUntil() during the event dispatch.
 */
function staleWhileRevalidate(request, cacheKey) {
  const key = cacheKey || request.url;
  const cachedP = caches.open(CACHE).then((c) => c.match(key)).catch(() => undefined);
  const networkP = fetchFresh(request.url).then(async (res) => {
    if (isCacheable(res)) {
      try {
        const cache = await caches.open(CACHE);
        await cache.put(key, res.clone());
      } catch (_) { /* quota: serve without caching */ }
    }
    return res;
  });
  const response = cachedP.then((cached) => cached || networkP.catch(async (err) => {
    // Offline and not cached yet: a navigation can still fall back to the cached app page.
    if (request.mode === 'navigate') {
      const cache = await caches.open(CACHE);
      const fallback = await cache.match(INDEX_URL) || await cache.match(SCOPE.href);
      if (fallback) return fallback;
    }
    throw err;
  }));
  const update = networkP.then(() => undefined, () => undefined);
  return { response, update };
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  let url;
  try { url = new URL(request.url); } catch (_) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return; // blob:, data:, chrome-extension: …

  if (request.method === 'POST' && url.origin === SCOPE.origin && url.pathname === SHARE_ACTION_PATH) {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET') return;
  if (!inScope(url)) return;                      // cross-origin or outside the app
  if (request.headers.has('range')) return;       // media streaming: let the browser handle it
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  if (isExcluded(url)) return;

  if (request.mode === 'navigate') {
    if (!isAppPage(url)) return;
    // Any query string (e.g. ?share-target=files) loads the same app page.
    const { response, update } = staleWhileRevalidate(request, INDEX_URL);
    event.respondWith(response);
    event.waitUntil(update);
    return;
  }

  const rel = url.pathname.slice(SCOPE_PATH.length);
  if (!(rel === '' || CACHEABLE_EXT.test(rel))) return;
  const key = url.search ? url.href : url.origin + url.pathname;
  const { response, update } = staleWhileRevalidate(request, key);
  event.respondWith(response);
  event.waitUntil(update);
});

// ---------------------------------------------------------------------------
// Web Share Target: park shared files, then open the app which imports them.

async function receiveShare(request) {
  const base = SCOPE.href;
  try {
    const form = await request.formData();
    const files = form.getAll('media').filter((f) => f && typeof f === 'object' && typeof f.size === 'number' && f.size > 0);
    const cache = await caches.open(SHARE_CACHE);
    for (const k of await cache.keys()) await cache.delete(k);
    const stamp = Date.now();
    let i = 0;
    for (const f of files) {
      i += 1;
      const headers = new Headers({
        'Content-Type': f.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(f.name || `Shared file ${i}`),
        'X-Last-Modified': String(f.lastModified || stamp),
      });
      await cache.put(new Request(`${base}__shared__/${stamp}-${i}`), new Response(f, { headers }));
    }
    return Response.redirect(`${base}?share-target=${files.length ? 'files' : 'empty'}`, 303);
  } catch (err) {
    console.warn('[Movie Maker SW] Could not receive shared files.', err);
    return Response.redirect(`${base}?share-target=error`, 303);
  }
}
