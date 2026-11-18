// Kindly service worker: caches the app shell and static assets only.
// Chain state (RPC calls, balances, holds, receipts) is never cached: those requests go to other origins and are not intercepted.
const VERSION = "kindly-shell-v2";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png", "./fonts/fonts.css", "./fonts/satoshi-400.woff2", "./fonts/satoshi-500.woff2", "./fonts/satoshi-700.woff2"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  if (!same) return; // RPC, explorer, wallet: always live
  if (req.mode === "navigate") {
    // Network first so a new build shows at once; the cached shell only when offline.
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put("./index.html", copy)); return r; }).catch(() => caches.match("./index.html")));
    return;
  }
  if (same && !/\/(assets|icons|fonts)\/|\.(webmanifest|png|svg|woff2?|css)$/.test(url.pathname)) return; // only static files
  // Static, content-hashed files: cache first, then network.
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => { if (r.ok || r.type === "opaque") { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return r; })));
});
