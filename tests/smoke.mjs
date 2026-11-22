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
        // 속도가 3자리(>=100)가 된 시점에서 측정
        await page.waitForFunction(() => Number(document.getElementById('val-speed').textContent) >= 100, null, { timeout: 15000 });
        await page.waitForTimeout(250);

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
          return {
            turnHits,
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
        check(`${tag} 콘솔 에러 0`, errors.length === 0, errors.slice(0, 3).join(' | '));
        await page.screenshot({ path: join(screensDir, `${theme}-${vp.w}x${vp.h}.png`) });
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
