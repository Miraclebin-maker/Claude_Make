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
