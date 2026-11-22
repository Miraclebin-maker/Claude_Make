// 엔진 음 물리 모델 (JavaScript 포팅).
// 출처: DasEtwas/enginesound, src/gen.rs (MIT License, Copyright (c) 2020 DasEtwas). 원본 전문: LICENSE-enginesound.txt
// 원본의 계산 순서와 식을 그대로 옮겼다. 차이점:
//  - 부동소수점은 f32 대신 f64 (JS 기본). 결과가 원본과 비트 단위로 같지는 않다.
//  - 노이즈 시드는 원본처럼 실행 시각이 아니라 고정값이다(같은 프리셋이면 같은 소리).
//  - 파일 입출력, GUI, 녹음기는 없다. 순수 계산만 있어 AudioWorklet에서도 쓸 수 있다(DOM/Node API 없음).

const PI2 = 2 * Math.PI;
const PI4 = 4 * Math.PI;
const WAVEGUIDE_MAX_AMP = 20.0; // 이 진폭을 넘으면 되먹임 억제 함수를 적용한다 (gen.rs 와 같은 값)
const DC_CUTOFF_HZ = 0.5; // gen.rs main.rs: LowPassFilter::new(0.5, sample_rate) — 직류 성분 제거

// ---- 난수: rand_xorshift 의 XorShiftRng 와 같은 xorshift128 식 ----------------------------
class XorShift128 {
  constructor(seed = [0x9e3779b9, 0x243f6a88, 0xb7e15162, 0x6a09e667]) {
    [this.x, this.y, this.z, this.w] = seed.map((v) => v >>> 0);
  }

  nextU32() {
    const x = this.x;
    const t = (x ^ (x << 11)) >>> 0;
    this.x = this.y;
    this.y = this.z;
    this.z = this.w;
    const w = this.w;
    this.w = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return this.w;
  }
}

// gen.rs Noise::step: u32 -> [-1, 1)
class Noise {
  constructor(seed) {
    this.rng = new XorShift128(seed);
  }

  step() {
    return this.rng.nextU32() / (0xffffffff / 2) - 1.0;
  }
}

// ---- 기본 요소 -------------------------------------------------------------------------
// gen.rs LowPassFilter::new(freq, sps) 와 filter
class LowPassFilter {
  constructor(freq, sampleRate) {
    this.delay = 1 / freq;
    const k = PI2 * (1 / sampleRate) * freq;
    this.alpha = k / (k + 1);
    this.last = 0;
  }

  filter(sample) {
    const ret = (sample - this.last) * this.alpha + this.last;
    this.last = ret;
    return ret;
  }
}

// gen.rs LoopBuffer: 길이 N 의 원형 버퍼. pop 은 push 보다 한 칸 앞의 값을 준다.
class LoopBuffer {
  constructor(len) {
    if (!(len >= 1)) throw new Error(`delay line length ${len} < 1 sample`);
    this.len = len;
    this.data = new Float64Array(len);
    this.pos = 0;
  }

  push(value) {
    this.data[this.pos % this.len] = value;
  }

  pop() {
    return this.data[(this.pos + 1) % this.len];
  }

  advance() {
    this.pos += 1;
  }
}

// gen.rs WaveGuide::dampen: 큰 진폭을 부드럽게 눌러 되먹임 폭주를 막는다.
function dampen(sample) {
  const abs = Math.abs(sample);
  if (abs > WAVEGUIDE_MAX_AMP) {
    return [Math.sign(sample) * (-1.0 / (abs - WAVEGUIDE_MAX_AMP + 1.0) + 1.0 + WAVEGUIDE_MAX_AMP), true];
  }
  return [sample, false];
}

// gen.rs WaveGuide: 두 방향 지연선(chamber0: x0->x1, chamber1: x1->x0)과 양끝 반사 계수
class WaveGuide {
  constructor(delaySamples, alpha, beta) {
    this.chamber0 = new LoopBuffer(delaySamples);
    this.chamber1 = new LoopBuffer(delaySamples);
    this.alpha = alpha;
    this.beta = beta;
    this.c1Out = 0;
    this.c0Out = 0;
  }

  // 반환: [alpha 쪽 출력, beta 쪽 출력, 되먹임 억제 여부]
  pop() {
    const [c1, d1] = dampen(this.chamber1.pop());
    const [c0, d0] = dampen(this.chamber0.pop());
    this.c1Out = c1;
    this.c0Out = c0;
    return [c1 * (1.0 - Math.abs(this.alpha)), c0 * (1.0 - Math.abs(this.beta)), d1 || d0];
  }

  push(x0In, x1In) {
    const c0In = this.c1Out * this.alpha + x0In;
    const c1In = this.c0Out * this.beta + x1In;
    this.chamber0.push(c0In);
    this.chamber1.push(c1In);
    this.chamber0.advance();
    this.chamber1.advance();
  }
}

// gen.rs 밸브 함수 (크랭크 위치 0–1 은 720° 한 사이클)
function exhaustValve(c) {
  return 0.75 < c && c < 1.0 ? -Math.sin(c * PI4) : 0.0;
}

