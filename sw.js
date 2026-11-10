/* 天才交易员模拟器 · 离线缓存 */
const CACHE = 'genius-trader-v41';
const SHELL = ['./app/kline-mobile.html', './app/kline-core.js', './data/kline-index.js', './data/kline-fundamentals.js',
  './data/kline-news.js', './data/kline-news-index.js', './app/kline-futures.html', './app/kline-futures-core.js',
  './data/kline-fut-data.js', './app/manifest.webmanifest', './app/icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  /* 页面与静态资源（含 data/ 行情与新闻分片）：网络优先，离线回退缓存 */
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('./app/kline-mobile.html')))
  );
});
