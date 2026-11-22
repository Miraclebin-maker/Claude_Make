// 가상 변속기: 속도·페달에서 엔진 RPM 을 만든다 (§18.1). 순수 함수 (DOM/AudioContext 사용 금지).
export const GEARS = Object.freeze([3.2, 2.3, 1.75, 1.4, 1.15, 0.95, 0.8]); // 7단 기어비
export const FINAL_DRIVE = 3.6;
export const WHEEL_CIRC_M = 2.0;
export const IDLE_RPM = 950;
export const REDLINE_RPM = 8800;
export const SHIFT_BLEND_SEC = 0.12; // 변속 시 RPM 이 새 기어 값으로 옮겨 가는 시간
export const SHIFT_LOCK_SEC = 0.35; // 변속 후 재변속 금지 시간
export const SMOOTH_TAU = 0.08; // 출력 RPM 스무딩
export const STOP_KMH = 2; // 이보다 느리면 정차로 본다
export const WOBBLE_RPM = 20; // 정차 공회전 흔들림 진폭
export const WOBBLE_PERIOD_SEC = 1.6;
export const REV_RISE_SEC = 0.15; // 정차 중 페달 레브 상승
export const REV_FALL_SEC = 0.35; // 하강

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// 바퀴 회전으로 본 엔진 RPM (기어 g: 1..7)
export function wheelRpm(speedKmh, gear) {
  return ((speedKmh / 3.6) / WHEEL_CIRC_M) * 60 * GEARS[gear - 1] * FINAL_DRIVE;
}

// 업시프트 기준 RPM: 페달이 깊을수록 높게 올라간다.
export function upshiftRpm(pedalPct) {
  return (0.45 + 0.47 * clamp(pedalPct / 100, 0, 1)) * REDLINE_RPM;
}

export function createRpmModel() {
  return {
    gear: 1,
    shiftFrom: null, // 변속 시작 시점의 표시 RPM
    shiftT: 0,
    lock: 0, // 재변속 금지 남은 시간
    rev: IDLE_RPM, // 정차 공회전 레브 상태
    phase: 0,
    rpm: IDLE_RPM, // 출력(스무딩 후)
  };
}

// 한 틱 진행. 반환: { rpm, gear, event: null | 'upshift' | 'downshift' }
export function stepRpm(m, { speedKmh, pedalPct, dtSec }) {
  const dt = Math.max(0, dtSec);
  const p = clamp(pedalPct / 100, 0, 1);
  let event = null;
  let target;

  if (speedKmh < STOP_KMH) {
    // 정차: 첫 단, 공회전 흔들림. 페달을 밟으면 공회전 레브 (950 + p × 0.6 × 레드라인)
    m.gear = 1;
    m.shiftFrom = null;
    m.lock = 0;
    m.phase += dt;
    const revTarget = IDLE_RPM + p * 0.6 * REDLINE_RPM;
    const tau = revTarget > m.rev ? REV_RISE_SEC : REV_FALL_SEC;
    m.rev += (revTarget - m.rev) * (1 - Math.exp(-dt / tau));
    const wobble = p > 0 ? 0 : WOBBLE_RPM * Math.sin((2 * Math.PI * m.phase) / WOBBLE_PERIOD_SEC);
    target = m.rev + wobble;
  } else {
    m.lock = Math.max(0, m.lock - dt);
    if (m.lock <= 0) {
      const rpmNow = wheelRpm(speedKmh, m.gear);
      if (m.gear < GEARS.length && rpmNow > upshiftRpm(pedalPct)) {
        m.gear += 1;
        event = 'upshift';
      } else if (m.gear > 1 && rpmNow < 0.35 * REDLINE_RPM && wheelRpm(speedKmh, m.gear - 1) < 0.9 * REDLINE_RPM) {
        m.gear -= 1;
        event = 'downshift';
      }
      if (event) {
        m.shiftFrom = m.rpm;
        m.shiftT = 0;
        m.lock = SHIFT_LOCK_SEC;
      }
    }
    const raw = Math.max(IDLE_RPM, wheelRpm(speedKmh, m.gear));
    if (m.shiftFrom !== null) {
      m.shiftT += dt;
      const k = Math.min(1, m.shiftT / SHIFT_BLEND_SEC);
      target = m.shiftFrom + (raw - m.shiftFrom) * k;
      if (k >= 1) m.shiftFrom = null;
    } else {
      target = raw;
    }
    m.rev = IDLE_RPM; // 주행 중에는 정차 레브 상태를 초기화
  }

  m.rpm += (target - m.rpm) * (1 - Math.exp(-dt / SMOOTH_TAU));
  m.rpm = clamp(m.rpm, IDLE_RPM, REDLINE_RPM);
  return { rpm: m.rpm, gear: m.gear, event };
}
