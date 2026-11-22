// 데모 데이터 생성기. 출력 형식은 parseTelemetry176 결과와 같다.
// 가속 75틱 / 감속 45틱 / 120틱 주기. 카메라 접근(45~72틱) 시나리오를 함께 낸다.

export const DEMO_HV = Object.freeze({
  voltage: 396.4,
  current: -118.5,
  remainKwh: 51.2,
  fullKwh: 60.5,
});

export function createDemo() {
  let tick = 0;
  return {
    reset() {
      tick = 0;
    },
    next() {
      tick += 1;
      const cycle = tick % 120;
      const isAccel = cycle < 75;
      const speed = isAccel
        ? Math.min(212, Math.round((cycle / 75) * 212))
        : Math.max(0, Math.round(212 - ((cycle - 75) / 45) * 212));
      const pedal = isAccel ? Math.min(100, Math.round(25 + (cycle / 75) * 75)) : 0;
      const totalKw = isAccel ? Math.round((pedal / 100) * 320) : (speed > 5 ? -48 : 0);
      const ap = cycle > 35 && cycle < 95 ? 1 : 0;
      const frame = {
        speed,
        gear: speed === 0 && cycle > 110 ? 1 : 4,
        turn: (cycle > 15 && cycle < 32) ? 1 : ((cycle > 85 && cycle < 100) ? 2 : 0),
        ap,
        soc: 84,
        odo: 18420.5 + tick * 0.04,
        tpms: [42.1, 42.3, 41.8, 42.0],
        pedal,
        frontKw: Math.round(totalKw * 0.36),
        rearKw: Math.round(totalKw * 0.64),
        alt: 42,
        speedUnit: 1,
        handsOn: (cycle > 55 && cycle < 68) ? 1 : 0,
        bTemps: [46, 48, 41, 42],
        blowerRpm: 1650,
        hvacWatts: 820,
        cabinTemp: 21.5,
        ambTemp: 17.0,
        rangeKm: 425,
        battTemp: 29.5,
        limitSpd: 110,
      };
      const cam = (cycle >= 45 && cycle <= 72)
        ? { limit: 100, distM: Math.max(20, Math.round((73 - cycle) * 16)) }
        : null;
      // 사각지대 시연 (§19.5): 좌측은 좌 방향지시등이 켜진 구간과 겹치고, 우측은 따로 한 번 켠다.
      frame.blindLeft = cycle >= 20 && cycle <= 30;
      frame.blindRight = cycle >= 60 && cycle <= 66;
      return { frame, cam };
    },
  };
}
