// EV 사운드 (한스짐머 EV, 플래드 워프: 원본 legacy 의 오실레이터 구성) + 신규 2종 (일렉트릭 슈퍼카 motor, 제트 터빈 turbine).

import { motorParams, turbineTarget, stepSpool } from './ev-params.js';

export function createPinkNoiseBuffer(ctx) {
  const bufferSize = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const output = buffer.getChannelData(0);
  let b0 = 0; let b1 = 0; let b2 = 0; let b3 = 0; let b4 = 0; let b5 = 0; let b6 = 0;
  for (let i = 0; i < bufferSize; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    output[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.04;
    b6 = white * 0.115926;
  }
  return buffer;
}

function createTubeSaturationCurve(amount) {
  const samples = 44100;
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
  }
  return curve;
}

function createSpaceReverb(ctx) {
  const len = ctx.sampleRate * 1.4;
  const impulse = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
  }
  const convolver = ctx.createConvolver();
  convolver.buffer = impulse;
  return convolver;
}

// key: 'zimmer' | 'plaid' | 'motor' | 'turbine'. bus: 출력 노드. 반환 { update(speedKmh, pedalPct, kw, peakKw), stop() }
// kw/peakKw 는 motor 와 turbine 만 쓴다(zimmer/plaid 는 무시).
export function startEv(key, ctx, bus) {
  if (key === 'motor') return startMotor(ctx, bus);
  if (key === 'turbine') return startTurbine(ctx, bus);
  const voices = [];
  const noiseNode = ctx.createBufferSource();
  noiseNode.buffer = createPinkNoiseBuffer(ctx);
  noiseNode.loop = true;

  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.frequency.value = key === 'plaid' ? 950 : 280;
  noiseFilter.Q.value = key === 'plaid' ? 1.8 : 1.1;

  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0.01;

  noiseNode.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(bus);
  noiseNode.start();

  if (key === 'zimmer') {
    const reverb = createSpaceReverb(ctx);
    const wetGain = ctx.createGain();
    wetGain.gain.value = 0.28;
    reverb.connect(wetGain);
    wetGain.connect(bus);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 340;
    filter.Q.value = 1.4;
    filter.connect(bus);
    filter.connect(reverb);

    const ratios = [0.5, 1.0, 1.004, 1.498, 2.0, 2.249];
    const gains = [0.34, 0.22, 0.22, 0.16, 0.12, 0.09];
    ratios.forEach((r, idx) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = idx === 0 ? 'sine' : (idx % 2 === 0 ? 'triangle' : 'sawtooth');
      osc.frequency.value = 55 * r;
      g.gain.value = gains[idx];
      osc.connect(g);
      g.connect(filter);
      osc.start();
      voices.push({ osc, filter, ratio: r });
    });
  } else {
    const shaper = ctx.createWaveShaper();
    shaper.curve = createTubeSaturationCurve(1.4);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 420;
    filter.Q.value = 1.6;

    shaper.connect(filter);
    filter.connect(bus);

    const ratios = [0.5, 1.0, 1.995, 3.01, 4.5];
    const gains = [0.32, 0.24, 0.18, 0.14, 0.08];
    ratios.forEach((r, idx) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = idx < 2 ? 'sine' : 'triangle';
      osc.frequency.value = 65 * r;
      g.gain.value = gains[idx];
      osc.connect(g);
      g.connect(shaper);
      osc.start();
      voices.push({ osc, filter, ratio: r });
    });
  }

  function update(speedKmh, pedalPct) {
    const now = ctx.currentTime;
    const load = Math.min(1, pedalPct / 100);
    const spdNorm = Math.min(1, speedKmh / 210);
    if (key === 'zimmer') {
      const baseFreq = 52 + spdNorm * 95 + load * 34;
      voices.forEach((v) => {
        v.osc.frequency.setTargetAtTime(baseFreq * v.ratio, now, 0.08);
        v.filter.frequency.setTargetAtTime(280 + load * 1500 + spdNorm * 800, now, 0.08);
      });
      noiseFilter.frequency.setTargetAtTime(350 + spdNorm * 1400, now, 0.1);
      noiseGain.gain.setTargetAtTime(0.02 + load * 0.10 + spdNorm * 0.08, now, 0.1);
    } else {
      const baseFreq = 62 + spdNorm * 185 + load * 65;
      voices.forEach((v) => {
        v.osc.frequency.setTargetAtTime(baseFreq * v.ratio, now, 0.05);
        v.filter.frequency.setTargetAtTime(360 + load * 2200 + spdNorm * 1400, now, 0.05);
      });
      noiseFilter.frequency.setTargetAtTime(750 + spdNorm * 2400, now, 0.06);
      noiseGain.gain.setTargetAtTime(0.03 + load * 0.18 + spdNorm * 0.12, now, 0.06);
    }
  }

  function stop() {
    voices.forEach((v) => {
      try { v.osc.stop(); v.osc.disconnect(); } catch (e) { /* 이미 정지 */ }
    });
    try { noiseNode.stop(); noiseNode.disconnect(); } catch (e) { /* 이미 정지 */ }
    try { noiseFilter.disconnect(); noiseGain.disconnect(); } catch (e) { /* noop */ }
  }

  return { update, stop };
}

// ---- 신규 2종 ------------------------------------------------------------
// 일렉트릭 슈퍼카: 전기모터 휘닝. 기본음 f + 2배음 0.35 + 3배음 0.15, 인버터 f*1.5 삼각파 0.08, 기어 휘닝 f*0.5 0.12.
// 경로: 음원 -> 음량 -> 하이패스 120Hz -> 피킹 1.2kHz +4dB Q1 -> bus. 음량 계수 0.25 는 헤드룸 여유(설계 수치 밖의 스케일).
const MOTOR_VOICE_SCALE = 0.25;

