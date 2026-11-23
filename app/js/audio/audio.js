// 사운드 컨트롤러: AudioContext, 프로필 전환, 볼륨, 경고음, 가속 미리듣기.
// zimmer/plaid 는 ev.js 의 오실레이터로, v10 은 미리 렌더한 RPM 루프(v10.js)를 가상 변속기(rpm-model.js)로 재생한다.
import { startEv } from './ev.js';
import { createRpmModel, stepRpm } from './rpm-model.js';
import { createPredictor, observe, predict, resolveLatency, latencyLabel, smoothTauFor } from './latency.js';
import { loadV10Buffers, createV10Graph } from './v10.js';
import * as settings from '../settings.js';
import { audioStateFor, unlockWanted, CHIME_HOLD_MS } from './audio-state.js';

export const SOUND_PROFILES = Object.freeze(['off', 'zimmer', 'plaid', 'v10']);
const V10_BASE = new URL('../../audio/v10/', import.meta.url);

export function createAudio() {
  let ctx = null;
  let master = null;
  let bus = null;
  let readyPromise = null;
  let profile = 'off'; // §24.5: 앱을 열면 항상 음소거로 시작한다 (저장된 음원은 복원하지 않는다)
  let ev = null;
  let v10Player = null;
  let v10Promise = null;
  let rpmModel = createRpmModel();
  let telePred = createPredictor(); // §26: 실데이터(텔레메트리·데모) 샘플 이력. 샘플이 올 때만 관측한다
  let previewPred = createPredictor(); // §26: 가속 미리듣기(연속 합성 입력) 전용. 실데이터 경로와 섞지 않는다
  let latencySetting = settings.getLatency(); // auto | off | 150 | 300 | 450 (§26.2)
  let volume = settings.getVolume();
  let chimeOn = false; // 기본 OFF (main.js 가 저장값으로 덮어씀)
  let previewing = false;
  let previewStep = 0;
  let lastTickMs = 0;
  let closed = false; // close() 이후 true: 어떤 재생도 다시 시작하지 않는다
  let pageHidden = typeof document !== 'undefined' && document.hidden;
  let chimeBusy = false; // 경고음이 울리는 동안 true (§22: 음소거 상태에서도 잠깐 running)
  let chimeTimer = 0;

  const volumeGain = () => (volume / 100) * 0.8;

  function setStatus(s) {
    document.documentElement.dataset.audio = s;
  }

  function setAudioState(s) {
    document.documentElement.dataset.audioState = s;
  }

  // §22: 필요 없으면 suspend, 필요하면 resume. 상태 결정은 audio-state.js 가 한다.
  function applyState() {
    if (!ctx || closed) return;
    const want = audioStateFor({ profile, hidden: pageHidden, chimeBusy });
    if (want === 'running' && ctx.state !== 'running') ctx.resume().catch(() => {});
    else if (want === 'suspended' && ctx.state === 'running') ctx.suspend().catch(() => {});
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
        // close() 가 ctx 를 먼저 비우므로 이벤트 대상(e.target)에서 상태를 읽는다
        ctx.onstatechange = (e) => setAudioState(e.target.state);
        setAudioState(ctx.state);
        setStatus('ready');
      })().catch((err) => {
        setStatus('error');
        readyPromise = null;
        throw err;
      });
    }
    await readyPromise;
    applyState();
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
    profile = key; // §24.5: 사운드 선택은 저장하지 않는다 (앱을 켠 동안만 유지)
    document.documentElement.dataset.sound = key;
    stopAll();
    if (key === 'off') {
      applyState(); // §22: 음소거하면 컨텍스트를 놓는다
      return;
    }
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

    // §26: 블루투스 지연만큼 미래 값을 예측해 소리를 미리 바꾼다. 보정 0 이면 입력 그대로.
    // 실데이터는 observeTelemetry 가 들어온 샘플만 관측하고, 여기서는 마지막 샘플에서 외삽한다.
    const lead = latencyInfo().ms / 1000;
    const tau = smoothTauFor(lead * 1000);
    let p = { speed, pedal };
    if (previewing) {
      previewPred = observe(previewPred, now, speed, pedal);
      p = predict(previewPred, lead, now);
    } else if (lead > 0 && telePred.t !== null) {
      p = predict(telePred, lead, now);
    }

    if (v10Player) {
      const r = stepRpm(rpmModel, { speedKmh: p.speed, pedalPct: p.pedal, dtSec: dt, smoothTau: tau });
      v10Player.update(r.rpm, p.pedal, previewing ? 0 : kw, ctx.currentTime, tau);
    } else if (ev) {
      ev.update(p.speed, p.pedal, previewing ? 0 : kw, peakKw);
    }
  }

  // 적용 지연 (§26.2). 자동은 컨텍스트가 있으면 outputLatency + baseLatency 를 쓴다.
  function latencyInfo() {
    return resolveLatency(latencySetting, { outputLatency: ctx && ctx.outputLatency, baseLatency: ctx && ctx.baseLatency });
  }

  function setPreview(on) {
    if (on) {
      if (profile === 'off') setProfile('zimmer');
      previewing = true;
      previewStep = 0;
      previewPred = createPredictor();
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
    // §22: 경고음이 울리는 동안만 깨운다. 끝난 뒤 음소거 상태면 applyState 가 다시 suspend 한다.
    chimeBusy = true;
    clearTimeout(chimeTimer);
    chimeTimer = setTimeout(() => {
      chimeBusy = false;
      applyState();
    }, CHIME_HOLD_MS);
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
    // §26: 실데이터 샘플(176 프레임·데모) 관측. 샘플이 올 때만 호출한다. 연결이 끊기면 resetTelemetry.
    observeTelemetry(tMs, speed, pedal) {
      telePred = observe(telePred, tMs, speed, pedal);
    },
    resetTelemetry() {
      telePred = createPredictor();
    },
    setVolume,
    setChime,
    playChime,
    // 페이지 숨김/표시(visibilitychange). 숨기면 suspend, 보이면 프로필이 켜져 있을 때만 resume.
    setPageHidden(h) {
      pageHidden = !!h;
      applyState();
    },
    get profile() { return profile; },
    // 앱 종료: 노드를 멈추고 컨텍스트를 닫는다. 이후 재생은 모두 무시된다.
    async close() {
      closed = true;
      previewing = false;
      clearTimeout(chimeTimer);
      chimeBusy = false;
      stopAll();
      profile = 'off';
      const c = ctx;
      ctx = null;
      master = null;
      bus = null;
      readyPromise = null;
      v10Promise = null;
      setStatus('closed');
      setAudioState('closed');
      if (c) {
        try { await c.close(); } catch (e) { /* 이미 닫힘 */ }
      }
    },
    get volume() { return volume; },
    get latencySetting() { return latencySetting; },
    setLatency(v) {
      latencySetting = v;
      settings.setLatency(v);
    },
    latencyLabel() { return latencyLabel(latencyInfo()); },
    get chimeOn() { return chimeOn; },
    // 사용자 활성화 이벤트(click 등)마다 호출. 컨텍스트가 없으면 저장된 프로필로 만들고,
    // suspended 이면 재개를 시도한다.
    // §22: 프로필이 off 면 컨텍스트를 만들거나 재개하지 않는다.
    unlock() {
      if (!unlockWanted({ profile, closed })) return;
      if (ctx) {
        applyState();
        return;
      }
      setProfile(profile);
    },
  };
}
