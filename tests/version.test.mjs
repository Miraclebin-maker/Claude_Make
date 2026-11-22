// 버전·캐시 일관성 (§15.1, §15.5). sw.js 는 모듈이 아니므로 텍스트로 읽어 비교한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, APP_FILES } from '../app/js/version.js';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', 'app');
const sw = readFileSync(join(appDir, 'sw.js'), 'utf8');

function swShell() {
  const m = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(m, 'sw.js 에 SHELL 목록이 있어야 한다');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsFiles(p));
    else if (name.endsWith('.js')) out.push(relative(appDir, p));
  }
  return out;
}

test('sw.js 캐시 이름이 APP_VERSION 과 같다', () => {
  const m = sw.match(/const CACHE = 'tsl-shell-([^']+)';/);
  assert.ok(m, 'CACHE 상수가 있어야 한다');
  assert.equal(m[1], APP_VERSION);
});

test('sw.js 는 설치 때 reload, 요청 때 no-cache 로 받는다', () => {
  assert.ok(sw.includes("cache: 'reload'"), "install 에 cache: 'reload' 가 있어야 한다");
  assert.ok(sw.includes("cache: 'no-cache'"), "fetch 에 cache: 'no-cache' 가 있어야 한다");
});

test('셸 목록은 앱 파일 전체를 포함한다 (js 파일 누락 없음)', () => {
  const shell = new Set(swShell());
  for (const f of jsFiles(join(appDir, 'js'))) {
    assert.ok(shell.has(`./${f}`), `sw.js SHELL 에 ./${f} 가 없다`);
  }
  for (const f of APP_FILES) {
    assert.ok(shell.has(f), `sw.js SHELL 에 ${f} 가 없다 (APP_FILES 와 불일치)`);
  }
});
