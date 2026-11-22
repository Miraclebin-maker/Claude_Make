import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ICE_PROFILES, createRpmModel, stepRpm } from '../app/js/audio/rpm-model.js';

const DT = 0.01;

// 속도 ramp 로 시뮬레이션. 각 스텝 결과를 배열로 돌려준다.
function simulate(profile, { fromKmh, toKmh, seconds, pedal, dt = DT }) {
  const m = createRpmModel(profile);
  const steps = [];
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    const speed = fromKmh + ((toKmh - fromKmh) * i) / n;
    const before = m.rpm;
    const r = stepRpm(m, { speedKmh: speed, pedalPct: typeof pedal === 'function' ? pedal(i * dt) : pedal, dtSec: dt });
    steps.push({ ...r, before, t: i * dt, speed });
  }
  return { m, steps };
}

test('정차 시 rpm 은 idle 근처에 머문다', () => {
  const p = ICE_PROFILES.v8;
  const m = createRpmModel(p);
  let r;
  for (let i = 0; i < 300; i++) r = stepRpm(m, { speedKmh: 0, pedalPct: 0, dtSec: 0.01 });
  assert.ok(Math.abs(r.rpm - p.idle) <= 40, `rpm ${r.rpm} not near idle ${p.idle}`);
  assert.equal(r.gear, 1);
});

test('가속 시 업시프트가 발생하고 rpm 은 redline 을 넘지 않는다', () => {
  for (const key of ['v8', 'gt6']) {
    const p = ICE_PROFILES[key];
    const { steps } = simulate(p, { fromKmh: 0, toKmh: 180, seconds: 30, pedal: 70 });
    const ups = steps.filter((s) => s.event === 'upshift').length;
    assert.ok(ups >= 3, `${key}: expected >=3 upshifts, got ${ups}`);
    const maxRpm = Math.max(...steps.map((s) => s.rpm));
    assert.ok(maxRpm <= p.redline + 1e-6, `${key}: max rpm ${maxRpm} > redline ${p.redline}`);
  }
});

test('저부하 업시프트 rpm 이 고부하 업시프트 rpm 보다 낮다', () => {
  const p = ICE_PROFILES.v8;
  const firstUpRpm = (pedal) => {
    const { steps } = simulate(p, { fromKmh: 0, toKmh: 120, seconds: 20, pedal });
    const ev = steps.find((s) => s.event === 'upshift');
    assert.ok(ev, `no upshift at pedal ${pedal}`);
    return ev.before; // 변속 결정 직전 rpm
  };
  const low = firstUpRpm(20);
  const high = firstUpRpm(100);
  assert.ok(low < high, `low-load ${low} should be < high-load ${high}`);
});

test('변속 직후 throttle=0 구간이 존재하고 이후 복구된다', () => {
  const p = ICE_PROFILES.v8;
  const { steps } = simulate(p, { fromKmh: 0, toKmh: 140, seconds: 25, pedal: 70 });
  const idx = steps.findIndex((s) => s.event === 'upshift');
  assert.ok(idx > 0, 'upshift not found');
  assert.equal(steps[idx].throttle, 0, '변속 스텝 throttle 은 0');
  const cutSteps = steps.slice(idx).filter((s, k) => k * DT < 0.12 && s.throttle === 0);
  assert.ok(cutSteps.length >= 10, `cut window too short: ${cutSteps.length} steps`);
  const after = steps.slice(idx).find((s) => s.throttle > 0);
  assert.ok(after, 'throttle 이 복구되지 않음');
});

test('오버런 이벤트: 고rpm 에서 페달을 놓으면 발생, 저rpm 에서는 발생하지 않는다', () => {
  const p = ICE_PROFILES.v8;
  // 고rpm: 100km/h 까지 가속 후 페달 0
  const m = createRpmModel(p);
  let t = 0;
  for (; t < 10; t += DT) stepRpm(m, { speedKmh: (100 * t) / 10, pedalPct: 80, dtSec: DT });
  let overrun = 0;
  for (let i = 0; i < 100; i++) {
    const r = stepRpm(m, { speedKmh: 100, pedalPct: 0, dtSec: DT });
    if (r.event === 'overrun') overrun += 1;
  }
  assert.equal(overrun, 1, '고rpm 페달 해제 시 overrun 1회');

  // 저rpm: 20km/h 에서 페달 해제 -> 이벤트 없음
  const m2 = createRpmModel(p);
  for (let i = 0; i < 200; i++) stepRpm(m2, { speedKmh: 20, pedalPct: 80, dtSec: DT });
  let low = 0;
  for (let i = 0; i < 100; i++) {
    const r = stepRpm(m2, { speedKmh: 20, pedalPct: 0, dtSec: DT });
    if (r.event === 'overrun') low += 1;
  }
  assert.equal(low, 0, '저rpm 에서는 overrun 없음');
});
