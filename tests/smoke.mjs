// Playwright 스모크 테스트 (설계 10.3).
// 실행: node tests/smoke.mjs   (app/ 을 python3 -m http.server 로 띄운 뒤 Chromium 으로 검사)
// Playwright 모듈 해석 순서: import('playwright') -> env PLAYWRIGHT_MODULE -> 전역 설치 경로.
// playwright install 은 실행하지 않는다 (시스템 Chromium 사용).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const appDir = join(root, 'app');
const screensDir = join(here, 'screens');
const PORT = Number(process.env.SMOKE_PORT || 8765);
const BASE = `http://127.0.0.1:${PORT}`;

const VIEWPORTS = [
  { w: 390, h: 844 },
  { w: 844, h: 390 },
  { w: 360, h: 640 },
  { w: 640, h: 360 },
];
const THEMES = ['minimal', 'plaid', 'dial', 'track', 'night'];

async function loadPlaywright() {
  const candidates = [
    () => import('playwright'),
    () => import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/opt/node-tools/node_modules/playwright/index.js').href),
  ];
  let lastErr;
  for (const load of candidates) {
    try {
      const mod = await load();
      return mod.chromium || mod.default.chromium;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`playwright 모듈을 찾지 못함: ${lastErr && lastErr.message}`);
}

function startServer() {
  const proc = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', appDir], {
    stdio: 'ignore',
  });
  return proc;
}

