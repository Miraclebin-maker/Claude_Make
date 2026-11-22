// TSL 모듈 프로토콜 (순수 함수 모듈). DOM / navigator 사용 금지.
// 패킷: 55 7F type lenHi lenLo payload... sum(type..payload)&0xFF
// 파싱 비트 연산은 원본(legacy/tslclu_v0.html, parseTelemetry176 / parseHvPack208)을 그대로 옮겼다.

// 모듈로 보내도 되는 요청 타입의 화이트리스트. 차량 제어 명령은 존재하지 않는다.
export const ALLOWED_TX_TYPES = Object.freeze({
  INFO: 160,       // 모듈 정보 요청 (HW 버전)
  AUTH: 168,       // 모듈 비밀번호 인증
  TELEMETRY: 176,  // 실시간 텔레메트리 구독 [1] / 해제 [0]
  HV_PACK: 208,    // 고전압 팩 정보 요청
});

const ALLOWED_TYPE_SET = new Set(Object.values(ALLOWED_TX_TYPES));

// 화이트리스트 외 type 이면 throw. ble.js 는 반드시 이 함수를 거쳐서만 송신한다.
export function encodePacket(type, payload = []) {
  if (!ALLOWED_TYPE_SET.has(type)) {
    throw new Error(`encodePacket: type ${type} is not in the transmit whitelist`);
  }
  const data = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
  const len = data.length;
  if (len > 0xFFFF) throw new RangeError('encodePacket: payload too long');
  const pkt = new Uint8Array(6 + len);
  pkt[0] = 0x55;
  pkt[1] = 0x7F;
  pkt[2] = type & 0xFF;
  pkt[3] = (len >>> 8) & 0xFF;
  pkt[4] = len & 0xFF;
  pkt.set(data, 5);
  let sum = 0;
  for (let i = 2; i < 5 + len; i++) sum += pkt[i];
  pkt[5 + len] = sum & 0xFF;
  return pkt;
}

// 수신 스트림 디코더. 분할된 바이트 청크를 순서대로 push 하면 완성된 패킷을 돌려준다.
// nowMs 를 넘기면 500ms 이상 끊긴 뒤의 조각은 버린다(원본 동작). 생략하면 시간 리셋 없음.
export class PacketDecoder {
  constructor() {
    this.reset();
  }

  reset() {
    this.state = 0;
    this.type = 0;
    this.len = 0;
    this.index = 0;
    this.buf = new Uint8Array(0);
    this.verify = 0;
    this.lastTime = 0;
  }

  push(bytes, nowMs) {
    const out = [];
    if (nowMs !== undefined) {
      if (nowMs - this.lastTime >= 500) this.state = 0;
      this.lastTime = nowMs;
    }
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (this.state === 0 && b === 0x55) {
        this.state = 1;
      } else if (this.state === 1 && b === 0x7F) {
        this.state = 2;
        this.verify = 0;
      } else if (this.state === 2) {
        this.type = b;
        this.verify = (this.verify + b) & 0xFF;
        this.state = 3;
      } else if (this.state === 3) {
        this.len = b << 8;
        this.verify = (this.verify + b) & 0xFF;
        this.state = 4;
      } else if (this.state === 4) {
        this.len |= b;
        this.verify = (this.verify + b) & 0xFF;
        this.index = 0;
        if (this.len === 0) {
          this.buf = new Uint8Array(0);
          this.state = 6;
        } else if (this.len <= 4096) {
          this.buf = new Uint8Array(this.len);
          this.state = 5;
        } else {
          this.state = 0;
        }
      } else if (this.state === 5) {
        this.buf[this.index++] = b;
        this.verify = (this.verify + b) & 0xFF;
        if (this.index >= this.len) this.state = 6;
      } else if (this.state === 6) {
        if (this.verify === b) out.push({ type: this.type, payload: this.buf });
        this.state = 0;
      } else {
        this.state = 0;
      }
    }
    return out;
  }
}

