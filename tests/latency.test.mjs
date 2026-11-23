// §26 블루투스 지연 보정: 적용 지연 결정, 기울기 예측, 제한값, 스무딩 선택 (순수 함수)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveLatency, latencyLabel, smoothTauFor, createPredictor, observe, predict,
  MAX_PEDAL_LEAD, MAX_SPEED_LEAD, SMOOTH_TAU_BASE, SMOOTH_TAU_COMP,
} from '../app/js/audio/latency.js';
import { stepRpm, createRpmModel, SMOOTH_TAU } from '../app/js/audio/rpm-model.js';

// 60Hz 로 샘플을 흘려 보낸다
function feed(samples, { speedAt, pedalAt, fromMs = 0, hz = 60, seconds = 1 }) {
  let s = createPredictor();
  const n = Math.round(seconds * hz);
  for (let i = 0; i <= n; i += 1) {
    const t = fromMs + (i * 1000) / hz;
    s = observe(s, t, speedAt(i / hz), pedalAt(i / hz));
  }
  samples.push(s);
  return s;
}

test('적용 지연: 끔 0, 고정값은 그대로, 자동은 측정 합계, 없거나 50ms 미만이면 250ms, 상한 600ms', () => {
  assert.deepEqual(resolveLatency('off', { outputLatency: 0.2 }), { ms: 0, source: 'off' });
  assert.deepEqual(resolveLatency('300', { outputLatency: 0.2 }), { ms: 300, source: 'fixed' });
  assert.deepEqual(resolveLatency('auto', { outputLatency: 0.2, baseLatency: 0.08 }), { ms: 280, source: 'measured' });
  assert.deepEqual(resolveLatency('auto', {}), { ms: 250, source: 'default' });
  assert.deepEqual(resolveLatency('auto', { outputLatency: 0.01, baseLatency: 0.02 }), { ms: 250, source: 'default' });
  assert.deepEqual(resolveLatency('auto', { outputLatency: 0.9, baseLatency: 0.3 }), { ms: 600, source: 'measured' });
  assert.deepEqual(resolveLatency('모름', { outputLatency: 0.2 }), { ms: 200, source: 'measured' }); // 모르는 값은 자동
});

test('표시 문구: 자동 측정·자동 기본값·고정·끔', () => {
  assert.equal(latencyLabel({ ms: 280, source: 'measured' }), '적용 중: 약 280ms (자동 측정)');
  assert.equal(latencyLabel({ ms: 250, source: 'default' }), '적용 중: 약 250ms (자동 기본값)');
  assert.equal(latencyLabel({ ms: 300, source: 'fixed' }), '적용 중: 300ms');
  assert.equal(latencyLabel({ ms: 0, source: 'off' }), '적용 중: 끔');
});

test('보정 0이면 입력 그대로 (회귀 방지)', () => {
  const s = feed([], { speedAt: (t) => 40 + 30 * t, pedalAt: (t) => 20 + 50 * t });
  const p = predict(s, 0);
  assert.equal(p.speed, s.speed);
  assert.equal(p.pedal, s.pedal);
});

test('일정 가속에서 예측 속도 = 현재 + 기울기 × 보정 시간 (지수평균이 수렴한 뒤)', () => {
  // 속도 20km/h/s 로 증가: 1초 뒤 현재 속도 20 + 20 = 40 이 아니라 기울기로 본다
  const s = feed([], { speedAt: (t) => 20 * t, pedalAt: () => 30, seconds: 1.5 });
  const lead = 0.3;
  const p = predict(s, lead);
  assert.ok(Math.abs(s.slopeS - 20) < 1, `기울기 ${s.slopeS} 가 20 근처`);
  assert.ok(Math.abs(p.speed - (s.speed + s.slopeS * lead)) < 1e-9, '속도 예측 = 현재 + 기울기×시간');
  assert.ok(Math.abs(p.speed - (s.speed + 20 * lead)) < 1.5, '예측 증가량이 20km/h/s × 0.3s 근처');
  assert.equal(p.pedal, 30, '페달 일정이면 예측도 같다');
});

test('제한값: 페달은 한 번에 ±40, 속도는 ±25 를 넘지 않고 0~100, 0 이상', () => {
  // 페달이 한 프레임에 0 → 100 으로 튀면 기울기는 매우 크다. 더하는 양은 상한으로 잘린다
  let s = createPredictor();
  s = observe(s, 0, 0, 0);
  s = observe(s, 16, 0, 100);
  const up = predict(s, 1.0);
  assert.ok(up.pedal <= 100 && up.pedal - s.pedal <= MAX_PEDAL_LEAD + 1e-9, `페달 상승 ${up.pedal - s.pedal} <= ${MAX_PEDAL_LEAD}`);
  // 속도가 급감하면 0 아래로 내려가지 않는다
  let d = createPredictor();
  d = observe(d, 0, 50, 0);
  d = observe(d, 16, 1, 0);
  const down = predict(d, 1.0);
  assert.ok(down.speed >= 0, '속도는 0 이상');
  assert.ok(d.speed - down.speed <= MAX_SPEED_LEAD + 1e-9, '속도 하강량은 상한 이내');
  // 페달 0 근처에서 음수로 가지 않는다
  let e = createPredictor();
  e = observe(e, 0, 0, 10);
  e = observe(e, 16, 0, 0);
  assert.ok(predict(e, 1.0).pedal >= 0, '페달은 0 이상');
});

