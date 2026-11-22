// 신호 분석 도구: FFT, 피크 주파수, 대역 에너지, RMS/피크, 정규화, 루프 크로스페이드.
// 출처: DasEtwas/enginesound (MIT License, Copyright (c) 2020 DasEtwas). 원본 전문: LICENSE-enginesound.txt
// 이 파일의 crossfadeLoop 은 원본 src/main.rs 의 크로스페이드 계산을 옮긴 것이다.

export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2];
        const ai = im[i + k + len / 2];
        const tr = ar * cr - ai * ci;
        const ti = ar * ci + ai * cr;
        re[i + k + len / 2] = re[i + k] - tr;
        im[i + k + len / 2] = im[i + k] - ti;
        re[i + k] += tr;
        im[i + k] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// 한 구간(n 샘플, 해닝 창)의 진폭 스펙트럼. 반환: { mag: Float64Array(n/2), binHz }
export function spectrum(samples, start, n, sampleRate) {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = (samples[start + i] || 0) * w;
  }
  fft(re, im);
  const mag = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) mag[k] = Math.hypot(re[k], im[k]) / n;
  return { mag, binHz: sampleRate / n };
}

// 가장 강한 주파수(fmin..fmax Hz 범위)
export function peakFrequency(samples, sampleRate, { n = 16384, fmin = 20, fmax = 2000, start = 0 } = {}) {
  const { mag, binHz } = spectrum(samples, start, n, sampleRate);
  let best = -1;
  let bestK = 0;
  for (let k = Math.ceil(fmin / binHz); k <= Math.floor(fmax / binHz); k++) {
    if (mag[k] > best) {
      best = mag[k];
      bestK = k;
    }
  }
  return bestK * binHz;
}

// 대역 에너지 비율: [f0,f1] Hz 의 전력 / 전체(0..fmax) 전력
export function bandEnergyRatio(samples, sampleRate, f0, f1, { n = 16384, fmax = 4000, start = 0 } = {}) {
  const { mag, binHz } = spectrum(samples, start, n, sampleRate);
  let band = 0;
  let total = 0;
  for (let k = 1; k <= Math.floor(fmax / binHz); k++) {
    const p = mag[k] * mag[k];
    total += p;
    if (k * binHz >= f0 && k * binHz <= f1) band += p;
  }
  return total > 0 ? band / total : 0;
}

export function rms(samples) {
  let s = 0;
  for (const x of samples) s += x * x;
  return Math.sqrt(s / samples.length);
}

export function peak(samples) {
  let p = 0;
  for (const x of samples) p = Math.max(p, Math.abs(x));
  return p;
}

export const toDb = (x) => 20 * Math.log10(Math.max(x, 1e-12));

// 피크를 목표 dBFS 로 맞춘다 (설계: 피크 -1 dBFS). 반환: 새 배열과 적용 배율.
export function normalizePeak(samples, targetDbfs = -1) {
  const p = peak(samples);
  const target = Math.pow(10, targetDbfs / 20);
  const g = p > 0 ? target / p : 1;
  const out = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * g;
  return { samples: out, gain: g };
}

// render.mjs/원본 README 의 루프 방식: 반쪽을 바꿔 붙이고 가운데를 크로스페이드. 길이 = len - c/2.
// 원본 main.rs 의 crossfade 구현을 옮겼다.
export function crossfadeLoop(output, crossfadeSize) {
  const len = output.length;
  const half = Math.floor(len / 2);
  const shifted = new Float64Array(len);
  for (let i = 0; i < len; i++) shifted[i] = output[(half + i) % len];
  const fadeLen = Math.floor(crossfadeSize / 2);
  const outLen = len - fadeLen;
  const out = new Float64Array(outLen);
  out.set(shifted.subarray(0, half), 0);
  out.set(shifted.subarray(half + fadeLen), half);
  const start = half - fadeLen;
  for (let i = start; i < half; i++) {
    const fade = (i - start) / fadeLen;
    out[i] = shifted[i] * (1 - fade) + shifted[i + fadeLen] * fade;
  }
  return out;
}
