// GPS + 단속 카메라 DB + 접근 경고. 차량 송신 없음 (설계 8).
import * as settings from './settings.js';

export const DEMO_CAM_ID = 'demo';

export const SAMPLE_CAMERAS = Object.freeze([
  { id: 'kr-sample-1', lat: 37.5145, lng: 127.0595, limit: 50, name: '테헤란로 삼성역 구간' },
  { id: 'kr-sample-2', lat: 37.4979, lng: 127.0276, limit: 50, name: '강남대로 강남역 구간' },
  { id: 'kr-sample-3', lat: 37.3947, lng: 127.1112, limit: 60, name: '판교역 분당내곡로' },
]);

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
      if (!Number.isNaN(lat) && !Number.isNaN(lng) && lat !== 0 && lng !== 0) {
        imported.push({ id: `imp-${idx}`, lat, lng, limit: limit || 80 });
      }
    });
  } else {
    src.split(/\r?\n/).forEach((line, idx) => {
      const cols = line.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
      if (cols.length >= 2) {
        const lat = Number(cols[0]);
        const lng = Number(cols[1]);
        const limit = Number(cols[2]) || 80;
        if (!Number.isNaN(lat) && !Number.isNaN(lng) && lat > 30 && lat < 45) {
          imported.push({ id: `csv-${idx}`, lat, lng, limit });
        }
      }
    });
  }
  return imported;
}

// callbacks: onAlert({limit, distM}), onClear(), onChime(), onGps(text), onChange(), toast(msg)
export function createCameraWatch({ onAlert, onClear, onChime, onGps, onChange, toast }) {
  let db = settings.getCamDb();
  if (db.length === 0) db = SAMPLE_CAMERAS.map((c) => ({ ...c }));
  let enabled = settings.isCamEnabled();
  let radius = settings.getCamRadius();
  let watchId = null;
  let lastFix = null; // { lat, lng, heading }
  let tracked = null; // { id, lastDist }

  function persist() {
    if (!settings.setCamDb(db)) toast('DB가 너무 큽니다');
  }

  function clear() {
    tracked = null;
    onClear();
  }

  function evaluate(lat, lng, heading) {
    if (!enabled || db.length === 0) {
      if (tracked) clear();
      return;
    }
    let nearest = null;
    let nearestDist = Infinity;
    for (const cam of db) {
      const dist = haversineMeters(lat, lng, cam.lat, cam.lng);
      if (dist > radius + 150) continue;
      // 진행 방향(heading)이 유효할 때 전방 ±50도 이내 카메라만 선별
      if (typeof heading === 'number' && !Number.isNaN(heading) && dist > 25) {
        const bearing = calcBearingDeg(lat, lng, cam.lat, cam.lng);
        if (angleDiffDeg(heading, bearing) > 50) continue;
      }
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = cam;
      }
    }

    if (nearest && nearestDist <= radius) {
      const passing = tracked && tracked.id === nearest.id
        && nearestDist > tracked.lastDist + 12 && tracked.lastDist < 60;
      if (passing) {
        clear();
        return;
      }
      if (!tracked || tracked.id !== nearest.id) onChime(); // 접근 시 1회
      tracked = { id: nearest.id, lastDist: nearestDist };
      onAlert({ limit: nearest.limit || 80, distM: Math.round(nearestDist) });
    } else if (tracked) {
      clear();
    }
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

  function start() {
    if (!('geolocation' in navigator)) {
      setGps('미지원');
      return;
    }
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setGps('수신중');
        lastFix = { lat: pos.coords.latitude, lng: pos.coords.longitude, heading: pos.coords.heading };
        evaluate(lastFix.lat, lastFix.lng, lastFix.heading);
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
    const heading = lastFix && typeof lastFix.heading === 'number' && !Number.isNaN(lastFix.heading)
      ? lastFix.heading : 0;
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
    evaluate(baseLat, baseLng, heading);
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
