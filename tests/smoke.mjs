// Playwright 스모크 테스트 (설계 10.3, §13.4, §14.4).
// 실행: node tests/smoke.mjs   (app/ 을 python3 -m http.server 로 띄운 뒤 Chromium 으로 검사)
// Playwright 모듈 해석 순서: import('playwright') -> env PLAYWRIGHT_MODULE -> 전역 설치 경로.
// playwright install 은 실행하지 않는다 (시스템 Chromium 사용).
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const appDir = join(root, 'app');
const screensDir = join(here, 'screens');
const PORT = Number(process.env.SMOKE_PORT || 8765);
const BASE = `http://127.0.0.1:${PORT}`;

// §14.4: 실기기 브라우저 주소창·하단바를 뺀 크기 포함
const VIEWPORTS = [
  { w: 390, h: 844 },
  { w: 844, h: 390 },
  { w: 360, h: 640 },
  { w: 640, h: 360 },
  { w: 412, h: 780 },
  { w: 780, h: 340 },
  { w: 1000, h: 460 }, // 실기기 가로 전체화면 (§16.1)
];
const THEMES = ['minimal', 'plaid', 'arc', 'twin', 'hud'];
const SVG_THEMES = ['arc', 'twin', 'hud'];

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
  return spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', appDir], {
    stdio: 'ignore',
  });
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

// §14.4 정적 검사: v1 잔재(내연기관 워클릿, RPM 모델, v8/gt6, 삭제된 테마)가 app/ 에 없어야 한다.
function staticLeftovers() {
  const pat = /engine-worklet|\bv8\b|\bgt6\b|'dial'|'track'|'night'|'motor'|'turbine'|ev-params/;
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!['.js', '.css', '.html', '.webmanifest'].includes(extname(name)) && name !== 'sw.js') continue;
      const text = readFileSync(p, 'utf8');
      if (pat.test(text)) hits.push(p.slice(root.length + 1));
    }
  };
  walk(appDir);
  return hits;
}

// 측정 (브라우저 안). 값은 모두 viewport 좌표계의 px.
function measureScript() {
  const box = (r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height });
  const rectOf = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return null;
    const r = box(el.getBoundingClientRect());
    return r.w > 0 && r.h > 0 ? r : null;
  };
  const hit = (a, b) => !!a && !!b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  const inside = (a, b, tol = 1) => a.l >= b.l - tol && a.r <= b.r + tol && a.t >= b.t - tol && a.b <= b.b + tol;
  const lineCount = (el) => {
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const r = el.getBoundingClientRect();
    return { lines: (r.height - pad) / lh, lh, h: r.height - pad };
  };
  return { box, rectOf, hit, inside, lineCount };
}

