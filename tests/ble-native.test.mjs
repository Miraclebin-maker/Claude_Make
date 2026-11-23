// 네이티브 블루투스 전송 계층 (§23.5). 가짜 BluetoothLe 플러그인으로 송신 형식, 시작 순서, 재연결을 검사한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TslBleNative, isNativeApp, toHex, fromHex } from '../app/js/ble-native.js';
import { BLE_SERVICE_UUID, BLE_CHAR_UUID } from '../app/js/ble.js';
import { encodePacket } from '../app/js/protocol.js';
import * as settings from '../app/js/settings.js';

// settings.js 는 localStorage 를 쓴다. 노드에는 없으므로 메모리 저장소를 둔다.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const flush = () => new Promise((r) => setImmediate(r));

function fakePlugin({ failConnects = 0 } = {}) {
  const listeners = new Map();
  const calls = [];
  const writes = [];
  let failLeft = failConnects;
  const services = {
    services: [{ uuid: BLE_SERVICE_UUID, characteristics: [{ uuid: BLE_CHAR_UUID, properties: { writeWithoutResponse: true, write: false } }] }],
  };
  const plugin = {
    calls,
    writes,
    listeners,
    failConnects(n) { failLeft = n; },
    async initialize(o) { calls.push(['initialize', o.androidNeverForLocation]); },
    async requestDevice() { calls.push('requestDevice'); return { deviceId: 'AA:BB:CC:DD:EE:FF', name: 'TSL' }; },
    async addListener(name, fn) {
      listeners.set(name, fn);
      return { remove: async () => { listeners.delete(name); } };
    },
    async connect(o) {
      calls.push(['connect', o.deviceId]);
      if (failLeft > 0) { failLeft -= 1; throw new Error('connect failed'); }
    },
    async getServices() { return services; },
    async startNotifications(o) { calls.push(['startNotifications', o.characteristic]); },
    async disconnect(o) { calls.push(['disconnect', o.deviceId]); },
    async write(o) { writes.push(o.value); },
    async writeWithoutResponse(o) { writes.push(o.value); },
  };
  return plugin;
}

function setupSettings() {
  store.clear();
  settings.setAutoConnect(true);
  settings.setLastDevice('AA:BB:CC:DD:EE:FF', 'TSL');
}

test('플랫폼 판별: Capacitor 네이티브에서만 true', () => {
  assert.equal(isNativeApp({ Capacitor: { isNativePlatform: () => true } }), true);
  assert.equal(isNativeApp({ Capacitor: { isNativePlatform: () => false } }), false);
  assert.equal(isNativeApp({}), false);
  assert.equal(isNativeApp(undefined), false);
});

test('16진 변환은 왕복이 맞고 구분자를 무시한다', () => {
  const bytes = Uint8Array.from([0x55, 0x7f, 0xb0, 0x00, 0x01, 0x01, 0xb2]);
  assert.equal(toHex(bytes), '557fb0000101b2');
  assert.deepEqual(Array.from(fromHex('55 7F b0-00 01 01 b2')), Array.from(bytes));
});

test('연결 순서: 초기화(권한) -> 기기 선택 -> 연결 -> 알림 구독, 저장된 기기 기록', async () => {
  setupSettings();
  const plugin = fakePlugin();
  const ble = new TslBleNative({ plugin });
  const err = await ble.connect();
  assert.equal(err, null);
  assert.deepEqual(plugin.calls, [['initialize', true], 'requestDevice', ['connect', 'AA:BB:CC:DD:EE:FF'], ['startNotifications', BLE_CHAR_UUID]]);
  assert.equal(ble.state, 'connected');
  assert.equal(settings.getLastDevice().id, 'AA:BB:CC:DD:EE:FF');
  ble.shutdown();
});

test('시작 시퀀스: 160 (330ms) 와 176 구독 (500ms 이후 1초마다) 가 16진 형식으로 나간다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  setupSettings();
  const plugin = fakePlugin();
  const ble = new TslBleNative({ plugin });
  await ble.connect();
  // 저장된 비밀번호(기본 1234)로 168 인증이 180ms 에 먼저 나간다
  t.mock.timers.tick(180);
  await flush();
  assert.deepEqual(plugin.writes, ['557fa800043132333476']);
  t.mock.timers.tick(150); // 330ms: 160 정보 요청
  await flush();
  t.mock.timers.tick(170); // 500ms: 176 구독 시작
  await flush();
  assert.deepEqual(plugin.writes, ['557fa800043132333476', '557fa00000a0', '557fb0000101b2']);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(plugin.writes.length, 4);
  assert.equal(plugin.writes[3], '557fb0000101b2');
  ble.shutdown();
});

