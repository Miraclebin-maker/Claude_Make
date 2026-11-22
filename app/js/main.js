// 진입점: 상태 보관, 모듈 연결, 이벤트 바인딩, 트립/0-100 로직, 화면 꺼짐 방지.
import { TslBle } from './ble.js';
import { parseTelemetry176, parseHvPack208 } from './protocol.js';
import * as settings from './settings.js';
import { createUi, themeName } from './ui.js';
import { createAudio } from './audio/audio.js';
import { createCameraWatch } from './camera.js';
import { createDemo, DEMO_HV } from './demo.js';
import { createPlaid } from './plaid.js';

const SOUND_LABEL = {
  off: '음소거',
  zimmer: '한스짐머 EV',
  plaid: '플래드 워프',
  motor: '일렉트릭 슈퍼카',
  turbine: '제트 터빈',
};

const THEMES = ['minimal', 'plaid', 'arc', 'twin', 'hud'];

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

const savedDevice = settings.getLastDevice();
const state = {
  conn: { state: 'idle', name: '' },
  demo: false,
  hint: false,
  telem: null,
  longG: 0,
  hw: null,
  hv: null,
  trip: { startOdo: null, distKm: 0, maxSpeed: 0, maxKw: 0 },
  zero: { mode: 0, startMs: 0, text: '대기' },
  theme: 'minimal',
  mirror: false,
  sound: settings.getSound(),
  volume: settings.getVolume(),
  chime: true,
  autoConnect: settings.isAutoConnect(),
  devName: savedDevice ? savedDevice.name : '',
  cam: { enabled: settings.isCamEnabled(), radius: settings.getCamRadius(), gps: '대기', count: 0, banner: null },
  plaidHyper: false,
  sheet: null,
  latest: { speed: 0, pedal: 0, kw: 0 },
  fullscreen: false,
};

const ui = createUi();
const audio = createAudio();
const plaid = createPlaid(document.getElementById('plaid-canvas'));
const demo = createDemo();
let demoTimer = null;
let lastCamSim = null;

let renderQueued = false;
function schedule() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    ui.render(state);
  });
}

const cam = createCameraWatch({
  onAlert: (info) => { state.cam.banner = info; schedule(); },
  onClear: () => { if (state.cam.banner) { state.cam.banner = null; schedule(); } },
  onChime: () => audio.playChime(),
  onGps: (txt) => { state.cam.gps = txt; schedule(); },
  onChange: () => {
    state.cam.count = cam.count();
    state.cam.enabled = cam.isEnabled();
    state.cam.radius = cam.getRadius();
    schedule();
  },
  toast: (m) => ui.toast(m),
});
state.cam.count = cam.count();

const ble = new TslBle({ guard: () => !state.demo });

// ---- BLE 상태 / 패킷 ----------------------------------------------------
ble.onState((st, name) => {
  const prev = state.conn.state;
  state.conn = { state: st, name };
  if (st === 'connected') {
    state.hint = false;
    state.devName = name || state.devName;
    if (state.demo) stopDemo(false);
    ui.toast(prev === 'reconnecting' ? '재연결 완료' : 'TSL CAN 모듈 연결 완료');
  } else if (st === 'reconnecting' && prev !== 'reconnecting') {
    ui.toast('연결 끊김 · 재연결 중');
  }
  if (st !== 'connected' && prev === 'connected') {
    state.latest = { speed: 0, pedal: 0, kw: 0 };
  }
  schedule();
  syncWakeLock();
});

ble.onPacket(({ type, payload }) => {
  if (type === 160 || type === 161 || type === 163) {
    if (payload.length >= 1) state.hw = payload[0] || 6;
    schedule();
  } else if (type === 168) {
    if (payload[0] === 1) ui.toast('비밀번호 인증 완료');
    else if (payload[0] === 0) ui.toast('비밀번호 오류: 설정 › 연결에서 수정하세요.');
  } else if (type === 176) {
    const frame = parseTelemetry176(payload);
    if (frame) onFrame(frame);
  } else if (type === 208) {
    const hv = parseHvPack208(payload);
    if (hv) {
      state.hv = hv;
      schedule();
    }
  }
});

// ---- 텔레메트리 처리 (트립, 0-100, 경고, 플래드) ------------------------
let prevT = Date.now();
let prevSpeed = 0;
let lastHands = 0;
let lastHyper = false;

