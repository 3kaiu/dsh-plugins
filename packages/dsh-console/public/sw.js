// DSH Console Service Worker:静态资源预缓存 + 导航网络优先(事件流 API 永不缓存)
const CACHE = "dsh-console-v1";
const ASSETS = ["/", "/index.html", "/manifest.webmanifest", "/favicon.svg", "/apple-touch-icon.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;              // 跨域(如外部字体)不干预
  if (u.pathname.startsWith("/api/")) return;                 // 事件库/健康 API 永不缓存
  if (e.request.mode === "navigate") {                        // 导航:网络优先,离线回退缓存
    e.respondWith(fetch(e.request).then((res) => { const cp = res.clone(); caches.open(CACHE).then((c) => c.put("/", cp)); return res; }).catch(() => caches.match("/")));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
    if (res.ok && (u.pathname.startsWith("/assets/") || u.pathname.endsWith(".webmanifest"))) { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); }
    return res;
  })));
});
