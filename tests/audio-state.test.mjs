// 오디오 상태 결정 (§22): 음소거·숨김·경고음 조합에서 running/suspended 가 맞는지 검사한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioStateFor, unlockWanted, CHIME_HOLD_MS } from '../app/js/audio/audio-state.js';

test('음소거(off)면 suspended', () => {
  assert.equal(audioStateFor({ profile: 'off', hidden: false, chimeBusy: false }), 'suspended');
});

test('소리 프로필이 켜져 있고 화면이 보이면 running', () => {
  for (const profile of ['zimmer', 'plaid', 'v10']) {
    assert.equal(audioStateFor({ profile, hidden: false, chimeBusy: false }), 'running', profile);
  }
});

test('페이지가 숨겨지면 프로필이 켜져 있어도 suspended', () => {
  assert.equal(audioStateFor({ profile: 'v10', hidden: true, chimeBusy: false }), 'suspended');
});

test('음소거 상태에서 경고음이 울리는 동안만 running', () => {
  assert.equal(audioStateFor({ profile: 'off', hidden: false, chimeBusy: true }), 'running');
  assert.equal(audioStateFor({ profile: 'off', hidden: false, chimeBusy: false }), 'suspended');
});

test('경고음 유지 시간은 재생 길이 + 0.3 초', () => {
  assert.equal(CHIME_HOLD_MS, 700);
});

test('unlock 은 프로필이 off 이거나 닫혔으면 아무것도 하지 않는다', () => {
  assert.equal(unlockWanted({ profile: 'off', closed: false }), false);
  assert.equal(unlockWanted({ profile: 'v10', closed: true }), false);
  assert.equal(unlockWanted({ profile: 'v10', closed: false }), true);
});
