import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHeadingTracker, haversineMeters, calcBearingDeg, isAhead, camDirMatches,
  speedKmhOf, shouldAlert, MIN_ALERT_KMH,
} from '../app/js/camera-logic.js';

// 위도 방향으로 n 미터 북쪽 이동한 좌표
const north = (lat, lng, m) => ({ lat: lat + m / 111320, lng });
const BASE = { lat: 37.5, lng: 127.0 };

test('방향: GPS heading 이 있고 속도 ≥ 3 m/s 이면 그 값을 쓴다', () => {
  const t = createHeadingTracker();
  assert.equal(t.update({ ...BASE, heading: 90, speed: 5 }), 90);
});

test('방향: GPS 속도가 3 m/s 미만이면 GPS heading 을 믿지 않는다', () => {
  const t = createHeadingTracker();
  assert.equal(t.update({ ...BASE, heading: 90, speed: 1 }), null);
});

test('방향: 위치로 계산하려면 마지막 기준점에서 15 m 이상 이동해야 한다', () => {
  const t = createHeadingTracker();
  t.update({ ...BASE, heading: null, speed: null });
  assert.equal(t.update({ ...north(BASE.lat, BASE.lng, 10), heading: null, speed: null }), null, '10 m 이동');
  const h = t.update({ ...north(BASE.lat, BASE.lng, 20), heading: null, speed: null });
  assert.ok(h !== null, '20 m 이동 후 방향 계산');
  assert.ok(Math.abs(h - 0) < 1 || Math.abs(h - 360) < 1, `북쪽 이동 방위 ${h}`);
});

test('방향: 둘 다 없으면 미정(null). 계산된 방향은 새 계산 전까지 유지', () => {
  const t = createHeadingTracker();
  assert.equal(t.update({ ...BASE, heading: null, speed: null }), null);
  t.update({ ...north(BASE.lat, BASE.lng, 30), heading: null, speed: null });
  const kept = t.update({ ...north(BASE.lat, BASE.lng, 35), heading: null, speed: null });
  assert.ok(kept !== null, '5 m 더 움직여도 이전 방향 유지');
});

test('전방 판정: 진행 방향과 카메라 방위각 차이 ±35° 이내만 참', () => {
  assert.equal(isAhead(0, 30), true);
  assert.equal(isAhead(0, 36), false);
  assert.equal(isAhead(350, 10), true, '0도 경계 넘김');
  assert.equal(isAhead(null, 10), false, '방향 미정');
});

test('카메라 방향: 없으면 조건 생략, 있으면 ±45° 이내', () => {
  assert.equal(camDirMatches(0, undefined), true);
  assert.equal(camDirMatches(0, 40), true);
  assert.equal(camDirMatches(0, 50), false);
  assert.equal(camDirMatches(null, 10), false, '방향 미정이면 방향이 있는 카메라도 제외');
});

test('속도: 텔레메트리 우선, 없으면 GPS(m/s × 3.6), 둘 다 없으면 null', () => {
  assert.equal(speedKmhOf({ telemKmh: 50, gpsMs: 1 }), 50);
  assert.equal(speedKmhOf({ telemKmh: null, gpsMs: 10 }), 36);
  assert.equal(speedKmhOf({ telemKmh: null, gpsMs: null }), null);
});

test('경고: 방향 미정이면 경고하지 않는다', () => {
  assert.equal(shouldAlert({ heading: null, bearing: 0, dist: 300, prevDist: 320, camDir: undefined, speedKmh: 60 }), false);
});

test('경고: 15 km/h 미만이면 경고하지 않는다, 15 km/h 이상이면 가능', () => {
  const base = { heading: 0, bearing: 0, dist: 300, prevDist: 320, camDir: undefined };
  assert.equal(shouldAlert({ ...base, speedKmh: MIN_ALERT_KMH - 0.1 }), false);
  assert.equal(shouldAlert({ ...base, speedKmh: MIN_ALERT_KMH }), true);
  assert.equal(shouldAlert({ ...base, speedKmh: null }), false, '속도 정보 없음');
});

test('경고: 접근 중일 때만 (거리가 줄어들 때), 첫 평가는 접근 중으로 본다', () => {
  const base = { heading: 0, bearing: 0, dist: 300, camDir: undefined, speedKmh: 60 };
  assert.equal(shouldAlert({ ...base, prevDist: 320 }), true, '가까워짐');
  assert.equal(shouldAlert({ ...base, prevDist: 280 }), false, '멀어짐');
  assert.equal(shouldAlert({ ...base, prevDist: undefined }), true, '첫 평가');
});

test('경고: 전방 ±35° 밖이면 경고하지 않는다', () => {
  assert.equal(shouldAlert({ heading: 0, bearing: 60, dist: 300, prevDist: 320, camDir: undefined, speedKmh: 60 }), false);
});

test('경고: 카메라 방향이 있고 진행 방향과 45° 넘게 다르면 경고하지 않는다(반대 차선)', () => {
  const base = { heading: 0, bearing: 10, dist: 300, prevDist: 320, speedKmh: 60 };
  assert.equal(shouldAlert({ ...base, camDir: 20 }), true);
  assert.equal(shouldAlert({ ...base, camDir: 180 }), false);
});

test('거리/방위각 유틸: 북쪽 100 m 는 거리 약 100, 방위 약 0°', () => {
  const p = north(BASE.lat, BASE.lng, 100);
  assert.ok(Math.abs(haversineMeters(BASE.lat, BASE.lng, p.lat, p.lng) - 100) < 0.5);
  const b = calcBearingDeg(BASE.lat, BASE.lng, p.lat, p.lng);
  assert.ok(Math.abs(b) < 0.01 || Math.abs(b - 360) < 0.01);
});