function u32(a, o) {
  return ((a[o + 3] << 24) | (a[o + 2] << 16) | (a[o + 1] << 8) | a[o]) >>> 0;
}

// 176 텔레메트리 파싱. 16바이트 미만이면 null. 33바이트 미만이면 확장 필드는 기본값.
export function parseTelemetry176(a) {
  if (a.length < 16) return null;

  let e = u32(a, 0);
  const speed = e & 511;
  const gear = (e >>> 9) & 7;
  const turn = (e >>> 12) & 3;
  const ap = (e >>> 14) & 3;
  const soc = (e >>> 24) & 127;

  e = u32(a, 4);
  const odo = ((e >>> 6) & 67108863) / 10;

  const tpms = [];
  for (let t = 0; t < 4; t++) {
    const rawP = a[8 + t];
    tpms.push(rawP === 0 || rawP === 255 ? null : 0.025 * rawP * 14.5038);
  }

  e = u32(a, 12);
  const pedal = Math.min(100, Math.round((100 * (e & 255)) / 250));
  let rearKw = (e >>> 8) & 2047;
  if (rearKw >= 1024) rearKw -= 2048;
  rearKw = Math.round(rearKw / 2) || 0;
  let frontKw = (e >>> 19) & 2047;
  if (frontKw >= 1024) frontKw -= 2048;
  frontKw = Math.round(frontKw / 2) || 0;

  // 확장 필드 기본값 (33바이트 미만 패킷)
  let alt = 0;
  let speedUnit = 1;
  let handsOn = 0;
  let bTemps = [null, null, null, null];
  let blowerRpm = 0;
  let hvacWatts = 0;
  let cabinTemp = null;
  let ambTemp = null;
  let rangeKm = null;
  let battTemp = null;
  let limitSpd = 0;

  if (a.length >= 33) {
    const altRaw = (((a[17] << 16) | (a[16] << 8) | a[15]) >>> 6) & 16383;
    alt = altRaw >= 8192 ? altRaw - 16384 : altRaw;
    speedUnit = (a[17] >> 6) & 1;
    handsOn = (a[17] >> 7) & 1;

    e = u32(a, 18);
    bTemps = [
      (e & 1023) - 40,
      ((e >>> 10) & 1023) - 40,
      ((e >>> 20) & 1023) - 40,
      (((a[22] << 2) | (e >>> 30)) & 1023) - 40,
    ];

    e = u32(a, 23);
    blowerRpm = 5 * (e & 1023);
    hvacWatts = 5 * ((e >>> 10) & 2047);
    cabinTemp = 0.1 * ((e >>> 21) & 2047) - 40;
    ambTemp = 0.5 * a[27] - 40;

    e = u32(a, 28);
    rangeKm = Math.round(1.61 * ((e >>> 12) & 1023));
    battTemp = 0.5 * ((e >>> 22) & 511) - 40;

    limitSpd = (gear >= 2 && gear <= 4) ? 5 * ((((a[32] << 8) | a[31]) >>> 7) & 31) : 0;
  }

  return {
    speed, gear, turn, ap, soc, odo, tpms,
    pedal, frontKw, rearKw, alt, speedUnit, handsOn,
    bTemps, blowerRpm, hvacWatts, cabinTemp, ambTemp,
    rangeKm, battTemp, limitSpd,
  };
}

// 208 고전압 팩 파싱. 16바이트 미만이면 null.
export function parseHvPack208(a) {
  if (a.length < 16) return null;
  let i = u32(a, 0);
  const voltage = 0.01 * (i & 65535);
  let current = -0.1 * ((i >>> 16) & 65535);
  if (current < -3276.7) current += 6553.6;

  i = u32(a, 12);
  const remainKwh = 0.02 * (i & 65535);
  const fullKwh = 0.02 * ((i >>> 16) & 65535);

  return { voltage, current, remainKwh, fullKwh };
}
