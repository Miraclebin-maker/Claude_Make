// DOM 렌더링. render(state) 가 화면 전체를 상태에서 그린다. 이벤트 바인딩은 main.js 가 담당.
import { createGauge } from './gauge.js';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const CONN_LABEL = {
  idle: 'BLE 연결',
  connecting: '연결 중',
  searching: '기기 찾는 중',
  reconnecting: '재연결 중',
};
const WAKE_LABEL = { unsupported: '이 브라우저는 지원하지 않음', on: '사용 중', off: '대기' };
const THEME_NAMES = { minimal: '미니멀', plaid: '플래드 워프', arc: '퍼포먼스 아크', twin: '트윈 다이얼', hud: 'HUD' };

export function themeName(key) {
  return THEME_NAMES[key] || key;
}

export function createUi() {
  const nodes = new Map();
  const last = new Map();
  let gauge = null;

  function node(id) {
    let n = nodes.get(id);
    if (n === undefined) {
      n = document.getElementById(id);
      nodes.set(id, n);
    }
    return n;
  }

  function text(id, value) {
    const s = String(value);
    if (last.get(id) === s) return;
    last.set(id, s);
    const n = node(id);
    if (n) n.textContent = s;
  }

  function cls(id, on, name) {
    const n = node(id);
    if (n) n.classList.toggle(name, !!on);
  }

  function show(id, on) {
    const n = node(id);
    if (n) n.hidden = !on;
  }

  function style(id, prop, value) {
    const n = node(id);
    if (n) n.style[prop] = value;
  }

  const fmt1 = (v, unit = '') => (v == null || Number.isNaN(v) ? '--' : `${Number(v).toFixed(1)}${unit}`);
  const fmtInt = (v, unit = '') => (v == null || Number.isNaN(v) ? '--' : `${Math.round(v)}${unit}`);

  function renderConn(s) {
    const dot = node('conn-dot');
    if (dot) dot.dataset.state = s.demo ? 'demo' : s.conn.state;
    let label;
    if (s.demo) label = '데모';
    else if (s.conn.state === 'connected') label = s.conn.name || '연결됨';
    else label = CONN_LABEL[s.conn.state] || 'BLE 연결';
    text('conn-label', label);
    show('hint', s.hint && !s.demo);
  }

  // 신규 테마용 SVG 게이지 (lazy: DOM 준비 뒤 한 번)
  function gaugeOf() {
    if (!gauge) gauge = createGauge(node('fx'), node('cluster'));
    return gauge;
  }

  function renderGauge(s) {
    const t = s.telem;
    const speed = t ? t.speed : 0;
    const kw = t ? t.totalKw : 0;

    document.querySelectorAll('[data-gear]').forEach((el) => {
      el.classList.toggle('on', !!t && Number(el.dataset.gear) === t.gear);
    });
    show('ap-chip', t && (t.ap === 1 || t.ap === 2));
    text('val-soc', t && t.soc != null ? t.soc : '--');
    text('val-range', t && t.rangeKm != null ? t.rangeKm : '--');

    const limit = t && t.limitSpd > 0 ? t.limitSpd : null;
    text('val-limit', limit != null ? limit : '--');
    cls('limit', limit != null && speed > limit, 'over');

    style('bar-regen', 'width', `${kw < 0 ? clamp((-kw / 65) * 100, 0, 100) : 0}%`);
    style('bar-power', 'width', `${kw > 0 ? clamp((kw / 260) * 100, 0, 100) : 0}%`);
    text('val-kw', Math.round(kw));
    cls('val-kw', kw < 0, 'regen');
    text('val-front', t ? t.frontKw : 0);
    text('val-rear', t ? t.rearKw : 0);

    text('val-speed', speed);
    text('val-unit', t && t.speedUnit === 0 ? 'mph' : 'km/h');
    text('val-pedal', t ? t.pedal : 0);
    cls('turn-l', t && (t.turn & 1), 'on');
    cls('turn-r', t && (t.turn & 2), 'on');
    cls('val-speed', s.plaidHyper && s.theme === 'plaid', 'glow');
    show('hands-alert', t && t.handsOn);

    const cb = s.cam.banner;
    show('cam-banner', !!cb);
    if (cb) {
      text('cam-limit', cb.limit);
      text('cam-limit-2', cb.limit);
      text('cam-dist', `${cb.distM}m`);
    }

    gaugeOf().update(s);
  }

  function renderInfo(s) {
    const t = s.telem;
    for (let i = 0; i < 4; i++) {
      const p = t && t.tpms ? t.tpms[i] : null;
      text(`tpms-${i}`, p != null ? `${p.toFixed(1)} PSI` : '-- PSI');
      const b = t && t.bTemps ? t.bTemps[i] : null;
      text(`brk-${i}`, b != null ? `${Math.round(b)}°C` : '--°C');
    }
    const hv = s.hv;
    text('hv-vol', hv ? `${hv.voltage.toFixed(1)} V` : '-- V');
    text('hv-cur', hv ? `${hv.current.toFixed(1)} A` : '-- A');
    text('hv-rem', hv ? `${hv.remainKwh.toFixed(1)} kWh` : '-- kWh');
    text('hv-full', hv ? `${hv.fullKwh.toFixed(1)} kWh` : '-- kWh');
    text('hv-batt-temp', t ? `${fmt1(t.battTemp)} °C` : '-- °C');

    text('trip-dist', `${s.trip.distKm.toFixed(1)} km`);
    text('trip-max-spd', `${Math.round(s.trip.maxSpeed)} km/h`);
    text('trip-max-kw', `${Math.round(s.trip.maxKw)} kW`);
    text('zero-status', s.zero.text);

    text('veh-odo', t ? `${t.odo.toFixed(1)} km` : '-- km');
    text('veh-temp', t ? `${fmt1(t.cabinTemp, '°C')} / ${fmt1(t.ambTemp, '°C')}` : '-- / --');
    text('veh-alt', t ? `${fmtInt(t.alt, ' m')}` : '-- m');
    text('veh-hvac', t ? fmtInt(t.hvacWatts, ' W') : '-- W');
    text('veh-hw', `HW-${s.hw != null ? s.hw : '--'}`);
    text('veh-ap', t ? (t.ap === 1 || t.ap === 2 ? 'AP 활성' : 'AP 대기') : '--');
  }

  function renderSettings(s) {
    document.querySelectorAll('[data-sound]').forEach((b) => {
      const on = b.dataset.sound === s.sound;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    document.querySelectorAll('[data-theme]').forEach((b) => {
      const on = b.dataset.theme === s.theme;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const vol = node('sound-volume');
    if (vol && Number(vol.value) !== s.volume) vol.value = String(s.volume);
    text('volume-val', s.volume);
    text('wake-status', WAKE_LABEL[s.wake] || '--');
    text('btn-chime', `경고음: ${s.chime ? 'ON' : 'OFF'}`);
    cls('btn-chime', s.chime, 'on');
    text('btn-mirror', s.mirror ? 'ON' : 'OFF');
    cls('btn-mirror', s.mirror, 'on');
    text('btn-autoconnect', s.autoConnect ? 'ON' : 'OFF');
    cls('btn-autoconnect', s.autoConnect, 'on');
    text('dev-name', s.devName || '없음');
    text('btn-cam', s.cam.enabled ? 'ON' : 'OFF');
    cls('btn-cam', s.cam.enabled, 'on');
    text('gps-badge', `GPS ${s.cam.gps}`);
    document.querySelectorAll('[data-r]').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.r) === s.cam.radius);
    });
    text('cam-count', `${s.cam.count.toLocaleString()} 개`);
    text('btn-demo', s.demo ? '데모 중지' : '데모 시작');
    cls('btn-demo', s.demo, 'on');
    text('btn-zero', s.zero.mode === 0 ? '0-100 측정 시작' : '0-100 측정 취소');
  }

  // 사각지대 경보 (§19.5): 켜진 쪽 가장자리 글로우. 같은 쪽 방향지시등이 켜져 있으면 강하게.
  function renderBlind(s) {
    const el = node('blind');
    if (!el) return;
    const t = s.telem;
    const turnL = !!(t && (t.turn & 1));
    const turnR = !!(t && (t.turn & 2));
    cls('blind', s.blindLeft, 'on-l');
    cls('blind', s.blindRight, 'on-r');
    cls('blind', s.blindLeft && turnL, 'strong-l');
    cls('blind', s.blindRight && turnR, 'strong-r');
    cls('blind', s.mirror, 'mirror');
  }

  function render(s) {
    const root = document.documentElement;
    if (root.dataset.theme !== s.theme) root.dataset.theme = s.theme;
    cls('cluster', s.mirror, 'mirror');
    renderConn(s);
    renderGauge(s);
    renderInfo(s);
    renderSettings(s);
    renderBlind(s);
    show('ic-orient-auto', s.orient === 'auto');
    show('ic-orient-landscape', s.orient === 'landscape');
    show('ic-orient-portrait', s.orient === 'portrait');
    show('fs-expand', !s.fullscreen);
    show('fs-collapse', !!s.fullscreen);
    show('scrim', !!s.sheet);
    show('sheet-info', s.sheet === 'info');
    show('sheet-settings', s.sheet === 'settings');
  }

  let toastTimer = null;
  function toast(msg) {
    text('toast-msg', msg);
    const el = node('toast');
    if (!el) return;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  // 풀 가속 진입 시 화면 미세 진동 0.3초 (reduced-motion 이면 생략)
  function flashShake() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const app = node('app');
    if (!app) return;
    app.classList.remove('shake');
    void app.offsetWidth; // 애니메이션 재시작
    app.classList.add('shake');
    setTimeout(() => app.classList.remove('shake'), 300);
  }

  return { render, toast, flashShake };
}
