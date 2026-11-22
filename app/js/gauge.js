// 신규 테마 (arc 퍼포먼스 아크, twin 트윈 다이얼, hud HUD): 클러스터 영역 전체를 SVG 한 장으로 그린다 (§14.2).
// viewBox 는 고정(세로 400x640, 가로 960x400), preserveAspectRatio meet 이라 화면비와 무관하게 잘리지 않는다.
// 세로/가로 중 어느 viewBox 를 쓸지는 클러스터 가로세로 비율(>=1 이면 가로)로 정한다 (ResizeObserver).
// 값이 바뀔 때만 속성을 갱신한다(캐시). 바늘만 CSS transition 으로 움직인다.

// 가로 viewBox 는 테마별. arc/twin 은 780x340 클러스터(약 3.6:1)에 맞춰 960x264, hud 는 960x400.
const VB = {
  arc: { p: [400, 640], l: [960, 264] },
  twin: { p: [400, 640], l: [960, 284] },
  hud: { p: [400, 640], l: [960, 400] },
};
const SPEED_MAX = 260;
const KW_MIN = -80;
const KW_MAX = 400;
const REGEN_NORM = 80;
const LIMIT_RED = '#DC2626';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const f1 = (n) => Math.round(n * 10) / 10;

// 각도: 0 = 12시, 시계 방향 양수. 반지름 r 의 점.
function pt(cx, cy, r, a) {
  const t = (a * Math.PI) / 180;
  return [cx + r * Math.sin(t), cy - r * Math.cos(t)];
}

// 호 경로 (a0 -> a1). 빈 호면 빈 문자열.
function arcD(cx, cy, r, a0, a1) {
  if (Math.abs(a1 - a0) < 0.05) return '';
  const [x0, y0] = pt(cx, cy, r, a0);
  const [x1, y1] = pt(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M${f1(x0)} ${f1(y0)}A${r} ${r} 0 ${large} ${sweep} ${f1(x1)} ${f1(y1)}`;
}

// 속도 0–260 -> 240° 호 (-120 ~ +120)
const spdAng = (v) => -120 + (240 * clamp(v, 0, SPEED_MAX)) / SPEED_MAX;
// kW -80 ~ 400 -> 240° 호
const kwAng = (k) => -120 + (240 * (clamp(k, KW_MIN, KW_MAX) - KW_MIN)) / (KW_MAX - KW_MIN);

const txt = (id, x, y, size, anchor, cls, content) =>
  `<text${id ? ` id="${id}"` : ''} x="${f1(x)}" y="${f1(y)}" font-size="${size}" text-anchor="${anchor}" dominant-baseline="central" class="${cls}">${content}</text>`;

// 눈금: 값 범위를 호 위에 배치. major 는 라벨을 단다.
function scale({ cx, cy, R, from, to, step, majorEvery, angFn, majorIn, minorIn, labelR, labelSize, fmt }) {
  let out = '';
  for (let v = from; v <= to + 1e-9; v += step) {
    const a = angFn(v);
    const major = Math.abs(v % majorEvery) < 1e-9;
    const [x1, y1] = pt(cx, cy, R - 6, a);
    const [x2, y2] = pt(cx, cy, R - (major ? majorIn : minorIn), a);
    out += `<line x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}" class="tick${major ? ' major' : ''}"/>`;
    if (major) {
      const [lx, ly] = pt(cx, cy, labelR, a);
      out += txt('', lx, ly, labelSize, 'middle', 'scale-n', fmt(v));
    }
  }
  return out;
}

// 방향지시등 아이콘 (24 단위 그리드, 기존 HTML 아이콘과 같은 경로)
const TURN_D = {
  l: 'M11 4L3 12l8 8v-5h10V9H11V4z',
  r: 'M13 4l8 8-8 8v-5H3V9h10V4z',
};
function turn(id, dir, cx, cy, size) {
  const s = size / 24;
  return `<g id="${id}" class="turn" transform="translate(${f1(cx - size / 2)} ${f1(cy - size / 2)}) scale(${f1(s)})"><path d="${TURN_D[dir]}"/></g>`;
}

// 제한속도 표지 (LIMIT + 숫자). 제한이 없으면 전체 숨김(표시 값 갱신 때 display 토글).
function limitSign(cx, cy, r) {
  return `<g id="fx-limit" class="limit"><circle cx="${cx}" cy="${cy}" r="${r}" class="limit-ring" stroke-width="${f1(r * 0.14)}"/>`
    + txt('', cx, cy - r * 0.38, f1(r * 0.3), 'middle', 'limit-k', 'LIMIT')
    + txt('fx-limit-n', cx, cy + r * 0.2, f1(r * 0.62), 'middle', 'limit-n', '--')
    + '</g>';
}

