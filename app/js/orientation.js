// 화면 방향 전환 판단 (설계 §19.3). 순수 함수: DOM/screen API 사용 금지.
export const ORIENT_MODES = Object.freeze(['auto', 'landscape', 'portrait']);

// 자동 → 가로 → 세로 → 자동. 모르는 값은 자동으로 본다.
export function nextOrientMode(mode) {
  const i = Math.max(0, ORIENT_MODES.indexOf(mode)); // 모르는 값은 자동(0)으로 본다
  return ORIENT_MODES[(i + 1) % ORIENT_MODES.length];
}

// 현재 뷰포트가 가로인지 세로인지 (정사각형은 세로로 본다)
export function physicalOf(width, height) {
  return width > height ? 'landscape' : 'portrait';
}

// CSS 회전 대체가 필요한가: 자동이 아니고, 회전 잠금이 안 됐고, 실제 방향과 요청 방향이 다를 때
export function needsRotation(mode, lockOk, physical) {
  if (mode !== 'landscape' && mode !== 'portrait') return false;
  if (lockOk) return false;
  return mode !== physical;
}

export function isOrientMode(v) {
  return ORIENT_MODES.includes(v);
}

// §24.1: 회전 박스 크기(CSS px). visualViewport 가 있으면 그 값을, 없으면 innerWidth/innerHeight 를 쓴다.
export function viewportBox({ vvWidth, vvHeight, innerWidth, innerHeight }) {
  const w = vvWidth > 0 ? vvWidth : innerWidth;
  const h = vvHeight > 0 ? vvHeight : innerHeight;
  return { w: Math.round(w), h: Math.round(h) };
}

// §24.2: 실제 방향. screen.orientation.type(landscape-*/portrait-*)을 우선 쓰고, 없을 때만 크기로 본다.
export function actualOrientation({ type, width, height }) {
  if (typeof type === 'string') {
    if (type.startsWith('landscape')) return 'landscape';
    if (type.startsWith('portrait')) return 'portrait';
  }
  return physicalOf(width, height);
}

// §24.2: 회전 적용 판단 (순수 함수, 시간은 ms 인자).
//   - 같은 결과면 아무것도 하지 않는다.
//   - 잠금 시도 중이면 재계산하지 않는다 (잠금 결과가 나온 뒤 다시 부른다).
//   - force(↻ 버튼)면 디바운스·쿨다운 없이 즉시 적용한다.
//   - 마지막 이벤트 뒤 debounceMs, 마지막 변경 뒤 cooldownMs 가 지나야 적용한다. 덜 지났으면 남은 시간을 돌려준다.
export function rotationDecision({
  now, lastEventAt = null, lastChangeAt = null, current, want, locking = false, force = false,
  debounceMs = 400, cooldownMs = 1000,
}) {
  if (want === current) return { apply: false, waitMs: 0 };
  if (locking) return { apply: false, waitMs: 0 };
  if (force) return { apply: true, waitMs: 0 };
  const debounceLeft = lastEventAt === null ? 0 : debounceMs - (now - lastEventAt);
  const cooldownLeft = lastChangeAt === null ? 0 : cooldownMs - (now - lastChangeAt);
  const waitMs = Math.max(0, debounceLeft, cooldownLeft);
  return waitMs > 0 ? { apply: false, waitMs } : { apply: true, waitMs: 0 };
}
