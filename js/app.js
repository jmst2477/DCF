/* global DCF, SAParser, SAPdf, Tesseract, ExcelJS */
(function () {
  'use strict';

  const N = DCF.YEARS;
  const STORE_KEY = 'dcf-web-state-v1';
  const KEY_STORE = 'dcf-web-anthropic-key';
  const CLAUDE_MODEL = 'claude-opus-5-5';
  const CDN = 'https://cdn.jsdelivr.net/npm/';

  // ---------- 상태 ----------
  function blank() {
    const arr = v => Array.from({ length: N + 1 }, () => v);
    return {
      ticker: '', baseFY: new Date().getFullYear() - 1, price: 0, shares: 0, cash: 0, debt: 0,
      tax: 0.21, wacc: 0.08, g: 0.02, normCapex: 0.05, normDA: 0.05,
      beta: 0, rf: 0.042, erp: 0.05, sbcOn: false, sbc: 0, horizon: 3,
      revenue: arr(0), growth: arr(0.05), margin: arr(0.2), da: arr(0.05), capex: arr(0.05), nwc: arr(0),
      mode: 'basic', basic: blankBasic(),
    };
  }

  // ---------- 기본(강의) 방식: 원본 「DCF Valuation Model」 엑셀과 같은 고정 가정 ----------
  // 모든 해에 같은 가정을 쓰고 3년만 계산. 법인세 21%, 순운전자본 매출의 1%는 강의 기본값.
  const MAX_YEARS = 3; // 예측은 3년까지 (사용자 결정 2026-10-10)
  function blankBasic() {
    return { rev0: 0, growth: 0.1, margin: 0.2, tax: 0.21, da: 0.05, capex: 0.05, nwc: 0.01, years: 3, pe: 20, src: {} };
  }
  const BASIC_FIELDS = [
    { key: 'rev0', label: '0년차 매출 (백만 $)', type: 'num' },
    { key: 'growth', label: '매출 성장률 (%)', type: 'pct' },
    { key: 'margin', label: '영업이익률 (%)', type: 'pct' },
    { key: 'tax', label: '법인세율 (%)', type: 'pct' },
    { key: 'da', label: '감가상각비/매출 (%)', type: 'pct' },
    { key: 'capex', label: '캐펙스/매출 (%)', type: 'pct' },
    { key: 'nwc', label: '순운전자본증감/매출 (%)', type: 'pct' },
    { key: 'wacc', label: '할인율 (%)', type: 'pct', shared: true, hint: '좋은 회사 8%, 안 좋은 회사 12%' },
    { key: 'g', label: '영구성장률 (%)', type: 'pct', shared: true },
    { key: 'shares', label: '발행주식수 (백만 주)', type: 'num', shared: true },
    { key: 'cash', label: '보유현금 (백만 $)', type: 'num', shared: true },
    { key: 'debt', label: '총차입금 (백만 $)', type: 'num', shared: true },
    { key: 'price', label: '현재 주가 ($)', type: 'num', shared: true },
    { key: 'years', label: '예측 연수', type: 'int', hint: '기본 3년 (추정치가 더 있어도 3년까지)' },
    { key: 'pe', label: '적정 P/E (배, P/E 방식)', type: 'num' },
  ];

  // 지금 갖고 있는 자료(티커 조회·캡처·PDF)로 기본 가정을 채움. 직접 고친 칸('user')은 건드리지 않음.
  function basicRefresh(s) {
    const b = s.basic = Object.assign(blankBasic(), s.basic || {});
    b.src = b.src || {};
    const set = (k, v, label) => { if (b.src[k] === 'user' || v == null || !Number.isFinite(v)) return; b[k] = +(+v).toFixed(k === 'rev0' ? 1 : 4); b.src[k] = label; };
    const H = Math.max(1, Math.min(N, s.horizon || 1));
    set('rev0', s.revenue[0] || null, '최근 실적');
    // 매출 성장률: 애널리스트 매출 추정치가 있는 마지막 해까지의 연평균 (없으면 최근 실적 성장률)
    let tk = 0;
    for (let t = 1; t <= Math.min(H, MAX_YEARS); t++) if (s.revenue[t] > 0 && !(s.revAssumed && s.revAssumed[t])) tk = t;
    if (tk && s.revenue[0] > 0) set('growth', Math.pow(s.revenue[tk] / s.revenue[0], 1 / tk) - 1, `애널리스트 매출 추정치 ${tk}년 연평균`);
    else {
      const h = s.info && s.info.history;
      if (h && h.length > 1 && h[h.length - 2].revenue > 0) set('growth', h[h.length - 1].revenue / h[h.length - 2].revenue - 1, '최근 실적 성장률');
    }
    // 이익률·감가상각비·캐펙스: 시킹알파 추정치(EBIT/EPS 등)가 있으면 그 평균, 없으면 최근 실적
    const avgSrc = key => {
      const v = [], kinds = new Set();
      for (let t = 1; t <= H; t++) { const k = s.src && s.src[key] && s.src[key][t]; if (k === 'est' || k === 'eps') { v.push(s[key][t]); kinds.add(k); } }
      return v.length ? { v: v.reduce((a, c) => a + c, 0) / v.length, label: kinds.has('est') ? '시킹알파 추정치 평균' : 'EPS로 추정 (평균)' } : null;
    };
    const fromEps = {};
    for (const key of ['margin', 'da', 'capex']) {
      const e = avgSrc(key);
      fromEps[key] = !!e && e.label.startsWith('EPS');
      if (e) set(key, e.v, e.label);
      else set(key, s[key][0], '최근 실적');
    }
    // 시킹알파 EPS는 조정(Non-GAAP) EPS라 주식보상비용(SBC)과 인수 무형자산 상각비가 빠져 있음.
    // 그대로 쓰면 이익률이 높아지고, 감가상각비(상각비 포함)를 또 더해 현금흐름이 두 번 부풀려짐 (예: 브로드컴).
    if (fromEps.margin) {
      const sbc = s.sbc > 0 ? s.sbc : 0;
      if (sbc) set('margin', b.margin - sbc, `EPS로 추정 − 주식보상 ${(sbc * 100).toFixed(1)}%`);
      if (b.src.da !== 'user' && !(avgSrc('da') || {}).v && b.da > b.capex) set('da', b.capex, '캐펙스와 같게 (조정 EPS는 상각비를 이미 뺌)');
    }
    for (const [k, v] of [['tax', 0.21], ['nwc', 0.01]]) if (!b.src[k]) { b[k] = v; b.src[k] = '강의 기본값'; }
    // 적정 P/E: EPS 추정치가 2개 이상이면 PEG 1.5 × EPS 연평균 성장률(%) (10~40배), 없으면 20배
    const eg = epsGrowth(s);
    if (eg != null) set('pe', Math.max(10, Math.min(40, 1.5 * eg * 100)), `PEG 1.5 × EPS 성장률 ${(eg * 100).toFixed(1)}%`);
    else if (!b.src.pe) { b.pe = 20; b.src.pe = '시장 평균 수준 20배'; }
    if (!b.src.years || b.src.years === '강의 기본값') { b.years = MAX_YEARS; b.src.years = '기본 3년'; }
    return s;
  }
  // ---------- P/E 방식: 적정가 = 예상 EPS × 적정 P/E ----------
  // 지금 = 1년차 EPS, 내년 = 2년차, 내후년 = 3년차. 시킹알파 EPS 추정치가 없으면 계산값(매출 × 이익률 × (1 − 세율) ÷ 주식수).
  function epsAt(s, t) {
    const raw = s.estRaw && s.estRaw.eps, y = s.baseFY + t;
    if (raw && raw[y] > 0) return { v: raw[y], est: true };
    const b = s.basic;
    if (!(b && b.rev0 > 0 && s.shares > 0)) return { v: NaN, est: false };
    return { v: b.rev0 * Math.pow(1 + b.growth, t) * b.margin * (1 - b.tax) / s.shares, est: false };
  }
  function epsGrowth(s) {
    const raw = s.estRaw && s.estRaw.eps;
    if (!raw) return null;
    const ys = [1, 2, 3].map(t => s.baseFY + t).filter(y => raw[y] > 0);
    if (ys.length < 2) return null;
    const a = ys[0], z = ys[ys.length - 1];
    return Math.pow(raw[z] / raw[a], 1 / (z - a)) - 1;
  }

  function basicInput() {
    const b = state.basic;
    return { rev0: b.rev0, growth: b.growth, margin: b.margin, tax: b.tax, da: b.da, capex: b.capex, nwc: b.nwc, years: b.years,
      wacc: state.wacc, g: state.g, shares: state.shares, cash: state.cash, debt: state.debt, price: state.price };
  }

  let state = load() || blank();
  state.mode = 'basic'; // 계산 방식은 하나 (강의 방식, 3년)
  if (!state.basic || !state.basic.src) basicRefresh(state);

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? Object.assign(blank(), JSON.parse(raw)) : null;
    } catch (e) { return null; }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* 저장 불가 환경 무시 */ }
  }

  // ---------- 표시 형식 ----------
  const $ = sel => document.querySelector(sel);
  const fmt = (v, d = 0) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const pct = (v, d = 1) => (v == null || !Number.isFinite(v) ? '–' : (v * 100).toFixed(d) + '%');
  const toInput = (v, isPct) => (isPct ? +(v * 100).toFixed(4) : v);
  const fromInput = (s, isPct) => {
    const n = parseFloat(String(s).replace(/,/g, ''));
    if (!Number.isFinite(n)) return 0;
    return isPct ? n / 100 : n;
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- 티커 → 자동 입력 (같은 저장소의 Vercel 함수 /api/dcf-inputs, 야후 파이낸스) ----------
  // 실적·주가·현금·차입금·매출 컨센서스(보통 1~2년차)를 받아 나머지는 아래 규칙으로 가정한다.
  //  - 컨센서스가 없는 연도의 성장률: 마지막으로 알려진 성장률에서 영구성장률까지 10년차에 걸쳐 직선으로 낮춤
  //  - 영업이익률·감가상각비·캐펙스 비율: 최근 회계연도 값을 1~10년차에 그대로
  //  - 정상화 캐펙스 = 최근 실적 평균 캐펙스%, 정상화 감가상각비 = max(평균 D&A%, 캐펙스×0.8) (캐펙스 이하)
  function assumptionsFrom(j) {
    const h = j.history;
    const last = h[h.length - 1];
    const s = blank();
    const avg = arr => { const v = arr.filter(x => x != null && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    Object.assign(s, {
      ticker: j.ticker, baseFY: last.fy, price: j.currentPrice, shares: j.sharesOutstandingMillions,
      cash: j.cash, debt: j.debt, wacc: 0.08, g: 0.02,
      tax: last.taxRate > 0 && last.taxRate < 0.35 ? last.taxRate : 0.21,
    });
    s.revenue[0] = last.revenue;
    s.revAssumed = Array(N + 1).fill(false);
    // 예측 기간 = 컨센서스가 있는 마지막 해 (없으면 5년, 임시 가정)
    let known = 0;
    for (const e of j.estimates) {
      const t = e.fy - last.fy;
      if (t >= 1 && t <= 5 && t === known + 1) { s.revenue[t] = e.revenue; known = t; }
    }
    s.horizon = Math.min(MAX_YEARS, known || MAX_YEARS);
    const prev = h.length > 1 ? h[h.length - 2].revenue : null;
    const gStart = known ? s.revenue[known] / s.revenue[known - 1] - 1 : prev ? last.revenue / prev - 1 : 0.05;
    for (let t = known + 1; t <= N; t++) {
      const gt = +(gStart + (s.g - gStart) * (t - known) / (N - known + 1)).toFixed(4);
      if (t <= 5) { s.revenue[t] = Math.round(s.revenue[t - 1] * (1 + gt)); s.revAssumed[t] = true; }
      else s.growth[t] = gt;
    }
    const margin = last.ebitMargin != null ? last.ebitMargin : avg(h.map(x => x.ebitMargin)) || 0.1;
    s.margin = Array(N + 1).fill(margin);
    s.da = Array(N + 1).fill(last.daPct || 0);
    s.capex = Array(N + 1).fill(last.capexPct || 0);
    // 금융 자회사 채권(예: CAT 파이낸셜)이 매출채권에 섞이면 비율이 비정상적으로 커지므로 20%로 제한
    const NWC_CAP = 0.2;
    const nwcRaw = last.nwcPct != null ? last.nwcPct : 0;
    const nwc = Math.max(-0.1, Math.min(NWC_CAP, nwcRaw));
    s.nwcNote = nwcRaw > NWC_CAP ? `운전자본/매출이 ${(nwcRaw * 100).toFixed(1)}%로 높게 나와 20%로 제한했습니다 (금융 자회사 채권이 섞였을 수 있음). 필요하면 고치세요.` : '';
    s.nwc = Array(N + 1).fill(+nwc.toFixed(4));
    s.beta = j.beta || 0;
    s.fromLookup = true;
    s.companyName = j.companyName || j.ticker;
    s.info = { source: j.source, debtNote: j.debtNote, balanceDate: j.balanceDate, history: j.history };
    s.sbc = last.sbcPct || 0;
    s.sbcOn = false;
    s.normCapex = +(avg(h.map(x => x.capexPct)) || last.capexPct || 0).toFixed(4);
    s.normDA = +Math.min(s.normCapex, Math.max(avg(h.map(x => x.daPct)) || 0, s.normCapex * 0.8)).toFixed(4);
    s.basic = blankBasic();
    return basicRefresh(s);
  }

  async function lookup(ticker) {
    const st = $('#lookup-status');
    ticker = (ticker || '').trim().toUpperCase();
    if (!ticker) { st.textContent = '티커를 넣어주세요.'; return; }
    $('#lookup-ticker').value = ticker;
    $('#btn-lookup').disabled = true;
    st.textContent = '불러오는 중...';
    try {
      const res = await fetch('api/dcf-inputs?ticker=' + encodeURIComponent(ticker));
      const j = await res.json().catch(() => { throw new Error('자동 조회 서버가 없습니다 (Vercel 배포 주소에서만 동작).'); });
      if (!res.ok) throw new Error(j.error || '조회 실패');
      // 같은 종목을 다시 계산하면 주가만 새로 받고, 캡처·PDF·직접 고친 값은 그대로 둔다
      // (예전에는 매번 야후 값으로 처음부터 다시 채워서 PDF로 바꾼 차입금·운전자본과 캡처한 3~5년차 매출이 사라졌음)
      if (state.fromLookup && state.ticker === ticker) {
        state.price = j.currentPrice || state.price;
        if (!state.beta) state.beta = j.beta || 0;
        if (!lastLookup || lastLookup.ticker !== ticker) lastLookup = { ...j, ...(state.info || {}) };
        renderAll();
        renderHistory(state.info || j);
        st.innerHTML = `${esc(j.companyName)} · 현재 주가를 새로 반영했습니다. 올린 캡처·PDF와 직접 고친 값은 그대로입니다. ` +
          '<span class="muted">처음부터 다시 불러오려면 초기화 후 계산을 누르세요.</span>';
        return;
      }
      state = assumptionsFrom(j);
      lastLookup = j;
      renderAll();
      renderHistory(j);
      const assumed = state.revAssumed.map((a, t) => (a && t <= state.horizon ? t : 0)).filter(Boolean);
      st.innerHTML = `${esc(j.companyName)} · FY${state.baseFY + state.horizon}까지 ${state.horizon}년 예측 (애널리스트 컨센서스)` +
        (assumed.length ? ` · <span class="legend-assumed">${assumed[0]}~${assumed[assumed.length - 1]}년차 매출은 임시 가정</span>` : '') +
        (state.nwcNote ? `<br><span class="neg">${esc(state.nwcNote)}</span>` : '');
      try { history.replaceState(null, '', '?t=' + encodeURIComponent(ticker)); } catch (e) { /* ignore */ }
    } catch (err) {
      st.textContent = '자동 조회 실패: ' + err.message;
    } finally {
      $('#btn-lookup').disabled = false;
    }
  }
  let lastLookup = null;
  $('#lookup').addEventListener('submit', e => { e.preventDefault(); lookup($('#lookup-ticker').value); });

  function renderHistory(j) {
    $('#hist-wrap').hidden = false;
    $('#hist-src').textContent = `(출처: ${j.source}, 차입금 = ${j.debtNote}, 기준일 ${j.balanceDate})`;
    const h = j.history;
    const row = (label, f) => `<tr><td>${label}</td>${h.map(x => `<td>${f(x)}</td>`).join('')}</tr>`;
    $('#hist').innerHTML = `<thead><tr><th>회계연도</th>${h.map(x => `<th>FY${x.fy}</th>`).join('')}</tr></thead><tbody>` +
      row('매출 (백만 $)', x => fmt(x.revenue)) + row('영업이익률', x => pct(x.ebitMargin)) +
      row('감가상각비/매출', x => pct(x.daPct)) + row('캐펙스/매출', x => pct(x.capexPct)) +
      row('실효세율', x => pct(x.taxRate)) +
      row('운전자본/매출', x => pct(x.nwcPct)) + row('주식보상비용/매출', x => pct(x.sbcPct)) + '</tbody>';
  }

  // CAPM 자기자본비용 = 무위험이자율 + 베타 × 시장위험프리미엄 (차입금이 많으면 WACC는 이보다 낮음)
  // ---------- 3. 연도별 가정 ----------
  // 시킹알파 EBIT·EBITDA·캐펙스 추정치(백만 $, 회계연도별) → 연도별 영업이익률, 감가상각비/매출(EBITDA−EBIT), 캐펙스/매출.
  // EBIT 표가 없으면 EPS 추정치로 이익률을 추정: EPS × 발행주식수 ÷ (1 − 법인세율) ÷ 매출 (세전이익률).
  // 시킹알파 EPS는 보통 조정(Non-GAAP) 기준이라 주식보상비용이 빠져 있으므로, 이때는 SBC 차감을 켠다.
  // 추정치가 없는 칸은 최근 실적을 그대로 쓰고(fallback), 화면에 점선으로 표시한다.
  function applyMetricEstimates(s) {
    const raw = s.estRaw || {};
    s.src = s.src || {};
    for (const k of ['margin', 'da', 'capex']) s.src[k] = s.src[k] || [];
    for (let t = 1; t <= N; t++) {
      const y = s.baseFY + t, rev = s.revenue[t];
      if (!(rev > 0)) continue;
      const ebit = raw.ebit && raw.ebit[y], ebitda = raw.ebitda && raw.ebitda[y], capex = raw.capex && raw.capex[y];
      const eps = raw.eps && raw.eps[y];
      if (ebit != null) { s.margin[t] = +(ebit / rev).toFixed(4); s.src.margin[t] = 'est'; }
      else if (eps != null && s.shares > 0 && s.tax < 1) {
        s.margin[t] = +(eps * s.shares / (1 - s.tax) / rev).toFixed(4);
        s.src.margin[t] = 'eps';
        if (!s.sbcOn && s.sbc > 0) s.sbcOn = true;
      }
      if (ebitda != null && ebit != null) { s.da[t] = +Math.max(0, (ebitda - ebit) / rev).toFixed(4); s.src.da[t] = 'est'; }
      if (capex != null) { s.capex[t] = +(Math.abs(capex) / rev).toFixed(4); s.src.capex[t] = 'est'; }
    }
  }

  // ---------- 4. 결과 ----------
  // ---------- 트레이딩뷰 차트 (무료 위젯) ----------
  let chartTicker = null;
  function renderChart() {
    const t = (state.ticker || '').trim().toUpperCase();
    $('#chart-card').hidden = !t;
    if (!t || t === chartTicker) return;
    chartTicker = t;
    const box = $('#tv-chart');
    box.innerHTML = '<div class="tradingview-widget-container" style="height:100%;width:100%"><div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div></div>';
    const sc = document.createElement('script');
    sc.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    sc.async = true;
    sc.textContent = JSON.stringify({
      autosize: true, symbol: t, interval: 'D', timezone: 'Asia/Seoul', locale: 'kr',
      theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      style: '1', allow_symbol_change: false, hide_side_toolbar: false, withdateranges: true, support_host: 'https://www.tradingview.com',
    });
    box.firstChild.appendChild(sc);
    renderSignals(t);
  }

  // ---------- 매수 신호 (js/strategy.js 조건을 야후 일봉으로 계산) ----------
  const fmtP = v => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtR = r => `<span class="chg ${r >= 0 ? 'up' : 'down'}">${r >= 0 ? '+' : ''}${(r * 100).toFixed(1)}%</span>`;
  function findSignals(d, strat) {
    const out = strat.run(d, window.TA);
    const list = [];
    d.close.forEach((c, i) => {
      if (out.buy && out.buy[i]) list.push({ i, kind: 'buy' });
      else if (out.sell && out.sell[i]) list.push({ i, kind: 'sell' });
    });
    return list;
  }
  async function renderSignals(t) {
    const strat = window.STRATEGY;
    $('#sig-name').textContent = strat ? strat.name + ' · ' + strat.desc : '';
    $('#sig-badge').className = 'sig-badge';
    $('#sig-badge').textContent = '신호 계산 중…';
    $('#sig-last').textContent = '';
    $('#sig-more').hidden = true;
    let d;
    try {
      const res = await fetch('api/prices?ticker=' + encodeURIComponent(t));
      d = await res.json();
      if (!res.ok || !d.close || !d.close.length) throw new Error(d.error || '주가 없음');
    } catch (e) {
      if (chartTicker === t) { $('#sig-badge').textContent = '신호 계산 불가'; $('#sig-last').textContent = '주가를 불러오지 못했습니다: ' + (e.message || e); }
      return;
    }
    if (chartTicker !== t) return; // 그 사이 다른 종목으로 바뀜
    let list;
    try { list = findSignals(d, strat); } catch (e) {
      $('#sig-badge').textContent = '신호 계산 불가'; $('#sig-last').textContent = '조건 계산 오류: ' + (e.message || e); return;
    }
    const n = d.close.length, last = d.close[n - 1];
    const latest = list[list.length - 1];
    const badge = $('#sig-badge');
    if (latest && latest.i === n - 1) {
      badge.className = 'sig-badge ' + latest.kind;
      badge.textContent = latest.kind === 'buy' ? '오늘 매수 신호' : '오늘 매도 신호';
    } else {
      badge.className = 'sig-badge none';
      badge.textContent = '오늘은 신호 없음';
    }
    if (latest) {
      const days = n - 1 - latest.i;
      $('#sig-last').innerHTML = `마지막 신호: <b>${latest.kind === 'buy' ? '매수' : '매도'}</b> · ${d.time[latest.i]}${days ? ` (${days}거래일 전)` : ''} · ${fmtP(d.close[latest.i])}` +
        (days ? ` → 지금 ${fmtP(last)} ${fmtR(last / d.close[latest.i] - 1)}` : '');
      const rows = list.slice(-10).reverse().map(s =>
        `<tr><td>${d.time[s.i]}</td><td><span class="sig-tag ${s.kind}">${s.kind === 'buy' ? '매수' : '매도'}</span></td><td>${fmtP(d.close[s.i])}</td><td>${s.i === n - 1 ? '-' : fmtR(last / d.close[s.i] - 1)}</td></tr>`).join('');
      $('#sig-table').innerHTML = `<thead><tr><th>날짜</th><th>신호</th><th>그날 종가</th><th>지금까지</th></tr></thead><tbody>${rows}</tbody>`;
      $('#sig-more').hidden = false;
    } else {
      $('#sig-last').textContent = `최근 ${d.time[0]} 이후로 신호가 한 번도 없었습니다.`;
    }
  }

  function recalc() {
    save();
    renderChart();
    renderBasic();
    const bw = basicWarnings();
    renderHero(!bw.length, bw);
    renderSens();
  }

  function peRow(chg, money, LABEL) {
    const pe = state.basic.pe;
    if (!(pe > 0)) return '';
    const es = [1, 2, 3].map(t => epsAt(state, t));
    if (!es.some(e => Number.isFinite(e.v))) return '';
    const calc = es.some(e => !e.est);
    return `<div class="fv-title">P/E 방식 <span class="muted">예상 EPS × ${(+pe).toFixed(1)}배${calc ? ' · † EPS 추정치가 없어 계산값 사용' : ''}</span></div>
      <div class="fv-row">${es.map((e, k) => `
        <div class="fv pe"><div class="k">${LABEL[k]}${e.est ? '' : ' †'} <span class="muted">EPS $${fmt(e.v, 2)}</span></div>
          <div class="v">${money(e.v * pe)}</div>${chg(e.v * pe)}</div>`).join('')}
      </div>`;
  }

  function renderHero(ok, warn) {
    const name = state.companyName || state.ticker || '';
    if (!state.revenue[0] && !state.shares && !(state.basic && state.basic.rev0)) { $('#hero').innerHTML = '<p class="muted">티커를 넣고 계산을 누르세요.</p>'; return; }
    const rs = rolling(), r = rs[0].r, price = state.price;
    const chg = v => {
      if (!ok || !(price > 0) || !Number.isFinite(v)) return '';
      const u = v / price - 1;
      return `<span class="chg ${u >= 0 ? 'up' : 'down'}">${u >= 0 ? '+' : ''}${pct(u)}</span>`;
    };
    const money = v => (ok && Number.isFinite(v) ? '$' + fmt(v, 2) : '–');
    const LABEL = ['지금', '내년', '내후년'];
    const partial = rs.some(x => x.k && !x.full);
    $('#hero').innerHTML = `
      <div class="hero-top">
        <div class="hero-name">${esc(name)}${state.ticker && name !== state.ticker ? ` <span class="muted">${esc(state.ticker)}</span>` : ''}</div>
        <div class="hero-price">현재가 <b>${price ? '$' + fmt(price, 2) : '–'}</b></div>
      </div>
      <div class="hero-item main"><div class="k">지금 적정가</div><div class="v">${money(r.perShare)}</div>
        <div class="hero-sub">${price && ok ? `현재가보다 ${chg(r.perShare)}` : ''}</div></div>
      <div class="fv-title">DCF <span class="muted">현금흐름 할인</span></div>
      <div class="fv-row">${rs.map(x => `
        <div class="fv${x.k ? '' : ' now'}"><div class="k">${LABEL[x.k]}${x.k && !x.full ? ' *' : ''}</div>
          <div class="v">${money(x.r.perShare)}</div>${chg(x.r.perShare)}</div>`).join('')}
      </div>
      ${peRow(chg, money, LABEL)}
      <p class="hero-note">${r.horizon}년 예측 · 매출 성장률 ${pct(state.basic.growth)} · 영업이익률 ${pct(state.basic.margin)} · 할인율 ${pct(state.wacc)} · 영구성장률 ${pct(state.g)}<br>
        내년·내후년 적정가는 1년, 2년 뒤에 같은 방식(${r.horizon}년 예측)으로 계산한 값입니다. 현금·차입금·주식수는 지금과 같다고 봅니다.` +
        (partial ? '<br>* 그 해까지의 매출 추정치가 모자라 마지막 성장률을 이어 썼습니다. 시킹알파 매출 추정치를 5년치 넣으면 정확해집니다.' : '') + '</p>' +
      (warn.length ? `<div class="warn">${warn.join('<br>')}</div>` : '');
  }

  // 지금·내년·내후년 적정가: 같은 방식으로 3년 창을 1년씩 뒤로 밀어 계산.
  // 내년 적정가 = 1년차 매출에서 출발해 2~4년차를 예측한 값. 현금·차입금·주식수는 지금과 같다고 봄.
  function lastRealEst(s) {
    let tk = 0;
    for (let t = 1; t <= 5; t++) { if (s.revenue[t] > 0 && !(s.revAssumed && s.revAssumed[t])) tk = t; else break; }
    return tk;
  }
  function rolling() {
    const out = [], tk = lastRealEst(state);
    for (let k = 0; k <= 2; k++) {
      const inp = basicInput(), b = state.basic, user = b.src.growth === 'user';
      let full = true;
      if (k) {
        const r0 = !user && k <= tk ? state.revenue[k] : inp.rev0 * Math.pow(1 + inp.growth, k);
        const end = Math.min(k + inp.years, tk);
        if (!user && end > k) inp.growth = Math.pow(state.revenue[end] / r0, 1 / (end - k)) - 1;
        full = user || k + inp.years <= tk;
        inp.rev0 = r0;
      }
      out.push({ k, r: DCF.simple(inp), full });
    }
    return out;
  }

  function activeResult() { return DCF.simple(basicInput()); }
  function basicWarnings() {
    const w = [];
    if (!(state.basic.rev0 > 0)) w.push('0년차 매출을 넣어주세요.');
    if (!(state.shares > 0)) w.push('발행주식수를 넣어주세요.');
    if (state.wacc <= state.g) w.push('할인율이 영구성장률보다 커야 합니다.');
    return w;
  }

  // 기본(강의) 방식 화면: 가정 입력 + 원본 엑셀과 같은 5년 표
  function renderBasicForm() {
    const b = state.basic;
    $('#basic-form').innerHTML = BASIC_FIELDS.map(f => {
      const v = f.shared ? state[f.key] : b[f.key];
      const src = f.shared ? (f.hint || '') : (b.src[f.key] === 'user' ? '직접 입력' : b.src[f.key] || '');
      return `<label>${f.label}<input data-basic="${f.key}" type="number" step="any" value="${esc(f.type === 'pct' ? toInput(v, true) : v)}">` +
        (src ? `<span class="hint">${esc(src)}</span>` : '') + '</label>';
    }).join('');
  }
  $('#basic-form').addEventListener('input', e => {
    const key = e.target.dataset.basic;
    if (!key) return;
    const f = BASIC_FIELDS.find(x => x.key === key);
    const v = f.type === 'int' ? Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 5)) : fromInput(e.target.value, f.type === 'pct');
    if (f.shared) state[key] = v;
    else { state.basic[key] = v; state.basic.src[key] = 'user'; }
    recalc();
  });
  function renderBasic() {
    const r = DCF.simple(basicInput());
    const cols = r.rows;
    const line = (label, f) => `<tr><td>${label}</td>${cols.map(x => `<td>${f(x)}</td>`).join('')}</tr>`;
    $('#basic-table').innerHTML =
      `<thead><tr><th>백만 $</th>${cols.map(x => `<th>${x.t}년차</th>`).join('')}</tr></thead><tbody>` +
      line('매출액', x => fmt(x.revenue)) + line('영업이익 (EBIT)', x => fmt(x.ebit)) + line('법인세', x => fmt(x.taxes)) +
      line('세후영업이익 (NOPAT)', x => fmt(x.nopat)) + line('감가상각비', x => fmt(x.da)) + line('캐펙스', x => fmt(x.capex)) +
      line('순운전자본증감', x => fmt(x.dNwc)) + line('<b>잉여현금흐름 FCFF</b>', x => '<b>' + fmt(x.fcff) + '</b>') +
      line('할인계수', x => x.df.toFixed(4)) + line('FCFF 현재가치', x => fmt(x.pv)) + '</tbody>';
    const kv = (k, v, cls = '') => `<tr${cls}><td>${k}</td><td>${v}</td></tr>`;
    $('#basic-sum').innerHTML = '<tbody>' +
      kv('FCFF 현재가치 합계', fmt(r.pvSum)) + kv('영구가치', fmt(r.tv)) + kv('영구가치의 현재가치', fmt(r.pvTv)) +
      kv('기업가치', fmt(r.ev)) + kv('차감: 총차입금', fmt(-state.debt)) + kv('가산: 보유현금', fmt(state.cash)) +
      kv('자기자본가치', fmt(r.equity)) + kv('<b>1주당 내재가치</b>', '<b>$' + fmt(r.perShare, 2) + '</b>') + '</tbody>';
  }

  function renderSens() {
    const step = 0.01;
    const waccs = [-2, -1, 0, 1, 2].map(i => +(state.wacc + i * step).toFixed(4));
    const gs = [-1, -0.5, 0, 0.5, 1].map(i => +(state.g + i * step).toFixed(4));
    const m = waccs.map(w => gs.map(g => (w > g ? DCF.simple(Object.assign(basicInput(), { wacc: w, g })).perShare : null)));
    let h = '<thead><tr><th>WACC \\ g</th>' + gs.map(g => `<th>${pct(g)}</th>`).join('') + '</tr></thead><tbody>';
    waccs.forEach((w, i) => {
      h += `<tr><th>${pct(w)}</th>` + gs.map((g, j) => {
        const v = m[i][j];
        const base = i === 2 && j === 2 ? ' class="base"' : '';
        return `<td${base}>${v == null || !Number.isFinite(v) ? '–' : '$' + fmt(v, 0)}</td>`;
      }).join('') + '</tr>';
    });
    $('#sens').innerHTML = h + '</tbody>';
  }

  // ---------- 시킹알파 재무제표 PDF → 실적·현금·차입금·주식수 덮어쓰기 ----------
  // PDF 3개(Income Statement, Balance Sheet, Cash Flow, Annual)를 읽어 야후 값 대신 쓴다.
  // 주가·베타·매출 컨센서스는 PDF에 없으므로 티커 조회 값(또는 현재 입력값)을 그대로 둔다.
  const PDFJS = CDN + 'pdfjs-dist@3.11.174/build/';
  let pdfjsReady = null;
  function loadPdfJs() {
    if (!pdfjsReady) {
      pdfjsReady = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = PDFJS + 'pdf.min.js';
        s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; resolve(window.pdfjsLib); };
        s.onerror = () => { pdfjsReady = null; reject(new Error('PDF 읽기 도구를 불러오지 못했습니다')); };
        document.head.appendChild(s);
      });
    }
    return pdfjsReady;
  }
  async function readPdf(file) {
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      pages.push(tc.items.map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width })));
    }
    return SAPdf.parsePages(pages);
  }

  const KIND_KO = { income: '손익계산서', balance: '대차대조표', cashflow: '현금흐름표' };
  async function handlePdfs(files) {
    const out = $('#pdf-result');
    files = [...files].filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (!files.length) return;
    out.innerHTML = '<p class="muted small">PDF 읽는 중...</p>';
    try {
      const st = {};
      const unknown = [];
      for (const f of files) {
        const r = await readPdf(f);
        if (r.kind && r.columns.length) st[r.kind] = r; else unknown.push(f.name);
      }
      if (!Object.keys(st).length) throw new Error('시킹알파 재무제표 PDF가 아닌 것 같습니다 (표 제목·연도 열을 못 찾음)');
      const p = SAPdf.toInputs(st);
      applyPdf(p, unknown);
    } catch (err) {
      out.innerHTML = `<p class="neg small">PDF 읽기 실패: ${esc(err.message)}</p>`;
    }
  }

  function applyPdf(p, unknown) {
    const prev = state;
    const hadLookup = !!(lastLookup && lastLookup.ticker === prev.ticker);
    const base = hadLookup ? lastLookup : {
      ticker: prev.ticker, companyName: prev.ticker, currentPrice: prev.price, beta: prev.beta,
      sharesOutstandingMillions: prev.shares, cash: prev.cash, debt: prev.debt, debtNote: '입력값', history: [], estimates: [],
    };
    // 연도별: PDF 값이 있으면 PDF, 없으면 조회 값
    const baseH = new Map((base.history || []).map(x => [x.fy, x]));
    const years = p.history.length ? p.history : base.history || [];
    const history = years.map(x => {
      const b = baseH.get(x.fy) || {};
      const m = { ...b };
      for (const [k, v] of Object.entries(x)) if (v != null) m[k] = v;
      return m;
    });
    if (!history.length || !history[history.length - 1].revenue) {
      $('#pdf-result').innerHTML = '<p class="neg small">매출 실적이 없습니다. 손익계산서 PDF를 함께 올리거나 먼저 티커를 조회하세요.</p>';
      return;
    }
    const b = p.balance;
    const merged = {
      ...base, history,
      source: '시킹알파 PDF' + (hadLookup ? ' + 야후(주가·컨센서스)' : ''),
      sharesOutstandingMillions: b && b.shares ? b.shares : base.sharesOutstandingMillions,
      cash: b && b.cash != null ? b.cash : base.cash,
      debt: b && b.debt != null ? b.debt : base.debt,
      debtNote: b && b.debt != null ? '단기+유동성장기+장기차입금 (리스·금융 자회사 제외)' : base.debtNote,
      balanceDate: b ? b.column : base.balanceDate,
    };
    const next = assumptionsFrom(merged);
    // 같은 종목이면 이미 넣어 둔 매출 추정치(시킹알파 캡처 등)와 예측 기간은 그대로 둔다
    if (prev.ticker && prev.ticker === next.ticker && prev.baseFY === next.baseFY) {
      for (let t = 1; t <= N; t++) { next.revenue[t] = prev.revenue[t]; next.growth[t] = prev.growth[t]; }
      next.revAssumed = prev.revAssumed;
      next.horizon = prev.horizon;
      next.wacc = prev.wacc; next.g = prev.g; next.rf = prev.rf; next.erp = prev.erp;
      next.estRaw = prev.estRaw;
      applyMetricEstimates(next); // 캡처한 EBIT·EBITDA·캐펙스 추정치는 PDF 실적보다 우선
      next.basic = prev.basic;
    }
    // 운전자본은 PDF에서 금융 자회사 채권을 뺀 값이므로 20% 상한 안내는 필요 없음
    const last = history[history.length - 1];
    if (p.kinds.includes('balance') && last.nwcPct != null) {
      next.nwc = Array(N + 1).fill(+Math.max(-0.1, Math.min(0.5, last.nwcPct)).toFixed(4));
      next.nwcNote = '';
    }
    basicRefresh(next);

    const rows = [
      ['매출 (0년차)', prev.revenue[0], next.revenue[0], fmt],
      ['영업이익률', prev.margin[1], next.margin[1], pct],
      ['감가상각비/매출', prev.da[1], next.da[1], v => pct(v, 2)],
      ['캐펙스/매출', prev.capex[1], next.capex[1], v => pct(v, 2)],
      ['운전자본/매출', prev.nwc[1], next.nwc[1], pct],
      ['법인세율', prev.tax, next.tax, pct],
      ['발행주식수 (백만 주)', prev.shares, next.shares, v => fmt(v, 1)],
      ['현금+단기투자', prev.cash, next.cash, fmt],
      ['차입금', prev.debt, next.debt, fmt],
    ];
    const prevPS = activeResult().perShare;
    state = next;
    lastLookup = merged;
    renderAll();
    renderHistory(merged);
    const nowPS = activeResult().perShare;
    const notes = [];
    if (b && (b.financeDebt || b.financeLoans)) {
      notes.push(`금융 자회사(Finance Div.) 차입금 ${fmt(b.financeDebt)}와 대출채권 ${fmt(b.financeLoans)}은 차입금·운전자본에서 뺐습니다.`);
    }
    if (b && b.column === 'Last Report') notes.push('현금·차입금·주식수는 가장 최근 분기(Last Report) 값입니다.');
    const missing = ['income', 'balance', 'cashflow'].filter(k => !p.kinds.includes(k));
    if (missing.length) notes.push(`${missing.map(k => KIND_KO[k]).join(', ')} PDF가 없어 그 항목은 기존 값을 썼습니다.`);
    if (unknown.length) notes.push(`읽지 못한 파일: ${unknown.map(esc).join(', ')}`);
    if (!hadLookup) notes.push('주가·매출 컨센서스는 PDF에 없습니다. 티커를 먼저 조회하면 함께 채워집니다.');
    const same = (a, c) => a != null && c != null && Math.abs(a - c) <= Math.max(1e-4, Math.abs(c) * 1e-4);
    $('#pdf-result').innerHTML =
      `<p class="small"><b>${p.kinds.map(k => KIND_KO[k]).join(' · ')} PDF 값을 넣었습니다.</b> 1주당 가치 $${fmt(prevPS, 2)} → <b>$${fmt(nowPS, 2)}</b></p>` +
      `<div class="table-scroll"><table class="grid"><thead><tr><th>항목</th><th>이전 값</th><th>PDF 값</th></tr></thead><tbody>` +
      rows.map(([l, a, c, f]) => `<tr><td>${l}</td><td class="muted">${f(a)}</td><td${same(a, c) ? '' : ' class="pos"'}>${f(c)}</td></tr>`).join('') +
      '</tbody></table></div>' +
      (notes.length ? `<p class="muted small">${notes.join('<br>')}</p>` : '');
  }

  const pdfDrop = $('#pdf-drop');
  pdfDrop.addEventListener('click', () => $('#pdf-file').click());
  pdfDrop.addEventListener('keydown', e => { if (e.key === 'Enter') $('#pdf-file').click(); });
  $('#pdf-file').addEventListener('change', e => { handlePdfs(e.target.files); e.target.value = ''; });
  pdfDrop.addEventListener('dragover', e => { e.preventDefault(); pdfDrop.classList.add('over'); });
  pdfDrop.addEventListener('dragleave', () => pdfDrop.classList.remove('over'));
  pdfDrop.addEventListener('drop', e => { e.preventDefault(); pdfDrop.classList.remove('over'); handlePdfs(e.dataTransfer.files); });

  // ---------- 1. 캡처 업로드 & 읽기 ----------
  // 캡처 칸 2개: ① EPS 표, ② 매출 표. 칸마다 따로 읽고, 읽은 값은 아래 표 하나에 모읍니다.
  let estimates = [];
  const SLOT_KO = { eps: 'EPS 표', revenue: '매출 표' };
  const slots = [...document.querySelectorAll('.drop[data-slot]')];
  let pasteSlot = null; // 마지막으로 누르거나 가리킨 칸 (Ctrl+V 대상)

  for (const drop of slots) {
    const input = drop.querySelector('input[type=file]');
    drop.addEventListener('click', () => { pasteSlot = drop; input.click(); });
    drop.addEventListener('focus', () => { pasteSlot = drop; });
    drop.addEventListener('mouseenter', () => { pasteSlot = drop; });
    drop.addEventListener('keydown', e => { if (e.key === 'Enter') input.click(); });
    input.addEventListener('change', e => { if (e.target.files[0]) setImage(drop, e.target.files[0]); e.target.value = ''; });
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => {
      e.preventDefault(); drop.classList.remove('over');
      const files = [...e.dataTransfer.files];
      if (files.some(x => x.type === 'application/pdf')) { handlePdfs(files); return; } // 재무제표 PDF를 여기 놓아도 처리
      const f = files.find(x => x.type.startsWith('image/'));
      if (f) setImage(drop, f);
    });
  }
  document.addEventListener('paste', e => {
    // 북마클릿이 복사해 둔 시킹알파 자료
    const txt = e.clipboardData && e.clipboardData.getData('text/plain');
    if (txt && txt.includes('"dcf-sa"')) {
      try { const d = JSON.parse(txt); if (d.type === 'dcf-sa') { e.preventDefault(); receiveSA(d); return; } } catch (x) { /* 일반 글자 */ }
    }
    const item = [...(e.clipboardData || {}).items || []].find(x => x.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    // 칸을 누르거나 가리킨 적이 없으면 비어 있는 첫 칸에 넣음
    const target = pasteSlot || slots.find(d => !d.image) || slots[0];
    setImage(target, item.getAsFile());
  });

  function setImage(drop, blob) {
    const reader = new FileReader();
    reader.onload = () => {
      drop.image = { blob, dataUrl: reader.result };
      const img = drop.querySelector('.preview');
      img.src = reader.result;
      img.hidden = false;
      readSlot(drop); // 올리자마자 바로 읽음
    };
    reader.readAsDataURL(blob);
  }

  async function readSlot(drop) {
    const slot = drop.dataset.slot;
    const status = drop.parentElement.querySelector('.slot-status');
    try {
      let result;
      if (modeSel.value === 'claude') {
        status.textContent = 'Claude가 이미지를 읽는 중...';
        result = await readWithClaude(drop.image);
      } else {
        status.textContent = 'OCR 준비 중... (처음 한 번은 언어 데이터를 내려받느라 조금 걸립니다)';
        const text = await readWithTesseract(drop.image, p => { status.textContent = p; });
        result = SAParser.parseEstimates(text, slot);
        result.text = text;
      }
      // 이 칸에서 전에 읽은 값은 지우고 새로 읽은 값으로 바꿈
      const found = result.estimates.map(x => Object.assign({ use: true, slot }, x, { metric: x.metric || slot }));
      estimates = estimates.filter(e => e.slot !== slot && !found.some(f => f.metric === e.metric && f.year === e.year)).concat(found);
      renderEstimates((result.warnings || []).map(w => `${SLOT_KO[slot]}: ${w}`), result.text || '');
      const n = found.filter(e => e.metric === slot).length;
      status.textContent = n ? `${SAParser.METRIC_KO[slot]} ${n}개를 읽었습니다.` : found.length ? `읽었지만 ${SAParser.METRIC_KO[slot]} 표가 아닌 것 같습니다. 아래 표에서 확인하세요.` : '표를 읽지 못했습니다.';
      $('#ocr-status').textContent = estimates.length ? `추정치 ${estimates.length}개를 찾았습니다. 확인하고 "계산에 반영"을 누르세요.` : '';
    } catch (err) {
      console.error(err);
      status.textContent = '읽기 실패: ' + (err.message || err);
    }
  }

  // OCR 방식 선택
  const modeSel = $('#ocr-mode');
  function syncMode() {
    const claude = modeSel.value === 'claude';
    $('#key-wrap').hidden = !claude;
    $('#key-note').hidden = !claude;
  }
  modeSel.addEventListener('change', syncMode);
  try { $('#api-key').value = localStorage.getItem(KEY_STORE) || ''; } catch (e) { /* ignore */ }
  $('#api-key').addEventListener('change', e => { try { localStorage.setItem(KEY_STORE, e.target.value.trim()); } catch (x) { /* ignore */ } });

  // 스크린샷 전처리: 확대 + 흑백 + (다크모드면) 반전 → Tesseract 인식률 개선
  function preprocess(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(3, Math.max(1, 2000 / img.width));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const d = ctx.getImageData(0, 0, c.width, c.height);
        const px = d.data;
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) {
          const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
          px[i] = px[i + 1] = px[i + 2] = y;
          sum += y;
        }
        if (sum / (px.length / 4) < 128) for (let i = 0; i < px.length; i += 4) px[i] = px[i + 1] = px[i + 2] = 255 - px[i];
        ctx.putImageData(d, 0, 0);
        resolve(c);
      };
      img.onerror = () => reject(new Error('이미지를 열 수 없습니다.'));
      img.src = dataUrl;
    });
  }

  let workerPromise = null;
  let ocrProgress = () => {}; // 지금 읽고 있는 칸의 진행 표시
  function getWorker() {
    if (!workerPromise) {
      workerPromise = Tesseract.createWorker('eng', 1, {
        workerPath: CDN + 'tesseract.js@5.1.1/dist/worker.min.js',
        corePath: CDN + 'tesseract.js-core@5.1.1',
        langPath: CDN + '@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
        logger: m => {
          if (m.status && typeof m.progress === 'number') ocrProgress(`OCR: ${m.status} ${Math.round(m.progress * 100)}%`);
        },
      }).then(async w => {
        await w.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
        return w;
      });
      workerPromise.catch(() => { workerPromise = null; });
    }
    return workerPromise;
  }

  async function readWithTesseract(image, onProgress) {
    const canvas = await preprocess(image.dataUrl);
    ocrProgress = onProgress;
    const worker = await getWorker();
    const { data } = await worker.recognize(canvas);
    ocrProgress = () => {};
    return data.text;
  }

  async function readWithClaude(image) {
    const key = $('#api-key').value.trim();
    if (!key) throw new Error('Anthropic API 키를 넣어주세요.');
    const m = /^data:(image\/[a-z+]+);base64,(.*)$/.exec(image.dataUrl);
    if (!m) throw new Error('이미지 형식을 읽을 수 없습니다.');
    const schema = {
      type: 'object',
      properties: {
        estimates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              metric: { type: 'string', enum: ['revenue', 'ebit', 'ebitda', 'capex'] },
              period_label: { type: 'string' },
              fiscal_year: { type: 'integer' },
              value_millions_usd: { type: 'number' },
            },
            required: ['metric', 'period_label', 'fiscal_year', 'value_millions_usd'],
            additionalProperties: false,
          },
        },
        note: { type: 'string' },
      },
      required: ['estimates', 'note'],
      additionalProperties: false,
    };
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 8000,
        fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema } },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
            {
              type: 'text',
              text: 'This is a Seeking Alpha "Earnings Estimates" screenshot. Extract the annual consensus estimates for Revenue, EBIT, ' +
                'EBITDA and Capital Expenditure tables that are visible (the estimate column, not EPS, not Low/High). ' +
                'For each value give the metric, the fiscal period label as shown, ' +
                'the fiscal year (the calendar year in which the fiscal period ends), and the value converted to millions of USD ' +
                '(e.g. 614.82B -> 614820, 950.3M -> 950.3). If something is unclear or the table is quarterly, say so in note (in Korean).',
            },
          ],
        }],
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body.error && body.error.message) || 'HTTP ' + res.status);
    if (body.stop_reason === 'refusal') throw new Error('Claude가 요청을 처리하지 않았습니다.');
    const textBlock = (body.content || []).find(b => b.type === 'text');
    if (!textBlock) throw new Error('응답에 결과가 없습니다.');
    const parsed = JSON.parse(textBlock.text);
    return {
      estimates: parsed.estimates.map(x => ({ metric: x.metric, year: x.fiscal_year, label: x.period_label, value: x.value_millions_usd, raw: 'Claude' })),
      warnings: parsed.note ? [parsed.note] : [],
      text: textBlock.text,
    };
  }

  function slotFor(year) {
    const t = year - state.baseFY;
    return t >= 1 && t <= 5 ? t : null;
  }

  function renderEstimates(warnings, text) {
    $('#est-wrap').hidden = false;
    // 0년차 회계연도가 추정치와 안 맞으면 첫 추정치 직전 해로 맞춰 줌
    if (estimates.length && !estimates.some(e => slotFor(e.year))) {
      state.baseFY = Math.min(...estimates.map(e => e.year)) - 1;
      warnings = warnings.concat(`0년차 회계연도를 FY${state.baseFY}로 바꿨습니다 (첫 추정치 바로 전 해). 다르면 '자세히 보기'에서 고치세요.`);
      recalc();
    }
    $('#warnings').innerHTML = warnings.map(w => `<div class="warn">${esc(w)}</div>`).join('');
    $('#ocr-text').textContent = text;
    drawEstRows();
  }

  function drawEstRows() {
    $('#est-table tbody').innerHTML = estimates.map((e, i) => {
      const t = slotFor(e.year);
      return `<tr>
        <td><input type="checkbox" data-e="use" data-i="${i}" ${e.use ? 'checked' : ''}></td>
        <td><select data-e="metric" data-i="${i}">${Object.entries(SAParser.METRIC_KO).map(([k, l]) => `<option value="${k}"${(e.metric || 'revenue') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
        <td>${esc(e.label)}</td>
        <td><input data-e="year" data-i="${i}" type="number" value="${e.year}" style="width:76px"></td>
        <td class="muted">${esc(e.raw)}</td>
        <td><input class="wide" data-e="value" data-i="${i}" type="number" step="any" value="${+e.value.toFixed(2)}"></td>
        <td>${t ? t + '년차 (FY' + e.year + ')' + (t > MAX_YEARS ? ' <span class="muted small">내년·내후년용</span>' : '') : '<span class="muted">범위 밖</span>'}</td>
      </tr>`;
    }).join('');
  }

  $('#est-table').addEventListener('input', e => {
    const { e: field, i } = e.target.dataset;
    if (!field) return;
    const row = estimates[+i];
    if (field === 'use') row.use = e.target.checked;
    else if (field === 'metric') row.metric = e.target.value;
    else if (field === 'year') { row.year = parseInt(e.target.value, 10) || row.year; drawEstRows(); }
    else row.value = parseFloat(e.target.value) || 0;
  });
  $('#btn-add-row').addEventListener('click', () => {
    const last = estimates.length ? estimates[estimates.length - 1].year : state.baseFY;
    estimates.push({ use: true, metric: 'revenue', year: last + 1, label: '직접 입력', raw: '', value: 0 });
    drawEstRows();
  });
  $('#btn-apply').addEventListener('click', () => {
    const n = {}, raw = state.estRaw || (state.estRaw = {});
    let maxT = 0;
    for (const e of estimates) {
      const t = slotFor(e.year), m = e.metric || 'revenue';
      if (!e.use || !t || !e.value) continue;
      if (m === 'revenue') {
        if (e.value <= 0) continue;
        state.revenue[t] = e.value; if (state.revAssumed) state.revAssumed[t] = false; maxT = Math.max(maxT, t);
      } else (raw[m] = raw[m] || {})[e.year] = e.value;
      n[m] = (n[m] || 0) + 1;
    }
    // 예측 기간 = 매출 추정치가 있는 마지막 해
    if (maxT) state.horizon = Math.min(MAX_YEARS, maxT); // 5년치를 넣어도 3년까지만 계산 (4~5년차는 내년·내후년 적정가에 씀)
    applyMetricEstimates(state);
    basicRefresh(state);
    renderBasicForm();
    recalc();
    const done = Object.entries(n).map(([m, c]) => `${SAParser.METRIC_KO[m]} ${c}개`).join(', ');
    $('#ocr-status').textContent = done ? `${done}를 넣었습니다.` : '넣을 값이 없습니다.';
    $('#hero').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // ---------- 상단 버튼 ----------
  $('#btn-xlsx-basic').addEventListener('click', () => exportBasicXlsx().catch(err => alert('엑셀 만들기 실패: ' + err.message)));

  // 기본(강의) 방식 엑셀: 강의의 「DCF Valuation Model」 시트와 같은 셀 배치·수식 (금액은 달러 단위)
  async function exportBasicXlsx() {
    const wb = new ExcelJS.Workbook();
    wb.calcProperties.fullCalcOnLoad = true;
    const ws = wb.addWorksheet('DCF Valuation Model');
    const b = state.basic, r = DCF.simple(basicInput()), n = r.horizon;
    const M = 1e6;
    const cols = 'BCDEFGHIJKL'.split('').slice(0, n + 1), L = cols[n];
    const put = (addr, v, fmtStr, input) => {
      const c = ws.getCell(addr);
      c.value = v;
      if (fmtStr) c.numFmt = fmtStr;
      if (input) { c.font = { color: { argb: 'FF1A3FAE' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8D6' } }; }
      return c;
    };
    const f = (formula, result) => ({ formula, result });
    const NUMF = '#,##0', PCT = '0.0%';
    ws.getColumn(1).width = 44;
    cols.forEach(c => { ws.getColumn(c).width = 17; });
    put('A1', `${state.companyName || state.ticker || ''} DCF Valuation Model (현금흐름할인법 모델)`).font = { bold: true, size: 13 };
    put('A3', '1. 가정 (Assumptions)').font = { bold: true, color: { argb: 'FFC0362C' } };
    const A = [
      [4, '매출액 성장률 (Revenue Growth Rate)', b.growth, PCT], [5, '영업이익률 (EBIT Margin)', b.margin, PCT], [6, '법인세율 (Tax Rate)', b.tax, PCT],
      [7, '감가상각비/매출 (D&A % of Rev)', b.da, PCT], [8, '자본적지출/매출 (CapEx % of Rev)', b.capex, PCT],
      [9, '순운전자본증감/매출 (NWC % of Rev) 일상적인 활동을 유지', b.nwc, PCT], [10, '가중평균자본비용 (WACC) 할인율', state.wacc, PCT],
      [11, '영구성장률 (Terminal Growth Rate)', state.g, PCT], [12, '발행주식수 (Shares Outstanding)', state.shares * M, NUMF],
      [13, '보유현금 (Current Cash)', state.cash * M, NUMF], [14, '총차입금 (Current Debt)', state.debt * M, NUMF],
    ];
    for (const [row, label, v, nf] of A) { put('A' + row, label); put('B' + row, v, nf, true); }
    put('A16', '2. 현금흐름 추정 (Cash Flow Projections)').font = { bold: true, color: { argb: 'FFC0362C' } };
    cols.forEach((c, t) => put(c + '16', t === 0 ? '0년차 (현재)' : t + '년차'));
    const labels = { 17: '매출액 (Revenue)', 18: '영업이익 (EBIT) 매출액*영업이익률', 19: '법인세 (Taxes) 영업이익*법인세율', 20: '세후영업이익 (NOPAT) 영업이익*(1-법인세율)',
      21: '감가상각비 (D&A) 매출액*감가상각비', 22: '자본적지출 (CapEx) 매출액*자본적지출', 23: '순운전자본증감 (Change in NWC)', 24: '잉여현금흐름 (FCFF) B20+B21-B22-B23' };
    Object.entries(labels).forEach(([row, l]) => put('A' + row, l));
    const rev0 = b.rev0 * M;
    cols.forEach((c, t) => {
      const x = t ? r.rows[t - 1] : null, p = cols[t - 1];
      put(c + 17, t === 0 ? rev0 : f(`${p}17*(1+$B$4)`, x.revenue * M), NUMF, t === 0);
      put(c + 18, f(`${c}17*$B$5`, (t ? x.ebit : rev0 * b.margin / M) * M), NUMF);
      put(c + 19, f(`${c}18*$B$6`, (t ? x.taxes : rev0 * b.margin * b.tax / M) * M), NUMF);
      put(c + 20, f(`${c}18*(1-$B$6)`, (t ? x.nopat : rev0 * b.margin * (1 - b.tax) / M) * M), NUMF);
      put(c + 21, f(`${c}17*$B$7`, (t ? x.da : rev0 * b.da / M) * M), NUMF);
      put(c + 22, f(`${c}17*$B$8`, (t ? x.capex : rev0 * b.capex / M) * M), NUMF);
      put(c + 23, f(`${c}17*$B$9`, (t ? x.dNwc : rev0 * b.nwc / M) * M), NUMF);
      put(c + 24, f(`${c}20+${c}21-${c}22-${c}23`, t ? x.fcff * M : null), NUMF);
      put(c + 27, t === 0 ? 1 : f(`1/((1+$B$10)^${t})`, x.df), '0.0000');
      put(c + 28, f(`${c}24*${c}27`, t ? x.pv * M : null), NUMF);
    });
    put('A26', '3. 가치평가 (Valuation)').font = { bold: true, color: { argb: 'FFC0362C' } };
    put('A27', '할인계수 (Discount Factor) 미래현금흐름을 현재가치로 환산');
    put('A28', 'FCFF의 현재가치 (PV of FCF) B24*B27');
    const V = [
      [30, 'FCFF 현재가치 합계 (Sum of PV of FCF)', `SUM(C28:${L}28)`, r.pvSum * M],
      [31, '영구가치 (Terminal Value)', `${L}24*(1+$B$11)/($B$10-$B$11)`, r.tv * M],
      [32, '영구가치의 현재가치 (PV of Terminal Value)', `B31*${L}27`, r.pvTv * M],
      [33, '기업가치 (Enterprise Value)', 'B30+B32', r.ev * M],
      [34, '차감: 총차입금 (Less: Debt)', '-$B$14', -state.debt * M],
      [35, '가산: 보유현금 (Plus: Cash)', '$B$13', state.cash * M],
      [36, '자기자본가치 (Equity Value)', 'B33+B34+B35', r.equity * M],
      [37, '1주당 내재가치 (Implied Share Price)', 'B36/$B$12', r.perShare],
    ];
    for (const [row, label, formula, v] of V) { put('A' + row, label); put('B' + row, f(formula, v), row === 37 ? '#,##0.00' : NUMF); }
    ws.getCell('A37').font = { bold: true, color: { argb: 'FFC0362C' } };
    ws.getCell('B37').font = { bold: true };
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.ticker || 'DCF'}_DCF_기본_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('입력값을 모두 지울까요?')) return;
    state = blank(); renderAll();
  });
  function renderAll() {
    renderBasicForm();
    recalc();
  }

  // ---------- 시킹알파 자동 가져오기 (북마클릿) ----------
  // 사용자가 로그인한 시킹알파 페이지에서 북마크를 누르면, 그 브라우저 안에서 시킹알파 자료를 읽어 이 창으로 보냅니다.
  // 비밀번호나 로그인 정보는 이 사이트로 오지 않습니다.
  const SA_ORIGIN = 'https://seekingalpha.com';

  /* 시킹알파 페이지에서 실행되는 코드 (북마클릿으로 문자열이 되어 들어가므로 바깥 변수를 쓰면 안 됨) */
  function saGrab(site) {
    if (!/(^|\.)seekingalpha\.com$/.test(location.hostname)) { alert('시킹알파 종목 페이지에서 눌러 주세요.'); return; }
    const m = location.pathname.match(/\/symbol\/([^/?#]+)/i);
    let t = m ? decodeURIComponent(m[1]) : prompt('티커를 입력하세요', '');
    if (!t) return;
    t = t.trim().toUpperCase();
    const w = window.open(site + '?t=' + encodeURIComponent(t) + '&sa=1', 'dcf-calc');
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;background:#fff;color:#111;border:2px solid #2563eb;border-radius:10px;padding:12px 14px;font:14px/1.5 sans-serif;max-width:320px;box-shadow:0 6px 24px rgba(0,0,0,.2)';
    box.textContent = 'DCF: 시킹알파 자료를 읽는 중...';
    document.body.appendChild(box);
    const get = u => fetch(u, { credentials: 'include', headers: { accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(u.split('?')[0] + ' ' + r.status))));
    const items = 'revenue_consensus_mean,eps_normalized_consensus_mean,revenue_actual,eps_normalized_actual';
    const text = ((document.querySelector('main') || document.body).innerText || '').slice(0, 80000);
    get('/api/v3/symbols/' + encodeURIComponent(t.toLowerCase()))
      .then(j => get('/api/v3/symbol_data/estimates?estimates_data_items=' + items + '&period_type=annual&relative_periods=-3,-2,-1,0,1,2,3,4,5,6,7,8,9&ticker_ids=' + j.data.id))
      .then(est => ({ est }), err => ({ error: String(err && err.message || err) }))
      .then(r => {
        const data = Object.assign({ type: 'dcf-sa', v: 1, ticker: t, page: location.href, text }, r);
        const json = JSON.stringify(data);
        let sent = false;
        const origin = new URL(site).origin;
        const send = () => { if (!sent && w && !w.closed) { w.postMessage(data, origin); } };
        window.addEventListener('message', e => {
          if (e.origin !== origin) return;
          if (e.data === 'dcf-ready') send();
          if (e.data === 'dcf-got') { sent = true; box.textContent = 'DCF: 보냈습니다. DCF 창을 확인하세요.'; setTimeout(() => box.remove(), 4000); }
        });
        send();
        setTimeout(() => {
          if (sent) return;
          box.textContent = 'DCF 창으로 바로 보내지 못했습니다. 아래 버튼을 누른 뒤 DCF 창에서 Ctrl+V 하세요. ';
          const b = document.createElement('button');
          b.textContent = '자료 복사';
          b.style.cssText = 'display:block;margin-top:8px;padding:6px 12px;border-radius:6px;border:0;background:#2563eb;color:#fff;font-weight:600;cursor:pointer';
          b.onclick = () => navigator.clipboard.writeText(json).then(() => { b.textContent = '복사됨 → DCF 창에서 Ctrl+V'; }, () => prompt('복사해서 DCF 창에 붙여넣으세요', json));
          box.appendChild(b);
        }, 5000);
      });
  }

  function bookmarkletHref() {
    const site = location.origin + location.pathname;
    return 'javascript:' + encodeURIComponent('(' + saGrab.toString() + ')(' + JSON.stringify(site) + ');void 0');
  }
  if ($('#sa-bookmarklet')) $('#sa-bookmarklet').href = bookmarkletHref();
  $('#sa-bookmarklet') && $('#sa-bookmarklet').addEventListener('click', e => { e.preventDefault(); alert('이 버튼은 여기서 누르는 게 아니라, 북마크바로 끌어다 놓은 뒤 시킹알파 종목 페이지에서 누릅니다.'); });

  // 시킹알파 API 응답 → 추정치 행. 응답 모양: estimates[티커ID][항목][상대기간] = [{dataitemvalue, period:{fiscalyear, periodenddate}}]
  function saEstimatesFromJson(est) {
    const out = [];
    const root = est && est.estimates;
    if (!root) return out;
    const MET = { revenue_consensus_mean: 'revenue', eps_normalized_consensus_mean: 'eps' };
    for (const tid of Object.keys(root)) {
      for (const [item, byRel] of Object.entries(root[tid] || {})) {
        const metric = MET[item];
        if (!metric || !byRel) continue;
        for (const arr of Object.values(byRel)) {
          const list = (Array.isArray(arr) ? arr : [arr]).filter(x => x && x.dataitemvalue != null && x.period);
          if (!list.length) continue;
          // 같은 기간에 여러 번 수정된 값이 있으면 가장 최근 값
          const x = list.slice().sort((a, b) => String(a.effectivedate || '').localeCompare(String(b.effectivedate || ''))).pop();
          const pe = x.period.periodenddate || '';
          const year = /^\d{4}/.test(pe) ? +pe.slice(0, 4) : +x.period.fiscalyear;
          if (!year) continue;
          let v = parseFloat(x.dataitemvalue);
          if (!Number.isFinite(v)) continue;
          if (metric === 'revenue') v /= 1e6; // 달러 → 백만 달러
          const label = pe ? new Date(pe + 'T00:00:00Z').toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'FY' + year;
          out.push({ metric, year, label, value: v, raw: '시킹알파 자동' });
        }
      }
    }
    // 같은 항목·연도는 하나만
    const seen = new Set();
    return out.filter(e => { const k = e.metric + e.year; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => (a.metric > b.metric ? 1 : a.metric < b.metric ? -1 : a.year - b.year));
  }

  let saReceived = false;
  async function receiveSA(d) {
    saReceived = true;
    const st = $('#sa-status');
    st.textContent = `시킹알파에서 ${d.ticker} 자료를 받았습니다. 계산하는 중...`;
    if (!state.fromLookup || state.ticker !== d.ticker) await lookup(d.ticker);
    let found = saEstimatesFromJson(d.est), how = '시킹알파 추정치 자료';
    // 자료(API)를 못 읽었으면 그 페이지 글자에서 표를 찾음 (Earnings → Estimates 화면일 때)
    if (!found.some(e => e.metric === 'revenue') && d.text) {
      const r = SAParser.parseEstimates(d.text);
      const fromText = r.estimates.filter(e => e.metric === 'revenue' || e.metric === 'eps');
      if (fromText.length > found.length) { found = fromText.map(e => Object.assign({}, e, { raw: '시킹알파 페이지' })); how = '시킹알파 페이지 글자'; }
    }
    if (!found.length) {
      st.innerHTML = '<span class="neg">추정치를 찾지 못했습니다.</span> 시킹알파에서 <b>Earnings → Estimates → Annual</b> 화면을 연 뒤 북마크를 다시 누르거나, 아래 캡처 칸을 쓰세요.' +
        (d.error ? ` <span class="muted">(${esc(d.error)})</span>` : '');
      return;
    }
    estimates = found.map(e => Object.assign({ use: true, slot: 'auto' }, e));
    renderEstimates([], '');
    $('#btn-apply').click();
    const cnt = m => found.filter(e => e.metric === m).length;
    st.textContent = `${how}에서 매출 ${cnt('revenue')}개, EPS ${cnt('eps')}개를 넣고 계산했습니다. 아래 표에서 값을 확인할 수 있습니다.`;
  }

  window.addEventListener('message', e => {
    if (e.origin !== SA_ORIGIN || !e.data || e.data.type !== 'dcf-sa') return;
    try { e.source && e.source.postMessage('dcf-got', SA_ORIGIN); } catch (x) { /* ignore */ }
    if (!saReceived) receiveSA(e.data);
  });

  // 북마클릿이 연 창: 시킹알파 창에 준비됐다고 알리고 자료를 기다림
  function waitForSA(ticker) {
    $('#sa-status').textContent = '시킹알파 자료를 기다리는 중...';
    let n = 0;
    const timer = setInterval(() => {
      if (saReceived) return clearInterval(timer);
      try { window.opener && window.opener.postMessage('dcf-ready', SA_ORIGIN); } catch (x) { /* ignore */ }
      if (++n === 16) {
        $('#sa-status').textContent = '시킹알파 창에서 "자료 복사"를 누른 뒤 여기서 Ctrl+V 하세요.';
        if (ticker) lookup(ticker);
      }
      if (n > 60) clearInterval(timer);
    }, 500);
  }

  syncMode();
  renderAll();
  if (state.info && state.info.history) renderHistory(state.info);
  const qs = new URLSearchParams(location.search), qt = qs.get('t');
  if (qs.get('sa') && window.opener) waitForSA(qt);
  else if (qt) lookup(qt);
})();
