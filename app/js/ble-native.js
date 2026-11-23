// 네이티브(Capacitor) 블루투스 전송 계층 (§23.2). ble.js 와 같은 외부 인터페이스를 가진다.
// 플러그인: window.Capacitor.Plugins.BluetoothLe (원시 플러그인 API, 번들러 없이 사용).
// 쓰기 호출(plugin.write / plugin.writeWithoutResponse)은 이 파일의 writeChunk 한 곳에만 있으며,
// 모든 패킷은 protocol.js 의 encodePacket 화이트리스트를 거친다.
import { encodePacket, PacketDecoder } from './protocol.js';
import * as settings from './settings.js';
import { BLE_SERVICE_UUID, BLE_CHAR_UUID } from './ble.js';

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
const RETRY_MS = 10000;
// 네이티브 쓰기 단위: 20바이트 (웹 ble.js 가 MTU 실패 시 쓰는 크기와 같다). 패킷은 보통 이보다 짧다.
const CHUNK = 20;

// Capacitor 네이티브 셸 안에서 열렸는지. 브라우저에서는 false.
export function isNativeApp(w = typeof window !== 'undefined' ? window : undefined) {
  const cap = w && w.Capacitor;
  return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
}

// 플러그인은 값을 16진 문자열로 주고받는다 (공백 없이 소문자, 수신은 구분자 무시).
export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex) {
  const clean = String(hex).replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function defaultPlugin() {
  const w = typeof window !== 'undefined' ? window : undefined;
  return (w && w.Capacitor && w.Capacitor.Plugins && w.Capacitor.Plugins.BluetoothLe) || null;
}

export class TslBleNative {
  // plugin: BluetoothLe 원시 플러그인 객체 (테스트에서는 가짜 객체를 넣는다)
  // guard: () => boolean. false 면 자동 연결을 하지 않는다 (데모 중).
  constructor({ plugin = defaultPlugin(), guard = () => true } = {}) {
    this.plugin = plugin;
    this.guard = guard;
    this.deviceId = null;
    this.name = '';
    this.charWriteNoResponse = false;
    this.state = 'idle'; // idle | connecting | connected | reconnecting
    this.manual = false;
    this.closed = false; // 앱 종료 후에는 어떤 자동 연결도 시작하지 않는다
    this.listeners = []; // 플러그인 리스너 핸들 (remove() 로 해제)
    this.initPromise = null;
    this.decoder = new PacketDecoder();
    this.txQueue = Promise.resolve();
    this.pollTimer = null;
    this.seqTimers = [];
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.retryTimer = null;
    this.retryPending = false;
    this.packetHandlers = [];
    this.stateHandlers = [];

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.retryPending && !this.closed) {
          this.retryPending = false;
          this.autoConnect();
        }
      });
    }
  }

  // 플러그인 초기화 (블루투스 권한 요청). 한 번만 한다. androidNeverForLocation: 스캔 결과로 위치를 추정하지 않는다.
  ensureInitialized() {
    if (!this.initPromise) {
      this.initPromise = this.plugin.initialize({ androidNeverForLocation: true }).catch((err) => {
        this.initPromise = null; // 다음 시도에 다시 한다
        throw err;
      });
    }
    return this.initPromise;
  }

  onPacket(fn) {
    this.packetHandlers.push(fn);
  }

  onState(fn) {
    this.stateHandlers.push(fn);
  }

  setState(state, name = this.name) {
    if (this.state === state && this.name === name) return;
    this.state = state;
    this.name = name;
    this.stateHandlers.forEach((fn) => fn(state, name));
  }

  clearTimers() {
    this.seqTimers.forEach((t) => clearTimeout(t));
    this.seqTimers = [];
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  async dropListeners() {
    const handles = this.listeners;
    this.listeners = [];
    await Promise.all(handles.map((h) => Promise.resolve(h.remove()).catch(() => {})));
  }

  // 사용자 탭 -> 기기 선택(requestDevice, 서비스 UUID 필터). 실패 시 문구, 취소/성공 시 null.
  async connect() {
    if (this.closed) return null;
    if (!this.plugin) return '이 기기에서 블루투스 플러그인을 쓸 수 없습니다.';
    if (this.state === 'connected' || this.state === 'connecting') return null;
    this.manual = false;
    this.clearTimers();
    this.setState('connecting', this.name);
    try {
      await this.ensureInitialized();
      const dev = await this.plugin.requestDevice({
        services: [BLE_SERVICE_UUID],
        optionalServices: [BLE_SERVICE_UUID],
      });
      const name = dev.name || 'TSL';
      settings.setLastDevice(dev.deviceId, name);
      await this.attach(dev.deviceId, name);
      return null;
    } catch (err) {
      this.setState('idle', '');
      const msg = (err && err.message) || String(err);
      return /cancel|취소/i.test(msg) ? null : `연결 오류: ${msg}`;
    }
  }

  // 앱 종료: 연결을 해제하고 이후의 모든 연결 시도를 막는다.
  shutdown() {
    this.closed = true;
    this.disconnect();
  }

  // 수동 해제. 자동 재연결과 재시도 타이머를 모두 끈다.
  disconnect() {
    this.manual = true;
    const id = this.deviceId;
    const wasConnected = this.state === 'connected';
    this.clearTimers();
    if (id && wasConnected) {
      this.enqueueWrite(encodePacket(176, [0])); // 구독 해제 후 연결 종료
      this.txQueue.then(() => this.plugin && this.plugin.disconnect({ deviceId: id }).catch(() => {}));
    } else if (id && this.plugin) {
      this.plugin.disconnect({ deviceId: id }).catch(() => {});
    }
    this.dropListeners();
    this.deviceId = null;
    this.charWriteNoResponse = false;
    this.setState('idle', '');
  }

  // 저장된 기기 자동 연결 (설계 4.3). 반환: 'disabled' | 'no-device' | 'unavailable' | 'blocked'
  // | 'connected' | 'failed' | 연결 중이면 현재 상태
  async autoConnect() {
    if (this.closed) return 'disabled';
    if (this.state === 'connected' || this.state === 'connecting') return this.state;
    if (!this.guard()) return 'blocked';
    if (!settings.isAutoConnect()) return 'disabled';
    const last = settings.getLastDevice();
    if (!last) return 'no-device';
    if (!this.plugin) return 'unavailable';

    this.manual = false;
    this.clearTimers();
    this.setState('connecting', last.name);
    try {
      await this.ensureInitialized();
      await this.attach(last.id, last.name);
      return 'connected';
    } catch (e) {
      this.setState('idle', '');
      this.scheduleRetry();
      return 'failed';
    }
  }

  scheduleRetry() {
    if (this.closed) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (typeof document !== 'undefined' && document.hidden) {
        this.retryPending = true; // 화면이 다시 보일 때 재개
        return;
      }
      this.autoConnect();
    }, RETRY_MS);
  }

  // 연결 + 알림 구독 + 시작 시퀀스 (설계 4.2). 실패하면 던진다.
  async attach(deviceId, name) {
    if (this.closed) return;
    const p = this.plugin;
    await this.dropListeners();
    this.deviceId = deviceId;
    try {
      this.listeners.push(await p.addListener(`disconnected|${deviceId}`, () => this.handleDisconnect(deviceId)));
      await p.connect({ deviceId });
      const services = await p.getServices({ deviceId });
      const ch = findCharacteristic(services);
      if (!ch) throw new Error('TSL 서비스/특성을 찾지 못했습니다');
      this.charWriteNoResponse = !!(ch.properties && ch.properties.writeWithoutResponse);
      this.listeners.push(await p.addListener(`notification|${deviceId}|${BLE_SERVICE_UUID}|${BLE_CHAR_UUID}`,
        (ev) => this.onValue(ev && ev.value)));
      await p.startNotifications({ deviceId, service: BLE_SERVICE_UUID, characteristic: BLE_CHAR_UUID });
    } catch (err) {
      await this.dropListeners();
      p.disconnect({ deviceId }).catch(() => {});
      throw err; // deviceId 는 남긴다: 재연결이 같은 기기로 다시 시도한다
    }
    this.decoder.reset();
    this.reconnectAttempt = 0;
    this.setState('connected', name);
    this.startSequence();
  }

  onValue(hex) {
    const bytes = fromHex(hex || '');
    this.decoder.push(bytes, Date.now())
      .forEach((pkt) => this.packetHandlers.forEach((fn) => fn(pkt)));
  }

  startSequence() {
    this.seqTimers.forEach((t) => clearTimeout(t));
    this.seqTimers = [
      setTimeout(() => this.sendPassword(), 180),
      setTimeout(() => this.send(160, []), 330),
      setTimeout(() => this.startPolling(), 500),
    ];
  }

  sendPassword(pw = settings.getPassword()) {
    if (!pw || pw.length !== 4) return;
    this.send(168, [pw.charCodeAt(0), pw.charCodeAt(1), pw.charCodeAt(2), pw.charCodeAt(3)]);
  }

  startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.send(176, [1]);
    this.pollTimer = setInterval(() => {
      if (this.isConnected()) this.send(176, [1]);
    }, 1000);
  }

  isConnected() {
    return this.state === 'connected' && !!this.deviceId;
  }

  // 모든 송신은 encodePacket 화이트리스트를 거친다 (화이트리스트 외 type 은 throw).
  send(type, payload = []) {
    if (!this.isConnected()) return;
    this.enqueueWrite(encodePacket(type, payload));
  }

  enqueueWrite(pkt) {
    this.txQueue = this.txQueue.then(async () => {
      for (let offset = 0; offset < pkt.length; offset += CHUNK) {
        await this.writeChunk(pkt.slice(offset, offset + CHUNK));
      }
    }).catch(() => {});
  }

  // 송신 호출은 이 함수 한 곳에만 있다.
  async writeChunk(chunk) {
    const args = {
      deviceId: this.deviceId,
      service: BLE_SERVICE_UUID,
      characteristic: BLE_CHAR_UUID,
      value: toHex(chunk),
    };
    if (this.charWriteNoResponse) await this.plugin.writeWithoutResponse(args);
    else await this.plugin.write(args);
  }

  handleDisconnect(deviceId) {
    if (this.manual || this.closed || deviceId !== this.deviceId) return;
    this.seqTimers.forEach((t) => clearTimeout(t));
    this.seqTimers = [];
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.setState('reconnecting', this.name);
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    const idx = Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1);
    this.reconnectTimer = setTimeout(() => this.tryReconnect(), RECONNECT_DELAYS_MS[idx]);
  }

  async tryReconnect() {
    this.reconnectTimer = null;
    if (this.manual || this.closed || !this.deviceId) return;
    try {
      await this.attach(this.deviceId, this.name);
    } catch (e) {
      this.reconnectAttempt += 1;
      this.scheduleReconnect();
    }
  }
}

function findCharacteristic(services) {
  const list = (services && services.services) || [];
  for (const s of list) {
    if (String(s.uuid).toLowerCase() !== BLE_SERVICE_UUID) continue;
    for (const c of s.characteristics || []) {
      if (String(c.uuid).toLowerCase() === BLE_CHAR_UUID) return c;
    }
  }
  return null;
}
