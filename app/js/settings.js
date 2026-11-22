// localStorage 래퍼. 모든 접근은 try/catch (사생활 보호 모드, 차단된 저장소 대응).

const KEY = {
  password: 'tsl_ble_key',
  autoConnect: 'tsl_autoconnect',
  lastId: 'tsl_last_device_id',
  lastName: 'tsl_last_device_name',
  camEnabled: 'tsl_cam_auto',
  camRadius: 'tsl_cam_radius',
  camDb: 'tsl_cam_db',
  sound: 'tsl_sound_profile',
  volume: 'tsl_volume',
};

const SOUND_KEYS = ['off', 'zimmer', 'plaid', 'v8', 'gt6'];

export function read(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

export function write(key, value) {
  try {
    localStorage.setItem(key, String(value));
    return true;
  } catch (e) {
    return false;
  }
}

export function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch (e) { /* noop */ }
}

export function getPassword() {
  const v = read(KEY.password, '1234');
  return v && v.length === 4 ? v : '1234';
}

export function setPassword(v) {
  return write(KEY.password, v);
}

export function isAutoConnect() {
  return read(KEY.autoConnect, '1') !== '0';
}

export function setAutoConnect(on) {
  return write(KEY.autoConnect, on ? '1' : '0');
}

export function getLastDevice() {
  const id = read(KEY.lastId, null);
  if (!id) return null;
  return { id, name: read(KEY.lastName, 'TSL') };
}

export function setLastDevice(id, name) {
  write(KEY.lastId, id);
  write(KEY.lastName, name || 'TSL');
}

export function clearLastDevice() {
  remove(KEY.lastId);
  remove(KEY.lastName);
}

export function isCamEnabled() {
  return read(KEY.camEnabled, '1') !== '0';
}

export function setCamEnabled(on) {
  return write(KEY.camEnabled, on ? '1' : '0');
}

export function getCamRadius() {
  const r = Number(read(KEY.camRadius, '500'));
  return r === 300 ? 300 : 500;
}

export function setCamRadius(r) {
  return write(KEY.camRadius, r);
}

export function getCamDb() {
  try {
    const list = JSON.parse(read(KEY.camDb, '[]'));
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

// 저장 실패(용량 초과 등) 시 false
export function setCamDb(list) {
  return write(KEY.camDb, JSON.stringify(list));
}

export function getSound() {
  const v = read(KEY.sound, 'off');
  return SOUND_KEYS.includes(v) ? v : 'off';
}

export function setSound(key) {
  return write(KEY.sound, key);
}

export function getVolume() {
  const v = Number(read(KEY.volume, '60'));
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 60;
}

export function setVolume(v) {
  return write(KEY.volume, Math.round(v));
}
