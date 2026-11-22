import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_TX_TYPES,
  encodePacket,
  PacketDecoder,
  parseTelemetry176,
  parseHvPack208,
} from '../app/js/protocol.js';

// LSB-first 비트 필드 기록 (원본 비트 연산의 역연산)
function putBits(buf, bit, width, value) {
  for (let i = 0; i < width; i++) {
    const pos = bit + i;
    const b = (value >>> i) & 1;
    if (b) buf[pos >> 3] |= 1 << (pos & 7);
    else buf[pos >> 3] &= ~(1 << (pos & 7)) & 0xFF;
  }
}

// 33바이트 176 샘플: speed128 gear4 turn1(좌) ap1 soc84 odo18420.5
// tpms [100,102,98,0] pedal50 rear150kW front-50kW alt1000 speedUnit1 handsOn1
// bTemps [60,90,10,20] blower1500 hvac820W cabin21.5 amb-23 range425 batt30 limit110(gear4)
function sample176() {
  const b = new Uint8Array(33);
  putBits(b, 0, 9, 128);
  putBits(b, 9, 3, 4);
  putBits(b, 12, 2, 1);
  putBits(b, 14, 2, 1);
  putBits(b, 24, 7, 84);
  putBits(b, 38, 26, 184205);
  [100, 102, 98, 0].forEach((v, t) => putBits(b, 64 + 8 * t, 8, v));
  putBits(b, 96, 8, 125);           // pedal = round(100*125/250) = 50
  putBits(b, 104, 11, 300);         // rear = 150
  putBits(b, 115, 11, 1948);        // front = 1948-2048 = -100 -> -50
  putBits(b, 126, 14, 1000);        // alt
  putBits(b, 142, 1, 1);            // speedUnit
  putBits(b, 143, 1, 1);            // handsOn
  putBits(b, 144, 10, 100);         // bTemps[0] = 60
  putBits(b, 154, 10, 130);         // bTemps[1] = 90
  putBits(b, 164, 10, 50);          // bTemps[2] = 10
  putBits(b, 174, 10, 60);          // bTemps[3] = 20
  putBits(b, 184, 10, 300);         // blower raw -> 1500
  putBits(b, 194, 11, 164);         // hvac raw -> 820
  putBits(b, 205, 11, 615);         // cabin = 0.1*615-40 = 21.5
  putBits(b, 216, 8, 34);           // amb = 0.5*34-40 = -23
  putBits(b, 236, 10, 264);         // range = round(1.61*264) = 425
  putBits(b, 246, 9, 140);          // batt = 0.5*140-40 = 30
  putBits(b, 255, 5, 22);           // limit = 5*22 = 110
  return b;
}

test('encode 는 설계 포맷(55 7F type len sum)을 따른다', () => {
  assert.deepEqual([...encodePacket(176, [1])], [0x55, 0x7F, 0xB0, 0x00, 0x01, 0x01, 0xB2]);
  assert.deepEqual([...encodePacket(160, [])], [0x55, 0x7F, 0xA0, 0x00, 0x00, 0xA0]);
});

test('encode -> decode 왕복 (체크섬 포함)', () => {
  const pkt = encodePacket(168, [0x31, 0x32, 0x33, 0x34]);
  const dec = new PacketDecoder();
  const out = dec.push(pkt);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 168);
  assert.deepEqual([...out[0].payload], [0x31, 0x32, 0x33, 0x34]);
});

test('분할 수신 바이트 스트림도 같은 패킷으로 복원된다', () => {
  const pkt = encodePacket(208, [1]);
  const dec = new PacketDecoder();
  let got = [];
  for (let i = 0; i < pkt.length; i++) {
    got = got.concat(dec.push(pkt.slice(i, i + 1), 1000 + i));
  }
  assert.equal(got.length, 1);
  assert.equal(got[0].type, 208);
  assert.deepEqual([...got[0].payload], [1]);

  const dec2 = new PacketDecoder();
  const a = encodePacket(176, [1]);
  const b = encodePacket(160, []);
  const joined = new Uint8Array([...a, ...b]);
  const res = dec2.push(joined.slice(0, 5)).concat(dec2.push(joined.slice(5)));
  assert.deepEqual(res.map((p) => p.type), [176, 160]);
});

