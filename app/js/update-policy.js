// 새 서비스워커가 제어권을 가져갔을 때의 동작 (§15.1). 순수 함수 (DOM/navigator 사용 금지).
// 주행 중(BLE 연결·재연결 중)이나 데모 중에는 화면을 새로고침하지 않고 안내만 한다.
export function controllerChangeAction({ connState, demo }) {
  if (demo || connState === 'connected' || connState === 'reconnecting') return 'toast';
  return 'reload';
}
