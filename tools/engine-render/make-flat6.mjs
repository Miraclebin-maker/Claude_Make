// 플랫6 프리셋을 V10(presets/v10a.json) 에서 유도한다. 실행: node make-flat6.mjs
//
// 근거 (설계 §17.2: 점화 간격, 뱅크 차이, 더 높은 회전·날카로운 음색):
//  1. 실린더 6개, 4행정 720° 를 6등분 → 점화 간격 120°. 점화 순서 1-6-2-4-3-5 에 맞춰 크랭크 오프셋 = 순서 위치 / 6.
//  2. 박서 좌·우 뱅크(좌 1,3,5 / 우 2,4,6)는 배기관 길이가 다르다. 뱅크마다 배기 지연을 ±8% 차이 나게 해서 럼블을 만든다
//     (V10 프리셋의 실린더별 불균일 지연과 같은 역할을 뱅크 단위로 준다).
//  3. 날카로운 음색: 배기 웨이브가이드 지연을 V10 의 0.8배로 줄인다(0.00025 -> 0.0002 근처). 짧은 관은 공명이 높아져 고회전 음색이 날카로워진다.
//  4. 피스톤·점화·흡기 계수와 머플러는 V10 실린더 0 과 같은 값을 쓴다. 엔진 한 개의 질감을 바꾸지 않기 위해서다.
//  5. 흡기 관 지연은 V10 과 같다(흡기 공명 대역은 바꾸지 않는다).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const v10 = JSON.parse(readFileSync(join(here, 'presets', 'v10a.json'), 'utf8'));
const base = v10.cylinders[0];

const FIRING_ORDER = [1, 6, 2, 4, 3, 5];
const LEFT_BANK = new Set([1, 3, 5]);
const EXHAUST_SCALE = 0.8; // 근거 3
const BANK_SKEW = 0.08; // 근거 2: 좌 -8%, 우 +8%

const wg = (delay, alpha, beta) => ({
  chamber0: { samples: { delay } },
  chamber1: { samples: { delay } },
  alpha,
  beta,
});

const cylinders = FIRING_ORDER.map((cylNo) => {
  const pos = FIRING_ORDER.indexOf(cylNo);
  const bankFactor = LEFT_BANK.has(cylNo) ? 1 - BANK_SKEW : 1 + BANK_SKEW;
  const exDelay = base.exhaust_waveguide.chamber0.samples.delay * EXHAUST_SCALE * bankFactor;
  return {
    crank_offset: pos / 6,
    exhaust_waveguide: wg(exDelay, base.exhaust_waveguide.alpha, base.exhaust_waveguide.beta),
    intake_waveguide: wg(
      base.intake_waveguide.chamber0.samples.delay,
      base.intake_waveguide.alpha,
      base.intake_waveguide.beta,
    ),
    extractor_waveguide: wg(
      base.extractor_waveguide.chamber0.samples.delay,
      base.extractor_waveguide.alpha,
      base.extractor_waveguide.beta,
    ),
    intake_open_refl: base.intake_open_refl,
    intake_closed_refl: base.intake_closed_refl,
    exhaust_open_refl: base.exhaust_open_refl,
    exhaust_closed_refl: base.exhaust_closed_refl,
    piston_motion_factor: base.piston_motion_factor,
    ignition_factor: base.ignition_factor,
    ignition_time: base.ignition_time,
  };
});

const flat6 = {
  _note: 'V10a(example1.esc) 에서 유도. 6기통 점화 간격 120°, 점화 순서 1-6-2-4-3-5, 뱅크 배기 지연 ±8%, 배기 지연 0.8배. 자세한 근거는 make-flat6.mjs',
  rpm: 3000,
  intake_volume: v10.intake_volume,
  exhaust_volume: v10.exhaust_volume,
  engine_vibrations_volume: v10.engine_vibrations_volume,
  cylinders,
  intake_noise_factor: v10.intake_noise_factor,
  intake_noise_lp: v10.intake_noise_lp,
  engine_vibration_filter: v10.engine_vibration_filter,
  muffler: v10.muffler,
  intake_valve_shift: v10.intake_valve_shift,
  exhaust_valve_shift: v10.exhaust_valve_shift,
  crankshaft_fluctuation: v10.crankshaft_fluctuation,
  crankshaft_fluctuation_lp: v10.crankshaft_fluctuation_lp,
};

writeFileSync(join(here, 'presets', 'flat6.json'), JSON.stringify(flat6, null, 2) + '\n');
console.log('wrote presets/flat6.json', cylinders.map((c) => c.crank_offset.toFixed(3)).join(' '));
