import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controllerChangeAction } from '../app/js/update-policy.js';

test('미연결·유휴 상태에서는 다시 로드한다', () => {
  assert.equal(controllerChangeAction({ connState: 'idle', demo: false }), 'reload');
  assert.equal(controllerChangeAction({ connState: 'connecting', demo: false }), 'reload');
});

test('BLE 연결 또는 재연결 중에는 로드하지 않고 안내만 한다', () => {
  assert.equal(controllerChangeAction({ connState: 'connected', demo: false }), 'toast');
  assert.equal(controllerChangeAction({ connState: 'reconnecting', demo: false }), 'toast');
});

test('데모 중에는 연결 상태와 무관하게 안내만 한다', () => {
  assert.equal(controllerChangeAction({ connState: 'idle', demo: true }), 'toast');
});
