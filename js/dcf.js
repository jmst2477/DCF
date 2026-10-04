// DCF 계산 엔진 — /mnt/project-files/dcf/DCF_개선판_v2 엑셀의 "DCF" 시트와 같은 수식.
// 단위: 백만 달러, 주식수 백만 주. 연차 인덱스 0 = 0년차(실적), 1~10 = 추정.
(function (root) {
  'use strict';

  const YEARS = 10;
  const EST_YEARS = 5; // 1~5년차 = 시킹알파 추정치

  // inputs:
  //   tax, wacc, g, normCapex, normDA, shares, cash, debt, price
  //   revenue[0..5]   0년차 실적 + 1~5년차 추정 매출
  //   growth[6..10]   6~10년차 성장률
  //   margin/da/capex/nwc[1..10] 연도별 비율
  function compute(inp) {
    const rev = [];
    const growth = [];
    for (let t = 0; t <= YEARS; t++) {
      if (t <= EST_YEARS) {
        rev[t] = num(inp.revenue[t]);
        growth[t] = t === 0 ? null : rev[t] / rev[t - 1] - 1;
      } else {
        growth[t] = num(inp.growth[t]);
        rev[t] = rev[t - 1] * (1 + growth[t]);
      }
    }

    const rows = [];
    let pvSum = 0;
    for (let t = 1; t <= YEARS; t++) {
      const ebit = rev[t] * num(inp.margin[t]);
      const taxes = ebit * inp.tax;
      const nopat = ebit - taxes;
      const da = rev[t] * num(inp.da[t]);
      const capex = rev[t] * num(inp.capex[t]);
      const dNwc = (rev[t] - rev[t - 1]) * num(inp.nwc[t]);
      const fcff = nopat + da - capex - dNwc;
      const df = 1 / Math.pow(1 + inp.wacc, t);
      const pv = fcff * df;
      pvSum += pv;
      rows.push({ t, revenue: rev[t], growth: growth[t], ebit, taxes, nopat, da, capex, dNwc, fcff, df, pv });
    }

    const last = rows[YEARS - 1];
    // B37: FCF11 = L19×(1+g)×(L20×(1−tax)+정상화D&A−정상화CapEx) − L19×g×L23
    const fcf11 = rev[YEARS] * (1 + inp.g) * (num(inp.margin[YEARS]) * (1 - inp.tax) + inp.normDA - inp.normCapex)
      - rev[YEARS] * inp.g * num(inp.nwc[YEARS]);
    const tv = fcf11 / (inp.wacc - inp.g);
    const pvTv = tv * last.df;
    const ev = pvSum + pvTv;
    const equity = ev - inp.debt + inp.cash;
    const perShare = equity / inp.shares;
    const upside = inp.price ? perShare / inp.price - 1 : null;

    return { rows, rev0: rev[0], pvSum, fcf11, tv, pvTv, ev, equity, perShare, upside, tvShare: pvTv / ev };
  }

  // WACC × 영구성장률 민감도 표 (주당가치)
  function sensitivity(inp, waccs, gs) {
    return waccs.map(w => gs.map(g => (w <= g ? null : compute(Object.assign({}, inp, { wacc: w, g })).perShare)));
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  const api = { compute, sensitivity, YEARS, EST_YEARS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DCF = api;
})(this);
