// 신규 EV 사운드(일렉트릭 슈퍼카 motor, 제트 터빈 turbine)의 파라미터 계산. 순수 함수 (DOM/AudioContext 사용 금지).

export const MOTOR_MAX_HZ = 2600;
export const REGEN_NORM_KW = 80; // 회생 음량 정규화 기준 (§14.1 회생 0–80kW 와 같은 척도)

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

// 모터 휘닝: 기본음 주파수와 음량. 회생(kW<0)이면 음량은 회생량에 비례해 줄고 음높이는 그대로다.
export function motorParams({ speed, pedal, kw, peakKw }) {
  const freq = Math.min(MOTOR_MAX_HZ, 180 + Math.max(0, speed) * 9);
  if (kw < 0) {
    return { freq, gain: 0.3 * clamp(-kw / REGEN_NORM_KW, 0, 1) };
  }
  const powerNorm = clamp(Math.max(pedal / 100, kw / Math.max(1, peakKw)), 0, 1);
  return { freq, gain: 0.05 + 0.95 * powerNorm };
}

// 터빈 스풀 목표값 (0–1): 페달 또는 속도에서 온다.
export function turbineTarget({ speed, pedal }) {
  return clamp(Math.max(pedal / 100, (Math.max(0, speed) / 220) * 0.6), 0, 1);
}

// 스풀 관성: 올라갈 때 시상수 0.8s, 내려갈 때 1.5s (지수 접근).
export function stepSpool(s, target, dt) {
  const tau = target > s ? 0.8 : 1.5;
  const k = 1 - Math.exp(-Math.max(0, dt) / tau);
  return clamp(s + (target - s) * k, 0, 1);
}