function onFrame(f) {
  const now = Date.now();
  const totalKw = f.frontKw + f.rearKw;
  const dt = Math.max(0.05, (now - prevT) / 1000);
  state.longG = clamp((f.speed - prevSpeed) / 3.6 / (dt * 9.81), -1.2, 1.2);
  prevT = now;
  prevSpeed = f.speed;

  const tr = state.trip;
  if (tr.startOdo === null && f.odo > 0) tr.startOdo = f.odo;
  if (tr.startOdo !== null && f.odo >= tr.startOdo) tr.distKm = f.odo - tr.startOdo;
  if (f.speed > tr.maxSpeed) tr.maxSpeed = f.speed;
  if (totalKw > tr.maxKw) tr.maxKw = totalKw;

  const z = state.zero;
  if (z.mode === 1 && f.speed > 0) {
    z.mode = 2;
    z.startMs = now;
    z.text = '측정중';
  } else if (z.mode === 2 && f.speed >= 100) {
    const sec = ((now - z.startMs) / 1000).toFixed(2);
    z.mode = 0;
    z.text = `${sec}s`;
    ui.toast(`0-100km/h 기록 달성: ${sec}초`);
  }

  // 핸들 잡기 경고: 상승 엣지에서 1회 경고음
  if (f.handsOn && !lastHands) audio.playChime();
  lastHands = f.handsOn;

  const hyper = plaid.update({ speedKmh: f.speed, totalKw, peakKw: Math.max(200, tr.maxKw), nowMs: now });
  if (state.theme === 'plaid' && hyper && !lastHyper) ui.flashShake();
  lastHyper = hyper;
  state.plaidHyper = hyper;

  state.telem = { ...f, totalKw };
  state.latest = { speed: f.speed, pedal: f.pedal, kw: totalKw };
  schedule();
}

// ---- 데모 ---------------------------------------------------------------
function demoStep() {
  const { frame, cam: sim } = demo.next();
  onFrame(frame);
  if (sim) {
    cam.simulate(sim);
    lastCamSim = sim;
  } else if (lastCamSim) {
    cam.simulate(null);
    lastCamSim = null;
  }
}

function startDemo() {
  if (state.conn.state === 'connected' || state.conn.state === 'reconnecting') ble.disconnect();
  state.demo = true;
  state.hint = false;
  state.hv = { ...DEMO_HV };
  demo.reset();
  lastCamSim = null;
  demoTimer = setInterval(demoStep, 100);
  ui.toast('가속 주행 시뮬레이션 시작');
  syncWakeLock();
  schedule();
}

function stopDemo(notify = true) {
  if (!state.demo) return;
  clearInterval(demoTimer);
  demoTimer = null;
  state.demo = false;
  state.latest = { speed: 0, pedal: 0, kw: 0 };
  state.hv = null;
  cam.simulate(null);
  lastCamSim = null;
  if (notify) ui.toast('시뮬레이션 데모 중지');
  syncWakeLock();
  schedule();
}

function toggleDemo() {
  if (state.demo) stopDemo();
  else startDemo();
}

// ---- 연결 ---------------------------------------------------------------
async function connectNow() {
  if (state.conn.state === 'connecting') return;
  state.hint = false;
  if (state.demo) stopDemo(false);
  const err = await ble.connect();
  if (err) ui.toast(err);
  schedule();
}

function toggleConnection() {
  const s = state.conn.state;
  if (s === 'connected' || s === 'reconnecting') {
    ble.disconnect();
    ui.toast('블루투스 연결이 종료되었습니다.');
    schedule();
    return;
  }
  connectNow();
}

// ---- 화면 꺼짐 방지 (연결 또는 데모 중 자동) ------------------------------
let wakeSentinel = null;
async function syncWakeLock() {
  const want = state.conn.state === 'connected' || state.demo;
  if (!('wakeLock' in navigator)) return;
  if (want && !wakeSentinel) {
    try {
      wakeSentinel = await navigator.wakeLock.request('screen');
      wakeSentinel.addEventListener('release', () => { wakeSentinel = null; });
    } catch (e) { /* 미지원 / 거부 */ }
  } else if (!want && wakeSentinel) {
    const s = wakeSentinel;
    wakeSentinel = null;
    try { await s.release(); } catch (e) { /* noop */ }
  }
}

// ---- 설정 동작 ----------------------------------------------------------
function setSound(key) {
  state.sound = key;
  audio.setProfile(key);
  ui.toast(key === 'off' ? '주행 사운드 음소거' : `주행 사운드: ${SOUND_LABEL[key]} 활성화`);
  schedule();
}

function setTheme(t) {
  // 알 수 없는 값(삭제된 테마 포함)은 미니멀로
  state.theme = THEMES.includes(t) ? t : 'minimal';
  t = state.theme;
  if (t === 'plaid') plaid.start();
  else plaid.stop();
  ui.toast(`테마 변경: ${themeName(t)}`);
  schedule();
}

function resetTrip() {
  state.trip = { startOdo: null, distKm: 0, maxSpeed: 0, maxKw: 0 };
  ui.toast('주행 트립 기록이 초기화되었습니다.');
  schedule();
}

function toggleZero() {
  const z = state.zero;
  if (z.mode === 0) {
    z.mode = 1;
    z.text = '출발대기';
    ui.toast('정차 후 가속 시 0-100km/h 측정이 자동 시작됩니다.');
  } else {
    z.mode = 0;
    z.text = '대기';
    ui.toast('0-100km/h 측정이 취소되었습니다.');
  }
  schedule();
}

function openSheet(name) {
  state.sheet = name;
  if (name === 'info' && ble.isConnected()) ble.send(208, [1]);
  if (name === 'settings') document.getElementById('pw-input').value = settings.getPassword();
  schedule();
}

function closeSheets() {
  state.sheet = null;
  schedule();
}

