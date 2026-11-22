# TSL 계기판 v1

TSL CAN 모듈과 Web Bluetooth로 통신하는 읽기 전용 계기판 PWA. 빌드 도구 없이 바닐라 ES 모듈과 순수 CSS로 작성했다.
설계 기준은 `docs/DESIGN.md`, 원본은 `legacy/tslclu_v0.html`(수정 금지).

## 실행

Web Bluetooth와 AudioWorklet은 보안 컨텍스트(HTTPS 또는 localhost)에서만 동작한다.

```sh
npm run serve        # python3 -m http.server 8080 --directory app
# 브라우저에서 http://localhost:8080 열기
```

- 차량 없이 UI/사운드를 확인하려면 설정(⚙) › 기타 › **데모 시작**.
- 연결: 상단 좌측 BLE 상태 버튼 탭 (또는 힌트 배너가 뜬 상태에서 화면 탭).

## 호스팅 (실제 차량 사용)

- HTTPS 정적 호스팅에 `app/` 폴더를 그대로 올린다 (GitHub Pages, Netlify 등).
- 휴대폰 Chrome 홈 화면에 추가하면 PWA로 전체화면 실행, 오프라인 셸 캐시가 동작한다.

## 자동 연결 (Chrome 플래그)

마지막 기기 자동 연결은 `navigator.bluetooth.getDevices()` 와 `watchAdvertisements()`를 쓴다.
Android Chrome에서 이 API가 보이지 않으면 아래 플래그를 켠다.

```
chrome://flags/#enable-web-bluetooth-new-permissions-backend
```

플래그가 없으면 앱은 힌트 배너("화면을 탭하면 TSL 모듈에 연결합니다")로 수동 연결을 안내한다.

## 테스트

```sh
npm test                 # node --test 'tests/*.test.mjs'  (프로토콜, RPM 모델)
node tests/smoke.mjs     # Playwright 스모크 (Chromium 필요, playwright install 은 불필요)
```

- `smoke.mjs` 는 `playwright` 패키지를 찾는다. 전역 설치 경로가 다르면 `PLAYWRIGHT_MODULE=/path/to/playwright/index.js` 로 지정.
- 스크린샷은 `tests/screens/` 에 저장되며 git 에서 제외된다.

## 구조

```
app/
  index.html, manifest.webmanifest, sw.js, icons/icon.svg
  css/app.css            레이아웃, 테마 토큰
  js/main.js             진입점, 상태, 트립/0-100, 이벤트
  js/protocol.js         패킷 인코드/디코드, 176/208 파싱, 송신 화이트리스트 (순수 함수)
  js/ble.js              Web Bluetooth 전송, 자동 연결/재연결 (송신 호출은 이 파일에만 있음)
  js/ui.js               DOM 렌더링 render(state)
  js/settings.js         localStorage 래퍼
  js/camera.js           GPS, 단속 카메라 DB, 접근 경고 (송신 없음)
  js/demo.js             데모 데이터
  js/plaid.js            플래드 워프 캔버스
  js/audio/audio.js      AudioContext, 프로필 전환, 볼륨, 경고음
  js/audio/ev.js         주행 사운드 (zimmer, plaid 오실레이터)
  js/audio/v10.js        V10 사운드: 루프 17개 재생, 등전력 크로스페이드 (순수 함수 포함)
  js/audio/rpm-model.js  가상 7단 변속기 (속도·페달 -> RPM, 순수 함수)
  audio/v10/rpm-*.wav    V10 루프 17개 (32kHz, 1000~9000rpm)
  js/gauge.js            신규 테마(arc, twin, hud) SVG 게이지
tools/engine-render/     enginesound(MIT) 물리 모델 포팅과 루프 렌더러
tests/                   protocol / rpm-model / v10 / v10-loops / engine-model 단위 테스트, smoke 스모크
```

V10 루프 다시 만들기 (WAV 를 바꿀 때만):
`cd tools/engine-render && node render.mjs loops --config v10-loops.json`

## 읽기 전용 원칙

- 모듈로 보내는 타입은 `ALLOWED_TX_TYPES` (160, 168, 176, 208)뿐이다. 그 외 타입은 `encodePacket` 이 throw 한다.
- 차량 프로필 변경(FSD) 명령은 제거했다. 카메라 기능은 배너와 경고음만 낸다.
