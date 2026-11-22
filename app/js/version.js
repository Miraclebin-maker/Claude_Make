// 배포마다 올린다. sw.js 의 CACHE 이름(tsl-shell-<버전>)과 같아야 한다 (tests/version.test.mjs 가 검사).
export const APP_VERSION = '2.2.0';

// 새로고침 시 HTTP 캐시를 새 응답으로 채울 파일 목록 (sw.js SHELL 과 같아야 한다, tests/version.test.mjs 가 검사).
export const APP_FILES = [
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
  './js/gauge.js',
  './js/version.js',
  './js/update-policy.js',
  './js/audio/audio.js',
  './js/audio/ev.js',
  './js/audio/ev-params.js',
];
