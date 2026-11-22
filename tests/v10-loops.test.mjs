// V10 루프 파일 검사 (§18.3). app/audio/v10/ 의 17개 WAV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav } from '../tools/engine-render/wav.mjs';
import { peak, rms, toDb } from '../tools/engine-render/analysis.mjs';
import { V10_RPMS, v10FileName } from '../app/js/audio/v10.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'app', 'audio', 'v10');
const SR = 32000;
const loops = V10_RPMS.map((rpm) => ({ rpm, path: join(dir, v10FileName(rpm)) }));

test('17개 파일이 있고 합계 용량이 2MB 이하', () => {
  assert.equal(loops.length, 17);
  let total = 0;
  for (const l of loops) {
    assert.ok(existsSync(l.path), `${l.path} 없음`);
    total += statSync(l.path).size;
  }
  assert.ok(total <= 2 * 1024 * 1024, `총 ${total} bytes`);
});

test('형식: 32kHz, mono, 16-bit PCM', () => {
  for (const l of loops) {
    const { sampleRate, samples } = readWav(l.path);
    assert.equal(sampleRate, SR, `${l.rpm}`);
    assert.ok(samples.length > 0);
  }
});

test('길이는 엔진 사이클(120/rpm 초)의 정수배 ±1샘플, 약 1초', () => {
  for (const l of loops) {
    const { samples } = readWav(l.path);
    const cycleSamples = (120 / l.rpm) * SR;
    const cycles = Math.round(1.0 / (120 / l.rpm));
    const expect = cycles * cycleSamples;
    assert.ok(Math.abs(samples.length - expect) <= 1, `${l.rpm}: ${samples.length} vs ${expect.toFixed(2)}`);
    assert.ok(samples.length / SR > 0.9 && samples.length / SR < 1.1, `${l.rpm}: ${(samples.length / SR).toFixed(3)} s`);
  }
});

test('이음새: 끝→처음 점프는 파일 안의 평균 샘플 차의 4배 이하 (연속 신호의 한 샘플 차이 수준)', () => {
  for (const l of loops) {
    const { samples: x } = readWav(l.path);
    let mad = 0;
    for (let i = 1; i < x.length; i++) mad += Math.abs(x[i] - x[i - 1]);
    mad /= x.length - 1;
    const seam = Math.abs(x[x.length - 1] - x[0]);
    assert.ok(seam <= 4 * mad + 1e-9, `${l.rpm}: seam ${seam.toExponential(2)} vs mad ${mad.toExponential(2)}`);
  }
});

test('공통 게인: 17개 중 가장 큰 피크가 -1 dBFS (±0.1), 나머지는 그 이하', () => {
  const peaks = loops.map((l) => toDb(peak(readWav(l.path).samples)));
  const max = Math.max(...peaks);
  assert.ok(Math.abs(max - -1) <= 0.1, `최대 피크 ${max.toFixed(2)} dBFS`);
  for (const p of peaks) assert.ok(p <= max + 1e-9);
});

test('RPM 이 오를수록 음량(RMS)이 커지는 경향 (공통 게인이라 실제 음량 차이가 남는다)', () => {
  const r = loops.map((l) => toDb(rms(readWav(l.path).samples)));
  assert.ok(r[16] > r[0], `1000rpm ${r[0].toFixed(1)} dB, 9000rpm ${r[16].toFixed(1)} dB`);
});
