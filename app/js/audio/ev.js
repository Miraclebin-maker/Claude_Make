// EV 사운드 (한스짐머 EV, 플래드 워프: 원본 legacy 의 오실레이터 구성).


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

// key: 'zimmer' | 'plaid'. bus: 출력 노드. 반환 { update(speedKmh, pedalPct, kw, peakKw), stop() }
// kw/peakKw 는 쓰지 않는다(호출 인터페이스만 맞춘다).
export function startEv(key, ctx, bus) {
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
