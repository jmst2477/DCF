// DCF 계산 엔진 — /mnt/project-files/dcf/DCF_개선판_v2 엑셀의 "DCF" 시트와 같은 수식.
// 단위: 백만 달러, 주식수 백만 주. 연차 인덱스 0 = 0년차(실적), 1~10 = 추정.
(function (root) {
  'use strict';

  const YEARS = 10;
  const EST_YEARS = 5; // 1~5년차 = 시킹알파 추정치

  // inputs:
  //   tax, wacc, g, normCapex, normDA, shares, cash, debt, price
  //   sbc             주식보상비용/매출 (0이면 미반영) — FCFF와 영구가치에서 차감
  //   horizon         명시적 예측 기간(1~10년, 기본 10). 그 다음 해부터 영구가치
  //   revenue[0..5]   0년차 실적 + 1~5년차 추정 매출
  //   growth[6..10]   6~10년차 성장률
  //   margin/da/capex/nwc[1..10] 연도별 비율
  function compute(inp) {
    const H = Math.max(1, Math.min(YEARS, Math.round(inp.horizon || YEARS)));
    const rev = [];
    const growth = [];
    for (let t = 0; t <= H; t++) {
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
    for (let t = 1; t <= H; t++) {
      const ebit = rev[t] * num(inp.margin[t]);
      const taxes = ebit * inp.tax;
      const nopat = ebit - taxes;
      const da = rev[t] * num(inp.da[t]);
      const capex = rev[t] * num(inp.capex[t]);
      const dNwc = (rev[t] - rev[t - 1]) * num(inp.nwc[t]);
      const sbc = rev[t] * num(inp.sbc);
      const fcff = nopat + da - capex - dNwc - sbc;
      const df = 1 / Math.pow(1 + inp.wacc, t);
      const pv = fcff * df;
      pvSum += pv;
      rows.push({ t, revenue: rev[t], growth: growth[t], ebit, taxes, nopat, da, capex, dNwc, sbc, fcff, df, pv });
    }

    const last = rows[H - 1];
    // 영구가치 기준 FCF (예측 마지막 해 H의 다음 해):
    //   매출H×(1+g)×(이익률H×(1−세율)+정상화D&A−정상화CapEx−SBC) − 매출H×g×운전자본%H
    const fcf11 = rev[H] * (1 + inp.g) * (num(inp.margin[H]) * (1 - inp.tax) + inp.normDA - inp.normCapex - num(inp.sbc))
      - rev[H] * inp.g * num(inp.nwc[H]);
    const tv = fcf11 / (inp.wacc - inp.g);
    const pvTv = tv * last.df;
    const ev = pvSum + pvTv;
    const equity = ev - inp.debt + inp.cash;
    const perShare = equity / inp.shares;
    const upside = inp.price ? perShare / inp.price - 1 : null;

    return { horizon: H, rows, rev0: rev[0], pvSum, fcf11, tv, pvTv, ev, equity, perShare, upside, tvShare: pvTv / ev };
  }

  // WACC × 영구성장률 민감도 표 (주당가치)
  function sensitivity(inp, waccs, gs) {
    return waccs.map(w => gs.map(g => (w <= g ? null : compute(Object.assign({}, inp, { wacc: w, g })).perShare)));
  }

  // 역DCF: 1주당 가치가 현재가와 같아지는 값을 이분법으로 찾는다.
  //   kind 'g' → 영구성장률, 'margin' → 1~10년차 영업이익률(모두 같은 값)
  function reverse(inp, kind) {
    if (!inp.price || !inp.shares) return null;
    const apply = x => {
      const c = Object.assign({}, inp);
      if (kind === 'g') c.g = x;
      else { c.margin = inp.margin.slice(); for (let t = 1; t <= YEARS; t++) c.margin[t] = x; }
      return compute(c).perShare - inp.price;
    };
    let lo = kind === 'g' ? -0.1 : -0.5, hi = kind === 'g' ? inp.wacc - 0.0005 : 0.9;
    let flo = apply(lo), fhi = apply(hi);
    if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2, fm = apply(mid);
      if (fm * flo > 0) { lo = mid; flo = fm; } else { hi = mid; }
    }
    return (lo + hi) / 2;
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  const api = { compute, sensitivity, reverse, YEARS, EST_YEARS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DCF = api;
})(this);
