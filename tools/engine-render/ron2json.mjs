// .esc (RON) 엔진 프리셋을 JSON 으로 옮긴다. 원본 enginesound 의 .esc 는 RON 형식이다.
// 지원 문법: (name: value, ...) 구조체, (value, ...) 튜플(배열로 취급), [ ... ] 배열, 숫자, true/false, // 주석.
// 사용: node ron2json.mjs <in.esc> <out.json>

export function parseRon(text) {
  const src = text.replace(/\/\/[^\n]*/g, ''); // 줄 끝 주석 제거
  let i = 0;

  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };

  const expect = (ch) => {
    ws();
    if (src[i] !== ch) throw new Error(`RON: expected '${ch}' at ${i}, got '${src[i]}'`);
    i++;
  };

  const ident = () => {
    ws();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };

  function value() {
    ws();
    const ch = src[i];
    if (ch === '(') return compound();
    if (ch === '[') return array();
    const m = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (m) {
      i += m[0].length;
      return Number(m[0]);
    }
    const word = ident();
    if (word === 'true') return true;
    if (word === 'false') return false;
    throw new Error(`RON: unexpected token at ${i}: '${src.slice(i, i + 20)}'`);
  }

  function array() {
    expect('[');
    const out = [];
    ws();
    while (src[i] !== ']') {
      out.push(value());
      ws();
      if (src[i] === ',') { i++; ws(); }
    }
    i++;
    return out;
  }

  function compound() {
    expect('(');
    ws();
    if (src[i] === ')') { i++; return {}; }
    // 이름 있는 필드인지 확인 (ident 다음에 ':')
    const save = i;
    const first = ident();
    ws();
    if (first !== null && src[i] === ':') {
      const obj = {};
      i = save;
      while (true) {
        ws();
        if (src[i] === ')') { i++; break; }
        const name = ident();
        if (name === null) throw new Error(`RON: field name expected at ${i}`);
        expect(':');
        obj[name] = value();
        ws();
        if (src[i] === ',') { i++; }
      }
      return obj;
    }
    // 튜플: 값 목록을 배열로
    i = save;
    const out = [];
    while (true) {
      ws();
      if (src[i] === ')') { i++; break; }
      out.push(value());
      ws();
      if (src[i] === ',') i++;
    }
    return out;
  }

  const result = value();
  ws();
  if (i < src.length) throw new Error(`RON: trailing data at ${i}`);
  return result;
}

// 직접 실행 시 CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const [, , input, output] = process.argv;
  if (!input || !output) {
    console.error('usage: node ron2json.mjs <in.esc> <out.json>');
    process.exit(2);
  }
  const obj = parseRon(readFileSync(input, 'utf8'));
  writeFileSync(output, JSON.stringify(obj, null, 2) + '\n');
  console.log(`wrote ${output}`);
}