// ---- 퍼포먼스 아크 -------------------------------------------------------
function arcLayout(m) {
  // 속도 숫자 상자 네 모서리는 출력 아크 안쪽 반지름(powerR-4) - 6 안쪽에 있어야 한다 (§ 상자 모서리 기준).
  // half: 스윕 반각. 세로 240°(±120), 가로 200°(±100)로 높이를 맞춘다.
  if (m === 'p') {
    return {
      cx: 200, cy: 262, R: 180, half: 120, speedFont: 110, unitY: 150, kwX: 200, kwY: 390, frY: 424, kwFont: 40,
      limit: [70, 480, 44], turnL: [150, 480, 56], turnR: [250, 480, 56],
      powerR: 142, labelR: 158, labelSize: 16, majorIn: 16, minorIn: 11,
    };
  }
  return {
    cx: 480, cy: 193, R: 184, half: 100, speedFont: 110, unitY: 92, kwX: 840, kwY: 110, frY: 150, kwFont: 50,
    limit: [120, 80, 50], turnL: [120, 170, 56], turnR: [840, 200, 56],
    powerR: 142, labelR: 158, labelSize: 16, majorIn: 16, minorIn: 11,
  };
}

function arcSvg(m) {
  const P = arcLayout(m);
  const { cx, cy, R, half } = P;
  const ang = (v) => -half + (2 * half * clamp(v, 0, SPEED_MAX)) / SPEED_MAX;
  let s = `<defs><linearGradient id="fx-grad" gradientUnits="userSpaceOnUse" x1="${cx - R}" y1="0" x2="${cx + R}" y2="0">`
    + '<stop offset="0" stop-color="#F4F5F7"/><stop offset="1" stop-color="#E8A33D"/></linearGradient></defs>';
  s += `<path d="${arcD(cx, cy, R, -half, half)}" class="arc-bg"/>`;
  s += `<path id="arc-fill" d="" class="arc-fill" stroke="url(#fx-grad)"/>`;
  s += scale({
    cx, cy, R, from: 0, to: SPEED_MAX, step: 20, majorEvery: 40, angFn: ang,
    majorIn: P.majorIn, minorIn: P.minorIn, labelR: P.labelR, labelSize: P.labelSize, fmt: (v) => String(v),
  });
  // 안쪽 출력 아크: 오른쪽 = 출력(0–peakKw), 왼쪽 = 회생(0–80kW). 검사용 data-r 은 아크 중심 반지름.
  s += `<path d="${arcD(cx, cy, P.powerR, -half, half)}" class="arc-track" data-r="${P.powerR}" data-cx="${cx}" data-cy="${cy}"/>`;
  s += `<path id="arc-pwr" d="" class="pwr"/>`;
  s += `<path id="arc-rgn" d="" class="rgn"/>`;
  s += txt('fx-speed', cx, cy, P.speedFont, 'middle', 'spd', '--');
  s += txt('fx-unit', cx, P.unitY, 20, 'middle', 'unit', 'km/h');
  s += txt('fx-kw', P.kwX, P.kwY, P.kwFont, 'middle', 'kwv', '-- kW');
  s += txt('fx-kwfr', P.kwX, P.frY, m === 'p' ? 17 : 18, 'middle', 'kwfr', 'F:-- · R:--');
  s += limitSign(...P.limit);
  s += turn('fx-turnl', 'l', ...P.turnL);
  s += turn('fx-turnr', 'r', ...P.turnR);
  return s;
}

function arcUpdate(vals, q) {
  const P = vals.layout;
  const { cx, cy, R, powerR, half } = P;
  const ang = (v) => -half + (2 * half * clamp(v, 0, SPEED_MAX)) / SPEED_MAX;
  q.d('arc-fill', arcD(cx, cy, R, -half, ang(vals.speed)));
  const pwrA = vals.kw > 0 ? (half * Math.min(1, vals.kw / vals.peak)) : 0;
  const rgnA = vals.kw < 0 ? (half * Math.min(1, -vals.kw / REGEN_NORM)) : 0;
  q.d('arc-pwr', arcD(cx, cy, powerR, 0, pwrA));
  q.d('arc-rgn', arcD(cx, cy, powerR, 0, -rgnA));
}

