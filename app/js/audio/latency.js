// 블루투스 출력 지연 보정 (§26). 순수 함수: DOM/AudioContext 사용 금지.
// 지연만큼 미래 값을 예측해 소리를 미리 바꾼다. 보정 시간이 0이면 입력을 그대로 돌려준다(회귀 방지).

export const LATENCY_CHOICES = Object.freeze(['auto', 'off', '150', '300', '450']);
export const AUTO_DEFAULT_MS = 250; // 자동인데 측정값이 없거나 너무 작을 때
export const AUTO_MIN_MS = 50;
export const AUTO_MAX_MS = 600;
export const SLOPE_TAU_SEC = 0.15; // 기울기 지수평균 시상수
export const MAX_PEDAL_LEAD = 40; // 예측으로 더하는 페달 양 상한 (%)
export const MAX_SPEED_LEAD = 25; // 예측으로 더하는 속도 양 상한 (km/h)
export const SMOOTH_TAU_BASE = 0.08; // 보정 꺼짐: 기존 스무딩
export const SMOOTH_TAU_COMP = 0.05; // 보정 켜짐: 반응을 빠르게

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// 설정값과 오디오 컨텍스트 값으로 적용 지연(ms)을 정한다.
// outputLatency/baseLatency 는 초 단위(AudioContext 속성). 반환 source: 'off' | 'fixed' | 'measured' | 'default'.
export function resolveLatency(setting, { outputLatency, baseLatency } = {}) {
  const s = LATENCY_CHOICES.includes(setting) ? setting : 'auto';
  if (s === 'off') return { ms: 0, source: 'off' };
  if (s !== 'auto') return { ms: Number(s), source: 'fixed' };
  const ms = ((Number(outputLatency) || 0) + (Number(baseLatency) || 0)) * 1000;
  if (!(ms >= AUTO_MIN_MS)) return { ms: AUTO_DEFAULT_MS, source: 'default' };
  return { ms: Math.min(AUTO_MAX_MS, Math.round(ms)), source: 'measured' };
}

// 화면 표시 문구 (§26.2)
export function latencyLabel(res) {
  if (res.source === 'off') return '적용 중: 끔';
  if (res.source === 'fixed') return `적용 중: ${res.ms}ms`;
  if (res.source === 'measured') return `적용 중: 약 ${res.ms}ms (자동 측정)`;
  return `적용 중: 약 ${res.ms}ms (자동 기본값)`;
}

// 반응 스무딩 시상수: 보정이 켜져 있으면 짧게 (§26.1)
export function smoothTauFor(ms) {
  return ms > 0 ? SMOOTH_TAU_COMP : SMOOTH_TAU_BASE;
}

export function createPredictor() {
  return { t: null, speed: 0, pedal: 0, slopeS: 0, slopeP: 0 };
}

// 샘플 관측: tMs(밀리초), 속도(km/h), 페달(%). 기울기는 지수평균. 새 상태를 돌려준다(입력 상태는 바꾸지 않는다).
export function observe(state, tMs, speed, pedal) {
  if (state.t === null) return { t: tMs, speed, pedal, slopeS: 0, slopeP: 0 };
  const dt = (tMs - state.t) / 1000;
  if (!(dt > 0)) return { ...state, speed, pedal };
  const a = 1 - Math.exp(-dt / SLOPE_TAU_SEC);
  return {
    t: tMs,
    speed,
    pedal,
    slopeS: state.slopeS + ((speed - state.speed) / dt - state.slopeS) * a,
    slopeP: state.slopeP + ((pedal - state.pedal) / dt - state.slopeP) * a,
  };
}

// 예측: 현재 값 + 기울기 × 보정 시간. 더하는 양은 상한으로 자르고, 페달 0~100, 속도 0 이상.
export function predict(state, leadSec) {
  const lead = Math.max(0, Number(leadSec) || 0);
  if (lead === 0 || state.t === null) return { speed: state.speed, pedal: state.pedal };
  const dP = clamp(state.slopeP * lead, -MAX_PEDAL_LEAD, MAX_PEDAL_LEAD);
  const dS = clamp(state.slopeS * lead, -MAX_SPEED_LEAD, MAX_SPEED_LEAD);
  return {
    speed: Math.max(0, state.speed + dS),
    pedal: clamp(state.pedal + dP, 0, 100),
  };
}