test('화이트리스트 밖 타입은 송신 전에 throw 하고 아무것도 쓰지 않는다', async () => {
  setupSettings();
  const plugin = fakePlugin();
  const ble = new TslBleNative({ plugin });
  await ble.connect();
  assert.throws(() => ble.send(0x99, [1]), /whitelist/);
  await flush();
  assert.equal(plugin.writes.some((w) => w.startsWith('557f99')), false);
  ble.shutdown();
});

test('알림 수신: 16진 값이 PacketDecoder 를 거쳐 onPacket 으로 간다', async () => {
  setupSettings();
  const plugin = fakePlugin();
  const ble = new TslBleNative({ plugin });
  const got = [];
  ble.onPacket((pkt) => got.push(pkt));
  await ble.connect();
  const frame = encodePacket(160, [1, 2, 3]);
  plugin.listeners.get(`notification|AA:BB:CC:DD:EE:FF|${BLE_SERVICE_UUID}|${BLE_CHAR_UUID}`)({ value: toHex(frame) });
  assert.equal(got.length, 1);
  assert.equal(got[0].type, 160);
  assert.deepEqual(Array.from(got[0].payload), [1, 2, 3]);
  ble.shutdown();
});

test('자동 연결 실패 뒤 10초 간격으로 다시 시도한다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  setupSettings();
  const plugin = fakePlugin({ failConnects: 1 });
  const ble = new TslBleNative({ plugin });
  assert.equal(await ble.autoConnect(), 'failed');
  assert.equal(ble.state, 'idle');
  t.mock.timers.tick(9999);
  assert.equal(plugin.calls.filter((c) => Array.isArray(c) && c[0] === 'connect').length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(plugin.calls.filter((c) => Array.isArray(c) && c[0] === 'connect').length, 2);
  assert.equal(ble.state, 'connected');
  ble.shutdown();
});

test('끊기면 1/2/4/8 초 백오프로 재연결한다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  setupSettings();
  const plugin = fakePlugin();
  const ble = new TslBleNative({ plugin });
  await ble.connect();
  const connects = () => plugin.calls.filter((c) => Array.isArray(c) && c[0] === 'connect').length;
  plugin.failConnects(3);
  plugin.listeners.get('disconnected|AA:BB:CC:DD:EE:FF')();
  assert.equal(ble.state, 'reconnecting');
  t.mock.timers.tick(1000); await flush(); // 1차 실패
  t.mock.timers.tick(2000); await flush(); // 2차 실패
  t.mock.timers.tick(4000); await flush(); // 3차 실패
  assert.equal(connects(), 4); // 최초 1 + 실패 3
  assert.equal(ble.state, 'reconnecting');
  t.mock.timers.tick(8000); await flush(); // 4차 성공
  assert.equal(connects(), 5);
  assert.equal(ble.state, 'connected');
  ble.shutdown();
});

test('수동 해제 뒤에는 끊김 이벤트가 와도 재연결하지 않는다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  setupSettings();
  const plugin = fakePlugin();
  const ble = new TslBleNative({ plugin });
  await ble.connect();
  ble.disconnect();
  plugin.listeners.get('disconnected|AA:BB:CC:DD:EE:FF')?.();
  t.mock.timers.tick(60000); await flush();
  assert.equal(plugin.calls.filter((c) => Array.isArray(c) && c[0] === 'connect').length, 1);
  assert.equal(ble.state, 'idle');
});

test('해제할 때 구독 해제(176 [0])를 보내고 기기 연결을 끊는다', async () => {
  setupSettings();
  const plugin = fakePlugin();
  const ble = new TslBleNative({ plugin });
  await ble.connect();
  ble.disconnect();
  await flush();
  assert.ok(plugin.writes.includes('557fb0000100b1'));
  assert.ok(plugin.calls.some((c) => Array.isArray(c) && c[0] === 'disconnect'));
});

test('앱 종료 뒤에는 자동 연결을 시작하지 않는다', async () => {
  setupSettings();
  const plugin = fakePlugin();
  const ble = new TslBleNative({ plugin });
  ble.shutdown();
  assert.equal(await ble.autoConnect(), 'disabled');
  assert.equal(plugin.calls.length, 0);
});

test('쓰기 호출은 ble-native.js 와 ble.js 두 곳에만 있다 (읽기 전용 원칙)', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'js');
  const offenders = [];
  const walk = (d) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.name.endsWith('.js') && !/ble(-native)?\.js$/.test(name.name)) {
        const src = readFileSync(p, 'utf8');
        if (/\.write(WithoutResponse)?\(|writeValue/.test(src)) offenders.push(p);
      }
    }
  };
  walk(dir);
  assert.deepEqual(offenders, []);
});
