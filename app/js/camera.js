// GPS + 단속 카메라 DB + 접근 경고. 차량 송신 없음 (설계 8).
import * as settings from './settings.js';
import {
  haversineMeters, calcBearingDeg, angleDiffDeg, createHeadingTracker,
  isAhead, camDirMatches, speedKmhOf, shouldAlert, MIN_ALERT_KMH,
} from './camera-logic.js';

export { haversineMeters, calcBearingDeg, angleDiffDeg };

export const DEMO_CAM_ID = 'demo';

export const SAMPLE_CAMERAS = Object.freeze([
  { id: 'kr-sample-1', lat: 37.5145, lng: 127.0595, limit: 50, name: '테헤란로 삼성역 구간' },
  { id: 'kr-sample-2', lat: 37.4979, lng: 127.0276, limit: 50, name: '강남대로 강남역 구간' },
  { id: 'kr-sample-3', lat: 37.3947, lng: 127.1112, limit: 60, name: '판교역 분당내곡로' },
]);

// JSON 또는 CSV(위도,경도,제한속도) 텍스트 -> 카메라 배열. JSON 파싱 오류는 throw.
export function parseCameraText(text) {
  const src = String(text || '').trim();
  const imported = [];
  if (src.startsWith('[') || src.startsWith('{')) {
    const parsed = JSON.parse(src);
    const list = Array.isArray(parsed) ? parsed : (parsed.cameras || parsed.records || []);
    list.forEach((item, idx) => {
      const lat = Number(item.lat ?? item.latitude ?? item['위도']);
      const lng = Number(item.lng ?? item.lon ?? item.longitude ?? item['경도']);
      const limit = Number(item.limit ?? item.speedLimit ?? item['제한속도'] ?? 80);
      const rawDir = item.dir ?? item.heading ?? item['방향'];
      const dir = rawDir === undefined || rawDir === null || rawDir === '' ? NaN : Number(rawDir);
      if (!Number.isNaN(lat) && !Number.isNaN(lng) && lat !== 0 && lng !== 0) {
        const cam = { id: `imp-${idx}`, lat, lng, limit: limit || 80 };
        if (Number.isFinite(dir)) cam.dir = ((dir % 360) + 360) % 360;
        imported.push(cam);
      }
    });
  } else {
    src.split(/\r?\n/).forEach((line, idx) => {
      const cols = line.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
      if (cols.length >= 2) {
        const lat = Number(cols[0]);
        const lng = Number(cols[1]);
        const limit = Number(cols[2]) || 80;
        // 4번째 열(선택): 단속 방향 각도. 숫자일 때만 쓴다.
        const dir = cols.length >= 4 && cols[3] !== '' ? Number(cols[3]) : NaN;
        if (!Number.isNaN(lat) && !Number.isNaN(lng) && lat > 30 && lat < 45) {
          const cam = { id: `csv-${idx}`, lat, lng, limit };
          if (Number.isFinite(dir)) cam.dir = ((dir % 360) + 360) % 360;
          imported.push(cam);
        }
      }
    });
  }
  return imported;
}