async function waitForServer(timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/index.html`);
      if (r.ok) return;
    } catch (e) { /* 아직 기동 전 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('http.server 기동 실패');
}

async function main() {
  const chromium = await loadPlaywright();
  mkdirSync(screensDir, { recursive: true });
  const server = startServer();
  const results = [];
  const failures = [];
  const check = (name, ok, detail = '') => {
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    if (!ok) failures.push(name);
  };

  let browser;
  try {
    await waitForServer();
    browser = await chromium.launch();

    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
      const page = await ctx.newPage();
      const errors = [];
      const externalFailures = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const url = (m.location() && m.location().url) || '';
        // 외부 CDN(폰트) 로드 실패는 샌드박스 네트워크 제약이므로 별도 집계만 한다
        if (m.text().includes('Failed to load resource') && !url.startsWith(BASE)) {
          externalFailures.push(url || m.text());
          return;
        }
        errors.push(`console: ${m.text()}`);
      });

      await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
      await page.waitForSelector('#val-speed');

      // 데모 시작: 설정 시트 -> 데모 -> 시트 닫기
      await page.click('.dock [data-act="settings"]');
      await page.click('#btn-demo');
      await page.click('#sheet-settings .x');

      for (const theme of THEMES) {
        const tag = `${theme} ${vp.w}x${vp.h}`;
        await page.click('.dock [data-act="settings"]');
        await page.click(`#sheet-settings button[data-theme="${theme}"]`);
        await page.click('#sheet-settings .x');
        // 속도가 3자리(>=100)이고 카메라 배너가 떠 있는 시점에서 측정 (데모 45~72틱, §13.4)
        // 핸들 경고(cycle 55~68)가 떠 있는 동안 측정 (§13.6). 카메라 배너(45~72)도 함께 떠 있다.
        await page.waitForFunction(
          () => !document.getElementById('cam-banner').hidden && !document.getElementById('hands-alert').hidden
            && Number(document.getElementById('val-speed').textContent) >= 100,
          null, { timeout: 25000, polling: 50 });
        await page.waitForTimeout(150);
        // 경고 창(1.3초)이 닫히기 전에 찍는다. 측정은 같은 순간의 상태다.
        await page.screenshot({ path: join(screensDir, `${theme}-${vp.w}x${vp.h}.png`) });

        const m = await page.evaluate(() => {
          const box = (r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height });
          const speedEl = document.getElementById('val-speed');
          const range = document.createRange();
          range.selectNodeContents(speedEl);
          // 가로 범위: 실제 글자 폭(Range). 세로 범위: 줄 박스(line-height 기준, 글자 잉크 영역)
          const tr = box(range.getBoundingClientRect());
          const eb = box(speedEl.getBoundingClientRect());
          const speed = { l: tr.l, r: tr.r, t: eb.t, b: eb.b, w: tr.w, h: eb.h };
          const sel = [
            '#turn-l', '#turn-r', '#limit', '#kw-block',
            '#track .vbar-group', '#track .track-top > *', '#track .track-bottom > *',
            '#cam-banner', '#hands-alert', '.speed-meta',
          ];
          const parts = [];
          for (const q of sel) {
            document.querySelectorAll(q).forEach((el) => {
              if (el.closest('[hidden]')) return;
              let r;
              if (el.matches('.speed-meta')) {
                // 블록 박스가 셀 전체 폭이므로 실제 글자 영역으로 검사
                const rg = document.createRange();
                rg.selectNodeContents(el);
                r = box(rg.getBoundingClientRect());
              } else {
                r = box(el.getBoundingClientRect());
              }
              if (r.w === 0 || r.h === 0) return;
              parts.push({ name: q + (el.id ? `#${el.id}` : ''), ...r });
            });
          }
          const hits = parts.filter((r) => speed.l < r.r && r.l < speed.r && speed.t < r.b && r.t < speed.b)
            .map((r) => r.name);
          const turnHits = [];
          const turns = parts.filter((r) => r.name.startsWith('#turn') || r.name.startsWith('.speed-meta'));
          const track = parts.filter((r) => !r.name.startsWith('#turn') && r.name.startsWith('#track'));
          for (const t of turns) for (const r of track) {
            if (t.l < r.r && r.l < t.r && t.t < r.b && r.t < t.b) turnHits.push(`${t.name}x${r.name}`);
          }
          // §13.4 (a) 링 외곽 원 vs 상태줄/출력 바 (원 중심 = 회전 중심, 반지름 = 외곽 129/280 * 레이아웃 폭)
          const dialEl = document.getElementById('dial');
          let dialHits = null;
          if (dialEl && parseFloat(getComputedStyle(dialEl).width) > 0) {
            const dr = dialEl.getBoundingClientRect();
            const cx = (dr.left + dr.right) / 2;
            const cy = (dr.top + dr.bottom) / 2;
            // SVG 요소는 offsetWidth 가 없다. 계산 스타일 폭(회전 전 레이아웃 폭)을 쓴다.
            const layoutW = parseFloat(getComputedStyle(dialEl).width);
            const R = (layoutW * 129) / 280;
            const circleHits = (rect) => {
              const dx = Math.max(rect.l - cx, 0, cx - rect.r);
              const dy = Math.max(rect.t - cy, 0, cy - rect.b);
              return Math.hypot(dx, dy) < R + 8;
            };
            dialHits = [];
            for (const q of ['.status', '.bar']) {
              const el = document.querySelector(q);
              if (el && circleHits(box(el.getBoundingClientRect()))) dialHits.push(q);
            }
          }
          // §13.4 (b)(c) 카메라 배너: 제목 줄 높이, 화면 안, 트랙 SHIFT/PK(행 1) 및 LONG-G 비교차
          const cb = document.getElementById('cam-banner');
          const cbBox = box(cb.getBoundingClientRect());
          const titleEl = cb.querySelector('.cam-title');
          const cs = getComputedStyle(titleEl);
          const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
          const titleH = titleEl.getBoundingClientRect().height;
          const overlapsBanner = (el) => {
            const r = box(el.getBoundingClientRect());
            return r.w > 0 && r.h > 0 && cbBox.l < r.r && r.l < cbBox.r && cbBox.t < r.b && r.t < cbBox.b;
          };
          const camTop = [...document.querySelectorAll('#track .track-top > *')].filter(overlapsBanner).map((e) => e.className || e.id);
          const camBottom = [...document.querySelectorAll('#track .track-bottom > *')].filter(overlapsBanner).map((e) => e.className || e.id);
          // §13.6 핸들 경고: 한 줄, 화면 안, 보이는 kW 블록/트랙 내부 요소/카메라 배너/독 버튼과 비교차
          const ha = document.getElementById('hands-alert');
          const haBox = box(ha.getBoundingClientRect());
          const haCs = getComputedStyle(ha);
          const haLineH = parseFloat(haCs.lineHeight) || parseFloat(haCs.fontSize) * 1.2;
          const haPad = parseFloat(haCs.paddingTop) + parseFloat(haCs.paddingBottom)
            + parseFloat(haCs.borderTopWidth) + parseFloat(haCs.borderBottomWidth);
          const haContentH = haBox.h - haPad;
          const haHitsRect = (r) => r.w > 0 && r.h > 0 && haBox.l < r.r && r.l < haBox.r && haBox.t < r.b && r.t < haBox.b;
          const haItems = [];
          const kwEl = document.getElementById('kw-block');
          const kwHidden = getComputedStyle(kwEl).visibility === 'hidden';
          if (!kwHidden) haItems.push(['#kw-block', box(kwEl.getBoundingClientRect())]);
          document.querySelectorAll('#track .track-top > *, #track .vbar-group, #track .track-bottom > *')
            .forEach((e) => haItems.push([`track ${e.className || e.id}`, box(e.getBoundingClientRect())]));
          const cbEl = document.getElementById('cam-banner');
          if (!cbEl.hidden) haItems.push(['#cam-banner', box(cbEl.getBoundingClientRect())]);
          document.querySelectorAll('.dock button').forEach((e, i) => haItems.push([`dock button ${i}`, box(e.getBoundingClientRect())]));
          const haHits = haItems.filter(([, r]) => haHitsRect(r)).map(([n]) => n);
          return {
            turnHits,
            dialHits,
            hands: {
              box: haBox, lineH: haLineH, contentH: haContentH, kwHidden, hits: haHits,
            },
            cam: {
              box: cbBox, lineH, titleH, camTop, camBottom,
              visible: !cb.hidden,
            },
            speed,
            speedText: speedEl.textContent,
            theme: document.documentElement.dataset.theme,
            scrollW: document.documentElement.scrollWidth,
            innerW: window.innerWidth,
            innerH: window.innerHeight,
            hits,
          };
        });
        check(`${tag} 테마 적용`, m.theme === theme, `html[data-theme]=${m.theme}`);
        check(`${tag} 가로 스크롤 없음`, m.scrollW <= m.innerW, `scrollWidth ${m.scrollW} / innerWidth ${m.innerW}`);
        const s = m.speed;
        const inside = s.l >= 0 && s.t >= 0 && s.r <= m.innerW && s.b <= m.innerH;
        check(`${tag} 속도 요소 뷰포트 내 완전 노출`, inside,
          `text=${m.speedText} box ${Math.round(s.l)},${Math.round(s.t)}-${Math.round(s.r)},${Math.round(s.b)}`);
        check(`${tag} 속도(3자리) 겹침 없음`, m.hits.length === 0, m.hits.join(', ') || 'none');
        check(`${tag} 방향지시등·속도 단위 vs 트랙 세로바/LED/G미터 겹침 없음`, m.turnHits.length === 0, m.turnHits.join(', ') || 'none');
        if (vp.w === 390 && vp.h === 844 && theme === 'minimal') {
          check(`${tag} 3자리 속도 폭 >= 250px`, s.w >= 250, `width ${Math.round(s.w)}px`);
        }
        // §13.4 (a) 링 게이지: 링(선 두께 포함)이 상태줄·출력 바와 8px 이상 떨어짐
        if (theme === 'dial') {
          check(`${tag} 링 외곽 vs 상태줄/출력 바 (8px 여백)`, m.dialHits !== null && m.dialHits.length === 0,
            m.dialHits === null ? 'dial 미표시' : (m.dialHits.join(', ') || 'none'));
        }
        // §13.4 (b) 카메라 배너 제목은 한 줄, 배너는 화면 안
        check(`${tag} 카메라 배너 제목 1줄`, m.cam.titleH <= m.cam.lineH * 1.3,
          `titleH ${Math.round(m.cam.titleH)}px / lineH ${Math.round(m.cam.lineH)}px`);
        const cbIn = m.cam.box.l >= 0 && m.cam.box.t >= 0 && m.cam.box.r <= m.innerW && m.cam.box.b <= m.innerH;
        check(`${tag} 카메라 배너 화면 안`, cbIn,
          `box ${Math.round(m.cam.box.l)},${Math.round(m.cam.box.t)}-${Math.round(m.cam.box.r)},${Math.round(m.cam.box.b)}`);
        // §13.6 핸들 경고: 한 줄, 화면 안, 비교차. 세로에서는 kW 블록이 숨겨져 있어야 한다.
        check(`${tag} 핸들 경고 한 줄`, m.hands.contentH <= m.hands.lineH * 1.3,
          `contentH ${Math.round(m.hands.contentH)}px / lineH ${Math.round(m.hands.lineH)}px`);
        const hb = m.hands.box;
        check(`${tag} 핸들 경고 화면 안`, hb.l >= 0 && hb.t >= 0 && hb.r <= m.innerW && hb.b <= m.innerH,
          `box ${Math.round(hb.l)},${Math.round(hb.t)}-${Math.round(hb.r)},${Math.round(hb.b)}`);
        check(`${tag} 핸들 경고 vs kW/트랙 내부/카메라 배너/독 버튼 비교차`, m.hands.hits.length === 0,
          m.hands.hits.join(', ') || 'none');
        if (vp.h > vp.w) {
          check(`${tag} 세로: 핸들 경고 중 kW 블록 숨김`, m.hands.kwHidden, m.hands.kwHidden ? 'hidden' : 'visible');
        }
        // §13.4 (c) 트랙: 카메라 배너 vs SHIFT/PK (LONG-G 는 추가 확인)
        if (theme === 'track') {
          check(`${tag} 카메라 배너 vs SHIFT/PK 비교차`, m.cam.camTop.length === 0, m.cam.camTop.join(', ') || 'none');
          check(`${tag} 카메라 배너 vs LONG-G 비교차`, m.cam.camBottom.length === 0, m.cam.camBottom.join(', ') || 'none');
        }
        check(`${tag} 콘솔 에러 0`, errors.length === 0, errors.slice(0, 3).join(' | '));
      }

      if (vp.w === 390 && vp.h === 844) {
        // 내연기관 worklet 로드 (AudioWorklet addModule 성공 여부)
        await page.click('.dock [data-act="settings"]');
        await page.click('#sheet-settings button[data-sound="v8"]');
        await page.click('#sheet-settings .x');
        let audioState = '';
        for (let i = 0; i < 50; i++) {
          audioState = await page.evaluate(() => document.documentElement.dataset.audio || '');
          if (audioState === 'ready' || audioState === 'error') break;
          await page.waitForTimeout(100);
        }
        check('AudioWorklet 로드 (engine-worklet.js addModule)', audioState === 'ready', `audio=${audioState}`);
        await page.click('.dock [data-act="settings"]');
        await page.click('#sheet-settings button[data-sound="off"]');
        await page.click('#sheet-settings .x');
      }
      check(`뷰포트 ${vp.w}x${vp.h} 전체 콘솔 에러 0`, errors.length === 0, errors.slice(0, 3).join(' | '));
      if (externalFailures.length) results.push(`INFO  외부 리소스 로드 실패 ${externalFailures.length}건(샌드박스 네트워크, 무시)`);

      await ctx.close();
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
  }

  console.log(results.join('\n'));
  console.log(`\n${failures.length === 0 ? 'SMOKE PASS' : `SMOKE FAIL (${failures.length})`}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('SMOKE ERROR:', err);
  process.exitCode = 1;
});
