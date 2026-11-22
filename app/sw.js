// 앱 셸 캐시. 네트워크 우선, 실패 시 캐시 (오프라인 실행).
const CACHE = 'tsl-shell-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './icons/icon.svg',
  './js/main.js',
  './js/protocol.js',
  './js/ble.js',
  './js/ui.js',
  './js/settings.js',
  './js/camera.js',
  './js/demo.js',
  './js/plaid.js',
  './js/audio/audio.js',
  './js/audio/ev.js',
  './js/audio/rpm-model.js',
  './js/audio/engine-worklet.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))),
  );
});
