// sw.js: makes the app shell work offline. Data is NOT handled here: Firestore keeps its own offline cache (see firebase.js).
// Bump VERSION when you want every device to drop its cached copy of your own files.
const VERSION = 'v2';
const SHELL = 'study-shell-' + VERSION; // your own files
const LIBS = 'study-libs';              // CDN files (KaTeX, marked, DOMPurify, Firebase SDK). URLs are version-pinned, so they never go stale.

const SHELL_FILES = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'app.js', 'auth.js', 'db.js', 'firebase.js', 'flashcards.js', 'import.js', 'quiz.js', 'review.js', 'stats.js', 'theory.js', 'todos.js', 'journal.js', 'ui.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];

const isLib = url =>
  url.hostname === 'cdn.jsdelivr.net' ||
  (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/'));

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // one by one, so a single missing file does not stop the whole install
    await Promise.all(SHELL_FILES.map(f => cache.add(new Request(f, { cache: 'reload' })).catch(err => console.warn('sw: could not cache', f, err))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('study-shell-') && k !== SHELL).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Own files: network first, so an update on GitHub shows up straight away. If the network is slow (3.5 s) or down,
// the cached copy is used. Nothing cached yet: wait for the network.
async function ownFile(req) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(req, { ignoreSearch: true })
    || (req.mode === 'navigate' ? (await cache.match('./')) || (await cache.match('index.html')) : undefined);
  const net = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; });
  net.catch(() => {});
  if (!cached) return net;
  return Promise.race([net.catch(() => cached), new Promise(r => setTimeout(() => r(cached), 3500))]);
}

// CDN files: cache first (pinned versions), fetched once and kept.
async function libFile(req) {
  const cache = await caches.open(LIBS);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) e.respondWith(ownFile(req));
  else if (isLib(url)) e.respondWith(libFile(req));
  // everything else (Firestore, Firebase Auth, Google APIs) goes straight to the network, untouched
});