async function measure(page, theme) {
  return page.evaluate(({ src, theme, svgThemes }) => {
    // eslint-disable-next-line no-new-func
    const M = new Function(`return (${src})()`)();
    const { box, rectOf, hit, inside, lineCount } = M;
    const isSvg = svgThemes.includes(theme);
    const out = {
      theme,
      innerW: innerWidth,
      innerH: innerHeight,
      scrollW: document.documentElement.scrollWidth,
      speedText: document.getElementById('val-speed').textContent,
      hits: [],
    };

    // 속도 텍스트 rect
    let speedRect;
    if (isSvg) {
      speedRect = rectOf(document.getElementById('fx-speed'));
    } else {
      const speedEl = document.getElementById('val-speed');
      // 가로: 실제 글자 폭(Range). 세로: 요소 박스(줄 높이 기준)
      const rg = document.createRange();
      rg.selectNodeContents(speedEl);
      const tr = box(rg.getBoundingClientRect());
      const eb = box(speedEl.getBoundingClientRect());
      speedRect = { l: tr.l, r: tr.r, t: eb.t, b: eb.b, w: tr.w, h: eb.h };
    }
    out.speed = speedRect;

    // 겹침 후보
    const cands = isSvg
      ? ['#fx-unit', '#fx-limit', '#fx-turnl', '#fx-turnr', '#fx-kw', '#fx-kwfr']
      : ['#turn-l', '#turn-r', '#limit', '#kw-block', '.speed-meta'];
    out.speedHits = [];
    for (const q of cands) {
      const r = rectOf(document.querySelector(q));
      if (r && hit(speedRect, r)) out.speedHits.push(q);
    }
    // 카메라 배너·핸들 경고는 속도 텍스트와도 겹치면 안 된다
    const cbR = rectOf(document.getElementById('cam-banner'));
    const haR = rectOf(document.getElementById('hands-alert'));
    out.cam = cbR;
    out.hands = haR;
    if (cbR && hit(speedRect, cbR)) out.speedHits.push('#cam-banner');
    if (haR && hit(speedRect, haR)) out.speedHits.push('#hands-alert');
    out.speedInViewport = speedRect.l >= 0 && speedRect.t >= 0 && speedRect.r <= innerWidth && speedRect.b <= innerHeight;

    // 카메라 배너 제목 줄 수 (§13.4 b)
    if (cbR) {
      const title = document.querySelector('#cam-banner .cam-title');
      out.camTitle = lineCount(title);
    }
    // 핸들 경고 한 줄 (§13.6)
    if (haR) {
      out.handsLines = lineCount(document.getElementById('hands-alert'));
      const kw = rectOf(document.getElementById('kw-block'));
      const hitsH = [];
      const others = ['#kw-block', '#cam-banner', '#fx-speed', '#fx-unit', '#fx-kw', '#fx-kwfr', '#fx-limit', '#fx-turnl', '#fx-turnr'];
      for (const q of others) {
        const r = rectOf(document.querySelector(q));
        if (r && hit(haR, r)) hitsH.push(q);
      }
      for (const b of document.querySelectorAll('.dock button')) {
        const r = rectOf(b);
        if (r && hit(haR, r)) hitsH.push(`dock ${b.id || b.dataset.act}`);
      }
      out.handsHits = hitsH;
      out.kwVisible = !!kw;
    }

    // 전체화면 버튼: 화면 안, 다른 버튼과 비교차
    const fs = rectOf(document.getElementById('btn-fs'));
    out.fs = { enabled: document.fullscreenEnabled, box: fs, hits: [] };
    if (fs) {
      for (const b of document.querySelectorAll('.dock button')) {
        if (b.id === 'btn-fs') continue;
        const r = rectOf(b);
        if (r && hit(fs, r)) out.fs.hits.push(b.id || b.dataset.act);
      }
    }

    if (isSvg && innerWidth > innerHeight) {
      // 가로 최소 크기 (§ 780x340 기준): 화면 픽셀로 환산해 잰다
      const fxEl = document.getElementById('fx');
      const scale = fxEl.getScreenCTM().a;
      const sizes = {};
      const labs = [...document.querySelectorAll('#fx .scale-n')];
      sizes.scalePx = labs.length ? Math.min(...labs.map((e) => parseFloat(getComputedStyle(e).fontSize) * scale)) : null;
      const spEl = document.getElementById('fx-speed');
      const spCs = getComputedStyle(spEl);
      const ctx2d = document.createElement('canvas').getContext('2d');
      ctx2d.font = `${spCs.fontWeight} ${parseFloat(spCs.fontSize) * scale}px ${spCs.fontFamily}`;
      const mt = ctx2d.measureText('0123456789');
      // 숫자 잉크 높이 (실제 글자 윤곽 기준)
      sizes.speedInkPx = mt.actualBoundingBoxAscent + mt.actualBoundingBoxDescent;
      const tl = rectOf(document.getElementById('fx-turnl'));
      const tr = rectOf(document.getElementById('fx-turnr'));
      sizes.turnPx = Math.min(tl ? tl.w : 0, tr ? tr.w : 0);
      const ln = document.getElementById('fx-limit-n');
      sizes.limitPx = rectOf(document.getElementById('fx-limit')) ? parseFloat(getComputedStyle(ln).fontSize) * scale : null;
      out.sizes = sizes;
    }
    if (isSvg) {
      // 속도 상자 vs 모든 눈금 숫자 (arc, twin)
      const sr = rectOf(document.getElementById('fx-speed'));
      out.scaleHits = [];
      document.querySelectorAll('#fx .scale-n').forEach((e, i) => {
        const r = rectOf(e);
        if (r && sr && hit(sr, r)) out.scaleHits.push(`scale ${e.textContent}`);
      });
      // 출력 아크 안쪽 원 (화면 좌표): 중심 = 아크 중심, 반지름 = (powerR - 10) 단위 (안쪽 가장자리 4 + 여유 6)
      const arcEl = document.querySelector('#fx .arc-track');
      if (arcEl && sr) {
        const ctm = document.getElementById('fx').getScreenCTM();
        const ccx = ctm.a * Number(arcEl.dataset.cx) + ctm.e;
        const ccy = ctm.d * Number(arcEl.dataset.cy) + ctm.f;
        const rad = (Number(arcEl.dataset.r) - 10) * ctm.a;
        const corners = [[sr.l, sr.t], [sr.r, sr.t], [sr.l, sr.b], [sr.r, sr.b]];
        out.arcCorner = { maxDist: Math.max(...corners.map(([x, y]) => Math.hypot(x - ccx, y - ccy))), limit: rad };
      }
    }
    if (isSvg) {
      const fx = rectOf(document.getElementById('fx'));
      const cl = box(document.getElementById('cluster').getBoundingClientRect());
      out.fxBox = fx;
      out.clusterBox = cl;
      // 게이지 구성 요소(보이는 것)의 합집합 가로 중심과 클러스터 가로 중심의 차이 (폭 대비)
      if (innerWidth > innerHeight) {
        let u = null;
        document.getElementById('fx').querySelectorAll('*').forEach((e) => {
          if (e.closest('defs')) return;
          const r = rectOf(e);
          if (!r) return;
          u = u ? { l: Math.min(u.l, r.l), r: Math.max(u.r, r.r) } : { l: r.l, r: r.r };
        });
        out.centerErr = u ? Math.abs((u.l + u.r) / 2 - (cl.l + cl.r) / 2) / (cl.r - cl.l) : null;
      }
      out.fxInCluster = !!fx && inside(fx, cl);
      out.fxSpeedInFx = !!fx && !!speedRect && inside(speedRect, fx);
    }

    if (theme === 'minimal' || theme === 'plaid') {
      out.portrait = innerHeight > innerWidth;
      out.kwHiddenWhileHands = !!haR ? !rectOf(document.getElementById('kw-block')) : null;
    }
    return out;
  }, { src: measureScript.toString(), theme, svgThemes: SVG_THEMES });
}

