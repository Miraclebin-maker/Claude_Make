// 사운드 컨트롤러: AudioContext, 프로필 전환, 볼륨, 경고음, 가속 미리듣기.
// 내연기관(v8, gt6)은 engine-worklet 으로, EV(zimmer, plaid)는 ev.js 의 오실레이터로 합성한다.
import { ICE_PROFILES, createRpmModel, stepRpm } from './rpm-model.js';
import { startEv } from './ev.js';
import * as settings from '../settings.js';

export const SOUND_PROFILES = Object.freeze(['off', 'zimmer', 'plaid', 'v8', 'gt6']);
const WORKLET_URL = new URL('./engine-worklet.js', import.meta.url);

export function createAudio() {
  let ctx = null;
  let master = null;
  let bus = null;
  let engine = null;
  let readyPromise = null;
  let profile = 'off';
  let ev = null;
  let model = null;
  let volume = settings.getVolume();
  let chimeOn = true;
  let previewing = false;
  let previewStep = 0;
  let lastTickMs = 0;

  const volumeGain = () => (volume / 100) * 0.8;

  function setStatus(s) {
    document.documentElement.dataset.audio = s;
  }

  async function ensureContext() {
    if (!readyPromise) {
      readyPromise = (async () => {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) throw new Error('AudioContext unsupported');
        ctx = new AC();
        bus = ctx.createDynamicsCompressor();
        bus.threshold.value = -14;
        bus.knee.value = 18;
        bus.ratio.value = 4;
        bus.attack.value = 0.005;
        bus.release.value = 0.15;
        master = ctx.createGain();
        master.gain.value = volumeGain();
        bus.connect(master);
        master.connect(ctx.destination);

        setStatus('loading');
        await ctx.audioWorklet.addModule(WORKLET_URL);
        engine = new AudioWorkletNode(ctx, 'tsl-engine', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        engine.parameters.get('gain').value = 0;
        engine.connect(bus);
        setStatus('ready');
      })().catch((err) => {
        setStatus('error');
        readyPromise = null;
        throw err;
      });
    }
    await readyPromise;
    // 자동재생 정책으로 suspended 일 수 있다. 제스처 이후 재개를 시도하되 기다리지 않는다.
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  function setEngineGain(v) {
    if (engine && ctx) engine.parameters.get('gain').setTargetAtTime(v, ctx.currentTime, 0.05);
  }

  function stopEv() {
    if (ev) {
      ev.stop();
      ev = null;
    }
  }

  async function setProfile(key) {
    if (!SOUND_PROFILES.includes(key)) return;
    profile = key;
    settings.setSound(key);
    stopEv();
    model = null;
    if (key === 'off') {
      setEngineGain(0);
      return;
    }
    try {
      await ensureContext();
    } catch (err) {
      return;
    }
    if (profile !== key) return; // 기다리는 사이 다른 프로필이 선택됨
    if (key === 'zimmer' || key === 'plaid') {
      setEngineGain(0);
      ev = startEv(key, ctx, bus);
    } else {
      model = createRpmModel(ICE_PROFILES[key]);
      engine.port.postMessage({ type: 'profile', profile: ICE_PROFILES[key] });
      setEngineGain(1);
    }
  }

  // 60Hz 호출. 속도/페달은 telemetry 또는 가속 미리듣기 값.
  function tick(speedKmh, pedalPct) {
    const now = performance.now();
    const dt = lastTickMs ? Math.min(0.1, (now - lastTickMs) / 1000) : 1 / 60;
    lastTickMs = now;

    let speed = speedKmh;
    let pedal = pedalPct;
    if (previewing) {
      previewStep = Math.min(100, previewStep + 150 * dt);
      speed = previewStep * 1.6;
      pedal = previewStep;
    }

    if (ev) {
      ev.update(speed, pedal);
      return;
    }
    if (!model || !engine || !ctx) return;
    const r = stepRpm(model, { speedKmh: speed, pedalPct: pedal, dtSec: dt });
    engine.parameters.get('rpm').value = r.rpm;
    engine.parameters.get('throttle').value = r.throttle;
    if (r.event === 'overrun') engine.port.postMessage({ type: 'overrun' });
  }

  function setPreview(on) {
    if (on) {
      if (profile === 'off') setProfile('zimmer');
      previewing = true;
      previewStep = 0;
    } else {
      previewing = false;
    }
  }

  function setVolume(v) {
    volume = Math.min(100, Math.max(0, Number(v) || 0));
    settings.setVolume(volume);
    if (master && ctx) master.gain.setTargetAtTime(volumeGain(), ctx.currentTime, 0.05);
  }

  function setChime(on) {
    chimeOn = !!on;
  }

  // 경고음 (상승 2음). force 면 설정과 무관하게 재생(테스트 용도).
  function playChime(force = false) {
    if (!chimeOn && !force) return;
    ensureContext().then(() => {
      const t = ctx.currentTime;
      [587.33, 880].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t + idx * 0.14);
        g.gain.setValueAtTime(0.18, t + idx * 0.14);
        g.gain.exponentialRampToValueAtTime(0.001, t + idx * 0.14 + 0.25);
        osc.connect(g);
        g.connect(master);
        osc.start(t + idx * 0.14);
        osc.stop(t + idx * 0.14 + 0.26);
      });
    }).catch(() => {});
  }

  return {
    setProfile,
    tick,
    setPreview,
    setVolume,
    setChime,
    playChime,
    get profile() { return profile; },
    get volume() { return volume; },
    get chimeOn() { return chimeOn; },
    // 사용자 활성화 이벤트(click 등)마다 호출. 컨텍스트가 없으면 저장된 프로필로 만들고,
    // suspended 이면 재개를 시도한다.
    unlock() {
      if (ctx) {
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        return;
      }
      if (settings.getSound() !== 'off') setProfile(settings.getSound());
    },
  };
}
