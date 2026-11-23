// 오디오 컨텍스트 상태 결정 (§22). 순수 함수: 브라우저 API 를 쓰지 않는다 (tests/audio-state.test.mjs 가 검사).
// 소리가 필요 없으면 AudioContext 를 suspend 해 안드로이드 오디오 포커스를 놓는다.

// 경고음 길이: 두 음 (0.14 s 간격 + 0.26 s 꼬리) 과 그 뒤 여유 0.3 s 뒤에 suspend 한다.
export const CHIME_LEN_MS = 400;
export const CHIME_HOLD_MS = CHIME_LEN_MS + 300;

// 'running' 이면 재생해야 하고, 'suspended' 이면 멈춰야 한다.
//   - 경고음이 울리는 중이면 프로필과 무관하게 running (경고음 뒤 CHIME_HOLD_MS 가 지나면 다시 suspended)
//   - 프로필이 off 이거나 페이지가 숨겨지면 suspended
//   - 그 밖에는 running
export function audioStateFor({ profile, hidden, chimeBusy }) {
  if (chimeBusy) return 'running';
  if (profile === 'off' || hidden) return 'suspended';
  return 'running';
}

// 탭(사용자 활성화)마다 unlock() 이 컨텍스트를 만들거나 재개할지. off 이거나 닫혔으면 아무것도 하지 않는다.
export function unlockWanted({ profile, closed }) {
  return !closed && profile !== 'off';
}
