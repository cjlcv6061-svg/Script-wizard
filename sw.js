/* 台詞小精靈 service worker：離線可用。
   - 安裝時預先快取應用外殼與 vendor/ 函式庫（路徑相對於 SW 所在位置，GitHub Pages 子路徑也適用）
   - 同源 GET：先回快取、背景更新（下次開啟就是新版）
   - 不碰跨來源請求（Worker 解析 API、Google Fonts），也不快取 POST
   改了外殼檔案清單（SHELL）時要把 VERSION 加一。 */
const VERSION = 'tsj-v1';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const OPTIONAL = ['vendor/mammoth.browser.min.js', 'vendor/pdf.min.js', 'vendor/pdf.worker.min.js'];   // 失敗不擋安裝

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(SHELL);
    await Promise.all(OPTIONAL.map(u => c.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then(res => { if (res && res.ok && res.type === 'basic') c.put(req, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const res = await net;
    if (res) return res;
    if (req.mode === 'navigate') { const idx = await c.match('index.html'); if (idx) return idx; }
    return new Response('離線中，且這個檔案還沒有快取', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  })());
});
