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
  const pat = /engine-worklet|rpm-model|\bv8\b|\bgt6\b|'dial'|'track'|'night'/;
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

  let browser;
  try {
    await waitForServer();
    browser = await chromium.launch();

    for (const vp of VIEWPORTS) {
      const vpTag = `${vp.w}x${vp.h}`;
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

      // 음원: 신규 2종과 기존 2종을 바꿔 가며 재생 경로 실행 (오류 없어야 함)
      await page.click('.dock [data-act="settings"]');
      for (const key of ['motor', 'turbine', 'zimmer', 'plaid']) {
        await page.click(`#sheet-settings button[data-sound="${key}"]`);
        await page.waitForTimeout(250);
      }
      await page.click('#sheet-settings button[data-sound="off"]');
      await page.click('#sheet-settings .x');
      if (vp.w === 390 && vp.h === 844) {
        check('음원 전환(motor/turbine/zimmer/plaid) 중 상태 error 아님',
          (await page.evaluate(() => document.documentElement.dataset.audio || '')) !== 'error', 'audio status');
      }
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