// callbacks: onAlert({limit, distM}), onClear(), onChime(), onGps(text), onChange(), toast(msg)
// getSpeedKmh(): 차량 속도(km/h) 또는 null (텔레메트리/데모). 없으면 GPS 속도를 쓴다 (§19.2).
export function createCameraWatch({ onAlert, onClear, onChime, onGps, onChange, toast, getSpeedKmh = () => null }) {
  let db = settings.getCamDb();
  if (db.length === 0) db = SAMPLE_CAMERAS.map((c) => ({ ...c }));
  let enabled = settings.isCamEnabled();
  let radius = settings.getCamRadius();
  let watchId = null;
  let closed = false; // stop() 이후 true
  let lastFix = null; // { lat, lng, heading, speed }
  let tracked = null; // { id, lastDist }
  const tracker = createHeadingTracker(); // 진행 방향 (§19.1)

  function persist() {
    if (!settings.setCamDb(db)) toast('DB가 너무 큽니다');
  }

  function clear() {
    tracked = null;
    onClear();
  }

  // fix: { lat, lng, heading, speed } (GPS). 진행 방향은 여기서 파생한다.
  function evaluate(fix) {
    const heading = tracker.update(fix);
    if (!enabled || db.length === 0) {
      if (tracked) clear();
      return;
    }
    const speedKmh = speedKmhOf({ telemKmh: getSpeedKmh(), gpsMs: fix.speed });
    let nearest = null;
    let nearestDist = Infinity;
    let nearestBearing = null;
    if (speedKmh !== null && speedKmh >= MIN_ALERT_KMH && heading !== null) {
      for (const cam of db) {
        const dist = haversineMeters(fix.lat, fix.lng, cam.lat, cam.lng);
        if (dist > radius + 150) continue;
        const bearing = calcBearingDeg(fix.lat, fix.lng, cam.lat, cam.lng);
        // 전방 ±35° (25 m 이내는 방위각이 불안정하므로 생략)
        if (dist > 25 && !isAhead(heading, bearing)) continue;
        if (!camDirMatches(heading, cam.dir)) continue;
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = cam;
          nearestBearing = bearing;
        }
      }
    }

    if (!nearest || nearestDist > radius) {
      if (tracked) clear();
      return;
    }
    const sameCam = tracked && tracked.id === nearest.id;
    if (sameCam && nearestDist > tracked.lastDist + 12 && tracked.lastDist < 60) {
      clear(); // 통과: 멀어짐
      return;
    }
    const alert = shouldAlert({
      heading,
      bearing: nearestBearing,
      dist: nearestDist,
      prevDist: sameCam ? tracked.lastDist : undefined,
      camDir: nearest.dir,
      speedKmh,
    });
    if (!alert) {
      if (tracked) clear();
      return;
    }
    if (!sameCam) onChime(); // 접근 시 1회
    tracked = { id: nearest.id, lastDist: nearestDist };
    onAlert({ limit: nearest.limit || 80, distM: Math.round(nearestDist) });
  }

  // 데모 시나리오 주입. info = { limit, distM } 또는 null(해제)
  function simulate(info) {
    if (!info || !enabled) {
      if (tracked || info === null) clear();
      return;
    }
    if (!tracked || tracked.id !== DEMO_CAM_ID) onChime();
    tracked = { id: DEMO_CAM_ID, lastDist: info.distM };
    onAlert({ limit: info.limit, distM: info.distM });
  }

  function setGps(text) {
    onGps(text);
  }

  // 앱 종료: GPS 감시를 끄고 다시 켜지 않는다.
  function stop() {
    closed = true;
    if (watchId !== null && 'geolocation' in navigator) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    setGps('정지');
    clear();
  }

  function start() {
    if (closed) return;
    if (!('geolocation' in navigator)) {
      setGps('미지원');
      return;
    }
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setGps('수신중');
        lastFix = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          heading: pos.coords.heading,
          speed: pos.coords.speed,
        };
        evaluate(lastFix);
      },
      () => setGps('권한필요'),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 5000 },
    );
  }

  function setEnabled(on) {
    enabled = !!on;
    settings.setCamEnabled(enabled);
    if (!enabled) clear();
    onChange();
  }

  function setRadius(r) {
    radius = r === 300 ? 300 : 500;
    settings.setCamRadius(radius);
    onChange();
  }

  // 현재 위치(없으면 서울 시청) 기준 전방 250m 테스트 카메라
  function addTest() {
    const baseLat = lastFix ? lastFix.lat : 37.5665;
    const baseLng = lastFix ? lastFix.lng : 126.978;
    const heading = tracker.heading ?? (lastFix && typeof lastFix.heading === 'number' ? lastFix.heading : 0);
    const rad = (heading * Math.PI) / 180;
    const dLat = (250 * Math.cos(rad)) / 111320;
    const dLng = (250 * Math.sin(rad)) / (111320 * Math.cos((baseLat * Math.PI) / 180));
    db.push({
      id: `test-${Date.now()}`,
      lat: Number((baseLat + dLat).toFixed(6)),
      lng: Number((baseLng + dLng).toFixed(6)),
      limit: 80,
      name: '사용자 테스트 카메라',
    });
    persist();
    if (lastFix) evaluate(lastFix);
    onChange();
    toast('전방 250m 지점에 테스트 단속 카메라가 추가되었습니다.');
  }

  function clearDb() {
    db = [];
    persist();
    clear();
    onChange();
    toast('카메라 좌표 DB가 초기화되었습니다.');
  }

  function importFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const items = parseCameraText(String(e.target.result || ''));
        if (items.length === 0) {
          toast('유효한 위도/경도 좌표를 찾지 못했습니다.');
          return;
        }
        db = db.concat(items);
        persist();
        onChange();
        toast(`단속 카메라 ${items.length.toLocaleString()}개 불러오기 완료`);
      } catch (err) {
        toast('파일 파싱 오류: JSON 또는 CSV 형식을 확인하세요.');
      }
    };
    reader.readAsText(file, 'UTF-8');
  }

  return {
    start,
    stop,
    evaluate,
    simulate,
    setEnabled,
    setRadius,
    addTest,
    clearDb,
    importFile,
    isEnabled: () => enabled,
    getRadius: () => radius,
    count: () => db.length,
  };
}
