// 엔진 음 렌더러 검증 (§17.3). 청취는 못 하므로 신호 성질만 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineModel, DEFAULT_SEEDS } from '../tools/engine-render/engine-model.mjs';
import { parseRon } from '../tools/engine-render/ron2json.mjs';
import { renderSteady, sweepRpm } from '../tools/engine-render/render.mjs';
import { normalizePeak, crossfadeLoop, peakFrequency, bandEnergyRatio, peak } from '../tools/engine-render/analysis.mjs';
import { encodeWav } from '../tools/engine-render/wav.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const presetDir = join(here, '..', 'tools', 'engine-render', 'presets');
const preset = (name) => JSON.parse(readFileSync(join(presetDir, `${name}.json`), 'utf8'));
const SR = 48000;

test('렌더 결과는 NaN 이 없고 무음이 아니다', () => {
  const s = renderSteady(preset('flat6'), 2000, 0.3);
  assert.ok(s.every((x) => Number.isFinite(x)), 'NaN/Infinity 없음');
  assert.ok(peak(s) > 0, '무음이 아님');
});

test('같은 프리셋과 RPM 이면 같은 소리(고정 시드)', () => {
  const a = renderSteady(preset('flat6'), 3000, 0.2);
  const b = renderSteady(preset('flat6'), 3000, 0.2);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i += 997) assert.equal(a[i], b[i]);
});

test('피크 정규화: 피크가 -1 dBFS (0.8913)', () => {
  const s = renderSteady(preset('flat6'), 1500, 0.2);
  const n = normalizePeak(s, -1).samples;
  assert.ok(Math.abs(peak(n) - Math.pow(10, -1 / 20)) < 1e-9, `peak ${peak(n)}`);
});

test('6기통: 점화 주파수 rpm×6/120 (= rpm/20) 이 피크이고, RPM 이 오르면 따라 올라간다', () => {
  const got = [1000, 3000, 6000].map((rpm) => {
    const s = renderSteady(preset('flat6'), rpm, 1.2);
    return { rpm, expect: rpm / 20, f: peakFrequency(s, SR, { fmin: 20, fmax: 2000, start: 4000 }) };
  });
  for (const g of got) {
    assert.ok(Math.abs(g.f - g.expect) / g.expect < 0.05, `rpm ${g.rpm}: peak ${g.f.toFixed(1)} Hz, expected ${g.expect} Hz`);
  }
  assert.ok(got[0].f < got[1].f && got[1].f < got[2].f, '피크 주파수가 RPM 과 함께 증가');
});

test('V10: 점화 주파수(rpm×10/120) 근처에 에너지가 있다', () => {
  const s = renderSteady(preset('v10a'), 3000, 1.2);
  const expect = (3000 * 10) / 120;
  const near = bandEnergyRatio(s, SR, expect * 0.9, expect * 1.1, { start: 4000 });
  assert.ok(near > 0.05, `점화 대역 에너지 비율 ${near.toFixed(3)}`);
});

test('스윕 RPM 곡선: 1000 -> 9000 (4초 가속) -> 레드존 -> 1500 (감속)', () => {
  assert.equal(sweepRpm(0), 1000);
  assert.equal(sweepRpm(1.9), 1000);
  assert.equal(sweepRpm(4), 5000);
  assert.equal(sweepRpm(6.5), 9000);
  assert.equal(sweepRpm(10), 1500);
});

test('크로스페이드 루프: 길이는 len - c/2', () => {
  const x = new Float64Array(1000).map((_, i) => Math.sin(i / 10));
  const out = crossfadeLoop(x, 200);
  assert.equal(out.length, 900);
  assert.ok(out.every(Number.isFinite));
});

test('RON 파서: 주석, 중첩 구조체, 배열을 읽는다', () => {
  const v = parseRon('(rpm: 1.5, // 주석\n cylinders: [ (crank_offset: 0, samples: (delay:0.25,),), ],)');
  assert.equal(v.rpm, 1.5);
  assert.equal(v.cylinders.length, 1);
  assert.equal(v.cylinders[0].samples.delay, 0.25);
});

test('원본 예제 프리셋 변환: 10기통, 원본 rpm 유지', () => {
  const v10a = preset('v10a');
  assert.equal(v10a.cylinders.length, 10);
  assert.ok(Math.abs(v10a.rpm - 1459.5205) < 1e-3);
  assert.equal(v10a.muffler.muffler_elements.length, 4);
});

test('플랫6 프리셋: 6기통, 점화 간격 1/6 (120°), 점화 순서 1-6-2-4-3-5', () => {
  const f = preset('flat6');
  assert.equal(f.cylinders.length, 6);
  const offs = f.cylinders.map((c) => c.crank_offset);
  assert.deepEqual(offs.map((o) => Math.round(o * 6)), [0, 1, 2, 3, 4, 5]);
});

test('WAV 인코딩: 헤더 샘플레이트와 길이', () => {
  const buf = encodeWav(new Float64Array(480).fill(0.5), 48000);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.readUInt32LE(24), 48000);
  assert.equal(buf.readUInt16LE(34), 16);
  assert.equal(buf.length, 44 + 480 * 2);
});

test('엔진 모델은 외부 의존성 없이 샘플을 만든다', () => {
  const m = new EngineModel(preset('flat6'), SR, DEFAULT_SEEDS);
  const x = m.sample(1000);
  assert.ok(Number.isFinite(x));
});
