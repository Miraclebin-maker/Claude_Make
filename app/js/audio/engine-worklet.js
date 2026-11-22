// AudioWorkletProcessor: 내연기관 합성 (설계 6.3 ~ 6.4).
// 파라미터: rpm (a-rate), throttle (a-rate), gain (k-rate, 0 이면 무음).
// 메시지: { type: 'profile', profile } (ICE_PROFILES 항목), { type: 'overrun' }.
// 이 파일은 AudioWorkletGlobalScope 에서 실행되므로 import 하지 않는다.

const TWO_PI = Math.PI * 2;
const MAX_PULSE_MS = 30;

function biquadCoefs(type, f, q, dbGain, sr) {
  const w0 = (TWO_PI * Math.min(f, sr * 0.45)) / sr;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0; let b1; let b2; let a0; let a1; let a2;
  if (type === 'peak') {
    const A = Math.pow(10, dbGain / 40);
    b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
  } else if (type === 'lowpass') {
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else { // bandpass (0 dB peak gain)
    b0 = alpha; b1 = 0; b2 = -alpha;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

function biquadRun(f, x) {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1; f.x1 = x;
  f.y2 = f.y1; f.y1 = y;
  return y;
}

class TslEngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 0, minValue: 0, maxValue: 20000, automationRate: 'a-rate' },
      { name: 'throttle', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'gain', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.p = null;
    this.theta = 0;          // 크랭크 각 0..720
    this.pulses = [];
    this.frame = 0;
    this.lines = [];         // 뱅크별 웨이브가이드
    this.peaks = [];
    this.lowpass = null;
    this.lpCutoff = 300;
    this.intake = null;
    this.overrunUntil = -1;
    this.cracks = [];
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    if (!msg) return;
    if (msg.type === 'profile') this.setProfile(msg.profile);
    else if (msg.type === 'overrun') {
      this.overrunUntil = this.frame + (0.4 + Math.random() * 0.8) * sampleRate;
    }
  }

  setProfile(p) {
    this.p = p;
    this.lines = [0, 1].map((b) => {
      const len = Math.max(1, Math.round((p.bankTubeMs[b] * sampleRate) / 1000));
      return {
        buf: new Float32Array(len),
        idx: 0,
        len,
        lp: 0,
        k: 1 - Math.exp((-TWO_PI * p.loopLpHz) / sampleRate),
        fb: p.feedback[b],
      };
    });
    this.peaks = p.muffler.peaks.map((pk) => biquadCoefs('peak', pk.f, pk.q, pk.db, sampleRate));
    this.lowpass = biquadCoefs('lowpass', 500, 0.707, 0, sampleRate);
    this.intake = biquadCoefs('bandpass', 300, p.intake.q, 0, sampleRate);
    this.pulses = [];
    this.cracks = [];
  }

  spawnPulse(cyl, thr, offsetSamples) {
    const p = this.p;
    const jitterMs = 0.15 + (Math.random() * 2 - 1) * 0.15; // 0 ~ 0.3ms
    const at = this.frame + offsetSamples + Math.round((jitterMs * sampleRate) / 1000);
    this.pulses.push({
      at,
      amp: (0.25 + 0.75 * thr) * (1 + (Math.random() * 2 - 1) * 0.06),
      bank: p.banks[cyl],
      noiseLen: Math.round((1.5 + Math.random() * 2.5) * sampleRate / 1000),
      thumpW: (TWO_PI * p.thumpHz * (0.9 + 0.2 * Math.random())) / sampleRate,
      ph: 0,
    });
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;
    const p = this.p;
    const gain = parameters.gain[0];
    if (!p || gain <= 0) {
      out.fill(0);
      this.frame += out.length;
      return true;
    }

    const rpmA = parameters.rpm;
    const thrA = parameters.throttle;
    const N = out.length;
    const rpm0 = rpmA[0];
    const thr0 = thrA[0];

    // 머플러 필터 계수는 블록 단위로 갱신
    this.lpCutoff += (p.muffler.lpBase + rpm0 * p.muffler.lpRpmK + thr0 * p.muffler.lpThrK - this.lpCutoff) * 0.2;
    this.lowpass = Object.assign(this.lowpass, biquadCoefs('lowpass', this.lpCutoff, 0.707, 0, sampleRate), {
      x1: this.lowpass.x1, x2: this.lowpass.x2, y1: this.lowpass.y1, y2: this.lowpass.y2,
    });
    const intakeFc = p.intake.centerBase + rpm0 * p.intake.centerRpmK;
    this.intake = Object.assign(this.intake, biquadCoefs('bandpass', intakeFc, p.intake.q, 0, sampleRate), {
      x1: this.intake.x1, x2: this.intake.x2, y1: this.intake.y1, y2: this.intake.y2,
    });

    const limiterPeriod = sampleRate * 0.05;
    const pulseMaxSamples = (MAX_PULSE_MS * sampleRate) / 1000;
    const cylCount = p.angles.length;
    const inBank = [0, 0];

    for (let i = 0; i < N; i++) {
      const rpm = rpmA.length > 1 ? rpmA[i] : rpm0;
      const thr = thrA.length > 1 ? thrA[i] : thr0;

      // 크랭크 진행 (0~720도, 4행정)
      const dth = (rpm / 60) * 360 / sampleRate;
      let t2 = this.theta + dth;
      let wrapped = false;
      if (t2 >= 720) { t2 -= 720; wrapped = true; }

      // 레브 리미터: redline 이상이면 50ms 주기로 절반 컷
      const limiterCut = rpm >= p.redline && (this.frame % limiterPeriod) >= limiterPeriod / 2;

      if (!limiterCut) {
        for (let c = 0; c < cylCount; c++) {
          const a = p.angles[c];
          const fire = wrapped ? (a > this.theta || a <= t2) : (this.theta < a && t2 >= a);
          if (fire) this.spawnPulse(c, thr, 0);
        }
      }
      this.theta = t2;

      // 펄스 합산 (뱅크별 입력)
      inBank[0] = 0; inBank[1] = 0;
      for (let k = 0; k < this.pulses.length; k++) {
        const pu = this.pulses[k];
        const s = this.frame - pu.at;
        if (s < 0 || s > pulseMaxSamples) continue;
        const noiseEnv = s < pu.noiseLen ? Math.exp(-s / (pu.noiseLen / 3)) : 0;
        const noise = (Math.random() * 2 - 1) * noiseEnv;
        const thump = Math.sin(pu.ph) * Math.exp(-s / (0.008 * sampleRate));
        pu.ph += pu.thumpW;
        inBank[pu.bank] += pu.amp * (0.6 * noise + 1.0 * thump);
      }

      // 뱅크별 배기 웨이브가이드 (딜레이 + 루프 내 1차 LP 피드백)
      let bus = 0;
      for (let b = 0; b < 2; b++) {
        const ln = this.lines[b];
        const delayed = ln.buf[ln.idx];
        ln.lp += ln.k * (delayed - ln.lp);
        ln.buf[ln.idx] = inBank[b] + ln.fb * ln.lp;
        ln.idx = (ln.idx + 1) % ln.len;
        bus += delayed;
      }

      // 머플러: 피킹 2개 + 가변 로우패스
      let x = bus * 0.5;
      for (let k = 0; k < this.peaks.length; k++) x = biquadRun(this.peaks[k], x);
      x = biquadRun(this.lowpass, x);

      // 흡기/기계 노이즈 (rpm 비례 레벨, rpm 비례 중심주파수)
      const level = p.intake.level * (rpm / p.redline) * (0.4 + 0.6 * thr);
      x += biquadRun(this.intake, (Math.random() * 2 - 1) * level * 4);

      // 오버런 팝
      if (this.frame < this.overrunUntil && Math.random() < 0.0015) {
        this.cracks.push({ at: this.frame, amp: 0.2 + Math.random() * 0.3, len: Math.round(0.006 * sampleRate) });
      }
      for (let k = 0; k < this.cracks.length; k++) {
        const cr = this.cracks[k];
        const s = this.frame - cr.at;
        if (s >= 0 && s < cr.len) x += (Math.random() * 2 - 1) * cr.amp * Math.exp(-s / (0.0015 * sampleRate));
      }

      // 마스터: 소프트 클립
      const drive = 1.2 + 2.5 * thr;
      const y = Math.tanh(drive * x) / Math.tanh(drive);
      out[i] = Number.isFinite(y) ? y * gain * 0.8 : 0;

      this.frame++;
    }

    // 종료된 항목 정리 (블록 단위)
    const now = this.frame;
    this.pulses = this.pulses.filter((pu) => now - pu.at <= pulseMaxSamples);
    this.cracks = this.cracks.filter((cr) => now - cr.at < cr.len);
    return true;
  }
}

registerProcessor('tsl-engine', TslEngineProcessor);
