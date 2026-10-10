// 파인스크립트 ta.* 내장 함수를 자바스크립트로 옮긴 것. 모든 함수는 배열(봉 순서)을 받아 같은 길이 배열을 돌려준다.
// 값이 아직 없는 앞부분은 NaN(파인스크립트의 na)이다.
(function (g) {
  'use strict';
  const isNa = v => v == null || Number.isNaN(v);
  const at = (x, i) => (Array.isArray(x) ? x[i] : x);
  const map = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const len = (...xs) => Math.max(...xs.map(x => (Array.isArray(x) ? x.length : 0)));

  function sma(src, n) {
    return map(src.length, i => {
      if (i < n - 1) return NaN;
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += src[j];
      return s / n;
    });
  }
  // 지수 평균: 처음 값이 나오는 자리에서 단순평균으로 시작 (트레이딩뷰와 같음)
  function smooth(src, n, alpha) {
    const out = new Array(src.length).fill(NaN);
    let prev = NaN, start = src.findIndex(v => !isNa(v));
    if (start < 0) return out;
    for (let i = start; i < src.length; i++) {
      if (isNaN(prev)) {
        if (i - start + 1 < n) continue;
        let s = 0;
        for (let j = i - n + 1; j <= i; j++) s += src[j];
        prev = s / n;
      } else prev = alpha * src[i] + (1 - alpha) * prev;
      out[i] = prev;
    }
    return out;
  }
  const ema = (src, n) => smooth(src, n, 2 / (n + 1));
  const rma = (src, n) => smooth(src, n, 1 / n);
  function wma(src, n) {
    const d = (n * (n + 1)) / 2;
    return map(src.length, i => {
      if (i < n - 1) return NaN;
      let s = 0;
      for (let k = 0; k < n; k++) s += src[i - k] * (n - k);
      return s / d;
    });
  }
  const change = (src, n = 1) => map(src.length, i => (i < n ? NaN : src[i] - src[i - n]));
  function rsi(src, n) {
    const ch = change(src);
    const up = rma(ch.map(v => (isNa(v) ? NaN : Math.max(v, 0))), n);
    const dn = rma(ch.map(v => (isNa(v) ? NaN : -Math.min(v, 0))), n);
    return up.map((u, i) => (isNa(u) || isNa(dn[i]) ? NaN : dn[i] === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / dn[i])));
  }
  function stdev(src, n) {
    const m = sma(src, n);
    return map(src.length, i => {
      if (isNa(m[i])) return NaN;
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (src[j] - m[i]) ** 2;
      return Math.sqrt(s / n);
    });
  }
  function bb(src, n, mult) {
    const basis = sma(src, n), dev = stdev(src, n);
    return [basis, basis.map((b, i) => b + mult * dev[i]), basis.map((b, i) => b - mult * dev[i])];
  }
  function macd(src, fast, slow, sig) {
    const f = ema(src, fast), s = ema(src, slow);
    const line = f.map((v, i) => v - s[i]);
    const signal = ema(line, sig);
    return [line, signal, line.map((v, i) => v - signal[i])];
  }
  const highest = (src, n) => map(src.length, i => (i < n - 1 ? NaN : Math.max(...src.slice(i - n + 1, i + 1))));
  const lowest = (src, n) => map(src.length, i => (i < n - 1 ? NaN : Math.min(...src.slice(i - n + 1, i + 1))));
  function tr(high, low, close) {
    return map(close.length, i => (i === 0 ? high[i] - low[i] : Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]))));
  }
  const atr = (high, low, close, n) => rma(tr(high, low, close), n);
  function stoch(close, high, low, n) {
    const hh = highest(high, n), ll = lowest(low, n);
    return close.map((c, i) => (100 * (c - ll[i])) / (hh[i] - ll[i]));
  }
  // a가 b를 아래에서 위로 뚫음 / 위에서 아래로 뚫음 (b는 숫자도 됨)
  const crossover = (a, b) => map(len(a, b), i => i > 0 && at(a, i) > at(b, i) && at(a, i - 1) <= at(b, i - 1));
  const crossunder = (a, b) => map(len(a, b), i => i > 0 && at(a, i) < at(b, i) && at(a, i - 1) >= at(b, i - 1));
  const cross = (a, b) => crossover(a, b).map((v, i) => v || crossunder(a, b)[i]);
  // 배열끼리 계산할 때 쓰는 도우미: ta.op((x, y) => x > y, a, b)
  const op = (f, ...xs) => map(len(...xs), i => f(...xs.map(x => at(x, i))));
  const prev = (src, n = 1) => map(src.length, i => (i < n ? NaN : src[i - n])); // src[n]

  g.TA = { sma, ema, rma, wma, rsi, stdev, bb, macd, highest, lowest, tr, atr, stoch, change, crossover, crossunder, cross, op, prev, isNa };
})(typeof window !== 'undefined' ? window : globalThis);
