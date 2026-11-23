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

// §24 강제 회전 안정화: 박스 크기, 실제 방향, 디바운스·쿨다운 판단
import { viewportBox, actualOrientation, rotationDecision } from '../app/js/orientation.js';

test('회전 박스 크기: visualViewport 가 있으면 우선, 없으면 innerWidth/innerHeight', () => {
  assert.deepEqual(viewportBox({ vvWidth: 390, vvHeight: 760, innerWidth: 390, innerHeight: 844 }), { w: 390, h: 760 });
  assert.deepEqual(viewportBox({ vvWidth: undefined, vvHeight: 0, innerWidth: 390, innerHeight: 844 }), { w: 390, h: 844 });
});

test('실제 방향: screen.orientation.type 우선, 없으면 크기 비교', () => {
  assert.equal(actualOrientation({ type: 'landscape-primary', width: 390, height: 844 }), 'landscape');
  assert.equal(actualOrientation({ type: 'portrait-secondary', width: 844, height: 390 }), 'portrait');
  assert.equal(actualOrientation({ type: undefined, width: 844, height: 390 }), 'landscape');
  assert.equal(actualOrientation({ type: undefined, width: 390, height: 844 }), 'portrait');
});

test('디바운스: 400ms 안의 연속 이벤트는 마지막 판단 시점에만 반영한다', () => {
  // 0ms 에 이벤트가 있었고, 300ms 에 다시 보면 아직 기다린다 (남은 100ms)
  assert.deepEqual(rotationDecision({ now: 300, lastEventAt: 0, current: false, want: true }), { apply: false, waitMs: 100 });
  // 400ms 가 지나면 그때의 값(want)을 반영한다
  assert.deepEqual(rotationDecision({ now: 400, lastEventAt: 0, current: false, want: true }), { apply: true, waitMs: 0 });
});

test('같은 결과면 아무것도 바꾸지 않는다', () => {
  assert.equal(rotationDecision({ now: 5000, current: true, want: true, force: true }).apply, false);
});

test('쿨다운: 변경 뒤 1초 안에는 다시 바꾸지 않고 남은 시간을 알려 준다', () => {
  assert.deepEqual(rotationDecision({ now: 1500, lastEventAt: 0, lastChangeAt: 1000, current: true, want: false }),
    { apply: false, waitMs: 500 });
  assert.deepEqual(rotationDecision({ now: 2000, lastEventAt: 0, lastChangeAt: 1000, current: true, want: false }),
    { apply: true, waitMs: 0 });
});

test('↻ 버튼(force)은 디바운스·쿨다운을 무시하고 즉시 반영한다', () => {
  assert.deepEqual(rotationDecision({ now: 1100, lastEventAt: 1090, lastChangeAt: 1000, current: false, want: true, force: true }),
    { apply: true, waitMs: 0 });
});

test('잠금 시도 중에는 재계산하지 않는다', () => {
  assert.equal(rotationDecision({ now: 9000, current: false, want: true, locking: true, force: true }).apply, false);
});
