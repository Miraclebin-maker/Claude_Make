// 진입점: 상태 보관, 모듈 연결, 이벤트 바인딩, 트립/0-100 로직, 화면 꺼짐 방지.
import { TslBle } from './ble.js';
import { parseTelemetry176, parseHvPack208 } from './protocol.js';
import * as settings from './settings.js';
import { createUi, themeName } from './ui.js';
import { createAudio } from './audio/audio.js';
import { createCameraWatch } from './camera.js';
import { createDemo, DEMO_HV } from './demo.js';
import { createPlaid } from './plaid.js';
import { APP_VERSION, APP_FILES } from './version.js';
import { controllerChangeAction } from './update-policy.js';
import { nextOrientMode, needsRotation, isOrientMode, viewportBox, actualOrientation, rotationDecision } from './orientation.js';

const SOUND_LABEL = {
  off: '음소거',
  zimmer: '한스짐머 EV',
  plaid: '플래드 워프',
  v10: 'V10 슈퍼카',
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
  theme: settings.getTheme(), // §24.5: 저장값
  mirror: settings.getMirror(),
  sound: 'off', // §24.5: 시작 때는 항상 음소거 (저장된 음원을 복원하지 않는다)
  latency: settings.getLatency(), // 블루투스 지연 보정 설정 (§26.2)
  latencyText: '', // 적용값 표시 문구 (audio 가 정한다)
  volume: settings.getVolume(),
  chime: settings.getChime(), // 기본 OFF (§16.2)
  wake: 'off', // 화면 켜짐 상태: unsupported | on | off (§16.3)
  autoConnect: settings.isAutoConnect(),
  devName: savedDevice ? savedDevice.name : '',
  cam: { enabled: settings.isCamEnabled(), radius: settings.getCamRadius(), gps: '대기', count: 0, banner: null },
  plaidHyper: false,
  quit: false, // 종료 후 true: 연결·재생·GPS·화면 꺼짐 방지를 모두 막는다
  orient: settings.getOrient(), // 화면 방향 선택 (§19.3)
  lockOk: false, // 회전 잠금에 성공했는지
  lockResult: 'na', // 진단용: 'ok' | 'fail' | 'na' (§24.3)
  locking: false, // 잠금 요청 대기 중이면 회전을 다시 계산하지 않는다 (§24.2)
  blindLeft: false, // 사각지대 경보 (§19.5). 실제 176 파서에는 필드가 없어 데모만 켠다
  blindRight: false,
  sheet: null,
  latest: { speed: 0, pedal: 0, kw: 0 },
  fullscreen: false,
};

const ui = createUi();
const audio = createAudio();
audio.setChime(settings.getChime());
state.latencyText = audio.latencyLabel();
setInterval(() => { // 자동 값은 컨텍스트가 생긴 뒤 바뀌므로 1초마다 표시를 맞춘다 (§26.2)
  const t = audio.latencyLabel();
  if (t !== state.latencyText) { state.latencyText = t; schedule(); }
}, 1000);
const plaid = createPlaid(document.getElementById('plaid-canvas'));
if (state.theme === 'plaid') plaid.start(); // §24.5: 저장된 테마가 플레이드면 시작 시 바로 그린다
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
  // 차량 속도: 연결 중이거나 데모일 때만 텔레메트리 값 (끊긴 뒤의 낡은 값은 쓰지 않는다)
  getSpeedKmh: () => ((state.demo || state.conn.state === 'connected') && state.telem ? state.telem.speed : null),
});
state.cam.count = cam.count();

// Web Bluetooth 전용 (§25: 웹 방식으로만 제작)
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

  // 사각지대: 켜지는 순간 같은 쪽 방향지시등이 켜져 있으면 경고음 1회 (경고음 설정이 ON일 때만 소리 난다)
  const bl = !!f.blindLeft;
  const br = !!f.blindRight;
  if (bl && !state.blindLeft && (f.turn & 1)) audio.playChime();
  if (br && !state.blindRight && (f.turn & 2)) audio.playChime();
  state.blindLeft = bl;
  state.blindRight = br;

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
  if (state.quit || state.conn.state === 'connecting') return;
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
// 화면 켜짐 유지 (§16.3): 앱이 보이는 동안 항상 요청. 종료 후에는 요청하지 않는다.
let wakeSentinel = null;
let wakeBusy = false;
let wakePending = false;
const wakeWanted = () => !state.quit && !document.hidden;