function intakeValve(c) {
  return 0.0 < c && c < 0.25 ? Math.sin(c * PI4) : 0.0;
}

function pistonMotion(c) {
  return Math.cos(c * PI4);
}

function fuelIgnition(c, ignitionTime) {
  return 0.5 < c && c < ignitionTime / 2.0 + 0.5 ? Math.sin(PI2 * ((c - 0.5) / ignitionTime)) : 0.0;
}

const fract = (x) => x - Math.floor(x);

// gen.rs Cylinder: 흡기 WG, 배기 WG, 익스트랙터 WG 와 피스톤·점화 음원
class Cylinder {
  constructor(p, sampleRate) {
    this.crankOffset = p.crank_offset;
    this.exhaust = new WaveGuide(delayOf(p.exhaust_waveguide.chamber0, sampleRate), p.exhaust_waveguide.alpha, p.exhaust_waveguide.beta);
    this.intake = new WaveGuide(delayOf(p.intake_waveguide.chamber0, sampleRate), p.intake_waveguide.alpha, p.intake_waveguide.beta);
    this.extractor = new WaveGuide(delayOf(p.extractor_waveguide.chamber0, sampleRate), p.extractor_waveguide.alpha, p.extractor_waveguide.beta);
    this.intakeOpenRefl = p.intake_open_refl;
    this.intakeClosedRefl = p.intake_closed_refl;
    this.exhaustOpenRefl = p.exhaust_open_refl;
    this.exhaustClosedRefl = p.exhaust_closed_refl;
    this.pistonMotionFactor = p.piston_motion_factor;
    this.ignitionFactor = p.ignition_factor;
    this.ignitionTime = p.ignition_time;
    this.cylSound = 0;
    this.extractorExhaust = 0;
  }

  // 반환: [흡기 출력, 배기 출력, 피스톤+점화 음원, 되먹임 억제 여부]
  pop(crankPos, exhaustCollector, intakeValveShift, exhaustValveShift) {
    const crank = fract(crankPos + this.crankOffset);
    this.cylSound = pistonMotion(crank) * this.pistonMotionFactor
      + fuelIgnition(crank, this.ignitionTime) * this.ignitionFactor;

    const exValve = exhaustValve(fract(crank + exhaustValveShift));
    const inValve = intakeValve(fract(crank + intakeValveShift));
    this.exhaust.alpha = this.exhaustClosedRefl + (this.exhaustOpenRefl - this.exhaustClosedRefl) * exValve;
    this.intake.alpha = this.intakeClosedRefl + (this.intakeOpenRefl - this.intakeClosedRefl) * inValve;

    const exRet = this.exhaust.pop();
    const inRet = this.intake.pop();
    const exrRet = this.extractor.pop();
    this.extractorExhaust = exrRet[0];
    this.extractor.push(exRet[1], exhaustCollector);

    return [inRet[1], exrRet[1], this.cylSound, exRet[2] || inRet[2] || exrRet[2]];
  }

  // pop 뒤에 호출: 흡기 공기와 피스톤 음원을 되돌려 넣는다
  push(intake) {
    const exIn = (1.0 - Math.abs(this.exhaust.alpha)) * this.cylSound * 0.5;
    this.exhaust.push(exIn, this.extractorExhaust);
    const inIn = (1.0 - Math.abs(this.intake.alpha)) * this.cylSound * 0.5;
    this.intake.push(inIn, intake);
  }
}

// RON 의 delay(초)를 지연선 샘플 수로. gen.rs fix_engine: (delay * sample_rate) as usize (버림).
// 차이: 1/sampleRate 초(예: example2.esc 의 머플러 0.0000208333s)는 f32 계산에서 0.99999994 가 되어 원본은 길이 0 이 되고
// 나중에 0 으로 나눠 죽는다. 여기서는 작은 오차(1e-6)를 더해 버림하고 최소 1샘플을 보장한다.
function delayOf(lb, sampleRate) {
  return Math.max(1, Math.floor(lb.samples.delay * sampleRate + 1e-6));
}