test('잘못된 체크섬 패킷은 폐기하고 다음 정상 패킷은 처리한다', () => {
  const bad = encodePacket(176, [1]);
  bad[bad.length - 1] ^= 0xFF;
  const good = encodePacket(160, []);
  const dec = new PacketDecoder();
  const out = dec.push(new Uint8Array([...bad, ...good]));
  assert.deepEqual(out.map((p) => p.type), [160]);
});

test('500ms 이상 끊긴 뒤의 조각은 버리고 새 패킷부터 복원한다', () => {
  const dec = new PacketDecoder();
  const partial = encodePacket(176, [1]).slice(0, 3); // 55 7F B0
  assert.deepEqual(dec.push(partial, 0), []);
  const full = encodePacket(160, []);
  const out = dec.push(full, 1000);
  assert.deepEqual(out.map((p) => p.type), [160]);
});

test('화이트리스트: 160/168/176/208 허용, 167 및 임의 값은 throw', () => {
  assert.deepEqual(Object.values(ALLOWED_TX_TYPES).sort((a, b) => a - b), [160, 168, 176, 208]);
  for (const t of [160, 168, 176, 208]) assert.doesNotThrow(() => encodePacket(t, []));
  for (const t of [167, 0, 255, 52, 53, 54, 161]) {
    assert.throws(() => encodePacket(t, [1]), /whitelist/);
  }
});

test('parse176: 속도/기어/방향/AP/SOC/ODO/페달/전후 출력(음수 포함) 검증', () => {
  const f = parseTelemetry176(sample176());
  assert.equal(f.speed, 128);
  assert.equal(f.gear, 4);
  assert.equal(f.turn, 1);
  assert.equal(f.ap, 1);
  assert.equal(f.soc, 84);
  assert.ok(Math.abs(f.odo - 18420.5) < 1e-9);
  assert.equal(f.pedal, 50);
  assert.equal(f.frontKw, -50);
  assert.equal(f.rearKw, 150);
  assert.equal(f.tpms[3], null);
  assert.ok(Math.abs(f.tpms[0] - 0.025 * 100 * 14.5038) < 1e-9);
});

test('parse176: 확장 필드(33바이트) 값 검증', () => {
  const f = parseTelemetry176(sample176());
  assert.equal(f.alt, 1000);
  assert.equal(f.speedUnit, 1);
  assert.equal(f.handsOn, 1);
  assert.deepEqual(f.bTemps, [60, 90, 10, 20]);
  assert.equal(f.blowerRpm, 1500);
  assert.equal(f.hvacWatts, 820);
  assert.ok(Math.abs(f.cabinTemp - 21.5) < 1e-9);
  assert.ok(Math.abs(f.ambTemp - -23) < 1e-9);
  assert.equal(f.rangeKm, 425);
  assert.ok(Math.abs(f.battTemp - 30) < 1e-9);
  assert.equal(f.limitSpd, 110);
});

test('parse176: 33바이트 미만이면 확장 필드는 기본값', () => {
  const short = sample176().slice(0, 16);
  const f = parseTelemetry176(short);
  assert.equal(f.speed, 128);
  assert.equal(f.alt, 0);
  assert.equal(f.speedUnit, 1);
  assert.equal(f.handsOn, 0);
  assert.deepEqual(f.bTemps, [null, null, null, null]);
  assert.equal(f.cabinTemp, null);
  assert.equal(f.battTemp, null);
  assert.equal(f.rangeKm, null);
  assert.equal(f.limitSpd, 0);
});

test('parse176: 16바이트 미만이면 null', () => {
  assert.equal(parseTelemetry176(new Uint8Array(15)), null);
});

test('parse208: 전압/전류(음수)/잔여/만충 값 검증', () => {
  const b = new Uint8Array(16);
  putBits(b, 0, 16, 39640);          // 396.4 V
  putBits(b, 16, 16, 1185);          // -118.5 A
  putBits(b, 96, 16, 2560);          // 51.2 kWh
  putBits(b, 112, 16, 3025);         // 60.5 kWh
  const hv = parseHvPack208(b);
  assert.ok(Math.abs(hv.voltage - 396.4) < 1e-9);
  assert.ok(Math.abs(hv.current - -118.5) < 1e-9);
  assert.ok(Math.abs(hv.remainKwh - 51.2) < 1e-9);
  assert.ok(Math.abs(hv.fullKwh - 60.5) < 1e-9);
  assert.equal(parseHvPack208(new Uint8Array(15)), null);
});