async function applyWakeLock() {
  if (wakeWanted() && !wakeSentinel) {
    try {
      const s = await navigator.wakeLock.request('screen');
      wakeSentinel = s;
      s.addEventListener('release', () => {
        if (wakeSentinel === s) wakeSentinel = null;
        state.wake = 'off';
        schedule();
        // 시스템이 해제했지만 아직 보이는 상태면 다시 요청
        if (wakeWanted()) syncWakeLock();
      });
    } catch (e) { /* 거부: 다음 가시성 변화 때 다시 시도 */ }
  } else if (!wakeWanted() && wakeSentinel) {
    const s = wakeSentinel;
    wakeSentinel = null;
    try { await s.release(); } catch (e) { /* noop */ }
  }
}

async function syncWakeLock() {
  if (!('wakeLock' in navigator)) {
    state.wake = 'unsupported';
    schedule();
    return;
  }
  if (wakeBusy) {
    wakePending = true;
    return;
  }
  wakeBusy = true;
  try {
    do {
      wakePending = false;
      await applyWakeLock();
    } while (wakePending);
  } finally {
    wakeBusy = false;
  }
  state.wake = wakeSentinel ? 'on' : 'off';
  schedule();
}

// ---- 설정 동작 ----------------------------------------------------------
function setSound(key) {
  state.sound = key;
  audio.setProfile(key);
  if (key === 'v10') ui.toast('V10 사운드 불러오는 중');
  else ui.toast(key === 'off' ? '주행 사운드 음소거' : `주행 사운드: ${SOUND_LABEL[key]} 활성화`);
  schedule();
}

// 블루투스 지연 보정 선택 (§26.2). 선택은 저장한다(audio 가 저장).
function setLatency(v) {
  state.latency = v;
  audio.setLatency(v);
  state.latencyText = audio.latencyLabel();
  schedule();
}

