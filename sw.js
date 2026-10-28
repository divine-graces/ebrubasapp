// sw.js: makes the app shell work offline. Data is NOT handled here: Firestore keeps its own offline cache (see firebase.js).
// Bump VERSION when you want every device to drop its cached copy of your own files.
const VERSION = 'v3';
const SHELL = 'study-shell-' + VERSION; // your own files
const LIBS = 'study-libs';              // Firebase SDK modules from gstatic. URLs are version-pinned, so they never go stale.

// Keep this version in step with the imports in firebase.js, auth.js and db.js.
const FIREBASE_BASE = 'https://www.gstatic.com/firebasejs/10.12.2/';
const FIREBASE_MODULES = ['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js'];

const SHELL_FILES = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'app.js', 'auth.js', 'db.js', 'firebase.js', 'flashcards.js', 'import.js', 'quiz.js', 'review.js', 'stats.js', 'theory.js', 'todos.js', 'journal.js', 'settings.js', 'ui.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
  // self-hosted libraries (KaTeX 0.16.9, marked 12.0.2, DOMPurify 3.0.9) and every KaTeX font
  'vendor/katex.min.css', 'vendor/katex.min.js', 'vendor/auto-render.min.js', 'vendor/marked.min.js', 'vendor/purify.min.js',
  'vendor/fonts/KaTeX_AMS-Regular.woff2',
  'vendor/fonts/KaTeX_Caligraphic-Bold.woff2',
  'vendor/fonts/KaTeX_Caligraphic-Regular.woff2',
  'vendor/fonts/KaTeX_Fraktur-Bold.woff2',
  'vendor/fonts/KaTeX_Fraktur-Regular.woff2',
  'vendor/fonts/KaTeX_Main-Bold.woff2',
  'vendor/fonts/KaTeX_Main-BoldItalic.woff2',
  'vendor/fonts/KaTeX_Main-Italic.woff2',
  'vendor/fonts/KaTeX_Main-Regular.woff2',
  'vendor/fonts/KaTeX_Math-BoldItalic.woff2',
  'vendor/fonts/KaTeX_Math-Italic.woff2',
  'vendor/fonts/KaTeX_SansSerif-Bold.woff2',
  'vendor/fonts/KaTeX_SansSerif-Italic.woff2',
  'vendor/fonts/KaTeX_SansSerif-Regular.woff2',
  'vendor/fonts/KaTeX_Script-Regular.woff2',
  'vendor/fonts/KaTeX_Size1-Regular.woff2',
  'vendor/fonts/KaTeX_Size2-Regular.woff2',
  'vendor/fonts/KaTeX_Size3-Regular.woff2',
  'vendor/fonts/KaTeX_Size4-Regular.woff2',
  'vendor/fonts/KaTeX_Typewriter-Regular.woff2',
];

const isLib = url => url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/');

// Fetches an ES module into the libs cache, then follows its own relative imports (e.g. "./firebase-app.js"), so the whole
// Firebase SDK is stored at install time and the very first offline start already works.
async function precacheModule(url, cache, seen) {
  if (seen.has(url)) return;
  seen.add(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + ' returned ' + res.status);
  await cache.put(url, res.clone());
  const src = await res.text();
  const deps = [...src.matchAll(/(?:\bfrom|\bimport)\s*["'](\.{1,2}\/[^"']+\.js)["']/g)].map(m => new URL(m[1], url).href);
  await Promise.all(deps.map(u => precacheModule(u, cache, seen).catch(err => console.warn('sw: could not cache', u, err))));
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // one by one, so a single missing file does not stop the whole install
    const failed = [];
    await Promise.all(SHELL_FILES.map(f => cache.add(new Request(f, { cache: 'reload' })).catch(err => { failed.push(f); console.warn('sw: could not cache', f, err); })));
    if (failed.length) console.warn('sw: NOT in the offline cache:', failed.join(', '));
    // Firebase SDK (gstatic): stored now, not on the second load
    const libs = await caches.open(LIBS), seen = new Set();
    await Promise.all(FIREBASE_MODULES.map(m => precacheModule(FIREBASE_BASE + m, libs, seen).catch(err => console.warn('sw: could not cache', m, err))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('study-shell-') && k !== SHELL).map(k => caches.delete(k)));
    // drop the old jsdelivr copies (KaTeX, marked, DOMPurify) that earlier versions stored; they are self-hosted now
    const libs = await caches.open(LIBS);
    for (const r of await libs.keys()) if (new URL(r.url).hostname === 'cdn.jsdelivr.net') await libs.delete(r);
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
