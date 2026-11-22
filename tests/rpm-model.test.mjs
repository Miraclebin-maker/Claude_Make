import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpmModel, stepRpm, upshiftRpm, wheelRpm, IDLE_RPM, REDLINE_RPM, SHIFT_LOCK_SEC } from '../app/js/audio/rpm-model.js';

const DT = 0.01;

// 속도 ramp 로 달린다. 반환: 샘플 배열과 변속 이벤트
function drive({ fromKmh, toKmh, seconds, pedal, dt = DT }) {
  const m = createRpmModel();
  const samples = [];
  const events = [];
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    const speed = fromKmh + ((toKmh - fromKmh) * i) / n;
    const r = stepRpm(m, { speedKmh: speed, pedalPct: typeof pedal === 'function' ? pedal(i * dt) : pedal, dtSec: dt });
    samples.push({ t: i * dt, ...r });
    if (r.event) events.push({ t: i * dt, event: r.event, rpm: r.rpm, gear: r.gear });
  }
  return { samples, events };
}

test('정차 시 공회전 근처에 머문다 (950 ± 25)', () => {
  const m = createRpmModel();
  let r;
  for (let i = 0; i < 500; i++) r = stepRpm(m, { speedKmh: 0, pedalPct: 0, dtSec: DT });
  assert.ok(Math.abs(r.rpm - IDLE_RPM) <= 25, `rpm ${r.rpm}`);
  assert.equal(r.gear, 1);
});

test('정차 중 페달: 공회전 레브 950 + p×0.6×레드라인 (페달 100% 이면 약 6230rpm)', () => {
  const m = createRpmModel();
  let r;
  for (let i = 0; i < 300; i++) r = stepRpm(m, { speedKmh: 0, pedalPct: 100, dtSec: DT });
  const target = IDLE_RPM + 0.6 * REDLINE_RPM;
  assert.ok(Math.abs(r.rpm - target) < 60, `rpm ${r.rpm} vs ${target}`);
});

test('가속 시 업시프트가 발생하고 RPM 은 레드라인을 넘지 않는다', () => {
  const { samples, events } = drive({ fromKmh: 0, toKmh: 220, seconds: 20, pedal: 100 });
  assert.ok(events.some((e) => e.event === 'upshift'), '업시프트 발생');
  assert.ok(Math.max(...samples.map((s) => s.rpm)) <= REDLINE_RPM + 1e-9, '레드라인 초과 없음');
  assert.ok(Math.min(...samples.map((s) => s.rpm)) >= IDLE_RPM - 1e-9, '공회전 아래로 내려가지 않음');
});

test('저부하 업시프트 RPM 은 고부하보다 낮다 (수치와 실제 변속 모두)', () => {
  assert.ok(upshiftRpm(20) < upshiftRpm(100));
  const low = drive({ fromKmh: 0, toKmh: 120, seconds: 15, pedal: 30 }).events.find((e) => e.event === 'upshift');
  const high = drive({ fromKmh: 0, toKmh: 120, seconds: 15, pedal: 100 }).events.find((e) => e.event === 'upshift');
  assert.ok(low && high, '두 경우 모두 업시프트');
  assert.ok(low.rpm < high.rpm, `저부하 ${low.rpm.toFixed(0)} < 고부하 ${high.rpm.toFixed(0)}`);
});

test('변속 후 재변속 금지: 연속 변속 사이 간격은 0.35초 이상', () => {
  const { events } = drive({ fromKmh: 0, toKmh: 260, seconds: 25, pedal: 100 });
  assert.ok(events.length >= 3, `변속 ${events.length}회`);
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].t - events[i - 1].t >= SHIFT_LOCK_SEC - 0.02, `간격 ${(events[i].t - events[i - 1].t).toFixed(3)}s`);
  }
});

test('변속 직후 RPM 은 새 기어 값으로 0.12초에 걸쳐 옮겨 간다 (튀지 않음)', () => {
  const { samples, events } = drive({ fromKmh: 0, toKmh: 120, seconds: 15, pedal: 100 });
  const ev = events[0];
  const idx = samples.findIndex((s) => s.t >= ev.t);
  const before = samples[idx - 1].rpm;
  const after = samples[idx + 20].rpm; // 0.2초 뒤
  assert.ok(Math.abs(after - before) < REDLINE_RPM * 0.6, `급격한 점프 ${before.toFixed(0)} -> ${after.toFixed(0)}`);
});

test('바퀴 RPM 공식: 속도가 두 배면 RPM 도 두 배 (같은 기어)', () => {
  assert.ok(Math.abs(wheelRpm(100, 3) * 2 - wheelRpm(200, 3)) < 1e-9);
});
