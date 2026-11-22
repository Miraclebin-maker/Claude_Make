// 엔진 음 렌더 CLI. 수동 실행용(package.json 스크립트 없음).
// 출처: DasEtwas/enginesound (MIT License, Copyright (c) 2020 DasEtwas). 원본 전문: LICENSE-enginesound.txt
// 이 파일의 crossfadeLoop 은 원본 src/main.rs 의 크로스페이드 계산을 옮긴 것이다.
//
//   node render.mjs sweep  --preset presets/v10a.json --out <file.wav>
//   node render.mjs steady --preset presets/v10a.json --rpm 3000 --out <file.wav> [--seconds 2]
//
// sweep : 공회전 1000rpm 2초 -> 9000rpm 까지 4초 가속 -> 9000rpm 1초 -> 1500rpm 까지 3초 감속 (총 10초).
//         부하/스로틀 파라미터가 모델에 없으므로 RPM 만 바꾼다.
// steady: 고정 RPM 루프. 웜업 1초 후 녹음, 원본 README 방식 크로스페이드(c = 2 * 120/rpm 초)로 이음새를 만든다.
// 출력: 16-bit mono 48kHz WAV, 피크 -1 dBFS 로 정규화. 정규화 전 피크/RMS 도 표준출력에 찍는다(엔진끼리 음량 비교용).
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineModel, DEFAULT_SEEDS } from './engine-model.mjs';
import { writeWav } from './wav.mjs';
import { normalizePeak, crossfadeLoop, rms, peak, toDb } from './analysis.mjs';

export const SAMPLE_RATE = 48000;

export function sweepRpm(t) {
  if (t < 2) return 1000;
  if (t < 6) return 1000 + ((t - 2) / 4) * 8000;
  if (t < 7) return 9000;
  if (t < 10) return 9000 - ((t - 7) / 3) * 7500;
  return 1500;
}

// rpm 함수 f(t) 로 n 샘플을 만든다. warmupSec 만큼 앞에서 미리 돌린 뒤 그 구간은 버린다.
export function renderSchedule(preset, rpmAt, totalSec, warmupSec, sr = SAMPLE_RATE) {
  const engine = new EngineModel(preset, sr, DEFAULT_SEEDS);
  const warm = Math.round(warmupSec * sr);
  const n = Math.round(totalSec * sr);
  for (let i = 0; i < warm; i++) engine.sample(rpmAt(0));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = engine.sample(rpmAt(i / sr));
  return out;
}

export function renderSweep(preset) {
  return renderSchedule(preset, (t) => sweepRpm(t), 10, 0.5);
}

export function renderSteady(preset, rpm, seconds, warmupSec = 1) {
  const cfSec = (2 * 120) / rpm; // 원본 README: 파장 120/rpm 의 두 배
  const recSec = seconds + cfSec / 2; // reclen = audio_len + crossfade/2
  const rec = renderSchedule(preset, () => rpm, recSec, warmupSec);
  return crossfadeLoop(rec, Math.round(cfSec * SAMPLE_RATE));
}

function argValue(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

function stats(raw) {
  return { rawPeakDb: toDb(peak(raw)), rawRmsDb: toDb(rms(raw)) };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const here = dirname(fileURLToPath(import.meta.url));
  const [, , mode, ...args] = process.argv;
  const presetPath = resolve(argValue(args, '--preset', join(here, 'presets', 'v10a.json')));
  const outPath = resolve(argValue(args, '--out', 'out.wav'));
  const preset = JSON.parse(readFileSync(presetPath, 'utf8'));
  let samples;
  if (mode === 'sweep') {
    samples = renderSweep(preset);
  } else if (mode === 'steady') {
    const rpm = Number(argValue(args, '--rpm', '3000'));
    const seconds = Number(argValue(args, '--seconds', '2'));
    samples = renderSteady(preset, rpm, seconds);
  } else {
    console.error('usage: node render.mjs sweep|steady --preset <json> --out <wav> [--rpm R] [--seconds S]');
    process.exit(2);
  }
  const raw = stats(samples);
  const norm = normalizePeak(samples, -1);
  writeWav(outPath, norm.samples, SAMPLE_RATE);
  console.log(JSON.stringify({
    file: outPath,
    seconds: +(samples.length / SAMPLE_RATE).toFixed(3),
    sampleRate: SAMPLE_RATE,
    rawPeakDb: +raw.rawPeakDb.toFixed(2),
    rawRmsDb: +raw.rawRmsDb.toFixed(2),
    gainDb: +toDb(norm.gain).toFixed(2),
  }));
}