test('정지 상태에서 예측이 흔들리지 않음: 값이 변하지 않으면 예측 = 현재', () => {
  const s = feed([], { speedAt: () => 0, pedalAt: () => 0, seconds: 0.5 });
  const p = predict(s, 0.3);
  assert.equal(p.speed, 0);
  assert.equal(p.pedal, 0);
  const q = feed([], { speedAt: () => 35, pedalAt: () => 12, seconds: 0.5 });
  const pq = predict(q, 0.3);
  assert.ok(Math.abs(pq.speed - 35) < 1e-6 && Math.abs(pq.pedal - 12) < 1e-6, '일정 값은 그대로');
});

test('페달 급변 뒤 지수평균 기울기가 반영되고 서서히 줄어든다', () => {
  let s = createPredictor();
  s = observe(s, 0, 0, 0);
  s = observe(s, 16, 0, 20); // 16ms 에 20% 상승 → 순간 기울기 1250%/s
  const first = s.slopeP;
  assert.ok(first > 0, '상승 기울기가 반영된다');
  for (let i = 2; i <= 40; i += 1) s = observe(s, i * 16, 0, 20); // 페달 유지
  assert.ok(s.slopeP < first, '유지되면 기울기는 줄어든다');
  assert.ok(Math.abs(s.slopeP) < Math.abs(first) * 0.2, '0.15초 시상수로 빨리 줄어든다');
});

test('스무딩 선택: 보정 꺼짐 0.08, 켜짐 0.05, rpm-model 기본값은 기존과 같다', () => {
  assert.equal(smoothTauFor(0), SMOOTH_TAU_BASE);
  assert.equal(smoothTauFor(300), SMOOTH_TAU_COMP);
  assert.equal(SMOOTH_TAU_BASE, 0.08);
  assert.equal(SMOOTH_TAU_COMP, 0.05);
  assert.equal(SMOOTH_TAU, 0.08);
  // 짧은 시상수는 같은 입력에 더 빨리 따라간다
  const a = createRpmModel();
  const b = createRpmModel();
  for (let i = 0; i < 6; i += 1) {
    stepRpm(a, { speedKmh: 60, pedalPct: 50, dtSec: 1 / 60 });
    stepRpm(b, { speedKmh: 60, pedalPct: 50, dtSec: 1 / 60, smoothTau: SMOOTH_TAU_COMP });
  }
  assert.ok(b.rpm > a.rpm, '짧은 시상수가 목표에 더 빨리 가까워진다');
});

// v2.9.1: 실데이터는 샘플이 올 때만 관측하고, 틱마다 마지막 샘플에서 외삽한다
test('10Hz 계단 입력 + 60Hz 예측: 예측 속도는 단조 증가하고 이웃 틱 사이에 출렁임이 없다', () => {
  let s = createPredictor();
  const lead = 0.25;
  const preds = [];
  let next = 0; // 다음 샘플 인덱스 (100ms 격자)
  for (let k = 0; k <= 60; k += 1) { // 1초, 60Hz 틱
    const tMs = (k * 1000) / 60;
    while (next * 100 <= tMs + 1e-9) { // 샘플은 100ms 마다 계단으로 도착 (속도 20km/h/s 일정 가속)
      s = observe(s, next * 100, (20 * next * 100) / 1000, 30);
      next += 1;
    }
    preds.push(predict(s, lead, tMs).speed);
  }
  for (let i = 1; i < preds.length; i += 1) {
    assert.ok(preds[i] >= preds[i - 1] - 1e-9, `틱 ${i}: ${preds[i].toFixed(3)} < 이전 ${preds[i - 1].toFixed(3)}`);
  }
  assert.ok(preds[preds.length - 1] - preds[0] > 15, '전체적으로 가속 방향으로 올라간다');
});

test('샘플이 끊기면 외삽은 MAX_AGE_SEC(0.3초)에서 멈춘다', () => {
  let s = createPredictor();
  s = observe(s, 0, 0, 0);
  s = observe(s, 100, 2, 0); // 기울기 > 0
  const at300 = predict(s, 0.25, 100 + 300);
  const at5000 = predict(s, 0.25, 100 + 5000);
  assert.equal(at300.speed, at5000.speed, '0.3초 뒤부터는 더 외삽하지 않는다');
  assert.equal(at300.pedal, at5000.pedal);
  assert.ok(predict(s, 0.25, 100 + 100).speed < at300.speed, '0.3초 안에서는 시간에 따라 올라간다');
});
