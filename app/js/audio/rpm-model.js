// 가상 RPM / 기어 모델 (순수 함수 + 상태 객체). DOM 사용 금지.
// 내연기관 프로필 상수는 전부 여기 ICE_PROFILES 한 곳에 모은다. 튜닝은 이 객체만 수정.

export const ICE_PROFILES = Object.freeze({
  v8: Object.freeze({
    key: 'v8',
    label: 'V8 머슬카',
    idle: 750,
    redline: 6500,
    gearRatios: Object.freeze([3.6, 2.2, 1.6, 1.25, 1.0, 0.85]),
    finalDrive: 3.1,
    wheelCircM: 2.1,
    // 크로스플레인: 90도 간격, 뱅크 배정 (뱅크별 불균일 간격 -> 두둥두둥)
    angles: Object.freeze([0, 90, 180, 270, 360, 450, 540, 630]),
    banks: Object.freeze([0, 1, 0, 0, 1, 0, 1, 1]),
    thumpHz: 58,
    bankTubeMs: Object.freeze([3.2, 3.6]),
    feedback: Object.freeze([0.5, 0.45]),
    loopLpHz: 2200,
    muffler: Object.freeze({
      peaks: Object.freeze([
        { f: 90, q: 1.2, db: 7 },
        { f: 220, q: 1.6, db: 4 },
      ]),
      lpBase: 380,
      lpRpmK: 0.05,
      lpThrK: 900,
    }),
    intake: Object.freeze({ centerBase: 180, centerRpmK: 0.03, q: 1.2, level: 0.02 }),
  }),
  gt6: Object.freeze({
    key: 'gt6',
    label: 'GT 슈퍼카',
    idle: 950,
    redline: 8800,
    gearRatios: Object.freeze([3.2, 2.1, 1.5, 1.15, 0.95, 0.8]),
    finalDrive: 3.2,
    wheelCircM: 2.0,
    // 플랫6: 120도 등간격
    angles: Object.freeze([0, 120, 240, 360, 480, 600]),
    banks: Object.freeze([0, 1, 0, 1, 0, 1]),
    thumpHz: 70,
    bankTubeMs: Object.freeze([2.4, 2.7]),
    feedback: Object.freeze([0.4, 0.4]),
    loopLpHz: 4200,
    muffler: Object.freeze({
      peaks: Object.freeze([
        { f: 300, q: 1.8, db: 5 },
        { f: 900, q: 2.2, db: 4 },
      ]),
      lpBase: 1400,
      lpRpmK: 0.12,
      lpThrK: 1600,
    }),
    intake: Object.freeze({ centerBase: 500, centerRpmK: 0.08, q: 1.0, level: 0.03 }),
  }),
});

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const lerp = (a, b, t) => a + (b - a) * t;

export function createRpmModel(profile) {
  return {
    idle: profile.idle,
    redline: profile.redline,
    gearRatios: profile.gearRatios.slice(),
    finalDrive: profile.finalDrive,
    wheelCircM: profile.wheelCircM,
    gear: 1,          // 1..6
    rpm: profile.idle,
    throttle: 0,
    prevPedal: 0,
    shiftCutSec: 0,   // 변속 점화 컷 잔여 시간
    cooldownSec: 0,   // 변속 후 재변속 금지 시간
    phase: 0,         // 정차 시 흔들림 위상
  };
}

// 주어진 기어/속도에서의 바퀴 기반 RPM (1-based 기어)
function rpmAt(m, gear, speedKmh) {
  const v = speedKmh / 3.6;
  return (v / m.wheelCircM) * 60 * m.gearRatios[gear - 1] * m.finalDrive;
}

// 한 스텝 진행. 반환: { rpm, gear, throttle, event }
// event: 'upshift' | 'downshift' | 'overrun' | null
// 오버런 판정은 페달 입력 기준(변속 중 throttle 강제 0 과 구분하기 위함).
export function stepRpm(m, { speedKmh = 0, pedalPct = 0, dtSec = 0.02 }) {
  const speed = Math.max(0, speedKmh);
  const pedal = clamp(pedalPct, 0, 100) / 100;
  const dt = Math.max(0, dtSec);
  const stopped = speed < 2;

  m.shiftCutSec = Math.max(0, m.shiftCutSec - dt);
  m.cooldownSec = Math.max(0, m.cooldownSec - dt);

  let shift = null;
  if (stopped) {
    m.gear = 1;
  } else if (m.cooldownSec <= 0) {
    const upRpm = lerp(0.45, 0.92, pedal) * m.redline;
    if (m.gear < 6 && rpmAt(m, m.gear, speed) > upRpm) {
      m.gear += 1;
      shift = 'upshift';
    } else if (m.gear > 1 && rpmAt(m, m.gear, speed) < m.idle * 1.6) {
      m.gear -= 1;
      shift = 'downshift';
    } else if (m.gear > 1 && pedal > 0.85 && rpmAt(m, m.gear - 1, speed) < m.redline * 0.92) {
      // 킥다운: 한 단 낮춰도 상향 기준 아래면 다운 (재상향 떨림 방지를 위해 0.92 배)
      m.gear -= 1;
      shift = 'downshift';
    }
    if (shift) {
      m.shiftCutSec = 0.12;
      m.cooldownSec = 0.35;
    }
  }

  let target;
  let tau;
  if (stopped) {
    m.phase += dt * 2 * Math.PI * 0.7;
    target = m.idle + 25 * Math.sin(m.phase) + pedal * 0.6 * m.redline;
    tau = target > m.rpm ? 0.15 : 0.35;
  } else {
    target = Math.max(m.idle, rpmAt(m, m.gear, speed));
    tau = m.shiftCutSec > 0 ? 0.08 : 0.1;
  }
  const alpha = dt > 0 ? 1 - Math.exp(-dt / tau) : 0;
  m.rpm = clamp(m.rpm + (target - m.rpm) * alpha, 0, m.redline);

  const throttle = m.shiftCutSec > 0 ? 0 : pedal;

  let event = null;
  if (pedal < 0.1 && m.prevPedal >= 0.6 && m.rpm > 0.45 * m.redline) {
    event = 'overrun';
  } else if (shift) {
    event = shift;
  }
  m.prevPedal = pedal;
  m.throttle = throttle;

  return { rpm: m.rpm, gear: m.gear, throttle, event };
}