// ---- 엔진 전체 -------------------------------------------------------------------------
// 프리셋 객체(JSON, .esc 를 ron2json 으로 옮긴 형태)를 받아 샘플을 한 개씩 만든다.
export class EngineModel {
  constructor(preset, sampleRate, { intakeSeed, crankSeed } = DEFAULT_SEEDS) {
    const p = preset;
    this.sr = sampleRate;
    this.intakeVolume = p.intake_volume;
    this.exhaustVolume = p.exhaust_volume;
    this.vibrationVolume = p.engine_vibrations_volume;
    this.cylinders = p.cylinders.map((c) => new Cylinder(c, sampleRate));
    this.intakeNoise = new Noise(intakeSeed);
    this.intakeNoiseFactor = p.intake_noise_factor;
    this.intakeNoiseLp = new LowPassFilter(1 / p.intake_noise_lp.delay, sampleRate);
    this.vibrationFilter = new LowPassFilter(1 / p.engine_vibration_filter.delay, sampleRate);
    this.straightPipe = new WaveGuide(
      delayOf(p.muffler.straight_pipe.chamber0, sampleRate),
      p.muffler.straight_pipe.alpha,
      p.muffler.straight_pipe.beta,
    );
    this.mufflerElements = p.muffler.muffler_elements.map(
      (m) => new WaveGuide(delayOf(m.chamber0, sampleRate), m.alpha, m.beta),
    );
    this.intakeValveShift = p.intake_valve_shift;
    this.exhaustValveShift = p.exhaust_valve_shift;
    this.crankshaftFluctuation = p.crankshaft_fluctuation;
    this.crankFluctuationLp = new LowPassFilter(1 / p.crankshaft_fluctuation_lp.delay, sampleRate);
    this.crankNoise = new Noise(crankSeed);
    this.crankshaftPos = 0;
    this.exhaustCollector = 0;
    this.intakeCollector = 0;
    this.dcLp = new LowPassFilter(DC_CUTOFF_HZ, sampleRate);
    this.dampened = false;
  }

  // gen.rs Generator::gen: 샘플 하나 분량의 (흡기, 진동, 배기, 억제) 채널
  gen() {
    const intakeNoise = this.intakeNoiseLp.filter(this.intakeNoise.step()) * this.intakeNoiseFactor;
    let engineVibration = 0;
    const numCyl = this.cylinders.length;
    const lastExhaustCollector = this.exhaustCollector / numCyl;
    this.exhaustCollector = 0;
    this.intakeCollector = 0;

    const crankOffset = this.crankFluctuationLp.filter(this.crankNoise.step());
    let cylinderDampened = false;

    for (const cyl of this.cylinders) {
      const [cyIn, cyEx, cyVib, dampened] = cyl.pop(
        this.crankshaftPos + this.crankshaftFluctuation * crankOffset,
        lastExhaustCollector,
        this.intakeValveShift,
        this.exhaustValveShift,
      );
      this.intakeCollector += cyIn;
      this.exhaustCollector += cyEx;
      engineVibration += cyVib;
      cylinderDampened = cylinderDampened || dampened;
    }

    // 배기 직관: alpha 끝은 배기 콜렉터
    const spRet = this.straightPipe.pop();
    // 머플러 요소: 여러 개의 지연선 출력을 합한다
    let muf = [0, 0, false];
    for (const m of this.mufflerElements) {
      const r = m.pop();
      muf = [muf[0] + r[0], muf[1] + r[1], muf[2] || r[2]];
    }

    for (const cyl of this.cylinders) {
      cyl.push(this.intakeCollector / numCyl + intakeNoise * intakeValve(fract(this.crankshaftPos + cyl.crankOffset)));
    }

    this.straightPipe.push(this.exhaustCollector, muf[0]);
    this.exhaustCollector += spRet[0];

    const n = this.mufflerElements.length;
    for (const m of this.mufflerElements) {
      m.push(spRet[1] / n, 0.0);
    }

    engineVibration = this.vibrationFilter.filter(engineVibration);
    return [this.intakeCollector, engineVibration, muf[1], spRet[2] || cylinderDampened];
  }

  // 한 샘플. rpm 은 호출마다 줄 수 있다(스윕용). gen.rs Generator::generate 의 내부 루프와 같다.
  sample(rpm) {
    const inc = rpm / (this.sr * 120.0); // 720° 한 사이클을 샘플 단위로
    this.crankshaftPos = fract(this.crankshaftPos + inc);
    const [ch0, ch1, ch2, dmp] = this.gen();
    const mixed = (ch0 * this.intakeVolume + ch1 * this.vibrationVolume + ch2 * this.exhaustVolume) * this.volume;
    this.dampened = this.dampened || dmp;
    return mixed - this.dcLp.filter(mixed);
  }

  // 볼륨 계수(원본 기본 0.1). 렌더 후 정규화하므로 값 자체는 중요하지 않다.
  get volume() {
    return this._volume ?? 0.1;
  }

  set volume(v) {
    this._volume = v;
  }
}

// 프리셋 JSON 을 받아 rpm 배열(샘플마다)을 렌더한다. 반환: Float64Array(샘플)
export function renderRpm(preset, sampleRate, rpmPerSample, { volume = 0.1 } = {}) {
  const engine = new EngineModel(preset, sampleRate, DEFAULT_SEEDS);
  engine.volume = volume;
  const out = new Float64Array(rpmPerSample.length);
  for (let i = 0; i < rpmPerSample.length; i++) out[i] = engine.sample(rpmPerSample[i]);
  return out;
}

// 노이즈 두 개(흡기 공기 노이즈, 크랭크축 흔들림)의 고정 시드. 원본은 실행 시각으로 시드를 정한다.
export const DEFAULT_SEEDS = {
  intakeSeed: [0x12345678, 0x9abcdef0, 0x0f1e2d3c, 0x4b5a6978],
  crankSeed: [0x02884197, 0x16939937, 0x51058209, 0x74944592],
};