function startMotor(ctx, bus) {
  const voice = ctx.createGain();
  voice.gain.value = 0;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 120;
  const peak = ctx.createBiquadFilter();
  peak.type = 'peaking';
  peak.frequency.value = 1200;
  peak.Q.value = 1;
  peak.gain.value = 4;
  voice.connect(hp);
  hp.connect(peak);
  peak.connect(bus);

  const parts = [
    { type: 'sine', mult: 1, gain: 1 },
    { type: 'sine', mult: 2, gain: 0.35 },
    { type: 'sine', mult: 3, gain: 0.15 },
    { type: 'triangle', mult: 1.5, gain: 0.08 },
    { type: 'sine', mult: 0.5, gain: 0.12 },
  ].map((spec) => {
    const osc = ctx.createOscillator();
    osc.type = spec.type;
    const g = ctx.createGain();
    g.gain.value = spec.gain;
    osc.connect(g);
    g.connect(voice);
    osc.start();
    return { osc, mult: spec.mult };
  });

  function update(speedKmh, pedalPct, kw = 0, peakKw = 200) {
    const now = ctx.currentTime;
    const p = motorParams({ speed: speedKmh, pedal: pedalPct, kw, peakKw });
    parts.forEach((v) => v.osc.frequency.setTargetAtTime(p.freq * v.mult, now, 0.06));
    voice.gain.setTargetAtTime(p.gain * MOTOR_VOICE_SCALE, now, 0.06);
  }

  function stop() {
    parts.forEach((v) => { try { v.osc.stop(); v.osc.disconnect(); } catch (e) { /* 이미 정지 */ } });
    [voice, hp, peak].forEach((n) => { try { n.disconnect(); } catch (e) { /* noop */ } });
  }

  return { update, stop };
}

// 제트 터빈: 스풀(0–1, 관성)이 휘슬·공기 흐름·저역 럼블을 함께 올린다. 리버브 wet 0.15.
function startTurbine(ctx, bus) {
  const mix = ctx.createGain();
  const dry = ctx.createGain();
  dry.gain.value = 1;
  mix.connect(dry);
  dry.connect(bus);
  const reverb = createSpaceReverb(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.15;
  mix.connect(reverb);
  reverb.connect(wet);
  wet.connect(bus);

  // 휘슬: 사인 두 개(0.10, 0.05). 주파수는 스풀에 따라 올라간다.
  const whistleA = ctx.createOscillator();
  whistleA.type = 'sine';
  const whistleAGain = ctx.createGain();
  whistleAGain.gain.value = 0.10;
  whistleA.connect(whistleAGain);
  whistleAGain.connect(mix);
  whistleA.start();

  const whistleB = ctx.createOscillator();
  whistleB.type = 'sine';
  const whistleBGain = ctx.createGain();
  whistleBGain.gain.value = 0.05;
  whistleB.connect(whistleBGain);
  whistleBGain.connect(mix);
  whistleB.start();

  // 공기 흐름: 핑크 노이즈 -> 밴드패스 -> 음량(0.04 + s*0.25)
  const noiseNode = ctx.createBufferSource();
  noiseNode.buffer = createPinkNoiseBuffer(ctx);
  noiseNode.loop = true;
  const airFilter = ctx.createBiquadFilter();
  airFilter.type = 'bandpass';
  airFilter.frequency.value = 300;
  airFilter.Q.value = 0.9;
  const airGain = ctx.createGain();
  airGain.gain.value = 0.04;
  noiseNode.connect(airFilter);
  airFilter.connect(airGain);
  airGain.connect(mix);
  noiseNode.start();

  // 저역 럼블: 사인 45 + s*40 Hz, 음량 0.25*s
  const rumble = ctx.createOscillator();
  rumble.type = 'sine';
  rumble.frequency.value = 45;
  const rumbleGain = ctx.createGain();
  rumbleGain.gain.value = 0;
  rumble.connect(rumbleGain);
  rumbleGain.connect(mix);
  rumble.start();

  let spool = 0;
  let lastT = null;

  function update(speedKmh, pedalPct) {
    const now = ctx.currentTime;
    const dt = lastT === null ? 1 / 60 : Math.min(0.2, Math.max(0, now - lastT));
    lastT = now;
    spool = stepSpool(spool, turbineTarget({ speed: speedKmh, pedal: pedalPct }), dt);
    whistleA.frequency.setTargetAtTime(600 + spool * 3400, now, 0.05);
    whistleB.frequency.setTargetAtTime((600 + spool * 3400) * 1.5, now, 0.05);
    airFilter.frequency.setTargetAtTime(300 + spool * 2200, now, 0.08);
    airGain.gain.setTargetAtTime(0.04 + spool * 0.25, now, 0.08);
    rumble.frequency.setTargetAtTime(45 + spool * 40, now, 0.1);
    rumbleGain.gain.setTargetAtTime(0.25 * spool, now, 0.1);
  }

  function stop() {
    [whistleA, whistleB, rumble].forEach((o) => { try { o.stop(); o.disconnect(); } catch (e) { /* noop */ } });
    try { noiseNode.stop(); noiseNode.disconnect(); } catch (e) { /* noop */ }
    [mix, dry, reverb, wet, airFilter, airGain, rumbleGain, whistleAGain, whistleBGain].forEach((n) => {
      try { n.disconnect(); } catch (e) { /* noop */ }
    });
  }

  return { update, stop };
}
