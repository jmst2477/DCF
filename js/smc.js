// LuxAlgo "Smart Money Concepts"의 구조(BOS·CHoCH) 판단 부분만 자바스크립트로 옮긴 것.
// 원본: © LuxAlgo, CC BY-NC-SA 4.0 (https://creativecommons.org/licenses/by-nc-sa/4.0/) — 이 파일도 같은 조건(비상업적 이용)이다.
// 오더블록·FVG·EQH/EQL·그림 요소는 옮기지 않았다. 기본 설정: 스윙 길이 50, 내부 구조 5, 필터 끔.
(function (g) {
  'use strict';
  const BULLISH = 1, BEARISH = -1;

  // 원본 leg(size): size봉 전 고가가 최근 size봉 최고가보다 높으면 하락 다리(0), 저가가 최저가보다 낮으면 상승 다리(1)
  function legs(d, size) {
    const out = new Array(d.close.length).fill(0);
    let leg = 0;
    for (let i = 0; i < d.close.length; i++) {
      if (i >= size) {
        let hh = -Infinity, ll = Infinity;
        for (let j = i - size + 1; j <= i; j++) { hh = Math.max(hh, d.high[j]); ll = Math.min(ll, d.low[j]); }
        if (d.high[i - size] > hh) leg = 0;
        else if (d.low[i - size] < ll) leg = 1;
      }
      out[i] = leg;
    }
    return out;
  }

  function structure(d) {
    const n = d.close.length;
    const mk = () => ({ cur: NaN, crossed: false });
    const P = { swing: { hi: mk(), lo: mk(), bias: 0, last: null, events: [] }, internal: { hi: mk(), lo: mk(), bias: 0, last: null, events: [] } };
    const legSwing = legs(d, 50), legInt = legs(d, 5);
    // 크로스 판단용: 각 봉에서 갱신된 뒤의 기준선 값 (ta.crossover는 직전 봉의 기준선 값과 비교)
    const prevLvl = { swing: { hi: NaN, lo: NaN }, internal: { hi: NaN, lo: NaN } };

    for (let i = 0; i < n; i++) {
      // getCurrentStructure: 새 다리 시작 → 피벗 갱신 (스윙 50 먼저, 그다음 내부 5)
      [['swing', legSwing, 50], ['internal', legInt, 5]].forEach(([k, lg, size]) => {
        if (i === 0) return;
        const ch = lg[i] - lg[i - 1];
        if (ch === 1) Object.assign(P[k].lo, { cur: d.low[i - size], crossed: false });
        else if (ch === -1) Object.assign(P[k].hi, { cur: d.high[i - size], crossed: false });
      });
      // displayStructure: 내부 먼저, 그다음 스윙
      ['internal', 'swing'].forEach(k => {
        const p = P[k], c = d.close[i], c1 = i > 0 ? d.close[i - 1] : NaN;
        const hiExtra = k === 'internal' ? P.internal.hi.cur !== P.swing.hi.cur : true;
        if (c > p.hi.cur && c1 <= prevLvl[k].hi && !p.hi.crossed && hiExtra) {
          const tag = p.bias === BEARISH ? 'CHoCH' : 'BOS';
          p.hi.crossed = true; p.bias = BULLISH;
          p.last = { bull: true, tag, i, time: d.time[i] }; p.events.push(p.last);
        }
        const loExtra = k === 'internal' ? P.internal.lo.cur !== P.swing.lo.cur : true;
        if (c < p.lo.cur && c1 >= prevLvl[k].lo && !p.lo.crossed && loExtra) {
          const tag = p.bias === BULLISH ? 'CHoCH' : 'BOS';
          p.lo.crossed = true; p.bias = BEARISH;
          p.last = { bull: false, tag, i, time: d.time[i] }; p.events.push(p.last);
        }
        prevLvl[k].hi = p.hi.cur; prevLvl[k].lo = p.lo.cur;
      });
    }
    return P;
  }

  g.SMC = { structure, legs };
})(typeof window !== 'undefined' ? window : globalThis);