function savePassword() {
  const v = document.getElementById('pw-input').value.trim();
  if (v.length !== 4) {
    ui.toast('비밀번호는 4자리여야 합니다.');
    return;
  }
  settings.setPassword(v);
  if (ble.isConnected()) ble.sendPassword(v);
  ui.toast('비밀번호 저장 완료');
}

function forgetDevice() {
  settings.clearLastDevice();
  state.devName = '';
  if (state.conn.state === 'connected' || state.conn.state === 'reconnecting') ble.disconnect();
  ui.toast('저장된 기기를 지웠습니다.');
  schedule();
}

// ---- 이벤트 바인딩 ------------------------------------------------------
const ACTIONS = {
  conn: () => toggleConnection(),
  info: () => openSheet('info'),
  settings: () => openSheet('settings'),
  close: () => closeSheets(),
  chime: () => {
    state.chime = !state.chime;
    audio.setChime(state.chime);
    schedule();
  },
  mirror: () => {
    state.mirror = !state.mirror;
    ui.toast(state.mirror ? 'HUD 유리 반사 모드 켜짐' : 'HUD 유리 반사 모드 꺼짐');
    schedule();
  },
  autoconnect: () => {
    state.autoConnect = !state.autoConnect;
    settings.setAutoConnect(state.autoConnect);
    schedule();
  },
  'save-pw': () => savePassword(),
  forget: () => forgetDevice(),
  'cam-toggle': () => cam.setEnabled(!cam.isEnabled()),
  'cam-radius': (el) => cam.setRadius(Number(el.dataset.r)),
  'cam-test': () => cam.addTest(),
  'cam-import': () => document.getElementById('cam-file').click(),
  'cam-clear': () => cam.clearDb(),
  demo: () => toggleDemo(),
  zero: () => toggleZero(),
  'trip-reset': () => resetTrip(),
  fullscreen: () => toggleFullscreen(),
};

// 전체화면 토글 (§14.3). 실패하면 토스트. 상태는 fullscreenchange 로 동기화.
function toggleFullscreen() {
  const req = document.fullscreenElement
    ? document.exitFullscreen()
    : document.documentElement.requestFullscreen();
  Promise.resolve(req).catch(() => ui.toast('이 브라우저는 전체화면을 지원하지 않습니다'));
}

document.addEventListener('fullscreenchange', () => {
  state.fullscreen = !!document.fullscreenElement;
  schedule();
});
if (!document.fullscreenEnabled) {
  const fsBtn = document.getElementById('btn-fs');
  if (fsBtn) fsBtn.hidden = true;
}

document.addEventListener('click', (e) => {
  if (!(e.target instanceof Element)) return;
  const sound = e.target.closest('button[data-sound]');
  if (sound) {
    setSound(sound.dataset.sound);
    return;
  }
  const theme = e.target.closest('button[data-theme]');
  if (theme) {
    setTheme(theme.dataset.theme);
    return;
  }
  const act = e.target.closest('[data-act]');
  if (act && ACTIONS[act.dataset.act]) ACTIONS[act.dataset.act](act);
});

// 사용자 활성화: 터치 기기에서 pointerdown 은 user activation 이 아니므로 click(capture) 에서 처리.
// 첫 클릭: 전체화면 요청. 매 클릭: 오디오 컨텍스트 생성/재개. 힌트 상태면 탭 위치에 따라 블루투스 연결.
let gestureDone = false;
document.addEventListener('click', (ev) => {
  if (!gestureDone) {
    gestureDone = true;
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }
  audio.unlock();
  if (state.hint && !state.demo && ev.target instanceof Element
    && !ev.target.closest('button, input, .sheet, .scrim')) {
    state.hint = false;
    connectNow();
  }
}, { capture: true });

const previewBtn = document.getElementById('btn-preview');
previewBtn.addEventListener('pointerdown', () => {
  audio.unlock();
  if (state.sound === 'off') setSound('zimmer');
  audio.setPreview(true);
});
previewBtn.addEventListener('touchstart', () => audio.unlock(), { passive: true });
['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => {
  previewBtn.addEventListener(t, () => {
    if (t === 'pointerup') audio.unlock();
    audio.setPreview(false);
  });
});
previewBtn.addEventListener('touchend', () => audio.unlock(), { passive: true });

document.getElementById('sound-volume').addEventListener('input', (e) => {
  state.volume = Number(e.target.value);
  audio.setVolume(state.volume);
  schedule();
});

document.getElementById('cam-file').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  cam.importFile(file);
  e.target.value = '';
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) syncWakeLock();
});

// ---- 주기 작업 ----------------------------------------------------------
// 가상 RPM / 사운드는 60Hz
setInterval(() => audio.tick(state.latest.speed, state.latest.pedal, state.latest.kw, Math.max(200, state.trip.maxKw)), 1000 / 60);

async function boot() {
  cam.start();
  schedule();
  const result = await ble.autoConnect();
  if (['disabled', 'no-device', 'unavailable', 'not-found'].includes(result)) {
    state.hint = true;
  }
  schedule();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

boot();