// ---- 트윈 다이얼 ---------------------------------------------------------
function twinLayout(m) {
  if (m === 'p') {
    return {
      sx: 200, sy: 215, sR: 130, spdFont: 56, spdY: 292, unitY: 336,
      px: 200, py: 455, pR: 100, kwFont: 36, kwY: 530,
      limit: [56, 110, 42], turnL: [60, 455, 52], turnR: [340, 455, 52],
      labelSpd: 16, labelKw: 15, unitX: 200, unitAnchor: 'middle',
    };
  }
  return {
    // 게이지 묶음 전체를 viewBox 가로 중앙에 둔다 (§16.1). 카메라 배너는 좌상단으로 옮김(CSS).
    sx: 323, sy: 102, sR: 96, spdFont: 110, spdY: 214, unitX: 443, unitY: 200, unitAnchor: 'start',
    px: 653, py: 102, pR: 80, kwFont: 40, kwY: 200,
    limit: [496, 80, 40], turnL: [473, 252, 56], turnR: [531, 252, 56],
    labelSpd: 16, labelKw: 16,
  };
}

function twinSvg(m) {
  const P = twinLayout(m);
  let s = '';
  // 속도 다이얼
  s += `<path d="${arcD(P.sx, P.sy, P.sR, -120, 120)}" class="ring"/>`;
  s += scale({
    cx: P.sx, cy: P.sy, R: P.sR, from: 0, to: SPEED_MAX, step: 20, majorEvery: 40, angFn: spdAng,
    majorIn: 26, minorIn: 14, labelR: P.sR - 36, labelSize: P.labelSpd, fmt: (v) => String(v),
  });
  s += `<g id="tw-spd" class="needle" style="transform-origin:${P.sx}px ${P.sy}px;transform-box:view-box">`
    + `<line x1="${P.sx}" y1="${P.sy}" x2="${P.sx}" y2="${P.sy - (P.sR - 16)}" class="hand"/></g>`;
  s += `<circle cx="${P.sx}" cy="${P.sy}" r="7" class="hub"/>`;
  s += txt('fx-speed', P.sx, P.spdY, P.spdFont, 'middle', 'spd', '--');
  s += txt('fx-unit', P.unitX ?? P.sx, P.unitY, 15, P.unitAnchor || 'middle', 'unit', 'km/h');
  // 출력 다이얼: 회생 구간(녹색, -80 ~ 0kW)과 출력 구간(주황, 0 ~ 400kW)은 고정 색, 바늘은 현재값
  s += `<path d="${arcD(P.px, P.py, P.pR, -120, kwAng(0))}" class="zone-rgn"/>`;
  s += `<path d="${arcD(P.px, P.py, P.pR, kwAng(0), 120)}" class="zone-pwr"/>`;
  s += scale({
    cx: P.px, cy: P.py, R: P.pR, from: KW_MIN, to: KW_MAX, step: 40, majorEvery: 80,
    angFn: kwAng, majorIn: 18, minorIn: 10, labelR: P.pR - 28, labelSize: P.labelKw,
    fmt: (v) => String(v),
  });
  s += `<g id="tw-kw" class="needle" style="transform-origin:${P.px}px ${P.py}px;transform-box:view-box">`
    + `<line x1="${P.px}" y1="${P.py}" x2="${P.px}" y2="${P.py - (P.pR - 12)}" class="hand pwr-hand"/></g>`;
  s += `<circle cx="${P.px}" cy="${P.py}" r="6" class="hub"/>`;
  s += txt('fx-kw', P.px, P.kwY, P.kwFont, 'middle', 'kwv', '-- kW');
  if (m === 'p') s += txt('fx-kwfr', P.px, P.kwY + 34, 16, 'middle', 'kwfr', 'F:-- · R:--');
  s += limitSign(...P.limit);
  s += turn('fx-turnl', 'l', ...P.turnL);
  s += turn('fx-turnr', 'r', ...P.turnR);
  return s;
}

function twinUpdate(vals, q) {
  q.rotate('tw-spd', f1(spdAng(vals.speed)));
  q.rotate('tw-kw', f1(kwAng(vals.kw)));
}

// ---- HUD -----------------------------------------------------------------
function hudLayout(m) {
  if (m === 'p') {
    return { cx: 200, spdY: 300, spdFont: 190, unitY: 440, unitFont: 40, limit: [200, 120, 46], turnL: [120, 530, 60], turnR: [280, 530, 60] };
  }
  return { cx: 480, spdY: 180, spdFont: 210, unitY: 346, unitFont: 44, limit: [860, 90, 52], turnL: [110, 200, 80], turnR: [850, 200, 80] };
}

function hudSvg(m) {
  const P = hudLayout(m);
  let s = txt('fx-speed', P.cx, P.spdY, P.spdFont, 'middle', 'spd hud-spd', '--');
  s += txt('fx-unit', P.cx, P.unitY, P.unitFont, 'middle', 'unit', 'km/h');
  s += limitSign(...P.limit);
  s += turn('fx-turnl', 'l', ...P.turnL);
  s += turn('fx-turnr', 'r', ...P.turnR);
  return s;
}

function hudUpdate() {}

