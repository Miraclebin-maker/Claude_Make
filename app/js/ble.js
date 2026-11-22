// Web Bluetooth 전송 계층. 자동 연결 / 재연결 / 송신 큐.
// 송신 호출은 이 파일의 writeChunk 한 곳에만 존재하며, 모든 패킷은 encodePacket 을 거친다.
// 외부 인터페이스: connect, disconnect, autoConnect, send, sendPassword, onPacket, onState.
import { encodePacket, PacketDecoder } from './protocol.js';
import * as settings from './settings.js';

export const BLE_SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
export const BLE_CHAR_UUID = '0000fff1-0000-1000-8000-00805f9b34fb';

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
const RETRY_MS = 10000;

export class TslBle {
  // guard: () => boolean. false 면 자동 연결을 하지 않는다 (데모 중).
  constructor({ guard = () => true } = {}) {
    this.guard = guard;
    this.device = null;
    this.char = null;
    this.state = 'idle'; // idle | connecting | searching | connected | reconnecting
    this.name = '';
    this.manual = false;
    this.closed = false; // 앱 종료 후에는 어떤 자동 연결도 시작하지 않는다
    this.mtu = 120;
    this.decoder = new PacketDecoder();
    this.txQueue = Promise.resolve();
    this.pollTimer = null;
    this.seqTimers = [];
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.retryTimer = null;
    this.retryPending = false;
    this.watchAbort = null;
    this.packetHandlers = [];
    this.stateHandlers = [];
    this.hooked = new WeakSet();

    this.onValue = (e) => {
      const dv = e.target.value;
      this.decoder.push(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength), Date.now())
        .forEach((pkt) => this.packetHandlers.forEach((fn) => fn(pkt)));
    };
    this.onGattDisconnected = () => this.handleDisconnect();

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.retryPending && !this.closed) {
          this.retryPending = false;
          this.autoConnect();
        }
      });
    }
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
    if (this.watchAbort) this.watchAbort.abort();
    this.watchAbort = null;
  }

  // 사용자 탭 -> requestDevice. 실패 시 사용자에게 보여줄 문구를, 성공/취소 시 null 을 돌려준다.
  async connect() {
    if (this.closed) return null;
    if (!navigator.bluetooth) {
      return '이 브라우저는 Web Bluetooth를 지원하지 않습니다. Chrome을 이용해 주세요.';
    }
    if (this.state === 'connected' || this.state === 'connecting') return null;
    this.manual = false;
    this.clearTimers();
    this.setState('connecting', this.name);
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [BLE_SERVICE_UUID] }],
        optionalServices: [BLE_SERVICE_UUID],
      });
      settings.setLastDevice(device.id, device.name || 'TSL');
      await this.attach(device);
      return null;
    } catch (err) {
      this.setState('idle', '');
      return err && err.name === 'NotFoundError' ? null : `연결 오류: ${err && err.message}`;
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
    const wasConnected = this.state === 'connected';
    const device = this.device;
    const ch = this.char;
    this.clearTimers();
    if (wasConnected && ch) {
      this.enqueueWrite(ch, 176, [0]); // 구독 해제 후 연결 종료
      this.txQueue.then(() => {
        if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
      });
    } else if (device && device.gatt && device.gatt.connected) {
      device.gatt.disconnect();
    }
    this.char = null;
    this.setState('idle', '');
  }

  // 저장된 기기 자동 연결 (설계 4.3). 반환: 'disabled' | 'no-device' | 'unavailable' | 'not-found'
  // | 'connected' | 'searching' | 'failed' | 'blocked'
  async autoConnect() {
    if (this.closed) return 'disabled';
    if (this.state === 'connected' || this.state === 'connecting' || this.state === 'searching') {
      return this.state;
    }
    if (!this.guard()) return 'blocked';
    if (!settings.isAutoConnect()) return 'disabled';
    const last = settings.getLastDevice();
    if (!last) return 'no-device';
    if (!navigator.bluetooth || typeof navigator.bluetooth.getDevices !== 'function') return 'unavailable';

    let devices = [];
    try {
      devices = await navigator.bluetooth.getDevices();
    } catch (e) {
      return 'unavailable';
    }
    const dev = devices.find((d) => d.id === last.id);
    if (!dev) return 'not-found';

    this.manual = false;
    this.setState('connecting', last.name);
    try {
      await this.attach(dev);
      return 'connected';
    } catch (e) {
      // 실패 시 광고 수신 대기(가능하면) 또는 10초 재시도
    }
    if (typeof dev.watchAdvertisements === 'function') {
      await this.watch(dev);
      return this.state === 'connected' ? 'connected' : 'searching';
    }
    this.setState('idle', '');
    this.scheduleRetry();
    return 'failed';
  }

  async watch(dev) {
    this.setState('searching', this.name);
    const ac = new AbortController();
    this.watchAbort = ac;
    const onAdv = async () => {
      dev.removeEventListener('advertisementreceived', onAdv);
      if (this.watchAbort) this.watchAbort.abort();
      this.watchAbort = null;
      this.setState('connecting', this.name);
      try {
        await this.attach(dev);
      } catch (e) {
        this.setState('idle', '');
        this.scheduleRetry();
      }
    };
    dev.addEventListener('advertisementreceived', onAdv);
    try {
      await dev.watchAdvertisements({ signal: ac.signal });
    } catch (e) {
      dev.removeEventListener('advertisementreceived', onAdv);
      this.watchAbort = null;
      this.setState('idle', '');
      this.scheduleRetry();
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

  // gatt 연결 + 특성 구독 + 시작 시퀀스 (설계 4.2)
  async attach(device) {
    if (this.closed) return;
    this.device = device;
    if (!this.hooked.has(device)) {
      device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
      this.hooked.add(device);
    }
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(BLE_SERVICE_UUID);
    const ch = await service.getCharacteristic(BLE_CHAR_UUID);
    await ch.startNotifications();
    // 재연결 시 리스너가 중복 등록되지 않도록 먼저 제거
    ch.removeEventListener('characteristicvaluechanged', this.onValue);
    ch.addEventListener('characteristicvaluechanged', this.onValue);
    this.char = ch;
    this.decoder.reset();
    this.reconnectAttempt = 0;
    this.setState('connected', device.name || 'TSL');
    this.startSequence();
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
    return this.state === 'connected' && !!this.char;
  }

  // 모든 송신은 encodePacket 화이트리스트를 거친다 (화이트리스트 외 type 은 throw).
  send(type, payload = []) {
    if (!this.isConnected()) return;
    const pkt = encodePacket(type, payload);
    this.enqueueWrite(this.char, pkt);
  }

  enqueueWrite(ch, typeOrPkt, payload) {
    const pkt = typeOrPkt instanceof Uint8Array ? typeOrPkt : encodePacket(typeOrPkt, payload);
    this.txQueue = this.txQueue.then(async () => {
      for (let offset = 0; offset < pkt.length; offset += this.mtu) {
        await this.writeChunk(ch, pkt.slice(offset, offset + this.mtu));
      }
    }).catch(() => {});
  }

  async writeChunk(ch, chunk) {
    try {
      if (ch.properties && ch.properties.writeWithoutResponse) {
        await ch.writeValueWithoutResponse(chunk);
      } else {
        await ch.writeValue(chunk);
      }
    } catch (err) {
      if (chunk.length > 20) {
        this.mtu = 20;
        for (let sub = 0; sub < chunk.length; sub += 20) {
          const part = chunk.slice(sub, sub + 20);
          if (ch.properties && ch.properties.writeWithoutResponse) {
            await ch.writeValueWithoutResponse(part);
          } else {
            await ch.writeValue(part);
          }
        }
      } else {
        throw err;
      }
    }
  }

  handleDisconnect() {
    if (this.manual) return;
    this.stopPollingSilently();
    this.char = null;
    this.setState('reconnecting', this.name);
    this.scheduleReconnect();
  }

  stopPollingSilently() {
    this.seqTimers.forEach((t) => clearTimeout(t));
    this.seqTimers = [];
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  scheduleReconnect() {
    const idx = Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1);
    this.reconnectTimer = setTimeout(() => this.tryReconnect(), RECONNECT_DELAYS_MS[idx]);
  }

  async tryReconnect() {
    this.reconnectTimer = null;
    if (this.manual || this.closed || !this.device) return;
    try {
      await this.attach(this.device);
    } catch (e) {
      this.reconnectAttempt += 1;
      this.scheduleReconnect();
    }
  }
}
