import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motorParams, turbineTarget, stepSpool, MOTOR_MAX_HZ } from '../app/js/audio/ev-params.js';

test('모터 주파수는 속도에 따라 단조 증가하고 상한을 넘지 않는다', () => {
  let prev = -Infinity;
  for (let v = 0; v <= 300; v += 5) {
    const { freq } = motorParams({ speed: v, pedal: 50, kw: 100, peakKw: 300 });
    assert.ok(freq >= prev, `speed ${v}: ${freq} < ${prev}`);
    assert.ok(freq <= MOTOR_MAX_HZ, `freq ${freq} over cap`);
    prev = freq;
  }
  assert.equal(motorParams({ speed: 0, pedal: 0, kw: 0, peakKw: 300 }).freq, 180);
  assert.equal(motorParams({ speed: 260, pedal: 0, kw: 0, peakKw: 300 }).freq, 180 + 260 * 9);
  assert.equal(motorParams({ speed: 999, pedal: 0, kw: 0, peakKw: 300 }).freq, MOTOR_MAX_HZ);
});

test('회생(kW<0) 시 음량은 같은 속도의 가속보다 작다', () => {
  const regen = motorParams({ speed: 100, pedal: 0, kw: -60, peakKw: 300 }).gain;
  const drive = motorParams({ speed: 100, pedal: 50, kw: 150, peakKw: 300 }).gain;
  assert.ok(regen < drive, `regen ${regen} >= drive ${drive}`);
  // 회생량이 클수록 음량이 줄지 않고 커져야 한다 (정규화 0–1)
  assert.ok(motorParams({ speed: 100, pedal: 0, kw: -80, peakKw: 300 }).gain
    > motorParams({ speed: 100, pedal: 0, kw: -20, peakKw: 300 }).gain);
});

test('모터 음량은 0–1 범위를 벗어나지 않는다', () => {
  for (const pedal of [0, 50, 100, 150]) {
    for (const kw of [-500, -40, 0, 120, 900]) {
      const { gain } = motorParams({ speed: 120, pedal, kw, peakKw: 200 });
      assert.ok(gain >= 0 && gain <= 1, `gain ${gain} out of range`);
    }
  }
});

test('터빈 목표값은 0–1 범위이고 페달/속도에 따라 커진다', () => {
  assert.equal(turbineTarget({ speed: 0, pedal: 0 }), 0);
  assert.ok(turbineTarget({ speed: 100, pedal: 0 }) < turbineTarget({ speed: 200, pedal: 0 }));
  assert.ok(turbineTarget({ speed: 0, pedal: 80 }) > turbineTarget({ speed: 0, pedal: 20 }));
  for (const speed of [-10, 0, 150, 400]) {
    for (const pedal of [-5, 0, 60, 300]) {
      const t = turbineTarget({ speed, pedal });
      assert.ok(t >= 0 && t <= 1, `target ${t} out of range`);
    }
  }
});

test('스풀은 올라갈 때가 내려갈 때보다 빠르다 (관성)', () => {
  let up = 0;
  for (let i = 0; i < 50; i++) up = stepSpool(up, 1, 0.02); // 1초 상승
  let down = 1;
  for (let i = 0; i < 50; i++) down = stepSpool(down, 0, 0.02); // 1초 하강
  assert.ok(up > 1 - down, `rise ${up} should exceed fall ${1 - down}`);
});

test('스풀 값은 항상 0–1 범위', () => {
  let s = 0.5;
  for (let i = 0; i < 2000; i++) {
    const target = i % 300 < 150 ? 1.7 : -0.4;
    s = stepSpool(s, target, 0.016);
    assert.ok(s >= 0 && s <= 1, `spool ${s} out of range`);
  }
  assert.equal(stepSpool(0.3, 0.3, 0.5), 0.3);
});
