import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextOrientMode, physicalOf, needsRotation, isOrientMode } from '../app/js/orientation.js';

test('방향 순환: 자동 → 가로 → 세로 → 자동', () => {
  assert.equal(nextOrientMode('auto'), 'landscape');
  assert.equal(nextOrientMode('landscape'), 'portrait');
  assert.equal(nextOrientMode('portrait'), 'auto');
  assert.equal(nextOrientMode('???'), 'landscape', '모르는 값은 자동으로 본다');
});

test('실제 방향: 가로형 뷰포트는 landscape, 정사각형은 portrait', () => {
  assert.equal(physicalOf(844, 390), 'landscape');
  assert.equal(physicalOf(390, 844), 'portrait');
  assert.equal(physicalOf(500, 500), 'portrait');
});

test('CSS 회전 대체: 잠금 실패 + 요청과 실제 방향이 다를 때만', () => {
  assert.equal(needsRotation('landscape', false, 'portrait'), true, '세로 기기에서 가로 요청');
  assert.equal(needsRotation('portrait', false, 'landscape'), true, '가로 기기에서 세로 요청');
  assert.equal(needsRotation('landscape', false, 'landscape'), false, '이미 가로');
  assert.equal(needsRotation('landscape', true, 'portrait'), false, '잠금 성공이면 회전 불필요');
  assert.equal(needsRotation('auto', false, 'portrait'), false, '자동이면 회전 없음');
});

test('저장값 검증', () => {
  assert.equal(isOrientMode('landscape'), true);
  assert.equal(isOrientMode('upside-down'), false);
});