function setTheme(t) {
  // 알 수 없는 값(삭제된 테마 포함)은 미니멀로
  state.theme = THEMES.includes(t) ? t : settings.DEFAULT_THEME;
  t = state.theme;
  settings.setTheme(t);
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
  'refresh-app': () => refreshApp(),
  orient: () => applyOrient(nextOrientMode(state.orient)),
  quit: () => quitApp(),
  restart: () => location.reload(),
  conn: () => toggleConnection(),
  info: () => openSheet('info'),
  settings: () => openSheet('settings'),
  close: () => closeSheets(),
  chime: () => {
    state.chime = !state.chime;
    settings.setChime(state.chime);
    audio.setChime(state.chime);
    schedule();
  },
  mirror: () => {
    state.mirror = !state.mirror;
    settings.setMirror(state.mirror);
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

// 전체화면 진입: 저장된 방향이 가로/세로면 잠금을 다시 시도한다(성공하면 CSS 회전 해제, §21).
// 나올 때: 잠금은 풀리므로 실제 방향과 저장된 방향을 비교해 CSS 회전 여부를 다시 정한다.
document.addEventListener('fullscreenchange', async () => {
  state.fullscreen = !!document.fullscreenElement;
  updateFullscreenClass();
  if (document.fullscreenElement) {
    if (state.orient !== 'auto') await lockTo(state.orient);
  } else {
    cancelLock();
    state.lockOk = false;
    state.lockResult = 'na';
  }
  requestRotation();
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
  const lat = e.target.closest('button[data-latency]');
  if (lat) {
    setLatency(lat.dataset.latency);
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
// 첫 탭은 자동 전체화면을 요청하지 않는다 (§21). 오디오 잠금 해제와 연결 힌트만 맡는다.
document.addEventListener('click', (ev) => {
  if (state.quit) return;
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
  syncWakeLock(); // 보이면 요청, 숨겨지면 해제 (§16.3)
  audio.setPageHidden(document.hidden); // 숨기면 오디오 suspend (§22)
});

// 테스트 전용: 경고음을 강제로 한 번 울린다 (§22 스모크가 음소거 상태의 경고음 깨움을 검사). 사용자 동작에는 영향 없음.
document.addEventListener('tsl:test-chime', () => audio.playChime(true));

// ---- 주기 작업 ----------------------------------------------------------
// 가상 RPM / 사운드는 60Hz
setInterval(() => audio.tick(state.latest.speed, state.latest.pedal, state.latest.kw, Math.max(200, state.trip.maxKw)), 1000 / 60);

async function boot() {
  requestRotation({ force: true });
  cam.start();
  syncWakeLock();
  schedule();
  const result = await ble.autoConnect();
  if (['disabled', 'no-device', 'unavailable', 'not-found'].includes(result)) {
    state.hint = true;
  }
  schedule();
}

// ---- 버전·캐시 (§15.1, §15.2) ------------------------------------------
// 새로고침 버튼: 서비스워커 해제, 캐시 전부 삭제, 파일을 HTTP 캐시까지 새로 받고, 다시 로드한다. 설정(localStorage)은 유지.
async function refreshApp() {
  ui.toast('최신 버전을 불러옵니다');
  setTimeout(async () => {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      // 서버 max-age 때문에 브라우저 HTTP 캐시에 옛 파일이 남는 것을 막는다
      await Promise.all(APP_FILES.map((u) => fetch(u, { cache: 'reload' }).catch(() => {})));
    } catch (e) { /* 실패해도 다시 로드한다 */ }
    location.reload();
  }, 400);
}

// 종료 (§15.3): 모든 기능을 멈추고 창 닫기를 시도한다. 닫히지 않으면 종료 오버레이를 보인다.
function quitApp() {
  if (state.quit) return;
  state.quit = true;
  state.sheet = null;
  state.hint = false;
  if (state.demo) stopDemo(false);
  ble.shutdown();
  cam.stop();
  plaid.stop();
  audio.close();
  syncWakeLock();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  schedule();
  try { window.close(); } catch (e) { /* 스크립트로 닫을 수 없는 탭 */ }
  setTimeout(() => {
    document.getElementById('quit-overlay').hidden = false;
  }, 300);
}

document.getElementById('app-version').textContent = APP_VERSION;

// ---- 화면 방향 (§19.3, §24) ---------------------------------------------
// 자동/가로/세로. 잠금이 되면 그대로 두고, 안 되면 앱 루트를 CSS로 돌려 같은 모양을 낸다.
// §24: 크기는 측정한 보이는 영역(--vw/--vh), 실제 방향은 screen.orientation 우선, 디바운스 400ms·쿨다운 1초.
const ROT_DEBOUNCE_MS = 400;
const ROT_COOLDOWN_MS = 1000;
const rotTiming = { lastEventAt: null, lastChangeAt: null, timer: 0, box: null };
const appEl = document.getElementById('app');
const ORIENT_LABEL = { auto: '자동', landscape: '가로', portrait: '세로' };
const LOCK_LABEL = { ok: '성공', fail: '실패', na: '해당 없음' };

function measureBox() {
  const vv = window.visualViewport;
  const box = viewportBox({
    vvWidth: vv && vv.width, vvHeight: vv && vv.height,
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
  });
  document.documentElement.style.setProperty('--vw', `${box.w}px`);
  document.documentElement.style.setProperty('--vh', `${box.h}px`);
  rotTiming.box = box;
  return box;
}

function wantRotation(box) {
  const type = screen.orientation && screen.orientation.type;
  const phys = actualOrientation({ type, width: box.w, height: box.h });
  return needsRotation(state.orient, state.lockOk, phys);
}

// 방향 진단 한 줄 (§24.3): 요청 · 잠금 · 회전
function renderOrientDiag() {
  const el = document.getElementById('orient-diag');
  if (!el) return;
  const rot = appEl.classList.contains('rot');
  el.textContent = `요청 ${ORIENT_LABEL[state.orient] || '자동'} · 잠금 ${LOCK_LABEL[state.lockResult] || '해당 없음'} · 회전 ${rot ? '적용' : '없음'}`;
}

// 입력(resize, fullscreenchange 등)은 다음 프레임에 측정하고 디바운스 뒤 판단한다. force(↻ 버튼, 부팅)는 즉시.
function requestRotation({ force = false } = {}) {
  if (force) {
    measureBox();
    clearTimeout(rotTiming.timer);
    applyRotation(true);
    return;
  }
  requestAnimationFrame(() => {
    measureBox();
    rotTiming.lastEventAt = performance.now();
    scheduleRotation(ROT_DEBOUNCE_MS);
  });
}

function scheduleRotation(delayMs) {
  clearTimeout(rotTiming.timer);
  rotTiming.timer = setTimeout(() => applyRotation(false), delayMs);
}

function applyRotation(force) {
  rotTiming.timer = 0;
  const now = performance.now();
  const want = wantRotation(rotTiming.box || measureBox());
  const d = rotationDecision({
    now, lastEventAt: rotTiming.lastEventAt, lastChangeAt: rotTiming.lastChangeAt,
    current: appEl.classList.contains('rot'), want, locking: state.locking, force,
    debounceMs: ROT_DEBOUNCE_MS, cooldownMs: ROT_COOLDOWN_MS,
  });
  if (!d.apply) {
    if (d.waitMs > 0) scheduleRotation(d.waitMs);
    renderOrientDiag();
    return;
  }
  appEl.classList.toggle('rot', want);
  rotTiming.lastChangeAt = now;
  renderOrientDiag();
  schedule();
}

// §24 진단: 잠금을 새로 건다. 이전 잠금을 먼저 풀어야 새 방향이 확실히 걸리고, 실패하면 잠금 상태를 정직하게 'fail'로 남긴다.
// 잠금 대기 중에는 locking 이 true 라서 회전을 다시 계산하지 않는다.
// 잠금 요청에 순번을 붙인다. 더 새 요청(또는 취소)이 있으면 늦게 끝난 이전 결과는 버린다 (§24.2 경쟁 방지).
let lockSeq = 0;
function cancelLock() {
  lockSeq += 1;
  state.locking = false;
}
async function lockTo(mode) {
  const seq = ++lockSeq;
  state.locking = true;
  let ok = false;
  try {
    try { screen.orientation.unlock(); } catch (e) { /* 미지원 */ }
    await screen.orientation.lock(mode);
    ok = true;
  } catch (e) {
    ok = false;
  }
  if (seq !== lockSeq) return; // 더 새 요청이나 취소가 있었다
  state.locking = false;
  state.lockOk = ok;
  state.lockResult = ok ? 'ok' : 'fail';
}

// 방향 버튼은 전체화면을 스스로 요청하지 않는다 (§21). 이미 전체화면이면 잠금을 시도하고,
// 아니거나 실패하면 CSS 회전 대체(§19.3)로 간다. 버튼은 즉시 반영한다 (§24.2).
async function applyOrient(mode) {
  if (!isOrientMode(mode)) return;
  state.orient = mode;
  settings.setOrient(mode);
  cancelLock(); // 이전 잠금 요청의 늦은 결과는 무시한다
  state.lockOk = false;
  state.lockResult = 'na';
  if (mode === 'auto') {
    try { screen.orientation.unlock(); } catch (e) { /* 미지원 */ }
  } else if (document.fullscreenElement) {
    await lockTo(mode); // 실패하면 CSS 회전으로 대체
  }
  requestRotation({ force: true });
  schedule(); // 방향 아이콘·진단 줄 갱신
  ui.toast(mode === 'auto' ? '화면 방향: 자동' : `화면 방향: ${mode === 'landscape' ? '가로' : '세로'}`);
}

window.addEventListener('resize', () => requestRotation());
window.addEventListener('orientationchange', () => requestRotation());
if (window.visualViewport) window.visualViewport.addEventListener('resize', () => requestRotation());

// 실제 전체화면 여부 (§20.1, §21): html.is-fullscreen 은 document.fullscreenElement 가 있을 때만.
// 홈 화면 앱(standalone)은 상단바 아래에서 시작하므로 브라우저 탭과 같은 규칙을 따른다.
function updateFullscreenClass() {
  document.documentElement.classList.toggle('is-fullscreen', !!document.fullscreenElement);
}
updateFullscreenClass();

// 종료 버튼 (§20.2): 1초 길게 눌러야 종료. 진행 링이 차오르고, 짧게 누르면 안내만 한다.
(function attachExitHold() {
  const EXIT_HOLD_MS = 1000;
  const btn = document.getElementById('btn-exit');
  const circle = btn.querySelector('.ring circle');
  let t0 = 0;
  let raf = 0;
  const setProgress = (p) => { circle.style.strokeDashoffset = String(100 * (1 - p)); };
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    t0 = 0;
    setProgress(0);
  };
  const tick = () => {
    const p = Math.min(1, (performance.now() - t0) / EXIT_HOLD_MS);
    setProgress(p);
    if (p >= 1) {
      stop();
      quitApp();
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  btn.addEventListener('pointerdown', (e) => {
    if (state.quit || t0) return;
    e.preventDefault();
    t0 = performance.now();
    raf = requestAnimationFrame(tick);
  });
  btn.addEventListener('pointerup', () => {
    if (!t0) return;
    const short = performance.now() - t0 < EXIT_HOLD_MS;
    stop();
    if (short) ui.toast('길게 누르면 종료됩니다');
  });
  const cancel = () => { if (t0) stop(); };
  btn.addEventListener('pointercancel', cancel);
  btn.addEventListener('pointerleave', cancel);
})();

if ('serviceWorker' in navigator) {
  // 설정 파일을 HTTP 캐시에서 읽지 않도록 워커 스크립트를 항상 서버에서 확인한다.
  const hadController = !!navigator.serviceWorker.controller;
  let swReloaded = false;
  let swToasted = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // 새 워커가 제어권을 가져갔다. 미연결이면 새 파일로 한 번만 다시 로드(무한 새로고침 방지).
    // 주행 중·데모 중이면 새로고침하지 않고 안내만 한 번 띄운다 (§15.1).
    if (!hadController) return;
    const action = controllerChangeAction({ connState: state.conn.state, demo: state.demo });
    if (action === 'reload') {
      if (swReloaded) return;
      swReloaded = true;
      location.reload();
      return;
    }
    if (!swToasted) {
      swToasted = true;
      ui.toast('새 버전이 준비되었습니다 · 설정 › 앱에서 새로고침');
    }
  });
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
}

boot();