const BUILD = { arc: arcSvg, twin: twinSvg, hud: hudSvg };
const LAYOUT = { arc: arcLayout, twin: twinLayout, hud: hudLayout };
const UPDATE = { arc: arcUpdate, twin: twinUpdate, hud: hudUpdate };

export const GAUGE_THEMES = Object.freeze(['arc', 'twin', 'hud']);

function isNightHour(date = new Date()) {
  const h = date.getHours();
  return h >= 19 || h < 6;
}

// svg: 클러스터 안의 <svg id="fx">, cluster: viewBox 비율을 재는 요소(#cluster)
export function createGauge(svg, cluster) {
  let mode = null;
  let theme = null;
  let built = false;
  const cache = new Map();

  function currentMode() {
    const r = cluster.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return r.width / r.height >= 1 ? 'l' : 'p';
  }

  function build(t, m) {
    const [w, h] = VB[t][m];
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML = BUILD[t](m);
    cache.clear();
    built = true;
    theme = t;
    mode = m;
  }

  // 요소 갱신 도우미: 값이 같으면 DOM 을 건드리지 않는다.
  const q = {
    el: (id) => svg.querySelector(`#${id}`),
    text(id, v) {
      const el = q.el(id);
      if (!el) return;
      const k = `t:${id}`;
      if (cache.get(k) === v) return;
      cache.set(k, v);
      el.textContent = v;
    },
    cls(id, name, on) {
      const el = q.el(id);
      if (!el) return;
      const k = `c:${id}:${name}`;
      if (cache.get(k) === !!on) return;
      cache.set(k, !!on);
      el.classList.toggle(name, !!on);
    },
    show(id, on) {
      const el = q.el(id);
      if (!el) return;
      const k = `s:${id}`;
      if (cache.get(k) === !!on) return;
      cache.set(k, !!on);
      el.style.display = on ? '' : 'none';
    },
    d(id, v) {
      const el = q.el(id);
      if (!el) return;
      const k = `d:${id}`;
      if (cache.get(k) === v) return;
      cache.set(k, v);
      el.setAttribute('d', v);
    },
    // 바늘 회전: 인라인 transform 만 바꾼다(transform-origin 은 마크업에 있다).
    rotate(id, deg) {
      const el = q.el(id);
      if (!el) return;
      const k = `r:${id}`;
      if (cache.get(k) === deg) return;
      cache.set(k, deg);
      el.style.transform = `rotate(${deg}deg)`;
    },
  };

  function update(s) {
    const t = s.theme;
    if (!GAUGE_THEMES.includes(t)) return;
    const m = mode || currentMode();
    if (!m) return;
    if (!built || t !== theme || m !== mode) build(t, m);
    const tel = s.telem;
    const speed = tel ? tel.speed : 0;
    const kw = tel ? tel.totalKw : 0;
    const limit = tel && tel.limitSpd > 0 ? tel.limitSpd : null;
    const vals = {
      layout: LAYOUT[t](m),
      speed: speed,
      kw,
      peak: Math.max(200, s.trip.maxKw),
      front: tel ? tel.frontKw : 0,
      rear: tel ? tel.rearKw : 0,
      over: limit != null && speed > limit,
    };

    svg.dataset.night = t === 'hud' && isNightHour() ? '1' : '';
    q.text('fx-speed', String(Math.round(speed)));
    q.text('fx-unit', tel && tel.speedUnit === 0 ? 'mph' : 'km/h');
    q.text('fx-kw', `${Math.round(kw)} kW`);
    q.text('fx-kwfr', `F:${Math.round(vals.front)} · R:${Math.round(vals.rear)}`);
    q.show('fx-limit', limit != null);
    q.text('fx-limit-n', limit != null ? String(limit) : '--');
    q.cls('fx-limit', 'over', vals.over);
    // 초과 시 속도 숫자 빨강은 HUD 테마만 (§14.2)
    q.cls('fx-speed', 'over', vals.over && t === 'hud');
    q.cls('fx-turnl', 'on', tel && (tel.turn & 1));
    q.cls('fx-turnr', 'on', tel && (tel.turn & 2));
    UPDATE[t](vals, q);
  }

  // 클러스터 크기가 바뀌면(세로/가로 전환) 같은 상태로 다시 그린다.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      const m = currentMode();
      if (!m || m === mode) return;
      mode = m;
      built = false;
      if (lastState) update(lastState);
    }).observe(cluster);
  }
  let lastState = null;

  return {
    update(s) {
      lastState = s;
      update(s);
    },
    get mode() { return mode; },
    // 테스트/디버그용: 현재 빌드된 viewBox
    get viewBox() { return svg.getAttribute('viewBox'); },
  };
}
