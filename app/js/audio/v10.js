// V10 사운드: 미리 렌더한 RPM 루프 17개를 현재 RPM에 맞춰 섞어 재생한다 (§18.1).
// 출처: 루프는 DasEtwas/enginesound 의 물리 모델(example2.esc 기반 V10)로 렌더 (MIT, tools/engine-render).
// 순수 함수(loopMix, equalPowerWeights, masterParams)는 DOM/AudioContext 없이 테스트한다.

export const V10_RPM_MIN = 1000;
export const V10_RPM_STEP = 500;
export const V10_RPMS = Object.freeze(Array.from({ length: 17 }, (_, i) => V10_RPM_MIN + i * V10_RPM_STEP));
export const V10_RATE_LIMIT = 0.25; // 재생 속도 보정 한계 ±25%

export const v10FileName = (rpm) => `rpm-${rpm}.wav`;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// 현재 RPM 에서 섞을 두 루프 (인덱스)와 비율 t. 범위 밖이면 가장 가까운 루프 하나를 쓴다.
// 재생 속도(playbackRate)는 update 에서 실제 RPM / 루프 RPM 으로 계산한다(950rpm 은 0.95 배속).
export function loopMix(rpm) {
  const r = clamp(rpm, V10_RPMS[0], V10_RPMS[V10_RPMS.length - 1]);
  const idx = (r - V10_RPM_MIN) / V10_RPM_STEP;
  const lo = Math.min(Math.floor(idx), V10_RPMS.length - 1);
  const hi = Math.min(lo + 1, V10_RPMS.length - 1);
  const t = hi === lo ? 0 : idx - lo;
  return { lo, hi, t };
}

// 등전력 크로스페이드: gLo² + gHi² = 1
export function equalPowerWeights(t) {
  const x = clamp(t, 0, 1) * (Math.PI / 2);
  return { gLo: Math.cos(x), gHi: Math.sin(x) };
}

// 페달·회생에 따른 마스터 로우패스 컷오프와 음량. 회생(kW<0)이거나 페달 0이면 p = 0.
export function masterParams(pedalPct, kw) {
  const p = kw < 0 || !(pedalPct > 0) ? 0 : clamp(pedalPct / 100, 0, 1);
  return { cutoffHz: 1200 + p * 6000, gain: 0.45 + 0.55 * p };
}

// 루프 17개를 가져와 디코드한다. baseUrl: 루프 폴더 URL (끝 슬래시 포함).
export async function loadV10Buffers(ctx, baseUrl, fetchFn = fetch) {
  const bufs = await Promise.all(
    V10_RPMS.map(async (rpm) => {
      const res = await fetchFn(new URL(v10FileName(rpm), baseUrl));
      if (!res.ok) throw new Error(`V10 루프 ${rpm} 로드 실패 (${res.status})`);
      return ctx.decodeAudioData(await res.arrayBuffer());
    }),
  );
  return bufs;
}

// 그래프: 루프마다 (소스 → 게인) → 공통 로우패스 → dest. 모든 루프는 계속 돈다(위상 튐 방지).
// update 는 현재 RPM/페달을 받아 setTargetAtTime 으로 부드럽게 바꾼다. when 은 AudioContext 시각(오프라인이면 임의 시각).
export function createV10Graph(ctx, buffers, dest, startAt = ctx.currentTime) {
  const lpf = ctx.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.Q.value = 0.7;
  const master = ctx.createGain();
  master.gain.value = 0.45;
  lpf.connect(master);
  master.connect(dest);

  const loops = buffers.map((buffer) => {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain);
    gain.connect(lpf);
    src.start(startAt);
    return { src, gain };
  });

  let stopped = false;

  return {
    update(rpm, pedalPct, kw, when = ctx.currentTime) {
      if (stopped) return;
      const mix = loopMix(rpm);
      const w = equalPowerWeights(mix.t);
      loops.forEach((l, i) => {
        const rate = clamp(rpm / V10_RPMS[i], 1 - V10_RATE_LIMIT, 1 + V10_RATE_LIMIT);
        l.src.playbackRate.setTargetAtTime(rate, when, 0.03);
        let g = 0;
        if (i === mix.lo) g = mix.lo === mix.hi ? 1 : w.gLo;
        if (i === mix.hi && mix.hi !== mix.lo) g = w.gHi;
        l.gain.gain.setTargetAtTime(g, when, 0.03);
      });
      const m = masterParams(pedalPct, kw);
      lpf.frequency.setTargetAtTime(m.cutoffHz, when, 0.08);
      master.gain.setTargetAtTime(m.gain, when, 0.08);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      loops.forEach((l) => {
        try { l.src.stop(); } catch (e) { /* 이미 정지 */ }
        try { l.src.disconnect(); l.gain.disconnect(); } catch (e) { /* noop */ }
      });
      try { lpf.disconnect(); master.disconnect(); } catch (e) { /* noop */ }
    },
  };
}
