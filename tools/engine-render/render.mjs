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
import { readFileSync, mkdirSync } from 'node:fs';
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

// 루프 하나: 엔진 사이클(120/rpm 초)의 정수배 길이. 이음새는 원본 방식(반쪽 교체 + 가운데 크로스페이드, 길이 2사이클)으로 맞춘다.
export function renderLoop(preset, rpm, cycles, sr, warmupSec = 1) {
  const cycleSec = 120 / rpm;
  const L = Math.round(cycles * cycleSec * sr);
  const cf = Math.round(2 * cycleSec * sr);
  const rec = renderSchedule(preset, () => rpm, (L + Math.floor(cf / 2)) / sr, warmupSec, sr);
  return crossfadeLoop(rec, cf); // 길이 = L
}

// 루프 세트 (config: tools/engine-render/v10-loops.json). 17개 전체에서 가장 큰 피크가 targetDbfs 가 되도록 같은 배율을 쓴다(공통 게인).
export function renderLoopSet(config, baseDir) {
  const preset = JSON.parse(readFileSync(resolve(baseDir, config.preset), 'utf8'));
  const sets = [];
  for (let rpm = config.rpmMin; rpm <= config.rpmMax; rpm += config.rpmStep) {
    const cycles = Math.max(1, Math.round(config.targetSeconds / (120 / rpm)));
    sets.push({ rpm, cycles, samples: renderLoop(preset, rpm, cycles, config.sampleRate, config.warmupSeconds) });
  }
  const maxPeak = Math.max(...sets.map((x) => peak(x.samples)));
  const gain = Math.pow(10, config.targetDbfs / 20) / maxPeak;
  return { sets, gain };
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
  if (mode === 'loops') {
    // 루프 세트 렌더: node render.mjs loops --config v10-loops.json
    const configPath = resolve(argValue(args, '--config', join(here, 'v10-loops.json')));
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const baseDir = dirname(configPath);
    const outDir = resolve(baseDir, config.output);
    mkdirSync(outDir, { recursive: true });
    const { sets, gain } = renderLoopSet(config, baseDir);
    const report = [];
    for (const { rpm, cycles, samples } of sets) {
      const file = join(outDir, `rpm-${rpm}.wav`);
      const norm = Float64Array.from(samples, (x) => x * gain);
      writeWav(file, norm, config.sampleRate);
      report.push({ rpm, cycles, samples: samples.length, seconds: +(samples.length / config.sampleRate).toFixed(4), peakDb: +toDb(peak(norm)).toFixed(2), rmsDb: +toDb(rms(norm)).toFixed(2) });
    }
    console.log(JSON.stringify({ outDir, commonGainDb: +toDb(gain).toFixed(2), loops: report }, null, 1));
    process.exit(0);
  }
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
