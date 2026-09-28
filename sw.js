/* =====================================================================
 * sw.js —— Service Worker
 * 策略：同源静态资源「网络优先 + 缓存兜底」（保证改版后一定是新代码），
 *       跨域请求（LCD / RPC / CDN）一律不拦截，避免缓存脏的链上数据。
 * ===================================================================== */
const CACHE = 'paxi-lottery-v1';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './chain.js',
  './session.js',
  './lottery.js',
  './hash.js',
  './config.js',
  './manifest.json',
  './icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 跨域（链上 API / CDN）不缓存，直接放行
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
