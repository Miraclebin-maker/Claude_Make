// 청취용: 앱의 V10 재생 경로(app/js/audio/v10.js + rpm-model.js)를 그대로 돌려 10초 가속 파일을 만든다 (§18.3).
// 헤드리스 Chromium 의 OfflineAudioContext 에서 실행하므로 Web Audio 노드 구성과 파라미터 계산이 앱과 같다.
// 실행: node app-sweep.mjs --out <file.wav>   (Playwright 는 기존 설치를 쓴다. 재설치하지 않는다)
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeWav } from './wav.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..', '..', 'app');
const PORT = 8797;

// 페이지 안에서 실행: 앱 모듈을 import 해서 오프라인 렌더
async function renderInPage(base) {
  const v10 = await import('/js/audio/v10.js');
  const rm = await import('/js/audio/rpm-model.js');
  const SR = 48000;
  const DUR = 10;
  const dt = 1 / 60;
  const ctx = new OfflineAudioContext(2, SR * DUR, SR);
  const buffers = await v10.loadV10Buffers(ctx, base);
  const graph = v10.createV10Graph(ctx, buffers, ctx.destination, 0);
  const model = rm.createRpmModel();
  // 시나리오: 1.5초 정차 -> 1.5~8.5초 페달 90%로 0 -> 180km/h -> 8.5~10초 페달 0 (회생)
  const speedAt = (t) => (t < 1.5 ? 0 : t < 8.5 ? ((t - 1.5) / 7) * 180 : 180);
  const pedalAt = (t) => (t < 1.5 ? 0 : t < 8.5 ? 90 : 0);
  const kwAt = (t) => (t < 1.5 ? 0 : t < 8.5 ? 150 : -30);
  const events = [];
  const trace = [];
  for (let t = 0; t < DUR; t += dt) {
    const r = rm.stepRpm(model, { speedKmh: speedAt(t), pedalPct: pedalAt(t), dtSec: dt });
    if (r.event) events.push({ t: +t.toFixed(2), event: r.event, rpm: Math.round(r.rpm), gear: r.gear });
    trace.push(Math.round(r.rpm));
    graph.update(r.rpm, pedalAt(t), kwAt(t), t);
  }
  const out = await ctx.startRendering();
  const ch = out.getChannelData(0);
  const bytes = new Uint8Array(ch.buffer, ch.byteOffset, ch.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { sampleRate: out.sampleRate, b64: btoa(bin), events, rpmMin: Math.min(...trace), rpmMax: Math.max(...trace) };
}

const outArg = process.argv.indexOf('--out');
const outPath = resolve(outArg >= 0 ? process.argv[outArg + 1] : join(here, 'v10-app-sweep.wav'));

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', appDir], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const pw = await import(pathToFileURL('/opt/node-tools/node_modules/playwright/index.js').href);
const chromium = pw.chromium || pw.default.chromium;
const browser = await chromium.launch();
try {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
  const res = await page.evaluate(renderInPage, `http://127.0.0.1:${PORT}/audio/v10/`);
  const f32 = new Float32Array(Buffer.from(res.b64, 'base64').buffer.slice(0));
  const samples = Float64Array.from(f32);
  // 청취 편의: 피크 -1 dBFS 로 한 번만 맞춘다(엔진 음량 비교용이 아니라 청취 파일)
  let peak = 0;
  for (const x of samples) peak = Math.max(peak, Math.abs(x));
  const g = Math.pow(10, -1 / 20) / peak;
  writeWav(outPath, Float64Array.from(samples, (x) => x * g), res.sampleRate);
  console.log(JSON.stringify({ file: outPath, sampleRate: res.sampleRate, seconds: samples.length / res.sampleRate, rpmMin: res.rpmMin, rpmMax: res.rpmMax, gearEvents: res.events }, null, 1));
} finally {
  await browser.close();
  server.kill();
}
