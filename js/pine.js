// 붙여 넣은 파인스크립트를 읽어 매매 신호·차트 지표로 만듭니다 ("＋ 신호 추가 / ＋ 지표 추가").
// 코드를 자바스크립트로 실행하지 않습니다: 글자를 직접 읽어(파싱) 정해진 계산(js/ta.js)만 합니다.
// 읽을 수 있는 것: 변수 계산 (=, :=, [a, b] =), input.*, ta.* 지표, 수식·비교·and/or/not, x[1], 삼항식,
//   if / else 안의 strategy.entry · strategy.close, alertcondition, plotshape, plot, hline.
// 못 읽는 것: for/while 반복문, 직접 만든 함수(=>), 배열·테이블, 봉마다 값을 이어 가는 var 계산.
(function () {
  'use strict';
  const TA = window.TA;
  const COLORS = {
    red: '#F23645', green: '#089981', blue: '#2962FF', orange: '#FF9800', yellow: '#FBC02D', purple: '#9C27B0', fuchsia: '#E040FB',
    aqua: '#00BCD4', teal: '#00897B', lime: '#00E676', maroon: '#880E4F', navy: '#311B92', olive: '#808000', silver: '#B2B5BE', gray: '#787B86', white: '#FFFFFF', black: '#363A45',
  };
  const POS = { possize: true }; // strategy.position_size: 보유 여부는 시뮬레이션이 따로 처리 → 조건에서는 항상 맞다고 봄
  class PineError extends Error {}
  const fail = (msg, line) => { throw new PineError(line ? `${line}번째 줄: ${msg}` : msg); };

  // ---------- 글자 → 토큰 ----------
  function stripComment(s) {
    let q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; } else if (c === '"' || c === "'") q = c;
      else if (c === '/' && s[i + 1] === '/') return s.slice(0, i);
    }
    return s;
  }
  function tokenize(s, line) {
    const t = [];
    let i = 0, m;
    while (i < s.length) {
      const c = s[i], rest = s.slice(i);
      if (c === ' ' || c === '\t') { i++; continue; }
      if ((m = /^(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)/.exec(rest))) { t.push({ k: 'num', v: parseFloat(m[1]) }); i += m[1].length; continue; }
      if ((m = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?/.exec(rest))) { t.push({ k: 'str', v: m[0].slice(0, 7) }); i += m[0].length; continue; }
      if ((m = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(rest))) { t.push({ k: 'id', v: m[0] }); i += m[0].length; continue; }
      if (c === '"' || c === "'") {
        let j = i + 1, v = '';
        while (j < s.length && s[j] !== c) { if (s[j] === '\\') j++; v += s[j++]; }
        if (j >= s.length) fail('따옴표가 닫히지 않았습니다', line);
        t.push({ k: 'str', v }); i = j + 1; continue;
      }
      if ((m = /^(:=|=>|==|!=|<=|>=|\+=|-=|\*=|\/=|[-+*/%<>?:=(),[\]])/.exec(rest))) { t.push({ k: 'op', v: m[1] }); i += m[1].length; continue; }
      fail(`읽을 수 없는 글자 '${c}'`, line);
    }
    return t;
  }

  // ---------- 토큰 → 식 ----------
  function parseExpr(toks, line) {
    let p = 0;
    const peek = (v, k) => { const x = toks[p]; return x && (v == null || x.v === v) && (k == null || x.k === k) ? x : null; };
    const isOp = v => { const x = toks[p]; return x && x.k !== 'str' && x.v === v; };
    const eat = v => { if (!isOp(v)) fail(`'${v}'가 있어야 합니다`, line); p++; };
    function primary() {
      const x = toks[p++];
      if (!x) fail('식이 끝났습니다', line);
      if (x.k === 'num') return { t: 'num', v: x.v };
      if (x.k === 'str') return { t: 'str', v: x.v };
      if (x.k === 'op' && x.v === '(') { const e = ternary(); eat(')'); return e; }
      if (x.k === 'id') {
        if (isOp('(')) {
          p++;
          const args = [];
          while (!isOp(')')) {
            let name = null;
            if (peek(null, 'id') && toks[p + 1] && toks[p + 1].k === 'op' && toks[p + 1].v === '=') { name = toks[p].v; p += 2; }
            args.push({ name, e: ternary() });
            if (isOp(',')) p++; else break;
          }
          eat(')');
          return { t: 'call', f: x.v, args };
        }
        return { t: 'id', v: x.v };
      }
      fail(`'${x.v}' 자리가 이상합니다`, line);
    }
    function postfix() {
      let e = primary();
      while (isOp('[')) { p++; const k = ternary(); eat(']'); e = { t: 'idx', e, k }; }
      return e;
    }
    function unary() {
      if (isOp('-') || isOp('+')) { const op = toks[p++].v; return { t: 'un', op, e: unary() }; }
      if (peek('not', 'id')) { p++; return { t: 'un', op: 'not', e: unary() }; }
      return postfix();
    }
    const bin = (next, ops) => () => {
      let a = next();
      for (;;) {
        const x = toks[p];
        if (!x || x.k === 'str' || x.k === 'num' || !ops.includes(x.v)) return a;
        p++;
        a = { t: 'bin', op: x.v, a, b: next() };
      }
    };
    const mul = bin(unary, ['*', '/', '%']);
    const add = bin(mul, ['+', '-']);
    const cmp = bin(add, ['<', '>', '<=', '>=']);
    const eq = bin(cmp, ['==', '!=']);
    const and = bin(eq, ['and']);
    const or = bin(and, ['or']);
    function ternary() {
      const c = or();
      if (!isOp('?')) return c;
      p++;
      const a = ternary(); eat(':');
      return { t: 'tern', c, a, b: ternary() };
    }
    const e = ternary();
    if (p < toks.length) fail(`'${toks[p].v}' 뒤를 읽지 못했습니다`, line);
    return e;
  }

  // ---------- 줄 → 문장 (들여쓰기로 if 블록) ----------
  const TYPES = new Set(['var', 'varip', 'float', 'int', 'bool', 'string', 'color', 'series', 'simple', 'const']);
  const CONT_END = /(,|\(|\[|\band|\bor|\bnot|[-+*/?:=<>])\s*$/;
  const CONT_START = /^\s*(and\b|or\b|\?|:(?!=)|[-+*/]|\))/;
  function logicalLines(src) {
    const out = [];
    src.replace(/\r/g, '').split('\n').forEach((raw, i) => {
      const s = stripComment(raw).replace(/\s+$/, '');
      if (!s.trim()) return;
      const prev = out[out.length - 1];
      const depth = prev ? (prev.text.match(/[([]/g) || []).length - (prev.text.match(/[)\]]/g) || []).length : 0;
      if (prev && (depth > 0 || (CONT_END.test(prev.text) && !/=>\s*$/.test(prev.text)) || CONT_START.test(s))) { prev.text += ' ' + s.trim(); return; }
      const ind = (/^[ \t]*/.exec(s)[0]).replace(/\t/g, '    ').length;
      out.push({ line: i + 1, ind, text: s.trim() });
    });
    return out;
  }
  function parseProgram(src) {
    const lines = logicalLines(src);
    let p = 0;
    function block(minInd) {
      const out = [];
      while (p < lines.length && lines[p].ind >= minInd) {
        const L = lines[p++], st = statement(L);
        if (st.t === 'if' || st.t === 'else' || st.t === 'for') {
          if (p < lines.length && lines[p].ind > L.ind) st.body = block(lines[p].ind); else st.body = [];
        } else if (p < lines.length && lines[p].ind > L.ind && st.t !== 'skip') fail('들여쓴 줄을 읽지 못했습니다 (if 아래가 아닌 블록)', lines[p].line);
        out.push(st);
      }
      return out;
    }
    return block(0);
  }
  function statement(L) {
    if (/^\/\/@|^@version/.test(L.text)) return { t: 'skip' };
    let toks = tokenize(L.text, L.line);
    const first = toks[0] && toks[0].v;
    if (first === 'for') {
      const toI = toks.findIndex(x => x.k === 'id' && x.v === 'to'), byI = toks.findIndex(x => x.k === 'id' && x.v === 'by');
      if (!toks[1] || toks[1].k !== 'id' || !toks[2] || toks[2].v !== '=' || toI < 0) fail('for 문은 "for i = 0 to 10" 모양만 읽습니다', L.line);
      return { t: 'for', v: toks[1].v, a: parseExpr(toks.slice(3, toI), L.line), b: parseExpr(toks.slice(toI + 1, byI < 0 ? undefined : byI), L.line), step: byI < 0 ? null : parseExpr(toks.slice(byI + 1), L.line), line: L.line };
    }
    if (['while', 'switch', 'type', 'method', 'import', 'export'].includes(first)) fail(`'${first}' 문장은 아직 읽지 못합니다`, L.line);
    if (toks.some(x => x.k === 'op' && x.v === '=>')) fail('직접 만든 함수(=>)는 아직 읽지 못합니다', L.line);
    if (first === 'if') return { t: 'if', c: parseExpr(toks.slice(1), L.line), text: L.text.slice(2).trim(), line: L.line };
    if (first === 'else') {
      if (toks[1] && toks[1].v === 'if') return { t: 'else', c: parseExpr(toks.slice(2), L.line), text: L.text.replace(/^else\s+if\s*/, ''), line: L.line };
      return { t: 'else', c: null, line: L.line };
    }
    const isVar = toks[0] && toks[0].k === 'id' && (toks[0].v === 'var' || toks[0].v === 'varip');
    while (toks.length > 2 && toks[0].k === 'id' && TYPES.has(toks[0].v)) toks = toks.slice(1);
    const a = toks.findIndex(x => x.k === 'op' && ['=', ':=', '+=', '-=', '*=', '/='].includes(x.v));
    if (a > 0 && toks[a].v !== '=' && toks[a].v !== ':=') fail(`'${toks[a].v}' 계산은 아직 읽지 못합니다`, L.line);
    if (a > 0 && toks[0].k === 'op' && toks[0].v === '[') {
      const names = toks.slice(1, a - 1).filter(x => x.k === 'id').map(x => x.v);
      return { t: 'set', names, e: parseExpr(toks.slice(a + 1), L.line), reassign: false, line: L.line, rhs: L.text.slice(L.text.indexOf('=') + 1).trim() };
    }
    if (a === 1 && toks[0].k === 'id') return { t: 'set', names: [toks[0].v], e: parseExpr(toks.slice(2), L.line), reassign: toks[a].v === ':=', isVar, line: L.line, rhs: L.text.replace(/^[^=]*?:?=\s*/, '') };
    return { t: 'expr', e: parseExpr(toks, L.line), line: L.line };
  }

  // ---------- 계산 (배열 단위) ----------
  const isArr = Array.isArray;
  const truthy = v => v === true || (typeof v === 'number' && v === v && v !== 0);
  const num = v => (v === true ? 1 : v === false ? 0 : v == null ? NaN : v);
  function makeCtx(d) {
    const n = d.close.length;
    const lift = (f, ...xs) => (xs.some(isArr) ? Array.from({ length: n }, (_, i) => f(...xs.map(x => (isArr(x) ? x[i] : x)))) : f(...xs));
    const arr = v => (isArr(v) ? v.map(num) : new Array(n).fill(num(v)));
    const hl2 = lift((h, l) => (h + l) / 2, d.high, d.low);
    const series = {
      open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume, hl2,
      hlc3: lift((h, l, c) => (h + l + c) / 3, d.high, d.low, d.close),
      ohlc4: lift((o, h, l, c) => (o + h + l + c) / 4, d.open, d.high, d.low, d.close),
      hlcc4: lift((h, l, c) => (h + l + 2 * c) / 4, d.high, d.low, d.close),
      bar_index: Array.from({ length: n }, (_, i) => i),
      'ta.tr': TA.tr(d.high, d.low, d.close),
    };
    return { d, n, lift, arr, series, vars: new Map(), plots: [], hlines: [], shapes: [], alerts: [], entries: [], exits: [], meta: {}, notes: new Set(), varDecl: new Set(), inLoop: false };
  }
  const roll = (n, src, len, f) => Array.from({ length: n }, (_, i) => (i < len - 1 ? NaN : f(src.slice(i - len + 1, i + 1))));
  function intArg(v, what, line) {
    if (isArr(v)) { const x = v.filter(y => y === y); v = x[x.length - 1]; }
    v = num(v);
    if (!(v >= 1) || v > 2000) fail(`${what} 길이가 이상합니다 (${v})`, line);
    return Math.round(v);
  }
  const FN = {
    sma: (c, [s, l], L) => TA.sma(c.arr(s), intArg(l, 'sma', L)),
    ema: (c, [s, l], L) => TA.ema(c.arr(s), intArg(l, 'ema', L)),
    rma: (c, [s, l], L) => TA.rma(c.arr(s), intArg(l, 'rma', L)),
    wma: (c, [s, l], L) => TA.wma(c.arr(s), intArg(l, 'wma', L)),
    rsi: (c, [s, l], L) => TA.rsi(c.arr(s), intArg(l, 'rsi', L)),
    stdev: (c, [s, l], L) => TA.stdev(c.arr(s), intArg(l, 'stdev', L)),
    highest: (c, a, L) => (a.length < 2 ? TA.highest(c.d.high, intArg(a[0], 'highest', L)) : TA.highest(c.arr(a[0]), intArg(a[1], 'highest', L))),
    lowest: (c, a, L) => (a.length < 2 ? TA.lowest(c.d.low, intArg(a[0], 'lowest', L)) : TA.lowest(c.arr(a[0]), intArg(a[1], 'lowest', L))),
    change: (c, [s, l = 1], L) => TA.change(c.arr(s), intArg(l, 'change', L)),
    mom: (c, [s, l], L) => TA.change(c.arr(s), intArg(l, 'mom', L)),
    atr: (c, [l], L) => TA.atr(c.d.high, c.d.low, c.d.close, intArg(l, 'atr', L)),
    tr: c => c.series['ta.tr'],
    crossover: (c, [a, b]) => TA.crossover(c.arr(a), c.arr(b)),
    crossunder: (c, [a, b]) => TA.crossunder(c.arr(a), c.arr(b)),
    cross: (c, [a, b]) => TA.cross(c.arr(a), c.arr(b)),
    stoch: (c, [s, h, lo, l], L) => TA.stoch(c.arr(s), c.arr(h), c.arr(lo), intArg(l, 'stoch', L)),
    bb: (c, [s, l, m], L) => ({ tuple: TA.bb(c.arr(s), intArg(l, 'bb', L), num(m)) }),
    macd: (c, [s, f, sl, sg], L) => ({ tuple: TA.macd(c.arr(s), intArg(f, 'macd', L), intArg(sl, 'macd', L), intArg(sg, 'macd', L)) }),
    sum: (c, [s, l], L) => roll(c.n, c.arr(s), intArg(l, 'sum', L), w => w.reduce((x, y) => x + y, 0)),
    vwma: (c, [s, l], L) => { const k = intArg(l, 'vwma', L), v = c.arr(c.d.volume), sv = c.lift((a, b) => a * b, c.arr(s), v); return c.lift((a, b) => a / b, TA.sma(sv, k), TA.sma(v, k)); },
    cci: (c, [s, l], L) => {
      const k = intArg(l, 'cci', L), x = c.arr(s), m = TA.sma(x, k);
      return roll(c.n, x, k, w => w).map((w, i) => { if (!isArr(w)) return NaN; const dev = w.reduce((a, y) => a + Math.abs(y - m[i]), 0) / k; return (x[i] - m[i]) / (0.015 * dev); });
    },
    rising: (c, [s, l], L) => { const x = c.arr(s), k = intArg(l, 'rising', L); return x.map((v, i) => { if (i < k) return false; for (let j = 1; j <= k; j++) if (!(v > x[i - j])) return false; return true; }); },
    falling: (c, [s, l], L) => { const x = c.arr(s), k = intArg(l, 'falling', L); return x.map((v, i) => { if (i < k) return false; for (let j = 1; j <= k; j++) if (!(v < x[i - j])) return false; return true; }); },
    barssince: (c, [cond]) => { let last = -1; return c.arr(cond).map((v, i) => { if (truthy(v)) last = i; return last < 0 ? NaN : i - last; }); },
    valuewhen: (c, [cond, s, occ = 0]) => {
      const x = c.arr(s), hits = [], k = num(occ);
      return c.arr(cond).map((v, i) => { if (truthy(v)) hits.push(x[i]); return hits.length > k ? hits[hits.length - 1 - k] : NaN; });
    },
    pivothigh: (c, a, L) => pivot(c, a, L, true),
    pivotlow: (c, a, L) => pivot(c, a, L, false),
    pwma: (c, [s, l = 14, pw = 2], L) => window.IND.pwma(c.arr(s), intArg(l, 'pwma', L), num(pw)),
  };
  function pivot(c, a, L, hi) {
    const x = a.length >= 3 ? c.arr(a[0]) : hi ? c.d.high : c.d.low;
    const lb = intArg(a.length >= 3 ? a[1] : a[0], 'pivot', L), rb = intArg(a.length >= 3 ? a[2] : a[1], 'pivot', L);
    return x.map((_, i) => {
      const k = i - rb;
      if (k - lb < 0) return NaN;
      const v = x[k];
      for (let j = k - lb; j <= k + rb; j++) if (j !== k && (hi ? x[j] >= v : x[j] <= v)) return NaN;
      return v;
    });
  }
  const MATH = {
    abs: Math.abs, sqrt: Math.sqrt, log: Math.log, exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
    pow: Math.pow, max: Math.max, min: Math.min, avg: (...x) => x.reduce((a, b) => a + b, 0) / x.length,
  };
  const IGNORE = /^(fill|bgcolor|barcolor|plotcandle|plotbar|label\.|line\.|box\.|table\.|runtime\.|log\.|alert$|strategy\.risk\.|strategy\.cancel)/;

  // 식 → 글자 (조건 설명용)
  function unparse(e) {
    switch (e.t) {
      case 'num': return String(e.v);
      case 'str': return JSON.stringify(e.v);
      case 'id': return e.v;
      case 'idx': return `${unparse(e.e)}[${unparse(e.k)}]`;
      case 'un': return e.op === 'not' ? `not ${unparse(e.e)}` : e.op + unparse(e.e);
      case 'bin': return `${unparse(e.a)} ${e.op} ${unparse(e.b)}`;
      case 'tern': return `${unparse(e.c)} ? ${unparse(e.a)} : ${unparse(e.b)}`;
      case 'call': return `${e.f}(${e.args.map(a => (a.name ? a.name + '=' : '') + unparse(a.e)).join(', ')})`;
    }
    return '';
  }
  function argv(c, node, L) {
    const pos = [], named = {};
    node.args.forEach(a => { const v = ev(c, a.e, L); if (a.name) named[a.name] = v; else pos.push(v); });
    return { pos, named };
  }
  const pick = (A, i, name, def) => (A.named[name] !== undefined ? A.named[name] : A.pos[i] !== undefined ? A.pos[i] : def);

  function ev(c, node, L) {
    switch (node.t) {
      case 'num': case 'str': return node.v;
      case 'id': {
        const v = node.v;
        if (c.vars.has(v)) return c.vars.get(v);
        if (v in c.series) return c.series[v];
        if (v === 'true') return true;
        if (v === 'false') return false;
        if (v === 'na') return NaN;
        if (v === 'strategy.position_size' || v === 'strategy.opentrades') return POS;
        if (v.startsWith('color.')) return COLORS[v.slice(6)] || '#787B86';
        if (COLORS[v]) return COLORS[v]; // 버전 3 색 이름 (green, red …)
        if (/^(strategy\.commission\.|strategy\.(long|short|fixed|cash|percent_of_equity)|location\.|shape\.|size\.|plot\.style_|display\.|position\.|format\.|scale\.|hline\.style_|xloc\.|yloc\.|extend\.|text\.|font\.|barmerge\.|timeframe\.period$)/.test(v)) return v;
        return fail(`'${v}'가 무엇인지 모릅니다`, L);
      }
      case 'idx': {
        const v = ev(c, node.e, L), k = num(ev(c, node.k, L));
        if (!isArr(v)) return v;
        return TA.prev(v.map(num), Math.round(k));
      }
      case 'un': {
        const v = ev(c, node.e, L);
        if (node.op === 'not') return c.lift(x => !truthy(x), v);
        return node.op === '-' ? c.lift(x => -num(x), v) : v;
      }
      case 'bin': {
        const a = ev(c, node.a, L), b = ev(c, node.b, L), op = node.op;
        if (a === POS || b === POS) {
          if (['<', '>', '<=', '>=', '==', '!='].includes(op)) return true; // 보유 중엔 다시 사지 않고 보유 중에만 청산하는 건 시뮬레이션이 처리
          fail('strategy.position_size 계산은 읽지 못합니다', L);
        }
        if (op === 'and') return c.lift((x, y) => truthy(x) && truthy(y), a, b);
        if (op === 'or') return c.lift((x, y) => truthy(x) || truthy(y), a, b);
        const f = {
          '+': (x, y) => (typeof x === 'string' ? x + y : num(x) + num(y)), '-': (x, y) => num(x) - num(y), '*': (x, y) => num(x) * num(y), '/': (x, y) => num(x) / num(y), '%': (x, y) => num(x) % num(y),
          '<': (x, y) => num(x) < num(y), '>': (x, y) => num(x) > num(y), '<=': (x, y) => num(x) <= num(y), '>=': (x, y) => num(x) >= num(y),
          '==': (x, y) => (typeof x === 'string' ? x === y : num(x) === num(y)), '!=': (x, y) => (typeof x === 'string' ? x !== y : num(x) !== num(y)),
        }[op];
        return c.lift(f, a, b);
      }
      case 'tern': {
        const cc = ev(c, node.c, L), a = ev(c, node.a, L), b = ev(c, node.b, L);
        return c.lift((x, y, z) => (truthy(x) ? y : z), cc, a, b);
      }
      case 'call': return call(c, node, L);
    }
    return fail('식을 읽지 못했습니다', L);
  }

  function call(c, node, L) {
    const f = node.f;
    if (IGNORE.test(f)) return NaN;
    if (f === 'input' || f.startsWith('input.')) { // 기본값(defval)만 씀
      const a = node.args.find(x => x.name === 'defval') || node.args.find(x => !x.name);
      return a ? ev(c, a.e, L) : fail('input 기본값이 없습니다', L);
    }
    const A = argv(c, node, L);
    if (f === 'nz') return c.lift((x, r) => (x == null || x !== x ? r : x), A.pos[0], A.pos[1] !== undefined ? A.pos[1] : 0);
    if (f === 'na') return c.lift(x => x == null || x !== x, A.pos[0]);
    if (f === 'color.new') return A.pos[0];
    if (f === 'color.rgb') return `rgb(${A.pos.slice(0, 3).map(num).join(',')})`;
    if (f === 'math.sum') return FN.sum(c, A.pos, L);
    if (f.startsWith('math.') && MATH[f.slice(5)]) return c.lift((...x) => MATH[f.slice(5)](...x.map(num)), ...A.pos);
    if (['max', 'min', 'abs', 'pow', 'sqrt', 'log', 'round'].includes(f)) return c.lift((...x) => MATH[f](...x.map(num)), ...A.pos);
    const base = f.replace(/^ta\./, '');
    if (FN[base] && (f.startsWith('ta.') || ['sma', 'ema', 'rma', 'wma', 'rsi', 'stdev', 'highest', 'lowest', 'change', 'atr', 'crossover', 'crossunder', 'cross', 'stoch', 'pwma', 'pivothigh', 'pivotlow', 'barssince', 'valuewhen', 'cci', 'vwma'].includes(f))) {
      return FN[base](c, [...A.pos, ...Object.values(A.named)], L);
    }
    // 화면에 그리거나 주문하는 함수: 결과만 모아 둠
    if (f === 'strategy' || f === 'indicator' || f === 'study') {
      c.meta.kind = f === 'strategy' ? 'strategy' : 'indicator';
      c.meta.title = pick(A, 0, 'title', '');
      c.meta.short = A.named.shorttitle || '';
      c.meta.overlay = truthy(A.named.overlay);
      if (A.named.commission_type === 'strategy.commission.percent' && num(A.named.commission_value) >= 0) c.meta.commission = num(A.named.commission_value) / 100;
      return NaN;
    }
    const when = A.named.when !== undefined ? A.named.when : true;
    if (f === 'strategy.entry' || f === 'strategy.order') {
      const dir = pick(A, 1, 'direction', 'strategy.long');
      (dir === 'strategy.short' ? c.exits : c.entries).push(cond(c, when, dir === 'strategy.short' ? '공매도 진입' : ''));
      if (dir === 'strategy.short') c.notes.add('공매도(short) 진입은 매수 포지션 청산으로 봅니다 (이 사이트는 매수만 계산).');
      return NaN;
    }
    if (f === 'strategy.close' || f === 'strategy.close_all') { c.exits.push(cond(c, when)); return NaN; }
    if (f === 'strategy.exit') {
      const keys = ['profit', 'loss', 'stop', 'limit', 'trail_points', 'trail_price', 'trail_offset'].filter(k => A.named[k] !== undefined);
      c.notes.add(`strategy.exit의 익절·손절 주문(${keys.join(', ') || '가격'})은 빠집니다. 조건으로 청산하는 부분만 계산합니다.`);
      return NaN;
    }
    if (f === 'plot') {
      c.plots.push({ values: A.pos[0], title: pick(A, 1, 'title', ''), color: pick(A, 2, 'color', null), width: num(A.named.linewidth) || 1.5, mask: c.mask });
      return NaN;
    }
    if (f === 'hline') { c.hlines.push({ price: num(pick(A, 0, 'price', NaN)), color: pick(A, 2, 'color', null), title: pick(A, 1, 'title', '') }); return NaN; }
    if (f === 'plotshape' || f === 'plotchar' || f === 'plotarrow') {
      c.shapes.push({ cond: cond(c, A.pos[0], node.args[0] ? unparse(node.args[0].e) : ''), title: pick(A, 1, 'title', ''), loc: A.named.location || '', style: A.named.style || pick(A, 2, 'style', ''), color: A.named.color || null, text: A.named.text || '' });
      return NaN;
    }
    if (f === 'alertcondition') { c.alerts.push({ cond: cond(c, A.pos[0], node.args[0] ? unparse(node.args[0].e) : ''), title: String(pick(A, 1, 'title', '') || pick(A, 2, 'message', '')) }); return NaN; }
    if (f.startsWith('strategy.') || f.startsWith('request.')) { c.notes.add(`${f}는 빼고 계산합니다.`); return NaN; }
    return fail(`'${f}' 함수는 아직 읽지 못합니다`, L);
  }
  // if 블록 조건 × when 인자
  function cond(c, when, tag) {
    const m = c.mask == null ? true : c.mask;
    return { v: c.lift((x, y) => truthy(x) && truthy(y), m, when), text: [c.maskText, tag].filter(Boolean).join(' · ') };
  }

  function exec(c, stmts) {
    let prevCond = null; // 바로 앞 if 조건 (else 용)
    stmts.forEach(st => {
      const L = st.line;
      if (st.t === 'skip') return;
      if (st.t === 'set') {
        if (c.mask != null) fail('if 안에서 변수를 바꾸는 계산은 아직 읽지 못합니다', L);
        const v = ev(c, st.e, L);
        if (st.names.length > 1 || (v && v.tuple)) {
          if (!v || !v.tuple) fail('[a, b] = 에는 여러 값을 돌려주는 함수(ta.bb, ta.macd)가 와야 합니다', L);
          st.names.forEach((nm, k) => c.vars.set(nm, v.tuple[k]));
        } else {
          if (st.isVar) c.varDecl.add(st.names[0]);
          if (st.reassign && c.varDecl.has(st.names[0]) && !c.inLoop) fail(`'var ${st.names[0]}'처럼 봉마다 이어 가는 계산은 아직 읽지 못합니다`, L);
          c.vars.set(st.names[0], v);
        }
        prevCond = null;
        return;
      }
      if (st.t === 'expr') { ev(c, st.e, L); prevCond = null; return; }
      if (st.t === 'for') {
        if (c.mask != null) fail('if 안의 for 문은 아직 읽지 못합니다', L);
        const sc = v => { if (isArr(v) || !(num(v) === num(v))) fail('for 범위는 숫자여야 합니다', L); return num(v); };
        const a = sc(ev(c, st.a, L)), b = sc(ev(c, st.b, L)), step = st.step ? Math.abs(sc(ev(c, st.step, L))) : 1;
        if (!(step > 0) || Math.abs(b - a) / step > 2000) fail('for 반복 횟수가 너무 많습니다', L);
        const dir = b >= a ? 1 : -1, saved = c.inLoop;
        c.inLoop = true;
        for (let i = a; dir > 0 ? i <= b : i >= b; i += dir * step) { c.vars.set(st.v, i); exec(c, st.body || []); }
        c.inLoop = saved;
        prevCond = null;
        return;
      }
      if (st.t === 'if' || st.t === 'else') {
        if (st.t === 'else' && !prevCond) fail('else 앞에 if가 없습니다', L);
        const saved = [c.mask, c.maskText];
        const here = st.c ? ev(c, st.c, L) : true;
        const notPrev = st.t === 'else' ? c.lift(x => !truthy(x), prevCond.v) : true;
        const mine = c.lift((x, y) => truthy(x) && truthy(y), notPrev, here);
        c.mask = c.lift((x, y) => truthy(x) && truthy(y), c.mask == null ? true : c.mask, mine);
        c.maskText = [c.maskText, st.t === 'else' ? (st.c ? `아니고 ${st.text}` : `(${prevCond.text}) 아닐 때`) : st.text].filter(Boolean).join(' 이고 ');
        exec(c, st.body || []);
        [c.mask, c.maskText] = saved;
        prevCond = { v: st.t === 'else' ? c.lift((x, y) => truthy(x) || truthy(y), prevCond.v, here) : here, text: st.text || '' };
      }
    });
  }

  const BUY_RE = /buy|long|bull|매수|롱|진입|상승/i, SELL_RE = /sell|short|exit|bear|close|매도|숏|청산|하락/i;
  const anyOf = (n, list) => { const out = new Array(n).fill(false); list.forEach(x => { for (let i = 0; i < n; i++) if (truthy(isArr(x.v) ? x.v[i] : x.v)) out[i] = true; }); return out; };

  const okColor = x => (typeof x === 'string' && /^(#[0-9a-fA-F]{6}|rgb\(\d{1,3},\d{1,3},\d{1,3}\))$/.test(x) ? x : null);
  // 결과 정리: 매매 신호는 { buy, exit }, 지표는 js/chart.js 가 그리는 모양 (lines, hlines, marks, status)
  function strategyOut(c) {
    let buy = c.entries, exit = c.exits, how = 'strategy';
    if (!buy.length) {
      const alerts = c.alerts.map(x => ({ ...x, label: x.title })), shapes = c.shapes.map(s => ({ cond: s.cond, title: `${s.title} ${s.text} ${s.style} ${s.loc}`, label: s.title || s.text }));
      const named = alerts.some(x => BUY_RE.test(x.title)) ? alerts : shapes.length ? shapes : alerts;
      buy = named.filter(x => BUY_RE.test(x.title) || /belowbar|up\b|triangleup|arrowup|labelup/i.test(x.title)).map(x => x.cond);
      exit = named.filter(x => !buy.includes(x.cond) && (SELL_RE.test(x.title) || /abovebar|down\b|triangledown|arrowdown|labeldown/i.test(x.title))).map(x => x.cond);
      how = 'alerts';
    }
    if (!buy.length) {
      const pickVar = re => [...c.vars.keys()].filter(k => re.test(k) && (isArr(c.vars.get(k)) || typeof c.vars.get(k) === 'boolean')).map(k => ({ v: c.vars.get(k), text: k }));
      buy = pickVar(/^(buy|long|longcondition|longcond|entry|buysignal|longsignal|golong|enterlong)$/i);
      exit = pickVar(/^(sell|exit|short|shortcondition|shortcond|exitlong|sellsignal|shortsignal|closelong|exitcondition)$/i);
      how = 'vars';
    }
    if (!buy.length) fail('매수 조건을 찾지 못했습니다. strategy.entry, alertcondition("Buy"…), plotshape(…매수…) 중 하나가 있어야 합니다.');
    if (!exit.length) c.notes.add('청산 조건을 찾지 못해 매수 신호만 표시합니다 (승률은 계산되지 않음).');
    const show = t => { t = String(t || '').trim().replace(/^\((.*)\)$/, '$1'); return /^[A-Za-z_]\w*$/.test(t) && c.defs[t] ? `${t} (= ${c.defs[t]})` : t; };
    const txt = list => [...new Set(list.map(x => show(x.text)).filter(Boolean))].join(' 또는 ');
    return { buy: anyOf(c.n, buy), exit: anyOf(c.n, exit), buyText: txt(buy), exitText: txt(exit), how };
  }
  function indicatorOut(c, opts) {
    const pane = c.meta.overlay ? 'main' : 'sub', n = c.n, palette = opts.palette || ['#2962FF', '#FF6D00', '#9C27B0', '#00897B'];
    const lines = c.plots.filter(p => isArr(p.values) || typeof p.values === 'number').map((p, k) => {
      const values = c.arr(p.values).map(v => (v === v ? v : NaN));
      const line = { title: p.title || `선 ${k + 1}`, values, width: Math.min(4, p.width), pane };
      if (isArr(p.color)) line.colors = p.color.map(okColor);
      line.color = okColor(p.color) || (line.colors && line.colors.find(Boolean)) || (k === 0 ? opts.color : palette[k % palette.length]);
      return line;
    });
    const hlines = pane === 'sub' ? c.hlines.filter(h => h.price === h.price).map(h => ({ price: h.price, color: okColor(h.color) || '#787B86' })) : [];
    const from = Math.max(0, n - 300), marks = [];
    c.shapes.forEach(s => {
      const up = /belowbar|up/i.test(`${s.loc} ${s.style}`), color = okColor(s.color) || opts.color;
      for (let i = from; i < n; i++) if (truthy(isArr(s.cond.v) ? s.cond.v[i] : s.cond.v)) marks.push({ i, text: s.text || '', color, position: up ? 'below' : 'above', shape: /circle|cross|xcross|diamond/i.test(s.style) ? 'circle' : up ? 'arrowUp' : 'arrowDown' });
    });
    if (!lines.length && !marks.length) fail('그릴 것을 찾지 못했습니다 (plot, plotshape가 없음).');
    const vals = lines.flatMap(l => l.values.slice(from)).filter(v => v === v);
    if (pane === 'sub' && vals.length && Math.min(...vals) >= 0 && Math.max(...vals) <= 100 && hlines.every(h => h.price >= 0 && h.price <= 100)) lines.forEach(l => { l.range = [0, 100]; });
    let status = null;
    const l0 = lines[0];
    if (l0) {
      const v = l0.values[n - 1], p = l0.values[n - 2];
      if (v === v) status = { text: `${l0.title} ${v.toFixed(2)}${p === p ? (v >= p ? ' · 오르는 중' : ' · 내리는 중') : ''}`, tone: p === p ? (v >= p ? 'up' : 'down') : '' };
    }
    return { lines, hlines, marks, status };
  }

  // 붙여 넣은 글자를 미리 한 번 읽어 문법·종류·이름을 확인 (계산은 종목 주가가 있을 때)
  function compile(src, opts = {}) {
    const prog = parseProgram(String(src || ''));
    if (!prog.length) fail('코드가 비어 있습니다.');
    const defs = {};
    prog.forEach(st => { if (st.t === 'set' && st.names.length === 1 && !st.reassign) defs[st.names[0]] = st.rhs; });
    const run = d => { const c = makeCtx(d); c.defs = defs; exec(c, prog); return c; };
    const info = { kind: opts.kind || 'strategy', title: '', notes: [] };
    const head = prog.find(s => s.t === 'expr' && s.e.t === 'call' && ['strategy', 'indicator', 'study'].includes(s.e.f));
    if (head) {
      if (head.e.f === 'strategy') info.kind = 'strategy';
      const t = head.e.args.find(a => a.name === 'title') || head.e.args.find(a => !a.name);
      if (t && t.e.t === 'str') info.title = t.e.v;
    }
    return {
      info,
      run(d) { const c = run(d), out = strategyOut(c); out.notes = [...c.notes]; out.commission = c.meta.commission; return out; },
      plot(d) { const c = run(d), out = indicatorOut(c, opts); out.notes = [...c.notes]; return out; },
    };
  }

  window.PINE = { compile, PineError };
})();
