// 16-bit PCM mono WAV 쓰기/읽기 (외부 의존성 없음).
import { writeFileSync, readFileSync } from 'node:fs';

// samples: Float64Array (-1..1). 범위를 넘는 값은 잘라낸다.
export function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt 청크 크기
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

export function writeWav(path, samples, sampleRate) {
  writeFileSync(path, encodeWav(samples, sampleRate));
}

// 우리가 쓴 WAV(16-bit mono PCM)만 읽는다. 검증용.
export function readWav(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  const sampleRate = buf.readUInt32LE(24);
  const channels = buf.readUInt16LE(22);
  const bits = buf.readUInt16LE(34);
  if (channels !== 1 || bits !== 16) throw new Error(`unsupported WAV: ${channels} ch, ${bits} bit`);
  const dataLen = buf.readUInt32LE(40);
  const n = dataLen / 2;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(44 + i * 2) / 32767;
  return { sampleRate, samples: out };
}