async function main() {
  const chromium = await loadPlaywright();
  mkdirSync(screensDir, { recursive: true });
  // 이전 버전(다이얼/트랙/나이트) 스크린샷은 남기지 않는다
  for (const f of readdirSync(screensDir)) {
    if (/^(dial|track|night)-/.test(f)) unlinkSync(join(screensDir, f));
  }
  const server = startServer();
  const results = [];
  const failures = [];
  const check = (name, ok, detail = '') => {
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    if (!ok) failures.push(name);
  };

  const leftovers = staticLeftovers();
  check('정적: app/ 에 v1 잔재(워클릿·RPM·v8/gt6·삭제 테마) 없음', leftovers.length === 0, leftovers.join(', ') || 'none');
  const swText = readFileSync(join(appDir, 'sw.js'), 'utf8');
  check("정적: sw.js 에 cache: 'no-cache' 와 cache: 'reload'", swText.includes("cache: 'no-cache'") && swText.includes("cache: 'reload'"));
  const idxText = readFileSync(join(appDir, 'index.html'), 'utf8');
  check('정적: 카메라 DB 안내 문구 교체 (CSV 파일: 한 줄에 …)', idxText.includes('CSV 파일: 한 줄에 위도,경도,제한속도'));

  let browser;
  try {
    await waitForServer();
    browser = await chromium.launch();

    for (const vp of VIEWPORTS) {
      const vpTag = `${vp.w}x${vp.h}`;
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
      // 화면 켜짐(Wake Lock) 권한: 헤드리스 기본값은 거부라서 허용해 둔다 (실기기는 권한 없이도 요청 가능)
      try { await ctx.grantPermissions(['screen-wake-lock']); } catch (e) { /* 이 빌드에 없는 권한 이름 */ }
      const page = await ctx.newPage();
      // 회전 잠금을 거부해 CSS 회전 대체 경로를 탄다 (헤드리스는 잠금이 빈 동작으로 성공하므로, §19.3)
      await page.addInitScript(() => {
        try {
          Object.defineProperty(screen.orientation, 'lock', { value: () => Promise.reject(new DOMException('blocked', 'NotSupportedError')), configurable: true });
        } catch (e) { /* 미지원 */ }
      });
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

      // §16.2 경고음 기본 OFF (저장값 없음), §16.3 화면 켜짐 상태 표시
      await page.waitForTimeout(300);
      const boot16 = await page.evaluate(() => ({
        chimeBtn: document.getElementById('btn-chime').textContent,
        chimeSaved: localStorage.getItem('tsl_chime'),
        wake: document.getElementById('wake-status').textContent,
        hasWakeLock: 'wakeLock' in navigator,
      }));
      check(`${vpTag} 경고음 기본값 OFF (저장값 없음)`, boot16.chimeBtn === '경고음: OFF' && boot16.chimeSaved === null,
        `${boot16.chimeBtn} saved=${boot16.chimeSaved}`);
      const wakeExpect = boot16.hasWakeLock ? '사용 중' : '이 브라우저는 지원하지 않음';
      check(`${vpTag} 화면 켜짐 상태 표시 (${wakeExpect})`, boot16.wake === wakeExpect, `status="${boot16.wake}"`);

      if (vp.w === 390 && vp.h === 844) {
        // 경고음 ON 저장 -> 새로고침 후에도 유지 -> OFF
        await page.click('.dock [data-act="settings"]');
        await page.click('#btn-chime');
        await page.waitForTimeout(150);
        check('경고음 ON 저장 (tsl_chime=1)', (await page.evaluate(() => localStorage.getItem('tsl_chime'))) === '1');
        const reloadedChime = page.waitForEvent('load', { timeout: 20000 });
        await page.reload();
        await reloadedChime;
        await page.waitForSelector('#val-speed');
        await page.waitForTimeout(200);
        check('경고음 ON 저장값 다음 실행에도 유지', (await page.evaluate(() => document.getElementById('btn-chime').textContent)) === '경고음: ON');
        await page.click('.dock [data-act="settings"]');
        await page.click('#btn-chime');
        await page.waitForTimeout(150);
        check('경고음 OFF 저장 (tsl_chime=0)', (await page.evaluate(() => localStorage.getItem('tsl_chime'))) === '0');
        await page.click('#sheet-settings .x');
      }

      // 데모 시작: 설정 시트 -> 데모 -> 시트 닫기
      await page.click('.dock [data-act="settings"]');
      await page.click('#btn-demo');
      await page.click('#sheet-settings .x');

      for (const theme of THEMES) {
        const tag = `${theme} ${vpTag}`;
        await page.click('.dock [data-act="settings"]');
        await page.click(`#sheet-settings button[data-theme="${theme}"]`);
        await page.click('#sheet-settings .x');
        // 속도 ≥100 이고 카메라 배너·핸들 경고가 함께 떠 있는 순간을 잡아 바로 측정·촬영한다.
        // 경고 창은 데모 한 주기 안의 약 1.2초뿐이고, 테마 전환 직후에는 창이 이미 지났을 수 있다.
        // 그래서 측정에 경고가 안 보이면 다음 창까지 기다려 최대 4회 다시 잡는다(검사 완화 아님: 측정값에 표시가 없으면 실패).
        let m = null;
        for (let attempt = 0; attempt < 4 && !(m && m.hands && m.cam); attempt++) {
          await page.waitForFunction(
            () => !document.getElementById('cam-banner').hidden && !document.getElementById('hands-alert').hidden
              && Number(document.getElementById('val-speed').textContent) >= 100,
            null, { timeout: 25000, polling: 'raf' });
          m = await measure(page, theme);
          if (m.hands && m.cam) {
            await page.screenshot({ path: join(screensDir, `${theme}-${vpTag}.png`) });
          }
        }
        check(`${tag} 측정 시점에 핸들 경고·카메라 배너 표시`, !!(m && m.hands && m.cam), `hands ${!!(m && m.hands)} cam ${!!(m && m.cam)}`);
        const applied = await page.evaluate(() => document.documentElement.dataset.theme);
        check(`${tag} 테마 적용`, applied === theme, `html[data-theme]=${applied}`);
        check(`${tag} 가로 스크롤 없음`, m.scrollW <= m.innerW, `scrollWidth ${m.scrollW} / innerWidth ${m.innerW}`);
        check(`${tag} 속도 요소 뷰포트 내 완전 노출`, m.speedInViewport,
          `text=${m.speedText} box ${Math.round(m.speed.l)},${Math.round(m.speed.t)}-${Math.round(m.speed.r)},${Math.round(m.speed.b)}`);
        check(`${tag} 속도(3자리) 겹침 없음 (방향지시등·제한속도·kW·단위·카메라/핸들 경고)`, m.speedHits.length === 0,
          m.speedHits.join(', ') || 'none');
        if (theme === 'minimal' && vp.w === 390 && vp.h === 844) {
          check(`${tag} 3자리 속도 폭 >= 250px`, m.speed.w >= 250, `width ${Math.round(m.speed.w)}px`);
        }
        // §19.4 방향지시등 크기: 기본 테마는 세로 64px, 가로 72px 이상
        if (theme === 'minimal' || theme === 'plaid') {
          const tb = await page.evaluate(() => {
            const a = document.getElementById('turn-l').getBoundingClientRect();
            const b = document.getElementById('turn-r').getBoundingClientRect();
            return Math.min(a.width, a.height, b.width, b.height);
          });
          const want = vp.w > vp.h ? 72 : 64;
          check(`${tag} 방향지시등 크기 >= ${want}px (§19.4)`, tb >= want - 0.5, `${tb.toFixed(1)}px`);
        }

        // §13.4 (b) 카메라 배너 제목 1줄, 화면 안
        if (m.cam) {
          check(`${tag} 카메라 배너 제목 1줄`, m.camTitle.lines <= 1.3,
            `lines ${m.camTitle.lines.toFixed(2)} (h ${Math.round(m.camTitle.h)}px / lh ${Math.round(m.camTitle.lh)}px)`);
          check(`${tag} 카메라 배너 화면 안`, m.cam.l >= 0 && m.cam.t >= 0 && m.cam.r <= m.innerW && m.cam.b <= m.innerH,
            `box ${Math.round(m.cam.l)},${Math.round(m.cam.t)}-${Math.round(m.cam.r)},${Math.round(m.cam.b)}`);
        }

        // §13.6 핸들 경고: 한 줄, 화면 안, 비교차
        if (m.hands) {
          check(`${tag} 핸들 경고 한 줄`, m.handsLines.lines <= 1.3,
            `lines ${m.handsLines.lines.toFixed(2)}`);
          const hb = m.hands;
          check(`${tag} 핸들 경고 화면 안`, hb.l >= 0 && hb.t >= 0 && hb.r <= m.innerW && hb.b <= m.innerH,
            `box ${Math.round(hb.l)},${Math.round(hb.t)}-${Math.round(hb.r)},${Math.round(hb.b)}`);
          check(`${tag} 핸들 경고 vs kW/SVG 속도·단위·kW·표지·방향지시등/카메라 배너/독 버튼 비교차`,
            m.handsHits.length === 0, m.handsHits.join(', ') || 'none');
          if (m.portrait && !SVG_THEMES.includes(theme)) {
            check(`${tag} 세로: 핸들 경고 중 kW 블록 숨김`, m.kwHiddenWhileHands === true,
              `kwHidden=${m.kwHiddenWhileHands}`);
          }
        }

        // §14.3 전체화면 버튼
        check(`${tag} 전체화면 버튼 화면 안`, !m.fs.enabled || (!!m.fs.box && m.fs.box.l >= 0 && m.fs.box.t >= 0
          && m.fs.box.r <= m.innerW && m.fs.box.b <= m.innerH), m.fs.box ? 'visible' : 'hidden/unsupported');
        check(`${tag} 전체화면 버튼 vs 다른 버튼 비교차`, m.fs.hits.length === 0, m.fs.hits.join(', ') || 'none');

        // §16.1 가로 중심 정렬 (arc·twin): 게이지 묶음 중심과 클러스터 중심의 차이 ≤ 폭의 3%
        if ((theme === 'arc' || theme === 'twin') && vp.w > vp.h) {
          check(`${tag} 게이지 가로 중심 정렬 (폭의 3% 이내)`, m.centerErr !== null && m.centerErr <= 0.03,
            m.centerErr === null ? 'no svg element' : `차이 ${(m.centerErr * 100).toFixed(2)}%`);
        }
        // §20.2 종료 버튼: 화면 안, 다른 하단 버튼과 겹치지 않음 (모든 뷰포트·테마)
        const exitBox = await page.evaluate(() => {
          const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
          const me = r(document.getElementById('btn-exit'));
          const hit = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
          const others = [...document.querySelectorAll('.dock button')].filter((b) => b.id !== 'btn-exit').map(r);
          return { inside: me.l >= 0 && me.t >= 0 && me.r <= innerWidth && me.b <= innerHeight, overlaps: others.filter((o) => hit(me, o)).length };
        });
        check(`${tag} 종료 버튼 화면 안, 다른 버튼과 비교차 (§20.2)`, exitBox.inside && exitBox.overlaps === 0,
          `inside=${exitBox.inside} overlaps=${exitBox.overlaps}`);

        // 가로 780x340 최소 크기 (신규 SVG 테마)
        if (SVG_THEMES.includes(theme) && vp.w === 780 && vp.h === 340) {
          const z = m.sizes;
          if (z.scalePx !== null) check(`${tag} 눈금 숫자 >= 11px`, z.scalePx >= 11, `${z.scalePx.toFixed(1)}px`);
          check(`${tag} 속도 숫자 높이 >= 60px`, z.speedInkPx >= 60, `${z.speedInkPx.toFixed(1)}px`);
          check(`${tag} 방향지시등 >= 28px`, z.turnPx >= 28, `${z.turnPx.toFixed(1)}px`);
          if (z.limitPx !== null) check(`${tag} 제한속도 숫자 >= 14px`, z.limitPx >= 14, `${z.limitPx.toFixed(1)}px`);
        }

        // 속도 숫자 vs 눈금 숫자 (arc, twin), 속도 숫자 상자 모서리 vs 출력 아크 안쪽 (arc)
        if (theme === 'arc' || theme === 'twin') {
          check(`${tag} 속도 숫자 vs 눈금 숫자 비교차`, m.scaleHits.length === 0, m.scaleHits.join(', ') || 'none');
        }
        if (theme === 'arc' && m.arcCorner) {
          check(`${tag} 속도 숫자 상자 네 모서리가 출력 아크 안쪽(반지름-6) 안`, m.arcCorner.maxDist <= m.arcCorner.limit,
            `max corner ${m.arcCorner.maxDist.toFixed(1)}px / limit ${m.arcCorner.limit.toFixed(1)}px`);
        }

        // §14.4 신규 SVG 테마 (arc, twin, hud)
        if (SVG_THEMES.includes(theme)) {
          check(`${tag} SVG 가 클러스터 영역 안에 완전히 포함`, m.fxInCluster,
            m.fxBox ? `svg ${Math.round(m.fxBox.l)},${Math.round(m.fxBox.t)}-${Math.round(m.fxBox.r)},${Math.round(m.fxBox.b)}` : 'svg 미표시');
          check(`${tag} SVG 내부 속도 text 가 SVG 안에 포함`, m.fxSpeedInFx, `speed ${m.speedText}`);
        }

        check(`${tag} 콘솔 에러 0`, errors.length === 0, errors.slice(0, 3).join(' | '));
      }

      // 음원 4종: 클릭 -> 저장값 -> 선택 표시가 모두 반영되는지. V10 은 루프 17개 디코드까지 기다린다 (§18.3)
      await page.click('.dock [data-act="settings"]');
      for (const key of ['v10', 'zimmer', 'plaid', 'off']) {
        await page.click(`#sheet-settings button[data-sound="${key}"]`);
        if (key === 'v10') {
          await page.waitForFunction(() => document.documentElement.dataset.v10 === 'ready', null, { timeout: 25000 });
          await page.waitForTimeout(500); // 데모가 도는 중에도 소리 경로가 오류 없이 돌아가는지
          const v = await page.evaluate(() => ({ sound: document.documentElement.dataset.sound, v10: document.documentElement.dataset.v10, demo: document.getElementById('btn-demo').textContent }));
          check(`${vpTag} V10: 루프 17개 디코드 완료, 데모 중 사운드 유지`, v.v10 === 'ready' && v.sound === 'v10' && v.demo === '데모 중지', `v10=${v.v10} sound=${v.sound} demo="${v.demo}"`);
          // 가속 사운드 테스트(미리듣기): 누르는 동안 정차 공회전 레브 경로, 떼면 복귀. 오류 없어야 한다.
          await page.locator('#btn-preview').dispatchEvent('pointerdown');
          await page.waitForTimeout(400);
          await page.locator('#btn-preview').dispatchEvent('pointerup');
          await page.waitForTimeout(200);
          const pv = await page.evaluate(() => document.documentElement.dataset.audio || '');
          check(`${vpTag} V10: 미리듣기 누르고 떼기 오류 없음`, pv !== 'error', `audio=${pv}`);
        }
        await page.waitForTimeout(250);
        const st = await page.evaluate((k) => ({
          saved: localStorage.getItem('tsl_sound_profile'),
          on: document.querySelector(`#sheet-settings button[data-sound="${k}"]`).classList.contains('on'),
          audio: document.documentElement.dataset.audio || '',
        }), key);
        check(`${vpTag} 음원 ${key}: 저장값과 선택 표시 반영`, st.saved === key && st.on, `saved=${st.saved} on=${st.on}`);
        if (key !== 'off') check(`${vpTag} 음원 ${key}: 오디오 상태 error 아님`, st.audio !== 'error', `audio=${st.audio}`);
      }

      // §15.1/15.2/15.3: 설정 시트 "앱" 섹션 — 버전, 새로고침, 종료 버튼이 보이고 다른 버튼과 겹치지 않는다
      const appBtn = page.locator('[data-act="refresh-app"]');
      await appBtn.scrollIntoViewIfNeeded();
      const appLayout = await page.evaluate(() => {
        const r = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
        const hit = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
        const refresh = r(document.querySelector('[data-act="refresh-app"]'));
        const quit = r(document.querySelector('[data-act="quit"]'));
        const sheet = r(document.getElementById('sheet-settings'));
        const others = [...document.querySelectorAll('#sheet-settings button')]
          .filter((b) => !b.matches('[data-act="refresh-app"], [data-act="quit"]'))
          .map((b) => ({ id: b.dataset.act || b.dataset.sound || b.dataset.theme || b.id || b.textContent.trim(), box: r(b) }))
          .filter((o) => o.box.r > o.box.l && o.box.b > o.box.t);
        const hits = others.filter((o) => hit(refresh, o.box) || hit(quit, o.box)).map((o) => o.id);
        return {
          version: document.getElementById('app-version').textContent,
          refreshIn: refresh.l >= 0 && refresh.r <= innerWidth && refresh.t >= sheet.t && refresh.b <= sheet.b + 1,
          quitIn: quit.l >= 0 && quit.r <= innerWidth && quit.t >= sheet.t && quit.b <= sheet.b + 1,
          sameRowHit: hit(refresh, quit),
          hits,
        };
      });
      check(`${vpTag} 설정: 버전 표시 2.5.0`, appLayout.version === '2.5.0', appLayout.version);
      check(`${vpTag} 설정: 새로고침·종료 버튼이 시트 안에 보임`, appLayout.refreshIn && appLayout.quitIn,
        `refresh ${appLayout.refreshIn} quit ${appLayout.quitIn}`);
      check(`${vpTag} 설정: 새로고침·종료 버튼이 서로·다른 버튼과 겹치지 않음`, !appLayout.sameRowHit && appLayout.hits.length === 0,
        appLayout.hits.join(', ') || 'none');

      // §19.7 카메라 DB 다운로드 링크: 보이고, href·새 탭·rel 이 정확하고, 다른 버튼과 겹치지 않는다
      const dbLink = await page.evaluate(() => {
        const a = document.getElementById('cam-db-link');
        const sheet = document.getElementById('sheet-settings');
        a.scrollIntoView({ block: 'center' });
        const r = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
        const hit = (x, y) => x.l < y.r && y.l < x.r && x.t < y.b && y.t < x.b;
        const me = r(a);
        const others = [...sheet.querySelectorAll('button, a')].filter((e) => e !== a).map(r);
        const sb = r(sheet);
        return {
          href: a.getAttribute('href'),
          target: a.getAttribute('target'),
          rel: a.getAttribute('rel'),
          visible: me.r > me.l && me.b > me.t && me.l >= sb.l && me.r <= sb.r && me.t >= sb.t - 1 && me.b <= sb.b + 1,
          overlaps: others.filter((o) => hit(me, o)).length,
        };
      });
      check(`${vpTag} 카메라 DB 링크: href·새 탭·rel 정확, 시트 안에 보임`,
        dbLink.href === 'https://www.data.go.kr/data/15028200/standard.do' && dbLink.target === '_blank'
          && dbLink.rel === 'noopener' && dbLink.visible,
        `href=${dbLink.href} target=${dbLink.target} rel=${dbLink.rel} visible=${dbLink.visible}`);
      check(`${vpTag} 카메라 DB 링크: 다른 버튼과 겹치지 않음`, dbLink.overlaps === 0, `overlaps=${dbLink.overlaps}`);
      await page.evaluate(() => { document.getElementById('sheet-settings').scrollTop = 0; });

      // §19.5 사각지대 오버레이: 데모에서 켜지면 가장자리 글로우가 보이고, 클릭을 막지 않는다
      await page.click('#sheet-settings .x');
      await page.waitForFunction(() => document.getElementById('blind').classList.contains('on-l'), null, { timeout: 25000 });
      const blind = await page.evaluate(() => {
        const edge = document.querySelector('#blind .blind-edge.l');
        const op = parseFloat(getComputedStyle(edge).opacity);
        const topAtLeft = document.elementFromPoint(12, innerHeight / 2);
        const onDock = document.querySelector('.dock [data-act="settings"]').getBoundingClientRect();
        const atDock = document.elementFromPoint(onDock.left + onDock.width / 2, onDock.top + onDock.height / 2);
        return { op, leftInsideBlind: !!(topAtLeft && topAtLeft.closest('#blind')), dockBlocked: !!(atDock && atDock.closest('#blind')) };
      });
      check(`${vpTag} 사각지대 좌측 글로우 보임, 클릭 막지 않음`, blind.op > 0.2 && !blind.leftInsideBlind && !blind.dockBlocked,
        `opacity=${blind.op.toFixed(2)} blockedLeft=${blind.leftInsideBlind} blockedDock=${blind.dockBlocked}`);
      await page.click('.dock [data-act="settings"]');

      // §19.3 화면 방향 전환 버튼: 자동 → 가로 → 세로 → 자동. 잠금이 안 되면 앱 루트를 CSS로 돌린다.
      // 가로 강제 (실기기가 세로일 때): 레이아웃 박스가 가로형, 화면 안에 보임, 가로 SVG 규칙 적용, 설정 시트가 열린다
      await page.click('#sheet-settings .x');
      await page.click('#btn-orient'); // 자동 -> 가로
      await page.waitForTimeout(400);
      const landOrient = await page.evaluate(() => {
        const app = document.getElementById('app');
        const r = app.getBoundingClientRect();
        return {
          lw: app.offsetWidth, lh: app.offsetHeight, rot: app.classList.contains('rot'),
          inside: r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
          vb: document.getElementById('fx').getAttribute('viewBox'), vw: innerWidth, vh: innerHeight,
        };
      });
      check(`${vpTag} 방향 가로: 레이아웃 박스가 가로형, 화면 안`, landOrient.lw > landOrient.lh && landOrient.inside,
        `box ${landOrient.lw}x${landOrient.lh} rot=${landOrient.rot} inside=${landOrient.inside}`);
      if (vp.w < vp.h) {
        // 세로 기기: 가로 요청은 잠금 실패 시 CSS 회전이어야 한다 (잠금 성공이면 그대로)
        check(`${vpTag} 방향 가로 강제: 세로 기기에서 CSS 회전 또는 잠금`, landOrient.rot || landOrient.lw > landOrient.lh,
          `rot=${landOrient.rot}`);
      }
      if (landOrient.lw > landOrient.lh) {
        check(`${vpTag} 방향 가로: 가로 SVG 규칙 적용 (hud viewBox 960x400)`, landOrient.vb === '0 0 960 400', `viewBox=${landOrient.vb}`);
      }
      await page.click('.dock [data-act="settings"]');
      await page.waitForTimeout(200);
      check(`${vpTag} 방향 가로: 설정 시트 열림`, await page.evaluate(() => !document.getElementById('sheet-settings').hidden));
      await page.click('#sheet-settings .x');
      // 세로 강제 (실기기가 가로일 때 세로 요청) 및 자동 복귀
      await page.click('#btn-orient'); // 가로 -> 세로
      await page.waitForTimeout(400);
      const portOrient = await page.evaluate(() => {
        const app = document.getElementById('app');
        return { lw: app.offsetWidth, lh: app.offsetHeight, rot: app.classList.contains('rot') };
      });
      check(`${vpTag} 방향 세로: 레이아웃 박스가 세로형`, portOrient.lw < portOrient.lh, `box ${portOrient.lw}x${portOrient.lh} rot=${portOrient.rot}`);
      await page.click('#btn-orient'); // 세로 -> 자동
      await page.waitForTimeout(300);
      const autoOrient = await page.evaluate(() => ({ rot: document.getElementById('app').classList.contains('rot'), lw: document.getElementById('app').offsetWidth }));
      check(`${vpTag} 방향 자동: 회전 해제, 실제 화면 크기 레이아웃`, !autoOrient.rot && autoOrient.lw === vp.w, `rot=${autoOrient.rot} lw=${autoOrient.lw} vw=${vp.w}`);
      await page.click('.dock [data-act="settings"]'); // 이후 단계는 설정 시트가 열린 상태를 기대한다

      if (vp.w === 390 && vp.h === 844) {
        // §15.2 새로고침: 설정(localStorage) 유지, 이전 캐시 삭제, 다시 로드
        await page.click('#sheet-settings button[data-sound="v10"]');
        await page.waitForTimeout(200);
        const loaded = page.waitForEvent('load', { timeout: 20000 });
        await page.locator('[data-act="refresh-app"]').click();
        await loaded;
        await page.waitForSelector('#val-speed');
        const after = await page.evaluate(async () => ({
          saved: localStorage.getItem('tsl_sound_profile'),
          keys: await caches.keys(),
        }));
        check('새로고침: 설정 유지 (사운드 v10 저장값)', after.saved === 'v10', `saved=${after.saved}`);
        check('새로고침: 이전 버전 캐시 없음 (현재 버전 캐시만)', after.keys.every((k) => k === 'tsl-shell-2.5.0'),
          after.keys.join(', ') || 'none');

        // §15.3 종료: 모든 기능 정지, 오버레이 표시, 다시 시작으로 정상 복귀
        await page.click('.dock [data-act="settings"]');
        await page.locator('[data-act="quit"]').click();
        await page.waitForFunction(() => !document.getElementById('quit-overlay').hidden, null, { timeout: 5000 });
        const q = await page.evaluate(() => ({
          audio: document.documentElement.dataset.audio || '',
          demo: document.getElementById('btn-demo').textContent,
          title: document.querySelector('#quit-overlay h2').textContent,
        }));
        check('종료: 오버레이 표시, 오디오 컨텍스트 closed', q.audio === 'closed' && q.title === '종료되었습니다', `audio=${q.audio}`);
        check('종료: 데모 중지 상태', q.demo === '데모 시작', `demo button="${q.demo}"`);
        const restarted = page.waitForEvent('load', { timeout: 20000 });
        await page.locator('#quit-overlay [data-act="restart"]').click();
        await restarted;
        await page.waitForSelector('#val-speed');
        const back = await page.evaluate(() => document.getElementById('quit-overlay').hidden);
        check('다시 시작: 오버레이 닫히고 앱 정상 로드', back === true, `hidden=${back}`);
      }
      // §20.1 세로 상단 여백: 세로 뷰포트에서 탭(기본), 전체화면(is-fullscreen 강제)을 비교한다
      const isPortrait = vp.h > vp.w;
      // 헤드리스는 첫 클릭으로 전체화면에 들어갈 수 있으므로, 탭 상태를 명시적으로 만든다
      await page.evaluate(() => document.documentElement.classList.remove('is-fullscreen'));
      await page.waitForTimeout(50);
      const topTab = await page.evaluate(() => document.getElementById('btn-conn').getBoundingClientRect().top);
      await page.evaluate(() => document.documentElement.classList.add('is-fullscreen'));
      await page.waitForTimeout(100);
      const topFs = await page.evaluate(() => ({
        top: document.getElementById('btn-conn').getBoundingClientRect().top,
        clusterTop: document.getElementById('cluster').getBoundingClientRect().top,
        clusterBottom: document.getElementById('cluster').getBoundingClientRect().bottom,
        statusBottom: document.querySelector('.status').getBoundingClientRect().bottom,
      }));
      await page.evaluate(() => document.documentElement.classList.remove('is-fullscreen'));
      if (isPortrait) {
        check(`${vpTag} 세로 전체화면: 상태줄 top ≥ 32px (§20.1)`, topFs.top >= 32, `top=${topFs.top.toFixed(1)}`);
        check(`${vpTag} 세로 전체화면: 클러스터가 상태줄 아래, 화면 안`, topFs.clusterTop >= topFs.statusBottom - 0.5 && topFs.clusterBottom <= vp.h + 0.5,
          `clusterTop=${topFs.clusterTop.toFixed(1)} statusBottom=${topFs.statusBottom.toFixed(1)}`);
        check(`${vpTag} 세로 탭: 상단 여백 기존 + 8px 이상 (§20.1)`, topTab >= 18 - 0.5, `top=${topTab.toFixed(1)}`);
      } else {
        check(`${vpTag} 가로 전체화면: 상태줄 기존 값 유지 (top ≤ 12px)`, topFs.top <= 12, `top=${topFs.top.toFixed(1)}`);
      }

      // §20.2 종료 버튼: 짧은 탭은 종료하지 않고 안내, 1.1초 길게 누르면 종료 오버레이
      if (!(await page.evaluate(() => document.getElementById('sheet-settings').hidden))) {
        await page.click('#sheet-settings .x');
      }
      await page.click('#btn-exit');
      await page.waitForTimeout(200);
      const tap = await page.evaluate(() => ({
        overlay: !document.getElementById('quit-overlay').hidden,
        toast: document.getElementById('toast-msg').textContent,
      }));
      check(`${vpTag} 종료 버튼 짧은 탭: 종료 안 됨, 안내 토스트`, !tap.overlay && tap.toast.includes('길게 누르면 종료됩니다'),
        `overlay=${tap.overlay} toast="${tap.toast}"`);
      await page.locator('#btn-exit').dispatchEvent('pointerdown');
      await page.waitForTimeout(1100);
      await page.waitForFunction(() => !document.getElementById('quit-overlay').hidden, null, { timeout: 3000 });
      check(`${vpTag} 종료 버튼 1.1초 길게 누르기: 종료 오버레이 표시`, true);

      check(`뷰포트 ${vpTag} 전체 콘솔 에러 0`, errors.length === 0, errors.slice(0, 3).join(' | '));
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
