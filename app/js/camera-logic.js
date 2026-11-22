// 단속 카메라 경고 판단 (설계 §19.1, §19.2). 순수 함수: DOM/GPS/저장소 사용 금지.
export const HEADING_MIN_SPEED_MS = 3; // GPS 방향을 믿을 최소 속도
export const HEADING_MIN_MOVE_M = 15; // 위치로 방향을 계산하는 최소 이동 거리
export const AHEAD_CONE_DEG = 35; // 전방 판정: 진행 방향과 카메라 방위각 차이
export const CAM_DIR_TOL_DEG = 45; // DB 에 카메라 방향이 있을 때 진행 방향과의 허용 차이
export const MIN_ALERT_KMH = 15; // 이보다 느리면 경고하지 않는다

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function calcBearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const toDeg = (rad) => (rad * 180) / Math.PI;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2))
    - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function angleDiffDeg(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// 진행 방향 파생 (§19.1):
//  (1) GPS heading 이 숫자이고 속도 ≥ 3 m/s 이면 그 값을 쓴다.
//  (2) 아니면 마지막으로 방향을 계산한 지점에서 15 m 이상 떨어졌을 때 두 점의 방위각을 쓴다.
//  (3) 둘 다 없으면 null(방향 미정). 이전에 계산한 방향은 새 계산 전까지 유지한다.
export function createHeadingTracker() {
  let ref = null; // 마지막으로 방향을 계산(또는 기준으로 삼은) 지점
  let heading = null;
  return {
    update(fix) {
      if (!isNum(fix.lat) || !isNum(fix.lng)) return heading;
      const here = { lat: fix.lat, lng: fix.lng };
      if (isNum(fix.heading) && isNum(fix.speed) && fix.speed >= HEADING_MIN_SPEED_MS) {
        heading = fix.heading;
        ref = here;
        return heading;
      }
      if (!ref) {
        ref = here;
        return heading;
      }
      if (haversineMeters(ref.lat, ref.lng, here.lat, here.lng) >= HEADING_MIN_MOVE_M) {
        heading = calcBearingDeg(ref.lat, ref.lng, here.lat, here.lng);
        ref = here;
      }
      return heading;
    },
    get heading() {
      return heading;
    },
    reset() {
      ref = null;
      heading = null;
    },
  };
}

// 전방 판정: 방향이 있고, 카메라 방위각과 ±cone 이내일 때만 참
export function isAhead(heading, bearing, cone = AHEAD_CONE_DEG) {
  if (!isNum(heading) || !isNum(bearing)) return false;
  return angleDiffDeg(heading, bearing) <= cone;
}

// DB 의 카메라 방향(도)이 있으면 진행 방향과 ±45° 이내일 때만 맞다. 없으면 조건 생략.
export function camDirMatches(heading, camDir) {
  if (!isNum(camDir)) return true;
  if (!isNum(heading)) return false;
  return angleDiffDeg(heading, camDir) <= CAM_DIR_TOL_DEG;
}

// 차량 속도(텔레메트리, km/h) 우선, 없으면 GPS 속도(m/s × 3.6). 둘 다 없으면 null.
export function speedKmhOf({ telemKmh, gpsMs }) {
  if (isNum(telemKmh)) return telemKmh;
  if (isNum(gpsMs) && gpsMs >= 0) return gpsMs * 3.6;
  return null;
}

// 경고 여부. 방향 미정, 저속, 전방 아님, 멀어지는 중, 카메라 방향 불일치면 경고하지 않는다.
// prevDist 가 없으면(첫 평가) 접근 중으로 본다.
export function shouldAlert({ heading, bearing, dist, prevDist, camDir, speedKmh }) {
  if (!isNum(speedKmh) || speedKmh < MIN_ALERT_KMH) return false;
  if (!isNum(heading)) return false;
  if (!isAhead(heading, bearing)) return false;
  const approaching = !isNum(prevDist) || dist < prevDist;
  if (!approaching) return false;
  return camDirMatches(heading, camDir);
}
