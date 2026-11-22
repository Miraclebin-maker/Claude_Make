// 플래드 가속 워프 캔버스 (설계 7.1).
// 강도 I = clamp(max(accelG/0.6, totalKw/peakKw*0.8), 0, 1). rAF 루프는 start() 중에만 돈다.

const STAR_COUNT = 160;
const BLUE_A = '#DDEBFF';
const BLUE_B = '#7FB7FF';
const RED = '#FF3B5C';
const WARM = '#FF8A5C';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function createPlaid(canvas) {
  const g = canvas.getContext('2d');
  const reduceMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w = 0;
  let h = 0;
  let stars = [];
  let running = false;
  let raf = 0;
  let intensity = 0;
  let accelG = 0;
  let prevSpeed = null;
  let prevMs = 0;
  let lastIMs = 0;
  let decel = false;
  let hyper = false;

  function spawn(i, zMax) {
    return {
      x: (Math.random() - 0.5) * w * 1.6,
      y: (Math.random() - 0.5) * h * 1.6,
      z: Math.random() * zMax + 1,
      red: i % 7 === 0,
      blue: i % 2 === 0,
    };
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    stars = Array.from({ length: STAR_COUNT }, (_, i) => spawn(i, w));
  }

  // 프레임마다 호출. 반환: 이번 프레임에 가속 강도가 풀 가속(0.6)을 넘었는지
  function update({ speedKmh, totalKw, peakKw, nowMs }) {
    if (prevSpeed !== null) {
      const dt = Math.max(0.02, (nowMs - prevMs) / 1000);
      const raw = (speedKmh - prevSpeed) / 3.6 / (dt * 9.81);
      const a = 1 - Math.exp(-dt / 0.3);
      accelG += (raw - accelG) * a;
    }
    prevSpeed = speedKmh;
    prevMs = nowMs;
    decel = accelG < -0.1;

    const target = clamp(Math.max(accelG / 0.6, (totalKw / Math.max(200, peakKw)) * 0.8), 0, 1);
    const dtI = lastIMs ? clamp((nowMs - lastIMs) / 1000, 0, 0.5) : 0;
    lastIMs = nowMs;
    const tau = target > intensity ? 0.15 : 0.8;
    intensity += (target - intensity) * (1 - Math.exp(-dtI / tau));

    const next = intensity > 0.6;
    hyper = next;
    return next;
  }

  function frame() {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const I = intensity;
    const cx = w / 2;
    const cy = h / 2;
    const max = Math.max(w, h);

    g.globalAlpha = 1;
    g.fillStyle = 'rgba(11, 12, 14, 0.34)';
    g.fillRect(0, 0, w, h);

    if (I > 0.02) {
      const bloom = g.createRadialGradient(cx, cy, 10, cx, cy, max * 0.5);
      bloom.addColorStop(0, `rgba(221, 235, 255, ${0.14 * I})`);
      bloom.addColorStop(1, 'rgba(11, 12, 14, 0)');
      g.fillStyle = bloom;
      g.fillRect(0, 0, w, h);
    }
    if (I > 0.05) {
      const vig = g.createRadialGradient(cx, cy, max * 0.35, cx, cy, max * 0.75);
      vig.addColorStop(0, 'rgba(0, 0, 0, 0)');
      vig.addColorStop(1, `rgba(0, 0, 0, ${0.45 * I})`);
      g.fillStyle = vig;
      g.fillRect(0, 0, w, h);
    }

    const speedZ = I < 0.05 ? 0.6 : 2 + I * 34;
    const streakK = decel ? 0.2 : (I < 0.05 ? 0.2 : 0.5 + 12 * I * I);
    const kx = w * 0.42;
    const ky = h * 0.42;
    g.lineCap = 'round';

    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const prevZ = s.z + speedZ * streakK;
      s.z -= speedZ;
      if (s.z <= 2) {
        stars[i] = spawn(i, w);
        continue;
      }
      const sx = cx + (s.x / s.z) * kx;
      const sy = cy + (s.y / s.z) * ky;
      const px = cx + (s.x / prevZ) * kx;
      const py = cy + (s.y / prevZ) * ky;
      if (sx < 0 || sx > w || sy < 0 || sy > h) continue;

      const depth = 1 - s.z / w;
      g.globalAlpha = Math.min(0.9, depth * (0.3 + I));
      g.lineWidth = Math.max(1, depth * 2.8);
      g.strokeStyle = decel ? WARM : (s.red ? RED : (s.blue ? BLUE_A : BLUE_B));
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(sx, sy);
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  function start() {
    if (running) return;
    running = true;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (w) g.setTransform(Math.min(2, window.devicePixelRatio || 1), 0, 0, Math.min(2, window.devicePixelRatio || 1), 0, 0);
  }

  resize();
  window.addEventListener('resize', resize);

  return { update, start, stop, get hyper() { return hyper; }, reduceMotion };
}
