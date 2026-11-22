// 사운드 컨트롤러: AudioContext, 프로필 전환, 볼륨, 경고음, 가속 미리듣기.
// zimmer/plaid 는 ev.js 의 오실레이터로, v10 은 미리 렌더한 RPM 루프(v10.js)를 가상 변속기(rpm-model.js)로 재생한다.
import { startEv } from './ev.js';
import { createRpmModel, stepRpm } from './rpm-model.js';
import { loadV10Buffers, createV10Graph } from './v10.js';
import * as settings from '../settings.js';

export const SOUND_PROFILES = Object.freeze(['off', 'zimmer', 'plaid', 'v10']);
const V10_BASE = new URL('../../audio/v10/', import.meta.url);

export function createAudio() {
  let ctx = null;
  let master = null;
  let bus = null;
  let readyPromise = null;
  let profile = 'off';
  let ev = null;
  let v10Player = null;
  let v10Promise = null;
  let rpmModel = createRpmModel();
  let volume = settings.getVolume();
  let chimeOn = false; // 기본 OFF (main.js 가 저장값으로 덮어씀)
  let previewing = false;
  let previewStep = 0;
  let lastTickMs = 0;
  let closed = false; // close() 이후 true: 어떤 재생도 다시 시작하지 않는다

  const volumeGain = () => (volume / 100) * 0.8;

  function setStatus(s) {
    document.documentElement.dataset.audio = s;
  }

  function setV10Status(s) {
    document.documentElement.dataset.v10 = s;
  }

  async function ensureContext() {
    if (closed) throw new Error('audio closed');
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

  // V10 루프 17개 로드·디코드 (한 번만). 실패하면 다음 선택 때 다시 시도한다.
  function loadV10() {
    if (!v10Promise) {
      setV10Status('loading');
      v10Promise = loadV10Buffers(ctx, V10_BASE)
        .then((buffers) => {
          setV10Status('ready');
          return buffers;
        })
        .catch((err) => {
          setV10Status('error');
          v10Promise = null;
          throw err;
        });
    }
    return v10Promise;
  }

  function stopAll() {
    if (ev) {
      ev.stop();
      ev = null;
    }
    if (v10Player) {
      v10Player.stop();
      v10Player = null;
    }
  }

  async function setProfile(key) {
    if (closed) return;
    if (!SOUND_PROFILES.includes(key)) return;
    profile = key;
    settings.setSound(key);
    document.documentElement.dataset.sound = key;
    stopAll();
    if (key === 'off') return;
    try {
      await ensureContext();
      if (key === 'v10') {
        const buffers = await loadV10();
        if (profile !== key || closed) return;
        rpmModel = createRpmModel();
        v10Player = createV10Graph(ctx, buffers, bus, ctx.currentTime);
      } else {
        if (profile !== key || closed) return;
        ev = startEv(key, ctx, bus);
      }
    } catch (err) {
      return;
    }
  }

  // 60Hz 호출. 속도/페달/kW 는 telemetry 또는 가속 미리듣기 값. peakKw 는 kW 정규화 기준.
  function tick(speedKmh, pedalPct, kw = 0, peakKw = 200) {
    const now = performance.now();
    const dt = lastTickMs ? Math.min(0.1, (now - lastTickMs) / 1000) : 1 / 60;
    lastTickMs = now;

    let speed = speedKmh;
    let pedal = pedalPct;
    if (previewing) {
      previewStep = Math.min(100, previewStep + 150 * dt);
      pedal = previewStep;
      // V10: 정차 중 페달 경로(공회전 레브)를 그대로 쓴다. 오실레이터 계열은 속도 흉내.
      speed = v10Player ? 0 : previewStep * 1.6;
    }

    if (v10Player) {
      const r = stepRpm(rpmModel, { speedKmh: speed, pedalPct: pedal, dtSec: dt });
      v10Player.update(r.rpm, pedal, previewing ? 0 : kw, ctx.currentTime);
    } else if (ev) {
      ev.update(speed, pedal, previewing ? 0 : kw, peakKw);
    }
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
    // 앱 종료: 노드를 멈추고 컨텍스트를 닫는다. 이후 재생은 모두 무시된다.
    async close() {
      closed = true;
      previewing = false;
      stopAll();
      profile = 'off';
      const c = ctx;
      ctx = null;
      master = null;
      bus = null;
      readyPromise = null;
      v10Promise = null;
      setStatus('closed');
      if (c) {
        try { await c.close(); } catch (e) { /* 이미 닫힘 */ }
      }
    },
    get volume() { return volume; },
    get chimeOn() { return chimeOn; },
    // 사용자 활성화 이벤트(click 등)마다 호출. 컨텍스트가 없으면 저장된 프로필로 만들고,
    // suspended 이면 재개를 시도한다.
    unlock() {
      if (closed) return;
      if (ctx) {
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        return;
      }
      if (settings.getSound() !== 'off') setProfile(settings.getSound());
    },
  };
}
