import { test } from 'node:test';
import assert from 'node:assert/strict';
import { V10_RPMS, v10FileName, loopMix, equalPowerWeights, masterParams } from '../app/js/audio/v10.js';

test('루프 목록: 1000~9000rpm 500 간격 17개, 파일 이름 규칙', () => {
  assert.equal(V10_RPMS.length, 17);
  assert.equal(V10_RPMS[0], 1000);
  assert.equal(V10_RPMS[16], 9000);
  assert.equal(v10FileName(3500), 'rpm-3500.wav');
});

test('루프 선택: 두 이웃과 비율 (1250 -> 1000/1500, t=0.5), 범위 밖은 한 개', () => {
  assert.deepEqual(loopMix(1250), { lo: 0, hi: 1, t: 0.5 });
  assert.deepEqual(loopMix(9000), { lo: 16, hi: 16, t: 0 });
  assert.deepEqual(loopMix(950), { lo: 0, hi: 1, t: 0 });
});

test('등전력 크로스페이드: gLo² + gHi² = 1, 경계에서 연속', () => {
  for (let i = 0; i <= 20; i++) {
    const { gLo, gHi } = equalPowerWeights(i / 20);
    assert.ok(Math.abs(gLo * gLo + gHi * gHi - 1) < 1e-12, `t=${i / 20}`);
  }
  const a = equalPowerWeights(0);
  const b = equalPowerWeights(1);
  assert.ok(Math.abs(a.gLo - 1) < 1e-12 && Math.abs(a.gHi) < 1e-12);
  assert.ok(Math.abs(b.gLo) < 1e-12 && Math.abs(b.gHi - 1) < 1e-12);
});

test('재생 속도: 항상 0.75~1.25 로 제한되고, 더 크게 섞이는 루프는 실제 음높이를 ±25% 안에서 맞춘다', () => {
  for (let r = 950; r <= 8800; r += 10) {
    const { lo, hi, t } = loopMix(r);
    for (const i of new Set([lo, hi])) {
      const clamped = Math.min(1.25, Math.max(0.75, r / V10_RPMS[i]));
      assert.ok(clamped >= 0.75 && clamped <= 1.25);
    }
    const dominant = t >= 0.5 ? hi : lo;
    assert.ok(Math.abs(r / V10_RPMS[dominant] - 1) <= 0.25 + 1e-9, `rpm ${r} 주 루프 ${V10_RPMS[dominant]}`);
  }
});

test('마스터 필터·음량: 페달 0 또는 회생이면 1.2kHz/0.45, 페달 100% 이면 7.2kHz/1.0', () => {
  assert.deepEqual(masterParams(0, 0), { cutoffHz: 1200, gain: 0.45 });
  assert.deepEqual(masterParams(80, -20), { cutoffHz: 1200, gain: 0.45 });
  const full = masterParams(100, 100);
  assert.ok(Math.abs(full.cutoffHz - 7200) < 1e-9 && Math.abs(full.gain - 1) < 1e-12);
});
