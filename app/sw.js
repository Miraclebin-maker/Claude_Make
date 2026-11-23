// 앱 셸 캐시. 네트워크 우선(서버 재검증), 실패 시 캐시 (오프라인 실행).
// 버전은 js/version.js 의 APP_VERSION 과 같아야 한다 (tests/version.test.mjs 가 검사).
// 배포 호스트(GitHub Pages)는 max-age=600 을 보내므로, 브라우저 HTTP 캐시를 피해 받는다.
const CACHE = 'tsl-shell-2.8.3';
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
  './js/audio/v10.js',
  './js/audio/rpm-model.js',
  './js/audio/audio-state.js',
  './js/gauge.js',
  './js/version.js',
  './js/update-policy.js',
  './js/camera-logic.js',
  './js/orientation.js',
  './audio/v10/rpm-1000.wav',
  './audio/v10/rpm-1500.wav',
  './audio/v10/rpm-2000.wav',
  './audio/v10/rpm-2500.wav',
  './audio/v10/rpm-3000.wav',
  './audio/v10/rpm-3500.wav',
  './audio/v10/rpm-4000.wav',
  './audio/v10/rpm-4500.wav',
  './audio/v10/rpm-5000.wav',
  './audio/v10/rpm-5500.wav',
  './audio/v10/rpm-6000.wav',
  './audio/v10/rpm-6500.wav',
  './audio/v10/rpm-7000.wav',
  './audio/v10/rpm-7500.wav',
  './audio/v10/rpm-8000.wav',
  './audio/v10/rpm-8500.wav',
  './audio/v10/rpm-9000.wav',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
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
    fetch(req, { cache: 'no-cache' })
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
