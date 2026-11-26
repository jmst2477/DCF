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
    // 한 해만 튀는 EPS(일회성 투자이익 등)로 추정한 이익률은 평균에서 뺌. 그 해밖에 없으면 그대로 씀
    const spikes = epsSpikes(s);
    const avgSrc = key => {
      const v = [], kinds = new Set(), skipped = [];
      for (let t = 1; t <= H; t++) {
        const k = s.src && s.src[key] && s.src[key][t];
        if (k === 'eps' && spikes.has(s.baseFY + t)) { skipped.push(s.baseFY + t); continue; }
        if (k === 'est' || k === 'eps') { v.push(s[key][t]); kinds.add(k); }
      }
      if (!v.length && skipped.length) { for (const y of skipped) v.push(s[key][y - s.baseFY]); kinds.add('eps'); skipped.length = 0; }
      const skip = skipped.length ? `, ${skipped.join('·')}년 일회성 EPS 제외` : '';
      return v.length ? { v: v.reduce((a, c) => a + c, 0) / v.length, label: kinds.has('est') ? '시킹알파 추정치 평균' : `EPS로 추정 (평균${skip})` } : null;
    };
    const fromEps = {};
    for (const key of ['margin', 'da', 'capex']) {
      const e = avgSrc(key);
      fromEps[key] = !!e && e.label.startsWith('EPS');
      if (e) set(key, e.v, e.label);
      else set(key, s[key][0], key === 'capex' && s.capexAvgN > 1 ? `최근 ${s.capexAvgN}년 평균` : '최근 실적');
    }
    // 시킹알파 EPS는 조정(Non-GAAP) EPS라 주식보상비용(SBC)과 인수 무형자산 상각비가 빠져 있음.
    // 그대로 쓰면 이익률이 높아지고, 감가상각비(상각비 포함)를 또 더해 현금흐름이 두 번 부풀려짐 (예: 브로드컴).
    if (fromEps.margin) {
      const sbc = s.sbc > 0 ? s.sbc : 0;
      if (sbc) set('margin', b.margin - sbc, `${b.src.margin} − 주식보상 ${(sbc * 100).toFixed(1)}%`);
      if (b.src.da !== 'user' && !(avgSrc('da') || {}).v && b.da > b.capex) set('da', b.capex, '캐펙스와 같게 (조정 EPS는 상각비를 이미 뺌)');
    }
    for (const [k, v] of [['tax', 0.21], ['nwc', 0.01]]) if (!b.src[k]) { b[k] = v; b.src[k] = '강의 기본값'; }
    // 적정 P/E: EPS 추정치가 2개 이상이면 PEG 1.5 × EPS 연평균 성장률(%) (10~40배), 없으면 20배
    const eg = epsGrowth(s);
    const sp = [...spikes].filter(y => y <= s.baseFY + 3);
    if (eg != null) set('pe', Math.max(10, Math.min(40, 1.5 * eg * 100)), `PEG 1.5 × EPS 성장률 ${(eg * 100).toFixed(1)}%${sp.length ? ` (${sp.join('·')}년 일회성 EPS 제외)` : ''}`);
    else if (!b.src.pe) { b.pe = 20; b.src.pe = '시장 평균 수준 20배'; }
    if (!b.src.years || b.src.years === '강의 기본값') { b.years = MAX_YEARS; b.src.years = '기본 3년'; }
    return s;
  }
  // ---------- P/E 방식: 적정가 = 예상 EPS × 적정 P/E ----------
  // 지금 = 1년차 EPS, 내년 = 2년차, 내후년 = 3년차. 시킹알파 EPS 추정치가 없으면 계산값(매출 × 이익률 × (1 − 세율) ÷ 주식수).
  // 한 해만 튀는 EPS: 다음 해 추정치가 10% 넘게 떨어지는 해 (예: GOOG 2026년 19.70 → 2027년 14.81).
  // 지분 평가이익 같은 일회성 이익이 섞인 것으로 보고 이익률 평균과 P/E 계산에서 뺀다.
  function epsSpikes(s) {
    const raw = s.estRaw && s.estRaw.eps, out = new Set();
    if (!raw) return out;
    for (let t = 1; t <= 5; t++) {
      const y = s.baseFY + t;
      if (raw[y] > 0 && raw[y + 1] > 0 && raw[y + 1] < raw[y] * 0.9) out.add(y);
    }
    return out;
  }
  function epsAt(s, t) {
    const raw = s.estRaw && s.estRaw.eps, y = s.baseFY + t;
    if (raw && raw[y] > 0 && epsSpikes(s).has(y)) {
      // 튀는 해는 다음 해 EPS를 EPS 성장률만큼 되돌려 씀
      const eg = epsGrowth(s);
      if (raw[y + 1] > 0 && eg != null && eg > -1) return { v: raw[y + 1] / (1 + eg), est: true, adj: raw[y] };
    }
    if (raw && raw[y] > 0) return { v: raw[y], est: true };
    const b = s.basic;
    if (!(b && b.rev0 > 0 && s.shares > 0)) return { v: NaN, est: false };
    return { v: b.rev0 * Math.pow(1 + b.growth, t) * b.margin * (1 - b.tax) / s.shares, est: false };
  }
  function epsGrowth(s) {
    const raw = s.estRaw && s.estRaw.eps;
    if (!raw) return null;
    const sp = epsSpikes(s);
    const ys = [1, 2, 3, 4, 5].map(t => s.baseFY + t).filter(y => raw[y] > 0 && !sp.has(y)).slice(0, 3);
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
  const $$ = sel => [...document.querySelectorAll(sel)];
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
    // 캐펙스는 한 해 투자 붐(예: AI 데이터센터)이 영원히 이어진다고 보지 않도록 최근 3년 평균
    const cx = h.slice(-3).map(x => x.capexPct).filter(v => v != null && Number.isFinite(v));
    s.capexAvgN = cx.length;
    s.capex = Array(N + 1).fill(+(cx.length ? cx.reduce((a, c) => a + c, 0) / cx.length : last.capexPct || 0).toFixed(4));
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
  // ---------- 매매 신호·차트 지표 (js/strategy.js 의 STRATEGIES, CHART_INDICATORS + "＋ 추가"로 넣은 것) ----------
  const fmtP = v => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtR = r => `<span class="chg ${r >= 0 ? 'up' : 'down'}">${r >= 0 ? '+' : ''}${(r * 100).toFixed(1)}%</span>`;
  // '가리기·삭제' (이 브라우저에 저장): 가린 것은 '다시 보이기'로 돌릴 수 있고, 삭제한 사이트 기본 항목은 다시 나오지 않음
  const HIDDEN_KEY = 'dcf-hidden-items', DELETED_KEY = 'dcf-deleted-items';
  const lsArr = k => { try { const v = JSON.parse(localStorage.getItem(k)); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
  let hiddenIds = lsArr(HIDDEN_KEY), deletedIds = lsArr(DELETED_KEY);
  const offIds = () => hiddenIds.concat(deletedIds);
  const BUILTIN_STRATS = (window.STRATEGIES || []).slice(), BUILTIN_INDS = (window.CHART_INDICATORS || []).slice();
  const STRATS = BUILTIN_STRATS.filter(x => !offIds().includes(x.id));
  const INDS = BUILTIN_INDS.filter(x => !offIds().includes(x.id));

  // 성적 계산 설정: 기간(최근 몇 년), 손절·익절 % (비우면 안 씀). 모든 신호에 똑같이 적용
  const BT_KEY = 'dcf-backtest';
  // 거래 수수료 (한 번 살 때, 한 번 팔 때 각각 %). 기본 0.25% = 신한투자증권 해외주식 온라인 기본 수수료. 이벤트·우대 요율이면 칸에서 바꿈
  const FEE_DEF = 0.25;
  // years: 1·3·5 = 최근 몇 년, 0 = 직접 정한 기간 (from ~ to, to 가 비면 마지막 날까지)
  const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  // minN·minRate: '손절·익절 찾기'에 보여 줄 최소 기준 (거래 몇 번 이상, 승률 몇 % 이상). 기본 5번·65%
  const MIN_N_DEF = 5, MIN_RATE_DEF = 65;
  const okN = v => Number.isInteger(v) && v >= 1 && v <= 100, okR = v => typeof v === 'number' && v >= 0 && v <= 100;
  const bt = (() => { try { const o = JSON.parse(localStorage.getItem(BT_KEY)) || {}; return { years: [0, 1, 3, 5].includes(o.years) ? o.years : 5, from: isDay(o.from) ? o.from : '', to: isDay(o.to) ? o.to : '', fee: typeof o.fee === 'number' && o.fee >= 0 && o.fee <= 3 ? o.fee : FEE_DEF, minN: okN(o.minN) ? o.minN : MIN_N_DEF, minRate: okR(o.minRate) ? o.minRate : MIN_RATE_DEF }; } catch (e) { return { years: 5, from: '', to: '', fee: FEE_DEF, minN: MIN_N_DEF, minRate: MIN_RATE_DEF }; } })();
  const saveBt = () => lsSet(BT_KEY, bt);
  // 손절·익절은 종목+신호마다 따로 저장: { AEHR: { 'stoch-x': {sl:10, tp:30} } }. 없으면 안 씀
  // (예전 형식 { AEHR: {sl, tp} } 은 아래 migrateSltp 에서 그 종목의 적용 신호 칸으로 옮김)
  const SLTP_KEY = 'dcf-sltp';
  let sltp = (() => { try { const o = JSON.parse(localStorage.getItem(SLTP_KEY)); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } })();
  const sltpOf = (t, sid) => { const o = (t && sid && sltp[t] && sltp[t][sid]) || {}; return { sl: o.sl > 0 ? o.sl : null, tp: o.tp > 0 ? o.tp : null }; };
  function setSltp(t, sid, rule) {
    if (!t || !sid) return;
    const m = sltp[t] || {};
    if (rule.sl || rule.tp) m[sid] = { sl: rule.sl || null, tp: rule.tp || null }; else delete m[sid];
    if (Object.keys(m).length) sltp[t] = m; else delete sltp[t];
    lsSet(SLTP_KEY, sltp);
  }
  const simKey = (s, rule) => `${s.id}|${rule.sl || ''}|${rule.tp || ''}|${bt.fee}`;

  // 트레이딩뷰 strategy와 같은 방식: 신호 봉 종가에서 판단 → 다음 봉 시가에 체결, 보유 중엔 매수 표시 안 함.
  // 손절·익절: 보유 중 그날 저가가 손절가 아래면 손절가(시가가 이미 아래면 시가)에, 고가가 익절가 위면 익절가에 판다. 같은 날 둘 다 닿으면 손절로 본다.
  function simulate(d, strat, rule) {
    rule = rule || { sl: null, tp: null };
    const out = strat.run(d, window.TA);
    // 사용자가 정한 수수료(증권사 실제 요율)를 신호 기본값보다 먼저 씀
    const n = d.close.length, fee = bt.fee >= 0 ? bt.fee / 100 : out && out.commission != null ? out.commission : strat.commission != null ? strat.commission : 0.0005;
    if (!out || !Array.isArray(out.buy) || !Array.isArray(out.exit)) throw new Error('buy·exit 배열을 돌려주지 않았습니다.');
    const sl = rule.sl / 100, tp = rule.tp / 100;
    const marks = [], trades = [];
    let pos = false, entry = null, pendBuy = false, pendExit = false;
    const close = (i, price, reason) => {
      pos = false;
      trades.push({ from: entry, to: { i, price }, ret: (price * (1 - fee)) / (entry.price * (1 + fee)) - 1, reason });
      entry = null;
    };
    for (let i = 0; i < n; i++) {
      if (pendBuy && !pos) { pos = true; entry = { i, price: d.open[i] }; }
      if (pendExit && pos) close(i, d.open[i]);
      if (pos && sl > 0 && d.low[i] <= entry.price * (1 - sl)) {
        const px = Math.min(d.open[i], entry.price * (1 - sl));
        close(i, px, '손절'); marks.push({ i, kind: 'sell', reason: '손절', price: px });
      } else if (pos && tp > 0 && d.high[i] >= entry.price * (1 + tp)) {
        const px = Math.max(d.open[i], entry.price * (1 + tp));
        close(i, px, '익절'); marks.push({ i, kind: 'sell', reason: '익절', price: px });
      }
      pendBuy = !!out.buy[i]; pendExit = !!out.exit[i];
      if (out.buy[i] && !pos) marks.push({ i, kind: 'buy' });
      if (out.exit[i] && pos) marks.push({ i, kind: 'sell' });
    }
    return { out, marks, trades, pos, entry, fee, d };
  }
  // 지난 성적 (설정한 기간 안에 산 거래만): 거래 수, 승률, 거래당 평균, 누적, 최대 낙폭, 같은 기간 그냥 들고 있었을 때
  // 성적을 셀 봉 범위 [시작, 끝]. years 를 주면 최근 그 햇수, 아니면 고른 기간 (직접 정한 기간 포함)
  function btRange(d, years) {
    const L = d.close.length - 1;
    const y = years || bt.years;
    if (y) {
      const cut = new Date(d.time[L]);
      cut.setFullYear(cut.getFullYear() - y);
      const c = cut.toISOString().slice(0, 10), k = d.time.findIndex(t => t >= c);
      return [k < 0 ? 0 : k, L];
    }
    let s = bt.from ? d.time.findIndex(t => t >= bt.from) : 0;
    if (s < 0) s = L;
    let e = L;
    if (bt.to) { e = -1; for (let i = L; i >= 0; i--) if (d.time[i] <= bt.to) { e = i; break; } }
    if (e < s) e = s;
    return [s, e];
  }
  const btStart = (d, years) => btRange(d, years)[0];
  // 화면에 쓰는 기간 이름: "2024-01-02 이후" 또는 "2024-01-02 ~ 2025-06-30"
  function btSpanTxt(d) {
    const [s, e] = btRange(d), L = d.close.length - 1;
    return e < L ? `${d.time[s]} ~ ${d.time[e]}` : `${d.time[s]} 이후`;
  }
  // 문장 안에 넣을 때: "2024-01-02 이후" 또는 "2024-01-02 ~ 2025-06-30 동안"
  const btDuring = d => { const t = btSpanTxt(d); return t.endsWith('이후') ? t : t + ' 동안'; };
  const btName = () => (bt.years ? `최근 ${bt.years}년` : `${bt.from || '처음'} ~ ${bt.to || '오늘'}`);
  // 지난 성적 (기간 안에 사서 기간 안에 판 거래): 거래 수, 승률, 거래당 평균, 누적, 최대 낙폭, 같은 기간 그냥 들고 있었을 때.
  // 기간 끝에 아직 들고 있는 거래는 끝난 거래로 세지 않고 낙폭에만 넣음
  function statsOf(sim, years) {
    if (!sim || sim.error || !sim.d) return null;
    const d = sim.d, [s0, e0] = btRange(d, years);
    const tr = (sim.trades || []).filter(x => x.from.i >= s0 && x.to.i <= e0);
    if (!tr.length) return null;
    const wins = tr.filter(x => x.ret > 0).length;
    // 최대 낙폭: 보유 중엔 매일 종가로 평가한 자산이 앞선 최고점에서 가장 많이 빠졌던 비율 (기간 끝까지 들고 있는 거래 포함)
    const legs = tr.map(x => ({ a: x.from.i, b: x.to.i, p: x.from.price, ret: x.ret }));
    const open = (sim.trades || []).find(x => x.from.i >= s0 && x.from.i <= e0 && x.to.i > e0) ||
      (sim.pos && sim.entry && sim.entry.i >= s0 && sim.entry.i <= e0 ? { from: sim.entry } : null);
    if (open) legs.push({ a: open.from.i, b: e0 + 1, p: open.from.price, ret: null });
    let eq = 1, peak = 1, mdd = 0;
    const mark = v => { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); };
    legs.forEach(g => {
      for (let k = g.a; k < g.b && k <= e0; k++) mark(eq * d.close[k] / g.p);
      if (g.ret != null) { eq *= 1 + g.ret; mark(eq); }
    });
    return {
      n: tr.length, wins, rate: wins / tr.length,
      avg: tr.reduce((a, x) => a + x.ret, 0) / tr.length,
      total: tr.reduce((a, x) => a * (1 + x.ret), 1) - 1,
      mdd, hold: d.close[e0] / d.open[s0] - 1, from: d.time[s0], to: d.time[e0],
      stops: tr.filter(x => x.reason).length,
      // 번 돈을 다시 넣어 굴릴 때 거래마다 들어간 금액의 합 (시작 금액 = 1). 수수료 금액 어림에 씀
      turn: tr.reduce((a, x) => { a.sum += a.eq * (2 + x.ret); a.eq *= 1 + x.ret; return a; }, { eq: 1, sum: 0 }).sum / 2,
    };
  }
  const rateTxt = st => (st ? `승률 ${Math.round(st.rate * 100)}%` : '거래 없음');

  // 종목별 일봉. 신호·지표 결과는 받은 데이터마다 한 번만 계산.
  // 화면이 열려 있으면 1분마다 새로 받음 (liveTick). 분 단위 꼬리표로 서버 캐시(5분)를 건너뜀
  const sigCache = {};
  const loadSig = t => fetch('api/prices?range=5y&ticker=' + encodeURIComponent(t) + '&m=' + Math.floor(Date.now() / 60000))
    .then(async res => {
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.close || !d.close.length) throw new Error(d.error || '주가 없음');
      return { t, d, sims: {}, inds: {} };
    });
  function getSig(t) {
    if (!sigCache[t]) {
      sigCache[t] = loadSig(t);
      sigCache[t].catch(() => delete sigCache[t]); // 실패하면 다음에 다시 시도
    }
    return sigCache[t];
  }
  // 이미 받은 종목만 새로 받기. 실패하면 이전 값을 그대로 둠 (화면이 멈추거나 비지 않게)
  async function refreshSig(t) {
    try { const r = await loadSig(t); sigCache[t] = Promise.resolve(r); return true; } catch (e) { return false; }
  }
  function simOf(r, s) {
    const rule = sltpOf(r.t, s.id), k = simKey(s, rule);
    if (!(k in r.sims)) { try { r.sims[k] = simulate(r.d, s, rule); } catch (e) { r.sims[k] = { error: e.message || String(e) }; } }
    return r.sims[k];
  }
  function indOf(r, ind) {
    if (!(ind.id in r.inds)) { try { r.inds[ind.id] = ind.plot(r.d, window.TA) || {}; } catch (e) { r.inds[ind.id] = { error: e.message || String(e) }; } }
    return r.inds[ind.id];
  }
  // 장전·장후(시간외) 마지막 거래가: 마지막 일봉 종가 대비. 일봉보다 오래된 값이면 버림
  function extOf(d) {
    const e = d.ext, L = d.close.length - 1;
    if (!e || !(e.price > 0) || !e.date || e.date < d.time[L]) return null;
    return { label: e.session === 'pre' ? '장전' : '장후', price: e.price, chg: e.price / d.close[L] - 1, time: e.time };
  }
  // 시간외 미리보기: 장전·장후 마지막 가격이 그대로 다음 종가가 된다고 가정하고 신호를 다시 계산.
  // 진짜 신호·승률·카톡 알림은 정규장 종가만 씀. 이건 화면에 '미리보기'로만 보여 줌
  function extPreview(r, s) {
    const d = r.d, ex = extOf(d), L = d.close.length - 1;
    if (!ex || !s) return null;
    const p = ex.price, d2 = {};
    for (const k in d) d2[k] = Array.isArray(d[k]) ? d[k].slice() : d[k];
    d2.time.push(d.ext.date > d.time[L] ? d.ext.date : d.time[L] + '+');
    d2.open.push(p); d2.high.push(p); d2.low.push(p); d2.close.push(p); if (d2.volume) d2.volume.push(0);
    let st;
    try { st = sigState(d2, simulate(d2, s, sltpOf(r.t, s.id))); } catch (e) { return null; }
    const now = sigState(d, simOf(r, s));
    const what = st.cls === 'buy' ? '매수 신호가 나옵니다' : st.cls === 'sell' ? '청산 신호가 나옵니다' : now.cls === 'hold' && st.cls === 'none' ? '손절·익절로 정리됩니다' : '새 신호는 없습니다';
    return { cls: st.cls, short: st.cls === 'buy' ? '매수' : st.cls === 'sell' ? '청산' : '', label: ex.label, price: p,
      text: `${ex.label} ${fmtP(p)} 그대로 마감하면 ${what}` };
  }
  // 다음 실적 발표일 (오늘 이후만). near = 7일 안: 발표 전후 큰 변동으로 신호가 잘 안 맞으니 주의
  function earnOf(d) {
    const e = d.earnings;
    if (!e || !e.date) return null;
    const now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const [y, m, dd] = e.date.split('-').map(Number), dday = Math.round((new Date(y, m - 1, dd) - today) / 864e5);
    if (dday < 0) return null;
    return { date: e.date, dday, estimate: e.estimate, near: dday <= 7, text: `실적 발표 ${e.date.slice(5)}${e.estimate ? ' 예상' : ''} (${dday ? 'D-' + dday : '오늘'})` };
  }
  // 마지막 봉 기준 상태: 오늘 매수 / 오늘 청산 / 매수 유지 / 신호 없음
  function sigState(d, sim) {
    const L = d.close.length - 1;
    if (!sim || sim.error) return { cls: 'none', text: '계산 오류', short: '' };
    // 이미 산 상태(매수 유지 중)에서 매수 조건이 또 나오면 새 매수가 아님: 성적 계산도 추가로 사지 않음 (물타기 없음)
    if (sim.out.buy[L] && sim.pos) return { cls: 'hold', text: '매수 유지 중 · 오늘 매수 조건이 또 나왔지만 이미 산 상태라 추가 매수 신호가 아닙니다', short: '매수 유지' };
    if (sim.out.buy[L]) return { cls: 'buy', text: '오늘 매수 신호', short: '매수' };
    if (sim.out.exit[L] && sim.pos) return { cls: 'sell', text: '오늘 청산 신호', short: '청산' };
    if (sim.pos) return { cls: 'hold', text: '매수 유지 중 · 청산 신호 기다리는 중', short: '매수 유지' };
    return { cls: 'none', text: '오늘은 신호 없음', short: '' };
  }

  // 고르기 (이 브라우저에 저장): 매매 신호는 한 번에 하나, 차트 지표는 여러 개 켜고 끄기
  const lsGet = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch (e) { return def; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 저장 불가 */ } };
  let stratSel = lsGet('dcf-strategy-id', null);
  // 기본 신호: 사용자가 직접 고른 신호. ★ 종목을 열어 잠깐 바뀐 신호(stratSel)와 달리, ★ 없는 종목의 목록 신호·카톡 알림은 늘 이 신호를 씀
  let baseSel = stratSel;
  let indOff = lsGet('dcf-indicators-off', []);
  // 종목별로 손절·익절을 적용할 때 쓴 신호 (그 종목을 열면 이 신호로 먼저 보여 줌)
  const TSTRAT_KEY = 'dcf-ticker-strat';
  let tstrat = lsGet(TSTRAT_KEY, {});
  if (!tstrat || typeof tstrat !== 'object') tstrat = {};
  function setTickerStrat(t, sid) { if (!t || !sid) return; tstrat[t] = sid; lsSet(TSTRAT_KEY, tstrat); }
  (function migrateSltp() {
    let ch = false;
    Object.keys(sltp).forEach(t => {
      const o = sltp[t];
      if (o && typeof o === 'object' && ('sl' in o || 'tp' in o)) {
        const sid = tstrat[t] || stratSel || (STRATS[0] && STRATS[0].id);
        sltp[t] = sid && (o.sl > 0 || o.tp > 0) ? { [sid]: { sl: o.sl > 0 ? o.sl : null, tp: o.tp > 0 ? o.tp : null } } : undefined;
        if (!sltp[t]) delete sltp[t];
        ch = true;
      }
    });
    if (ch) lsSet(SLTP_KEY, sltp);
  })();
  // 종목을 빼면 그 종목의 손절·익절과 적용 신호 기록도 지움
  function forgetTicker(t) { delete sltp[t]; delete tstrat[t]; lsSet(SLTP_KEY, sltp); lsSet(TSTRAT_KEY, tstrat); }
  // 종목을 열 때: ★ 신호가 있으면 그 신호로, 없으면 기본 신호로 바꿈 (기본 신호 저장값은 건드리지 않음). 바뀌었으면 true
  function useTickerStrat(t) {
    let sid = t && tstrat[t];
    if (!sid || !STRATS.some(x => x.id === sid)) sid = baseSel;
    if (!sid || sid === stratSel || !STRATS.some(x => x.id === sid)) return false;
    stratSel = sid; renderPickers();
    return true;
  }
  const activeStrats = () => {
    if (!STRATS.some(s => s.id === stratSel)) stratSel = STRATS[0] && STRATS[0].id;
    return STRATS.filter(s => s.id === stratSel);
  };
  const activeInds = () => INDS.filter(i => !indOff.includes(i.id));
  let pickRates = {}; // 지금 종목의 전략별 승률 (신호 버튼에 표시)
  function renderPickers() {
    activeStrats();
    $$('.strat-pick').forEach(box => {
      box.innerHTML = STRATS.map(s => {
        const st = pickRates[s.id];
        return `<button type="button" class="chip ${s.id === stratSel ? 'on' : ''}" data-sid="${esc(s.id)}" title="${esc(s.desc || '')}" style="--c:${s.color}"><i></i>${esc(s.name)}${st !== undefined ? `<span class="chip-rate">${rateTxt(st)}</span>` : ''}</button>`;
      }).join('') + '<button type="button" class="chip info" data-about>ⓘ 신호 설명</button><button type="button" class="chip add" data-add-kind="strategy">＋ 신호 추가</button><button type="button" class="chip del" data-del-kind="strategy">가리기·삭제</button>';
    });
    $$('.ind-pick').forEach(box => {
      box.innerHTML = INDS.map(i => `<button type="button" class="chip ${indOff.includes(i.id) ? '' : 'on'}" data-iid="${esc(i.id)}" style="--c:${i.color || '#787B86'}"><i></i>${esc(i.name)}</button>`).join('') +
        '<button type="button" class="chip add" data-add-kind="indicator">＋ 지표 추가</button><button type="button" class="chip del" data-del-kind="indicator">가리기·삭제</button>';
    });
    syncAbout();
  }
  // 성적 줄: 기간 버튼과 손절·익절 칸
  function renderBt() {
    $$('.bt-pick .chip[data-years]').forEach(b => { b.classList.toggle('on', +b.dataset.years === bt.years); b.style.setProperty('--c', 'var(--accent)'); });
    $('#bt-range').hidden = bt.years !== 0;
    if (document.activeElement !== $('#bt-from')) $('#bt-from').value = bt.from;
    if (document.activeElement !== $('#bt-to')) $('#bt-to').value = bt.to;
    const today = new Date().toISOString().slice(0, 10), min = new Date(); min.setFullYear(min.getFullYear() - 5);
    ['#bt-from', '#bt-to'].forEach(s => { $(s).max = today; $(s).min = min.toISOString().slice(0, 10); });
    // 처음 그릴 때는 종목 변수가 아직 없을 수 있음
    let mt = null; try { mt = modalTicker; } catch (e) { mt = null; }
    const rule = sltpOf(mt, stratSel);
    if (document.activeElement !== $('#bt-sl')) $('#bt-sl').value = rule.sl || '';
    if (document.activeElement !== $('#bt-tp')) $('#bt-tp').value = rule.tp || '';
    if (document.activeElement !== $('#bt-fee')) $('#bt-fee').value = bt.fee;
    // 손절·익절 칸은 "이 종목 + 지금 신호" 값. 종목을 열 때 먼저 켜지는 신호(적용 신호)는 ★로 표시
    const cs = STRATS.find(x => x.id === stratSel);
    $('#bt-for').textContent = mt && cs ? `${mt} · ${cs.short || cs.name} 전용${tstrat[mt] === cs.id ? ' ★' : ''}` : '';
    $('#bt-for').title = '손절·익절은 종목과 신호마다 따로 저장됩니다. ★ = 이 종목을 열면 먼저 켜지는 신호';
    // 풀 것이 있을 때만 누를 수 있음
    $('#bt-reset').disabled = !(mt && cs && (rule.sl || rule.tp || tstrat[mt] === cs.id));
  }
  function btChanged() {
    saveBt();
    renderBt();
    searchRefresh();
    if (!$('#chart-modal').hidden) { renderWatch(); if (modalTicker) showModalTicker(modalTicker); }
  }
  $$('.bt-pick .chip[data-years]').forEach(b => b.addEventListener('click', () => {
    bt.years = +b.dataset.years;
    // '직접'을 처음 누르면 2년 전부터 오늘까지로 시작
    if (!bt.years && !bt.from) { const f = new Date(); f.setFullYear(f.getFullYear() - 2); bt.from = f.toISOString().slice(0, 10); }
    btChanged();
  }));
  // 직접 정한 기간 (주가는 최근 5년치까지만 있음). 시작이 끝보다 늦으면 서로 바꿈
  ['from', 'to'].forEach(k => $('#bt-' + k).addEventListener('change', e => {
    bt[k] = isDay(e.target.value) ? e.target.value : '';
    if (bt.from && bt.to && bt.from > bt.to) [bt.from, bt.to] = [bt.to, bt.from];
    btChanged();
  }));
  $('#bt-fee').addEventListener('change', e => {
    const v = parseFloat(e.target.value);
    bt.fee = v >= 0 && v <= 3 ? v : FEE_DEF;
    btChanged();
  });
  ['sl', 'tp'].forEach(k => $('#bt-' + k).addEventListener('change', e => {
    const v = parseFloat(e.target.value);
    const rule = sltpOf(modalTicker, stratSel);
    rule[k] = v > 0 && v < 100 ? v : null;
    setSltp(modalTicker, stratSel, rule);
    setTickerStrat(modalTicker, stratSel);
    btChanged();
  }));
  renderBt();
  // "손절·익절 찾기": 지금 종목·신호·기간으로 손절 × 익절 조합을 모두 다시 계산해 누적 수익 순으로 보여 줌.
  // 지난 데이터에 맞춘 값이라 앞으로도 똑같이 맞는다는 보장은 없음 (안내 문구로 표시)
  const SL_GRID = [null, 5, 7, 10, 15, 20, 25, 30], TP_GRID = [null, 10, 15, 20, 30, 50, 75, 100];
  const pctTxt = v => (v ? v + '%' : '안 씀');
  // 찾기 결과 칸이 열려 있으면 신호·종목·기간·손절익절을 바꿀 때마다 그 조건으로 다시 계산 (닫기를 눌러야 닫힘)
  let searchRun = 0;
  function searchRefresh() { const b = $('#bt-search'); if (b && !b.hidden) setTimeout(findSlTp, 0); }
  async function findSlTp() {
    const box = $('#bt-search'), s = activeStrats()[0], t = modalTicker, run = ++searchRun;
    box.hidden = false; box.dataset.t = t || ''; box.dataset.sid = s ? s.id : '';
    if (!s || !t) { box.innerHTML = '<p class="muted small">종목과 신호를 먼저 고르세요.</p>'; return; }
    box.innerHTML = '<p class="muted small">계산 중...</p>';
    let r;
    try { r = await getSig(t); } catch (e) { if (run === searchRun) box.innerHTML = '<p class="neg small">주가를 불러오지 못했습니다.</p>'; return; }
    if (run !== searchRun || box.hidden) return; // 그사이 다른 조건으로 다시 계산 중이거나 닫힘
    const keep = sltpOf(t, s.id), rows = [];
    try {
      for (const sl of SL_GRID) for (const tp of TP_GRID) {
        const sim = simulate(r.d, s, { sl, tp }), st = statsOf(sim);
        if (st) rows.push({ sl, tp, st, sim });
      }
    } catch (e) { box.innerHTML = `<p class="neg small">계산 오류: ${esc(e.message || e)}</p>`; return; }
    if (!rows.length) { box.innerHTML = `<p class="muted small">${esc(t)}: ${esc(btName())} 동안 이 신호의 거래가 없습니다.</p>`; return; }
    // 손절·익절이 한 번도 안 걸려 결과가 똑같은 조합은 하나만 (더 단순한 설정, 즉 '안 씀'에 가까운 쪽을 남김)
    const sig = x => [x.st.n, x.st.total.toFixed(6), x.st.mdd.toFixed(6)].join('|'), seen = new Set();
    const uniq = rows.filter(x => { const k = sig(x); if (seen.has(k)) return false; seen.add(k); return true; });
    // 거래가 너무 적으면 운일 수 있어서 최소 기준(기본 거래 5번 이상, 승률 65% 이상)을 넘는 조합만 보여 줌. 기준은 위 칸에서 바꿈
    const MIN_TRADES = bt.minN, MIN_RATE = bt.minRate / 100, good = x => x.st.n >= MIN_TRADES && x.st.rate >= MIN_RATE - 1e-9;
    const pool = uniq.filter(good);
    if (!pool.length) {
      const most = Math.max(...uniq.map(x => x.st.n)), bestRate = Math.max(...uniq.filter(x => x.st.n >= MIN_TRADES).map(x => x.st.rate), 0);
      box.innerHTML = `<div class="bt-search-head"><b>${esc(t)} · ${esc(s.name)} · ${esc(btName())}</b><button type="button" class="ghost mini" data-bt-close>닫기 ✕</button></div>${minBox()}<p class="muted small">거래 ${MIN_TRADES}번 이상, 승률 ${Math.round(MIN_RATE * 100)}% 이상인 손절·익절 조합이 없습니다 (${most >= MIN_TRADES ? `거래 ${MIN_TRADES}번 이상 중 가장 높은 승률 ${Math.round(bestRate * 100)}%` : `가장 많은 조합도 거래 ${most}번`}). 기간을 바꾸거나 다른 신호를 골라 보세요.</p>`;
      return;
    }
    pool.sort((a, b) => b.st.total - a.st.total);
    const base = rows.find(x => !x.sl && !x.tp), cur = rows.find(x => x.sl === keep.sl && x.tp === keep.tp);
    const safest = pool.slice().sort((a, b) => b.st.mdd - a.st.mdd || b.st.total - a.st.total)[0];
    const show = [];
    pool.slice(0, 5).forEach(x => show.push([x, show.length ? '' : '누적 수익 1위']));
    const sh = show.find(y => y[0] === safest);
    if (sh) sh[1] = sh[1] ? sh[1] + ' · 낙폭 가장 작음' : '낙폭 가장 작음';
    else if (safest) show.push([safest, '낙폭 가장 작음']);
    if (base && good(base) && !show.some(y => y[0] === base)) show.push([base, '손절·익절 안 씀']);
    if (cur && good(cur) && !show.some(y => y[0] === cur)) show.push([cur, '지금 설정']);
    const pr = v => `<span class="chg ${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%</span>`;
    // 과최적화 확인: 기간이 3·5년이면 같은 조합이 최근 1년에도 통했는지 같이 보여 줌
    const recent = bt.years > 1;
    const rTxt = x => { const q = statsOf(x.sim, 1); return q ? `${pr(q.total)} <span class="muted small">${q.n}번</span>` : '<span class="muted small">거래 없음</span>'; };
    const base1 = recent && base ? statsOf(base.sim, 1) : null;
    // 1,000만원을 넣고 매번 전부 다시 넣었다면 (수수료 포함) 기간 끝에 얼마가 되는지
    const won = v => `${Math.round(1000 * (1 + v)).toLocaleString('ko-KR')}만원`;
    const mTxt = v => `<span class="money"><b>${won(v)}</b> <span class="chg ${v >= 0 ? 'up' : 'down'} small">${v >= 0 ? '+' : ''}${Math.round(1000 * v).toLocaleString('ko-KR')}만</span></span>`;
    box.innerHTML = `<div class="bt-search-head"><b>${esc(t)} · ${esc(s.name)} · ${esc(btName())}</b> <span class="muted small">손절 ${SL_GRID.length} × 익절 ${TP_GRID.length} = ${SL_GRID.length * TP_GRID.length}가지 조합 계산</span><button type="button" class="ghost mini" data-bt-close>닫기 ✕</button></div>${minBox()}
      <div class="table-scroll"><table class="grid"><thead><tr><th>손절</th><th>익절</th><th>거래</th><th>승률</th><th>누적</th><th title="처음에 1,000만원을 넣고 살 때마다 전부 넣었다면 (수수료 포함)">1,000만원이면</th><th>최대 낙폭</th>${recent ? '<th title="같은 조합으로 최근 1년만 따로 계산">최근 1년</th>' : ''}<th></th><th></th></tr></thead><tbody>${show.map(([x, tag]) => `
        <tr><td>${x.sl ? '-' + x.sl + '%' : '안 씀'}</td><td>${x.tp ? '+' + x.tp + '%' : '안 씀'}</td><td>${x.st.n}</td><td>${Math.round(x.st.rate * 100)}%</td><td>${pr(x.st.total)}</td><td>${mTxt(x.st.total)}</td><td>${pr(x.st.mdd)}</td>${recent ? `<td>${rTxt(x)}</td>` : ''}
        <td class="muted small">${tag}</td><td>${x === cur && tstrat[t] === s.id ? '<button type="button" class="mini applied" disabled title="지금 이 종목에 적용된 손절·익절입니다">✓ 적용 중</button>' : `<button type="button" class="ghost mini" data-bt-apply="${x.sl || ''},${x.tp || ''}">적용</button>`}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted small">같은 기간 그냥 들고 있었다면 ${pr(base ? base.st.hold : rows[0].st.hold)} (1,000만원 → ${won(base ? base.st.hold : rows[0].st.hold)}). '1,000만원이면'은 처음에 1,000만원을 넣고 살 때마다 가진 돈을 전부 넣었다고 본 금액입니다 (수수료 포함, 세금 제외). 지난 차트에 맞춘 값이라 앞으로도 똑같이 맞지는 않습니다. 1위와 비슷한 성적이 나오는 조합이 여럿이면 그 근처 값이 더 믿을 만합니다.${recent ? ` <b>최근 1년</b> 칸이 마이너스이거나 '손절·익절 안 씀'(최근 1년 ${base1 ? pr(base1.total) : '거래 없음'})보다 못하면, 예전 차트에만 맞춘 값일 수 있으니 조심하세요.` : ''} 거래 ${MIN_TRADES}번 이상, 승률 ${Math.round(MIN_RATE * 100)}% 이상인 조합만 보여 줍니다.</p>`;
  }
  $('#bt-find').addEventListener('click', findSlTp);
  // 최소 기준 칸 (거래 수·승률). 바꾸면 저장하고 바로 다시 계산. 에이전트의 '큰 종목 찾기'도 이 기준을 씀
  function minBox() {
    const def = bt.minN === MIN_N_DEF && bt.minRate === MIN_RATE_DEF;
    return `<div class="bt-min small"><b>최소 기준</b> 거래 <input type="number" min="1" max="100" step="1" value="${bt.minN}" data-bt-min="n">번 이상 · 승률 <input type="number" min="0" max="100" step="1" value="${bt.minRate}" data-bt-min="rate">% 이상${def ? ' <span class="muted">(기본값)</span>' : ' <button type="button" class="ghost mini" data-bt-min-reset>기본값(5번·65%)</button>'}</div>`;
  }
  $('#bt-search').addEventListener('change', e => {
    const i = e.target.closest('[data-bt-min]');
    if (!i) return;
    const v = Number(i.value);
    if (i.dataset.btMin === 'n') { if (okN(v)) bt.minN = v; } else if (okR(v)) bt.minRate = v;
    saveBt(); findSlTp();
  });
  // "여러 종목 풀기": 손절·익절이나 ★(적용 신호)가 저장된 종목을 골라 한꺼번에 지움 (전체 선택 가능)
  const sName = id => { const x = STRATS.find(s => s.id === id); return x ? x.short || x.name : id; };
  function bulkRender(note) {
    const box = $('#bt-bulk');
    const ts = [...new Set(Object.keys(sltp).concat(Object.keys(tstrat)))];
    const order = t => { const i = watch.indexOf(t); return i < 0 ? 1e9 : i; };
    ts.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
    const head = `<div class="bt-search-head"><b>손절·익절 여러 종목 풀기</b> <span class="muted small">${ts.length}종목에 저장돼 있음</span><button type="button" class="ghost mini" data-bulk-close>닫기 ✕</button></div>`;
    if (!ts.length) { box.innerHTML = head + `<p class="muted small">손절·익절이나 ★가 저장된 종목이 없습니다.${note ? ' ' + note : ''}</p>`; return; }
    const desc = t => {
      const parts = Object.keys(sltp[t] || {}).map(sid => { const r = sltp[t][sid] || {}; return `${sName(sid)} ${[r.sl ? '-' + r.sl + '%' : '', r.tp ? '+' + r.tp + '%' : ''].filter(Boolean).join('/')}`; });
      if (tstrat[t]) parts.push(`★ ${sName(tstrat[t])}`);
      return parts.join(' · ');
    };
    box.innerHTML = head + `<label class="bulk-all"><input type="checkbox" data-bulk-all> 전체 선택</label>
      <ul class="bulk-list">${ts.map(t => `<li><label><input type="checkbox" data-bulk-t="${esc(t)}"><b>${esc(t)}</b><span class="muted">${esc(desc(t))}</span></label></li>`).join('')}</ul>
      <div class="bulk-actions"><button type="button" class="mini" data-bulk-go disabled>선택한 종목 풀기</button><span class="muted small" data-bulk-n>0종목 선택</span></div>` +
      (note ? `<p class="small pos">${note}</p>` : '');
  }
  function bulkSync() {
    const box = $('#bt-bulk'), all = [...box.querySelectorAll('[data-bulk-t]')], on = all.filter(c => c.checked);
    const a = box.querySelector('[data-bulk-all]');
    if (a) { a.checked = all.length > 0 && on.length === all.length; a.indeterminate = on.length > 0 && on.length < all.length; }
    const go = box.querySelector('[data-bulk-go]'); if (go) go.disabled = !on.length;
    const n = box.querySelector('[data-bulk-n]'); if (n) n.textContent = `${on.length}종목 선택`;
  }
  $('#bt-bulk-btn').addEventListener('click', () => { const b = $('#bt-bulk'); if (!b.hidden) { b.hidden = true; return; } b.hidden = false; bulkRender(); });
  $('#bt-bulk').addEventListener('change', e => {
    if (e.target.matches('[data-bulk-all]')) $('#bt-bulk').querySelectorAll('[data-bulk-t]').forEach(c => { c.checked = e.target.checked; });
    bulkSync();
  });
  $('#bt-bulk').addEventListener('click', e => {
    if (e.target.closest('[data-bulk-close]')) { $('#bt-bulk').hidden = true; return; }
    if (!e.target.closest('[data-bulk-go]')) return;
    const ts = [...$('#bt-bulk').querySelectorAll('[data-bulk-t]')].filter(c => c.checked).map(c => c.dataset.bulkT);
    if (!ts.length || !confirm(`${ts.length}종목의 손절·익절과 ★를 모두 풀까요?\n${ts.join(', ')}`)) return;
    ts.forEach(forgetTicker);
    btChanged();
    bulkRender(`${ts.length}종목을 풀었습니다.`);
  });
  // "⚡ 최적 자동 적용": 고른 종목마다 보이는 모든 신호 × 손절·익절 64가지를 지금 기간으로 계산해
  // 최소 기준(거래 수·승률)을 넘는 조합 중 누적 수익 1위를 그 종목의 ★ + 손절·익절로 적용. 기간이 3·5년이면 최근 1년도 플러스인 조합을 먼저 고름.
  // 기준을 넘는 조합이 없는 종목은 건드리지 않음.
  let optRun = 0;
  function optRender(result) {
    const box = $('#bt-opt');
    const head = `<div class="bt-search-head"><b>⚡ 최적 조건 자동 적용</b> <span class="muted small">${esc(btName())} · <span title="${esc(STRATS.map(x => x.name).join(', '))}">보이는 신호 ${STRATS.length}개 (가린 신호 빼고)</span> × 손절·익절 ${SL_GRID.length * TP_GRID.length}가지</span><button type="button" class="ghost mini" data-opt-close>닫기 ✕</button></div>`;
    if (!watch.length) { box.innerHTML = head + '<p class="muted small">관심 종목이 없습니다.</p>'; return; }
    box.innerHTML = head + minBox().replace(/data-bt-min/g, 'data-opt-min') +
      `<label class="bulk-all"><input type="checkbox" data-opt-all> 전체 선택</label>
      <ul class="bulk-list">${watch.map(t => `<li><label><input type="checkbox" data-opt-t="${esc(t)}"><b>${esc(t)}</b><span class="muted">${tstrat[t] ? '★ ' + esc(sName(tstrat[t])) + (sltp[t] && sltp[t][tstrat[t]] ? ' ' + [sltp[t][tstrat[t]].sl ? '-' + sltp[t][tstrat[t]].sl + '%' : '', sltp[t][tstrat[t]].tp ? '+' + sltp[t][tstrat[t]].tp + '%' : ''].filter(Boolean).join('/') : '') : '적용 없음'}</span></label></li>`).join('')}</ul>
      <div class="bulk-actions"><button type="button" class="mini" data-opt-go disabled>찾아서 적용</button><span class="muted small" data-opt-n>0종목 선택</span></div>` + (result || '');
  }
  function optSync() {
    const box = $('#bt-opt'), all = [...box.querySelectorAll('[data-opt-t]')], on = all.filter(c => c.checked);
    const a = box.querySelector('[data-opt-all]');
    if (a) { a.checked = all.length > 0 && on.length === all.length; a.indeterminate = on.length > 0 && on.length < all.length; }
    const go = box.querySelector('[data-opt-go]'); if (go) go.disabled = !on.length;
    const n = box.querySelector('[data-opt-n]'); if (n) n.textContent = `${on.length}종목 선택`;
  }
  // 한 종목의 최적 조합 (없으면 null)
  async function bestFor(t) {
    const r = await getSig(t), good = x => x.st.n >= bt.minN && x.st.rate >= bt.minRate / 100 - 1e-9, rows = [];
    for (const s of STRATS) {
      for (const sl of SL_GRID) for (const tp of TP_GRID) {
        let sim; try { sim = simulate(r.d, s, { sl, tp }); } catch (e) { continue; }
        const st = statsOf(sim);
        if (st && good({ st })) rows.push({ s, sl, tp, st, sim });
      }
      await new Promise(res => setTimeout(res, 0)); // 화면이 멈추지 않게
    }
    if (!rows.length) return null;
    const recentOk = x => { if (bt.years <= 1) return true; const q = statsOf(x.sim, 1); return !!q && q.total > 0; };
    const pool = rows.some(recentOk) ? rows.filter(recentOk) : rows;
    // 누적 수익 1위, 같으면 낙폭 작은 것, 그래도 같으면 손절·익절이 단순한 것
    pool.sort((a, b) => b.st.total - a.st.total || b.st.mdd - a.st.mdd || (!!a.sl + !!a.tp) - (!!b.sl + !!b.tp));
    const best = pool[0], q1 = statsOf(best.sim, 1);
    return { ...best, y1: q1 ? q1.total : null, recentChecked: pool !== rows || bt.years <= 1 };
  }
  $('#bt-opt-btn').addEventListener('click', () => { const b = $('#bt-opt'); if (!b.hidden) { b.hidden = true; return; } b.hidden = false; optRender(); });
  $('#bt-opt').addEventListener('change', e => {
    const m = e.target.closest('[data-opt-min]');
    if (m) { const v = Number(m.value); if (m.dataset.optMin === 'n') { if (okN(v)) bt.minN = v; } else if (okR(v)) bt.minRate = v; saveBt(); const keep = [...$('#bt-opt').querySelectorAll('[data-opt-t]')].filter(c => c.checked).map(c => c.dataset.optT); optRender(); keep.forEach(t => { const c = $('#bt-opt').querySelector(`[data-opt-t="${CSS.escape(t)}"]`); if (c) c.checked = true; }); optSync(); return; }
    if (e.target.matches('[data-opt-all]')) $('#bt-opt').querySelectorAll('[data-opt-t]').forEach(c => { c.checked = e.target.checked; });
    optSync();
  });
  $('#bt-opt').addEventListener('click', async e => {
    if (e.target.closest('[data-opt-close]')) { $('#bt-opt').hidden = true; optRun++; return; }
    if (e.target.closest('[data-bt-min-reset]')) { bt.minN = MIN_N_DEF; bt.minRate = MIN_RATE_DEF; saveBt(); optRender(); return; }
    const go = e.target.closest('[data-opt-go]');
    if (!go) return;
    const ts = [...$('#bt-opt').querySelectorAll('[data-opt-t]')].filter(c => c.checked).map(c => c.dataset.optT);
    if (!ts.length || !confirm(`${ts.length}종목의 ★ 신호와 손절·익절을 가장 좋은 조합으로 바꿀까요?\n(최소 기준: 거래 ${bt.minN}번·승률 ${bt.minRate}% 이상, 기간 ${btName()})`)) return;
    const run = ++optRun, out = [];
    go.disabled = true;
    const status = $('#bt-opt').querySelector('[data-opt-n]');
    for (let k = 0; k < ts.length; k++) {
      const t = ts[k];
      if (status) status.textContent = `계산 중 ${k + 1}/${ts.length} · ${t}`;
      let b = null, err = null;
      try { b = await bestFor(t); } catch (x) { err = x; }
      if (run !== optRun) return; // 닫힘
      const before = tstrat[t] ? ((STRATS.find(s => s.id === tstrat[t]) || {}).name || tstrat[t]) : '없음';
      if (b) { setSltp(t, b.s.id, { sl: b.sl, tp: b.tp }); setTickerStrat(t, b.s.id); }
      out.push({ t, b, err, before });
    }
    btChanged();
    const pct = v => `<span class="chg ${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%</span>`;
    const done = out.filter(x => x.b).length;
    // 거래마다 무조건 500만원씩만 샀다면 번 돈을 모두 더한 금액 (번 돈은 다시 넣지 않음). 거래별 수익률에 사고팔 때 수수료가 이미 들어 있음
    const PER = 5e6, fee = bt.fee / 100;
    const money = st => PER * st.n * st.avg;
    const man = v => `${v >= 0 ? '+' : '-'}${Math.round(Math.abs(v) / 1e4).toLocaleString('ko-KR')}만원`;
    const won = v => `<span class="chg ${v >= 0 ? 'up' : 'down'}">${man(v)}</span>`;
    const okRows = out.filter(x => x.b), sumN = okRows.reduce((a, x) => a + x.b.st.n, 0), sumM = okRows.reduce((a, x) => a + money(x.b.st), 0);
    const sumFee = sumN * PER * fee * 2;
    optRender(`<p class="small pos">${done}종목에 적용했습니다${out.length > done ? `, ${out.length - done}종목은 기준을 넘는 조합이 없어 그대로 두었습니다` : ''}.</p>
      ${okRows.length ? `<p class="opt-sum">거래마다 500만원씩만 샀다면 (${esc(btName())}): 거래 ${sumN.toLocaleString('ko-KR')}번 · 누적 수익금 <b>${won(sumM)}</b> <span class="muted small">수수료 약 ${Math.round(sumFee / 1e4).toLocaleString('ko-KR')}만원 빼고 (한 번 살 때·팔 때 각 ${bt.fee}%), 세금 전</span></p>` : ''}
      <div class="table-scroll"><table class="grid"><thead><tr><th>종목</th><th>★ 신호</th><th>손절</th><th>익절</th><th>거래</th><th>승률</th><th>누적</th><th title="거래마다 500만원씩만 샀다면 번 돈을 모두 더한 금액 (번 돈은 다시 넣지 않음, 수수료 포함, 세금 전)">누적 수익금<br><span class="muted small">500만원씩</span></th><th>최근 1년</th><th title="적용하기 전에 ★였던 신호">이전 ★</th></tr></thead><tbody>${out.map(x => x.b
        ? `<tr><td><b>${esc(x.t)}</b></td><td>${esc(x.b.s.name)}</td><td>${x.b.sl ? '-' + x.b.sl + '%' : '안 씀'}</td><td>${x.b.tp ? '+' + x.b.tp + '%' : '안 씀'}</td><td>${x.b.st.n}</td><td>${Math.round(x.b.st.rate * 100)}%</td><td>${pct(x.b.st.total)}</td><td>${won(money(x.b.st))}</td><td>${x.b.y1 == null ? '<span class="muted small">거래 없음</span>' : pct(x.b.y1)}</td><td class="muted small">${esc(x.before)}</td></tr>`
        : `<tr><td><b>${esc(x.t)}</b></td><td colspan="8" class="muted small">${x.err ? '주가를 불러오지 못함' : '기준을 넘는 조합 없음'} · 그대로 둠</td><td class="muted small">${esc(x.before)}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted small">지난 차트에 맞춘 값이라 앞으로도 똑같이 맞지는 않습니다. 기간이 3·5년이면 최근 1년도 플러스인 조합을 먼저 골랐습니다. 마음에 안 들면 그 종목에서 '손절·익절 풀기'나 '손절·익절 찾기'로 바꾸세요. '누적 수익금'은 거래마다 500만원씩만 넣고 번 돈을 다 더한 금액이고, '누적'(%)은 번 돈까지 다시 넣어 굴렸다고 본 수익률이라 둘이 다르게 보일 수 있습니다.</p>`);
  });
  // "손절·익절 풀기": 이 종목 + 지금 신호의 손절·익절을 지우고, 이 신호가 ★(적용 신호)였으면 그것도 지움
  $('#bt-reset').addEventListener('click', () => {
    const t = modalTicker, cs = STRATS.find(x => x.id === stratSel);
    if (!t || !cs) return;
    if (!confirm(`${t} · ${cs.name}의 손절·익절을 풀고 처음 상태로 돌릴까요?`)) return;
    setSltp(t, cs.id, { sl: null, tp: null });
    if (tstrat[t] === cs.id) { delete tstrat[t]; lsSet(TSTRAT_KEY, tstrat); }
    btChanged();
  });
  $('#bt-search').addEventListener('click', e => {
    if (e.target.closest('[data-bt-close]')) { $('#bt-search').hidden = true; return; }
    if (e.target.closest('[data-bt-min-reset]')) { bt.minN = MIN_N_DEF; bt.minRate = MIN_RATE_DEF; saveBt(); findSlTp(); return; }
    const a = e.target.closest('[data-bt-apply]');
    if (!a) return;
    const [sl, tp] = a.dataset.btApply.split(',').map(v => parseFloat(v) || null);
    setSltp($('#bt-search').dataset.t || modalTicker, $('#bt-search').dataset.sid || stratSel, { sl, tp });
    setTickerStrat($('#bt-search').dataset.t || modalTicker, $('#bt-search').dataset.sid || stratSel);
    btChanged(); // 결과 칸은 열린 채로 '지금 설정'이 바뀐 걸 다시 보여 줌
  });
  // "ⓘ 신호 설명" 버튼은 아래 설명 칸이 열려 있을 때 눌린 모양으로 (칸 제목을 눌러 닫아도 같이 바뀜)
  const syncAbout = () => $$('.chip[data-about]').forEach(c => c.classList.toggle('on', !!$('#modal-info')?.open));
  $('#modal-info')?.addEventListener('toggle', syncAbout);
  document.addEventListener('click', e => {
    const b = e.target.closest('.strat-pick .chip[data-sid]'), ib = e.target.closest('.ind-pick .chip[data-iid]'), add = e.target.closest('.chip.add');
    if (add) { openAdd(add.dataset.addKind); return; }
    const del = e.target.closest('.chip.del');
    if (del) { openDel(del.dataset.delKind); return; }
    if (e.target.closest('.chip[data-about]')) {
      // 한 번 누르면 열고, 다시 누르면 닫아 차트를 크게 돌려놓는다
      const info = $('#modal-info');
      info.open = !info.open;
      if (info.open) setTimeout(() => { const a = $('#sig-about'); (a || info).scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
      return;
    }
    if (b) {
      if (b.dataset.sid === stratSel) return;
      stratSel = baseSel = b.dataset.sid;
      lsSet('dcf-strategy-id', stratSel);
      searchRefresh(); // 열려 있으면 새 신호로 다시 계산
    } else if (ib) {
      const id = ib.dataset.iid;
      indOff = indOff.includes(id) ? indOff.filter(x => x !== id) : [...indOff, id];
      lsSet('dcf-indicators-off', indOff);
    } else return;
    renderPickers();
    if (!$('#chart-modal').hidden) { if (b) renderWatch(); if (modalTicker) showModalTicker(modalTicker); }
  });

  // 신호 설명 (js/strategy.js 의 about: [제목, 내용] 목록). 직접 추가한 신호는 읽어 낸 조건을 보여 줌
  function aboutHtml(s) {
    const rows = s.about || (s.desc ? [['조건', s.desc]] : []);
    if (!rows.length) return '';
    return `<div id="sig-about" class="sig-about" style="--c:${s.color}"><h4>이 신호는? <span class="muted small">${esc(s.name)}</span></h4><dl>` +
      rows.map(([t, p]) => `<dt>${esc(t)}</dt><dd>${esc(p)}</dd>`).join('') + '</dl></div>';
  }
  // 실적 발표가 7일 안인데 매수 신호이거나 보유 중이면 경고
  function earnWarn(d, st) {
    const ea = earnOf(d);
    if (!ea || !ea.near || !['buy', 'hold'].includes(st.cls)) return '';
    return `<p class="earn-warn small">⚠ ${esc(ea.text)}: 실적 발표 전후로는 주가가 크게 튀어 신호가 잘 안 맞습니다. ${st.cls === 'buy' ? '발표 뒤에 들어가는 것도 방법입니다.' : '발표 전에 정리할지 생각해 보세요.'}</p>`;
  }
  const btFromTxt = d => btSpanTxt(d);
  const btRuleTxt = ss => { const r = sltpOf(modalTicker, stratSel); return r.sl || r.tp ? ` · ${[r.sl ? `손절 -${r.sl}%` : '', r.tp ? `익절 +${r.tp}%` : ''].filter(Boolean).join(' · ')}${ss && ss.stops ? ` (${ss.stops}번 발동)` : ''}` : ''; };
  // 차트 아래 "신호 자세히": 고른 신호, 모든 전략 승률 비교, 켜 둔 지표 상태, 최근 신호
  function renderSigInfo(r) {
    const d = r.d, n = d.close.length, L = n - 1, last = d.close[L];
    const s = activeStrats()[0];
    let html = '';
    if (s) {
      const sim = simOf(r, s);
      if (sim.error) html = `<div class="strat-row" style="--c:${s.color}"><div class="strat-head"><i></i><b>${esc(s.name)}</b><span class="sig-badge">계산 오류</span></div><p class="small muted">${esc(sim.error)}</p></div>`;
      else {
        const st = sigState(d, sim), latest = sim.marks[sim.marks.length - 1], ss = statsOf(sim);
        let lastTxt = `${d.time[0]} 이후로 신호가 한 번도 없었습니다.`;
        if (latest) {
          const days = L - latest.i;
          lastTxt = `마지막 신호: <b>${latest.kind === 'buy' ? '매수' : '청산'}</b> · ${d.time[latest.i]}${days ? ` (${days}거래일 전)` : ''} · ${fmtP(d.close[latest.i])}` + (days ? ` → 지금 ${fmtP(last)} ${fmtR(last / d.close[latest.i] - 1)}` : '');
        }
        const stats = ss ? `${esc(btDuring(d))} 이 조건대로 사고팔았다면: 거래 ${ss.n}번 · 이긴 거래 ${ss.wins}번 (<b>${Math.round(ss.rate * 100)}%</b>) · 거래당 평균 ${fmtR(ss.avg)} · 누적 ${fmtR(ss.total)} · 최대 낙폭 ${fmtR(ss.mdd)}` +
          ` · 같은 기간 그냥 들고 있었다면 ${fmtR(ss.hold)} <span class="muted">(다음 날 시가 체결, 수수료 ${(sim.fee * 100).toFixed(2)}%${btRuleTxt(ss)})</span>` : `<span class="muted">${esc(btDuring(d))} 끝난 거래가 없습니다.</span>`;
        html = `<div class="strat-row" style="--c:${s.color}">
          <div class="strat-head"><i></i><b>${esc(s.name)}</b><span class="sig-badge ${st.cls}">${st.text}</span></div>
          <p class="strat-desc muted small">${esc(s.desc || '')}</p>
          <p class="sig-last">${lastTxt}</p>${(pv => pv ? `<p class="ext-prev small"><span class="sig-tag ${pv.cls}">미리보기</span> ${esc(pv.text)} <span class="muted">(시간외는 거래가 적어 정규장 종가와 다를 수 있습니다. 실제 신호·알림은 정규장 종가 기준)</span></p>` : '')(extPreview(r, s))}${earnWarn(d, st)}${stats ? `<p class="sig-stats small">${stats}</p>` : ''}</div>`;
      }
      html += aboutHtml(s);
    }
    // 전략별 승률 비교 (이 종목)
    const rows = STRATS.map(x => {
      const sim = simOf(r, x), ss = statsOf(sim), st = sigState(d, sim);
      return `<tr class="${x.id === stratSel ? 'sel' : ''}"><td><span class="strat-name" style="--c:${x.color}"><i></i>${esc(x.name)}</span></td>` +
        (sim.error ? '<td colspan="6" class="muted">계산 오류</td>' :
          `<td>${ss ? ss.n : 0}</td><td>${ss ? `<b>${Math.round(ss.rate * 100)}%</b>` : '-'}</td><td>${ss ? fmtR(ss.avg) : '-'}</td><td>${ss ? fmtR(ss.total) : '-'}</td><td>${ss ? fmtR(ss.mdd) : '-'}</td><td><span class="sig-tag ${st.cls}">${st.short || '-'}</span></td>`) + '</tr>';
    }).join('');
    const [s0, e0] = btRange(d);
    html += `<h4 class="cmp-title">전략별 지난 성적 <span class="muted small">${esc(modalTicker || '')} · ${esc(btSpanTxt(d))} · 그냥 들고 있었다면 ${fmtR(d.close[e0] / d.open[s0] - 1)}${btRuleTxt()}</span></h4>
      <div class="table-scroll"><table class="grid cmp"><thead><tr><th>신호</th><th>거래</th><th>승률</th><th>거래당 평균</th><th>누적</th><th>최대 낙폭</th><th>오늘</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    $('#sig-strats').innerHTML = html;

    // 최근 신호 (고른 신호)
    const sim = s && simOf(r, s);
    if (sim && sim.marks && sim.marks.length) {
      const rows2 = sim.marks.slice(-15).reverse().map(m => {
        const px = m.price || d.close[m.i];
        return `<tr><td>${d.time[m.i]}</td><td><span class="sig-tag ${m.kind}">${m.kind === 'buy' ? '매수' : m.reason || '청산'}</span></td><td>${fmtP(px)}</td><td>${m.i === L ? '-' : fmtR(last / px - 1)}</td></tr>`;
      }).join('');
      $('#sig-table').innerHTML = `<thead><tr><th>날짜</th><th>신호</th><th>가격</th><th>지금까지</th></tr></thead><tbody>${rows2}</tbody>`;
      $('#sig-more').hidden = false;
    }
    $('#sig-ind').innerHTML = activeInds().map(ind => {
      const o = indOf(r, ind);
      const st = o.error ? { text: '계산 오류: ' + o.error, tone: '' } : o.status;
      return st ? `<li><span class="ind-name">${esc(ind.name)}</span><span class="ind-val ${st.tone ? 'chg ' + st.tone : ''}">${esc(st.text)}</span></li>` : '';
    }).join('');
  }

  function recalc() {
    save();
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
        <div class="fv pe"><div class="k">${LABEL[k]}${e.est ? '' : ' †'} <span class="muted">EPS $${fmt(e.v, 2)}${e.adj ? ` (추정치 $${fmt(e.adj, 2)}는 일회성으로 보고 보정)` : ''}</span></div>
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

  // ---------- 크게 보기 (제목 옆 "차트" 버튼) + 관심종목 ----------
  // 관심종목은 이 브라우저에만 저장됩니다 (localStorage).
  const WL_KEY = 'dcf-watchlist';
  const loadWl = () => { try { const a = JSON.parse(localStorage.getItem(WL_KEY)); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : []; } catch (e) { return []; } };
  const saveWl = a => { try { localStorage.setItem(WL_KEY, JSON.stringify(a)); } catch (e) { /* 저장 불가 */ } };
  // 실제 보유 종목은 관심종목 중 따로 표시 (이 브라우저에만 저장)
  const HOLD_KEY = 'dcf-holdings';
  let watch = loadWl(), modalTicker = null, modalChart = null;
  let holds = [].concat(lsGet(HOLD_KEY, [])).filter(x => typeof x === 'string' && watch.includes(x));
  const saveHolds = () => lsSet(HOLD_KEY, holds);
  // 테마(전력, 우주 …): 종목마다 하나씩 붙이고 위 칩으로 골라 봅니다.
  // 처음엔 js/themes.js가 자동으로 붙이고(사전 → 야후 업종), 사용자가 바꾸거나 뺀 것('')은 그대로 둡니다.
  const THEME_KEY = 'dcf-themes', THEME_PICK_KEY = 'dcf-theme-pick';
  let themes = (o => o && typeof o === 'object' && !Array.isArray(o) ? o : {})(lsGet(THEME_KEY, {}));
  Object.keys(themes).forEach(t => { if (!watch.includes(t) || typeof themes[t] !== 'string') delete themes[t]; });
  const autoTheme = (t, profile) => { if (t in themes) return false; const g = window.THEMES.guess(t, profile); if (g) themes[t] = g; return !!g; };
  let themePick = lsGet(THEME_PICK_KEY, '');
  // 테마 칸 접기: 접으면 한 줄만 (고른 테마는 '전체' 바로 옆으로), 펼치면 전부
  let themeFold = lsGet('dcf-theme-fold', true) !== false;
  const saveThemes = () => lsSet(THEME_KEY, themes);
  if (watch.filter(t => autoTheme(t)).length) saveThemes();
  const themeList = () => [...new Set(watch.map(t => themes[t]).filter(Boolean))];
  const shown = t => !themePick || themes[t] === themePick;
  function renderThemes() {
    const box = $('#wl-themes'), list = themeList();
    if (themePick && !list.includes(themePick)) { themePick = ''; lsSet(THEME_PICK_KEY, ''); }
    box.hidden = !list.length;
    const order = themeFold && themePick ? [themePick, ...list.filter(x => x !== themePick)] : list;
    box.classList.toggle('fold', themeFold);
    box.innerHTML = `<div class="wl-themes-row">${[['', '전체', watch.length], ...order.map(x => [x, x, watch.filter(t => themes[t] === x).length])]
      .map(([v, label, n]) => `<button type="button" class="chip ${v === themePick ? 'on' : ''}" data-theme-pick="${esc(v)}">${esc(label)} <span class="muted">${n}</span></button>`).join('')}</div>`
      + `<button type="button" class="ghost mini wl-themes-fold" title="${themeFold ? '테마를 모두 펼쳐 봅니다' : '테마 칸을 한 줄로 줄입니다 (옆으로 끌거나 밀어서 보기)'}">${themeFold ? '펼치기 ▾' : '접기 ▴'}</button>`;
    box.querySelector('.wl-themes-fold').hidden = list.length < 3;
  }

  // 맨 위 탭: chart = 차트·신호(이 화면), dcf = DCF 적정가
  const TAB_KEY = 'dcf-tab';
  function markTab(tab) {
    $$('#tabs [data-tab]').forEach(b => { const on = b.dataset.tab === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    lsSet(TAB_KEY, tab);
  }
  function openModal(t) {
    t = (t || state.ticker || watch[0] || '').trim().toUpperCase();
    markTab('chart');
    $('#chart-modal').hidden = false;
    document.body.classList.add('modal-open');
    renderPickers();
    renderWatch();
    modalTicker = null; // 다시 열 때도 그 종목의 신호로 먼저
    if (t) showModalTicker(t);
    else $('#modal-sig').innerHTML = '<p class="muted" style="padding:24px">왼쪽에 관심종목을 추가하거나, 위 검색창에서 종목을 계산하세요.</p>';
  }
  function closeModal() {
    markTab('dcf');
    // 차트에서 보던 종목을 DCF 칸에 미리 넣어 둠 (비어 있을 때만)
    if (modalTicker && !$('#lookup-ticker').value) $('#lookup-ticker').value = modalTicker;
    $('#chart-modal').hidden = true;
    document.body.classList.remove('modal-open');
    if (modalChart) { modalChart.remove(); modalChart = null; }
  }
  async function showModalTicker(t, live) {
    if (live) return liveModal(t);
    const moved = modalTicker !== t;
    modalTicker = t;
    // 다른 종목으로 옮길 때만: 이 종목에 손절·익절을 적용한 신호가 있으면 그 신호로 먼저 (같은 종목에서 신호를 바꾸는 건 그대로 둠)
    if (moved) useTickerStrat(t);
    renderBt(); // 손절·익절 칸은 이 종목 값으로
    if (!$('#bt-search').hidden && $('#bt-search').dataset.t !== t) searchRefresh(); // 열려 있으면 새 종목으로 다시 계산
    renderWatch();
    $('#modal-title').textContent = t;
    if (moved) { $('#opt-body').innerHTML = '<p class="muted small">펼치면 불러옵니다.</p>'; loadOpt(t); }
    if (moved && $('#deep-box').open) renderDeep(t);
    $('#modal-sub').textContent = '불러오는 중…';
    $('#modal-sub').className = 'modal-sub';
    if (modalChart) { modalChart.remove(); modalChart = null; }
    $('#modal-sig').innerHTML = '';
    $('#sig-strats').innerHTML = '';
    $('#sig-ind').innerHTML = '';
    $('#sig-more').hidden = true;
    pickRates = {};
    renderPickers();
    try {
      const r = await getSig(t);
      if (modalTicker !== t || $('#chart-modal').hidden) return;
      drawModal(r);
    } catch (e) {
      if (modalTicker === t) $('#modal-sub').textContent = '주가를 불러오지 못했습니다: ' + (e.message || e);
    }
  }
  // 1분마다 새 주가로 다시 그리기: '불러오는 중'으로 지우지 않고, 보던 차트 구간도 그대로
  async function liveModal(t) {
    let r;
    try { r = await getSig(t); } catch (e) { return; }
    if (modalTicker !== t || $('#chart-modal').hidden) return;
    let range = null;
    try { range = modalChart && modalChart.timeScale().getVisibleLogicalRange(); } catch (e) { /* 없음 */ }
    if (modalChart) { modalChart.remove(); modalChart = null; }
    drawModal(r);
    try { if (range && modalChart) modalChart.timeScale().setVisibleLogicalRange(range); } catch (e) { /* 그대로 */ }
  }
  // 가격 시각: 한국 시간으로 (예: 11-24 05:59)
  const kstTime = iso => { if (!iso) return ''; const x = new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString(); return x.slice(5, 10) + ' ' + x.slice(11, 16); };
  function drawModal(r) {
    {
      const s0 = activeStrats()[0], sim0 = s0 && simOf(r, s0), st = sigState(r.d, sim0), ss = statsOf(sim0), L = r.d.close.length - 1;
      const chg = L > 0 ? r.d.close[L] / r.d.close[L - 1] - 1 : 0;
      pickRates = {};
      STRATS.forEach(x => { const sm = simOf(r, x); if (!sm.error) pickRates[x.id] = statsOf(sm); });
      renderPickers();
      const ex = extOf(r.d), ea = earnOf(r.d);
      $('#modal-sub').innerHTML = `${fmtP(r.d.close[L])} ${fmtR(chg)}${ex ? ` · <span class="ext-quote">${ex.label} ${fmtP(ex.price)} ${fmtR(ex.chg)}</span>` : ''}${(pv => pv && pv.short ? ` <span class="sig-tag ${pv.cls}" title="${esc(pv.text)}">${pv.label} 기준 ${pv.short}?</span>` : '')(extPreview(r, s0))}${ea ? ` · <span class="earn-tag ${ea.near ? 'near' : ''}">${ea.near ? '⚠ ' : ''}${esc(ea.text)}</span>` : ''} · ${s0 ? `<span class="strat-name" style="--c:${s0.color}"><i></i>${esc(s0.short)}</span> ` : ''}<span class="sig-tag ${st.cls}">${st.text}</span>` +
        (ss ? ` · <b>승률 ${Math.round(ss.rate * 100)}%</b> <span class="muted small">(거래 ${ss.n}번 · 누적 ${(ss.total * 100).toFixed(0)}%)</span>` : '') +
        ` <span class="muted small" title="열려 있는 동안 1분마다 새 주가를 받습니다. 장중에는 오늘 봉이 지금 가격으로 계속 바뀝니다">${r.d.lastTime ? `가격 ${kstTime(r.d.lastTime)} (한국 시간)` : `${r.d.time[L]} 종가`} · 1분마다 자동 갱신</span>`;
      const sets = s0 && !sim0.error ? [{ strat: s0, sim: sim0 }] : [];
      modalChart = window.SigChart.draw($('#modal-sig'), r.d, sets, activeInds().map(ind => ({ ind, out: indOf(r, ind) })).filter(x => !x.out.error), { bars: 160, ext: ex, earn: ea });
      renderSigInfo(r);
    }
  }
  // 옵션 요약 (api/options). 펼쳤을 때만 받고, 종목마다 10분 동안 다시 받지 않음
  const optCache = {};
  const big = v => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : String(Math.round(v)));
  const pcTxt = v => (v == null ? '-' : v.toFixed(2) + (v >= 1.3 ? ' (풋 많음 · 하락 대비가 많음)' : v <= 0.7 ? ' (콜 많음 · 상승 기대가 많음)' : ' (보통)'));
  function optExpHtml(e, price) {
    const mv = e.move && e.move.pct != null ? `±${(e.move.pct * 100).toFixed(1)}% (${fmtP(price - e.move.usd)} ~ ${fmtP(price + e.move.usd)})` : '-';
    const walls = (a, cls) => a.length ? a.map(w => `<span class="opt-wall ${cls}">${fmtP(w.strike)} <span class="muted">${big(w.oi)}</span></span>`).join(' ') : '<span class="muted">-</span>';
    const mp = e.maxPain != null ? `${fmtP(e.maxPain)} <span class="muted">(지금보다 ${fmtR(e.maxPain / price - 1)})</span>` : '-';
    return `<div class="opt-exp"><h4>${esc(e.expiry || '')} 만기 <span class="muted small">${e.days != null ? e.days + '일 남음' : ''}</span></h4><dl class="opt-grid">
      <dt>예상 변동폭</dt><dd>${mv}<br><span class="muted small">등가격 콜+풋 값으로 본 만기까지 움직일 폭</span></dd>
      <dt>내재 변동성</dt><dd>${e.iv != null ? (e.iv * 100).toFixed(0) + '% (연율)' : '-'}</dd>
      <dt>풋·콜 비율</dt><dd>미결제약정 ${pcTxt(e.pcOI)}<br><span class="muted small">오늘 거래량 ${e.pcVol == null ? '-' : e.pcVol.toFixed(2)} · 콜 ${big(e.callVol)} / 풋 ${big(e.putVol)}</span></dd>
      <dt>맥스 페인</dt><dd>${mp}<br><span class="muted small">만기에 옵션 산 사람들이 가장 적게 버는 가격</span></dd>
      <dt>위쪽 콜 벽</dt><dd>${walls(e.callWall, 'call')}<br><span class="muted small">콜 미결제약정이 많은 행사가 · 저항 후보</span></dd>
      <dt>아래쪽 풋 벽</dt><dd>${walls(e.putWall, 'put')}<br><span class="muted small">풋 미결제약정이 많은 행사가 · 지지 후보</span></dd>
    </dl></div>`;
  }
  async function loadOpt(t) {
    const body = $('#opt-body');
    if (!t || !$('#opt-box').open) return;
    const c = optCache[t];
    if (!c || Date.now() - c.at > 600e3) {
      body.innerHTML = '<p class="muted small">옵션 불러오는 중…</p>';
      optCache[t] = { at: Date.now(), p: fetch('api/options?ticker=' + encodeURIComponent(t)).then(async res => { const j = await res.json().catch(() => ({})); if (!res.ok) throw new Error(j.error || '옵션 조회 실패'); return j; }) };
      optCache[t].p.catch(() => delete optCache[t]);
    }
    let j;
    try { j = await optCache[t].p; } catch (e) { if (modalTicker === t) body.innerHTML = `<p class="muted small">${esc(e.message || String(e))}</p>`; return; }
    if (modalTicker !== t) return;
    if (j.none || !j.expiries || !j.expiries.length) { body.innerHTML = `<p class="muted small">${esc(j.none || '옵션 데이터가 없습니다.')}</p>`; return; }
    body.innerHTML = `<p class="small">${esc(t)} 주가 ${fmtP(j.price)} 기준</p>` + j.expiries.map(e => optExpHtml(e, j.price)).join('');
  }
  $('#opt-box').addEventListener('toggle', () => loadOpt(modalTicker));
  // 🔬 심층 분석 보고서: 요청하면 서버가 Claude 에 맡기고 /d/<id> 주소를 돌려준다. 이 브라우저에 종목별로 지난 보고서 주소를 기억
  const DEEP_KEY = 'dcf-deep';
  function renderDeep(t) {
    const body = $('#deep-body'); if (!body) return;
    const list = ((lsGet(DEEP_KEY, {}) || {})[t] || []).slice(-5).reverse();
    body.innerHTML = `<p><button type="button" class="mini" data-deep-go>🔬 ${esc(t || '')} 보고서 요청</button> <span class="muted small" id="deep-msg"></span></p>` +
      (list.length ? `<p class="small">이 브라우저에서 요청한 보고서: ${list.map(x => `<a href="${esc(x.path)}" target="_blank" rel="noopener">${esc(String(x.at).slice(0, 10))}</a>`).join(' · ')}</p>` : '');
  }
  $('#deep-box').addEventListener('toggle', () => { if ($('#deep-box').open) renderDeep(modalTicker); });
  $('#deep-body').addEventListener('click', async e => {
    if (!e.target.closest('[data-deep-go]')) return;
    const t = modalTicker, msg = $('#deep-msg');
    if (!t) return;
    const pw = sGet('dcf-sync-pw');
    if (!pw) { msg.textContent = '먼저 ☁ 자동 동기화를 켜 주세요. 그 비밀번호로 요청합니다.'; return; }
    if (!confirm(`${t} 심층 분석 보고서를 요청할까요?\n10~40분(길면 몇 시간) 걸리고 Claude 비용이 약 1~3달러 듭니다. 하루 5번까지.`)) return;
    const btn = e.target.closest('button'); btn.disabled = true; msg.textContent = '요청하는 중…';
    try {
      const res = await fetch('/api/kakao', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'deep', ticker: t, password: pw }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || '요청 실패');
      const all = lsGet(DEEP_KEY, {}) || {}; (all[t] = all[t] || []).push({ path: j.path, at: new Date().toISOString() }); lsSet(DEEP_KEY, all);
      renderDeep(t);
      $('#deep-msg').innerHTML = `요청했습니다. <a href="${esc(j.path)}" target="_blank" rel="noopener">진행 상황·보고서 열기</a> (다 되면 카톡 알림도 갑니다)`;
      window.open(j.path, '_blank', 'noopener');
    } catch (err) { msg.textContent = err.message || String(err); btn.disabled = false; }
  });
  // 실시간 갱신: 화면이 보이고 차트 탭이 열려 있을 때만, 1분마다 목록 종목 + 보던 종목을 새로 받음
  let liveBusy = false;
  async function liveTick() {
    if (liveBusy || document.hidden || $('#chart-modal').hidden) return;
    liveBusy = true;
    try {
      const ts = [...new Set([modalTicker, ...watch].filter(t => t && sigCache[t]))];
      let ok = false;
      for (let k = 0; k < ts.length; k += 4) ok = (await Promise.all(ts.slice(k, k + 4).map(refreshSig))).some(Boolean) || ok;
      if (!ok || document.hidden || $('#chart-modal').hidden) return;
      if (!drag) renderWatch();
      if (modalTicker) showModalTicker(modalTicker, true);
    } finally { liveBusy = false; }
  }
  setInterval(liveTick, 60000);
  // 다른 탭에 있다가 돌아오면 바로 한 번
  document.addEventListener('visibilitychange', () => { if (!document.hidden) liveTick(); });
  const GRP_KEY = 'dcf-wl-open';
  let grpOpen = lsGet(GRP_KEY, []);
  // 목록 기준: 'ticker' = 종목마다 손절·익절을 적용한 신호 (없으면 지금 고른 신호), 'current' = 모두 지금 고른 신호
  const WL_MODE_KEY = 'dcf-wl-mode';
  let wlMode = lsGet(WL_MODE_KEY, 'ticker') === 'current' ? 'current' : 'ticker';
  function wlStratFor(t) {
    const cur = activeStrats()[0];
    if (wlMode !== 'ticker') return cur;
    return STRATS.find(x => x.id === tstrat[t]) || STRATS.find(x => x.id === baseSel) || cur;
  }
  function renderWlMode() {
    $$('#wl-mode [data-wl-mode]').forEach(b => b.classList.toggle('on', b.dataset.wlMode === wlMode));
  }
  function renderWatch() {
    renderWlMode();
    const list = $('#wl-list');
    const cur = (state.ticker || '').trim().toUpperCase();
    renderThemes();
    const held = watch.filter(t => holds.includes(t) && shown(t)), rest = watch.filter(t => !holds.includes(t) && shown(t));
    const items = [...(cur && !watch.includes(cur) ? [cur] : []), ...held, ...rest];
    const row = t => {
      const saved = watch.includes(t), h = holds.includes(t);
      return `
      <li class="${t === modalTicker ? 'on' : ''}" data-t="${esc(t)}"${saved ? ' data-saved="1"' : ''}>
        ${saved ? '<span class="wl-grip" title="끌어서 순서 바꾸기 · 보유/관심 칸 옮기기">⋮⋮</span>' : ''}<button type="button" class="wl-pick"><span class="wl-left"><span class="wl-name"><b>${esc(t)}</b>${saved ? `<span class="wl-theme ${themes[t] ? '' : 'none'}" data-theme-t="${esc(t)}" title="테마 정하기 (예: 전력, 우주)">${themes[t] ? esc(themes[t]) : '＋테마'}</span>` : ''}</span><span class="wl-rate" data-r="${esc(t)}"></span></span><span class="wl-val" data-v="${esc(t)}">…</span></button>
        ${saved ? `<button type="button" class="wl-kind ${h ? 'hold' : ''}" data-kind="${esc(t)}" title="${h ? '누르면 관심종목으로 옮깁니다' : '실제로 갖고 있으면 누르세요 (보유로 옮김)'}">${h ? '보유' : '관심'}</button><button type="button" class="wl-del" title="빼기" data-del="${esc(t)}">✕</button>` : `<button type="button" class="wl-add" title="관심종목에 추가" data-add="${esc(t)}">＋</button>`}
      </li>`;
    };
    const sec = (title, arr, empty, k, body) => `<li class="wl-sec" data-sec="${k}">${title} <span class="muted">${arr.length}</span></li>` + (arr.length ? (body || arr.map(row).join('')) : `<li class="muted small wl-empty">${empty}</li>`);
    // 관심 종목은 섹터(테마)별로 묶어 접어 둡니다. 묶음 제목을 누르면 펼침 (펼친 묶음은 이 브라우저에 기억)
    const groups = [];
    rest.forEach(t => { const g = themes[t] || '기타'; let x = groups.find(y => y.name === g); if (!x) groups.push(x = { name: g, ts: [] }); x.ts.push(t); });
    const etc = groups.findIndex(g => g.name === '기타');
    if (etc >= 0) groups.push(groups.splice(etc, 1)[0]);
    const restBody = groups.map(g => {
      const open = !!themePick || grpOpen.includes(g.name);
      return `<li class="wl-grp${open ? ' open' : ''}" data-grp="${esc(g.name)}"><button type="button" class="wl-grp-btn" aria-expanded="${open}"><span class="wl-grp-arrow">${open ? '▾' : '▸'}</span><b>${esc(g.name)}</b><span class="muted">${g.ts.length}</span><span class="wl-grp-sig"></span></button></li>` +
        g.ts.map(t => row(t).replace('<li class="', `<li data-g="${esc(g.name)}" class="${open ? '' : 'fold '}`)).join('');
    }).join('');
    list.innerHTML = (cur && !watch.includes(cur) ? row(cur) : '') +
      (watch.length ? sec('보유 종목', held, '종목 옆 "관심"을 누르거나 여기로 끌어 오면 보유로 옮겨집니다.', 'hold') + sec('관심 종목', rest, themePick ? `'${esc(themePick)}' 테마의 관심 종목이 없습니다.` : '지켜볼 종목을 위에서 추가하세요.', 'watch', restBody)
        : '<li class="muted small wl-empty">관심종목이 없습니다. 위에 티커를 넣고 추가하세요.</li>');
    items.forEach(t => getSig(t).then(r => {
      const el = list.querySelector(`.wl-val[data-v="${CSS.escape(t)}"]`);
      if (!el) return;
      const s0 = wlStratFor(t), sim0 = s0 && simOf(r, s0);
      // 종목별 적용 신호 보기에서 ★(손절·익절 적용) 없는 종목은 매수·청산 표시를 안 함 (손절·익절을 찾은 뒤에 매매)
      const st = wlMode === 'ticker' && !STRATS.some(x => x.id === tstrat[t]) ? { short: '', cls: 'none' } : sigState(r.d, sim0);
      const L = r.d.close.length - 1, chg = L > 0 ? r.d.close[L] / r.d.close[L - 1] - 1 : 0;
      const ea = earnOf(r.d);
      // 장전·장후 미리보기 (★ 없는 종목은 위와 똑같이 표시 안 함)
      const pv = st.cls === 'none' && wlMode === 'ticker' && !STRATS.some(x => x.id === tstrat[t]) ? null : extPreview(r, s0);
      const pvOn = pv && pv.short && pv.cls !== st.cls;
      el.innerHTML = `${fmtR(chg)}${st.short ? ` <span class="sig-pill ${st.cls}">${st.short}</span>` : ''}${pvOn ? ` <span class="sig-pill ext ${pv.cls}" title="${esc(pv.text)} (미리보기)">${pv.label} ${pv.short}?</span>` : ''}${ea && ea.near ? ` <span class="sig-pill earn" title="${esc(ea.text)}">실적 ${ea.dday ? 'D-' + ea.dday : '오늘'}</span>` : ''}`;
      const rt = list.querySelector(`.wl-rate[data-r="${CSS.escape(t)}"]`);
      if (rt && sim0 && !sim0.error) {
        const ru = sltpOf(t, s0.id), other = s0.id !== stratSel;
        // 신호 · 승률 · 누적 수익률(지금 기간, 수수료 포함) · 손익절 설정
        const st0 = statsOf(sim0);
        rt.innerHTML = esc((other ? (s0.short || s0.name) + ' · ' : '') + rateTxt(st0)) + (st0 ? ` · <span class="chg ${st0.total >= 0 ? 'up' : 'down'}" title="${esc(btName())} 누적 수익률 (수수료 포함)">${st0.total >= 0 ? '+' : ''}${(st0.total * 100).toFixed(0)}%</span>` : '') + (ru.sl || ru.tp || tstrat[t] === s0.id ? ' <span class="sltp-tag">손익절 설정</span>' : '');
      }
      const li = el.closest('li');
      if (li) { li.dataset.sig = st.cls; if (pvOn) li.dataset.ext = pv.cls; else delete li.dataset.ext; }
      // 사전에 없는 종목은 야후 업종으로 테마를 붙입니다
      if (watch.includes(t) && autoTheme(t, r.d.profile)) {
        saveThemes(); renderThemes();
        const tg = list.querySelector(`.wl-theme[data-theme-t="${CSS.escape(t)}"]`);
        if (tg) { tg.textContent = themes[t]; tg.classList.remove('none'); }
      }
      updateOnly();
    }, () => {
      const el = list.querySelector(`.wl-val[data-v="${CSS.escape(t)}"]`);
      if (el) el.innerHTML = '<span class="muted">조회 실패</span>';
    }));
  }
  function addWatch(t, hold) {
    t = (t || '').trim().toUpperCase();
    if (!/^[A-Z0-9.\-^=]{1,15}$/.test(t)) return false;
    if (!watch.includes(t)) { watch.push(t); saveWl(watch); }
    if (hold && !holds.includes(t)) { holds.push(t); saveHolds(); }
    if (themePick && !themes[t]) themes[t] = themePick; // 테마를 고른 채 추가하면 그 테마로
    else autoTheme(t);
    saveThemes();
    return true;
  }

  $('#btn-chart').addEventListener('click', () => openModal());
    $('#modal-close').addEventListener('click', closeModal);
  // 표·결과 칸을 마우스로 잡고 끌어서 옆(과 위아래)으로 움직이기. 버튼·입력칸·체크칸 위에서는 원래대로 누르기
  (() => {
    const AREA = '.table-scroll, .bt-search, .wl-themes-row', SKIP = 'a, button, input, select, textarea, label, summary, .wl-grip';
    const canX = el => el.scrollWidth > el.clientWidth + 1, canY = el => el.scrollHeight > el.clientHeight + 1;
    // 누른 곳에서 가장 가까운, 실제로 넘치는 칸들 (가로는 표, 세로는 결과 칸일 수 있음)
    const areasAt = t => { const out = []; for (let el = t.closest(AREA); el; el = el.parentElement && el.parentElement.closest(AREA)) out.push(el); return out; };
    let g = null, eatClick = false;
    document.addEventListener('pointerover', e => {
      if (g || e.pointerType !== 'mouse') return;
      const el = e.target.closest && e.target.closest(AREA);
      if (el) el.classList.toggle('drag-scroll', canX(el) || canY(el));
    });
    document.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse' || e.button !== 0 || !e.target.closest || (e.target.closest(SKIP) && !e.target.closest('.wl-themes-row'))) return;
      const els = areasAt(e.target);
      const x = els.find(canX), y = els.find(canY);
      if (!x && !y) return;
      e.preventDefault(); // 글자 선택 대신 끌기
      g = { x, y, sx: e.clientX, sy: e.clientY, l: x ? x.scrollLeft : 0, t: y ? y.scrollTop : 0, moved: false };
      document.body.classList.add('drag-scrolling');
    });
    window.addEventListener('pointermove', e => {
      if (!g) return;
      const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
      if (!g.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      g.moved = true;
      if (g.x) g.x.scrollLeft = g.l - dx;
      if (g.y) g.y.scrollTop = g.t - dy;
    });
    window.addEventListener('pointerup', () => {
      if (!g) return;
      eatClick = g.moved;
      g = null;
      document.body.classList.remove('drag-scrolling');
      setTimeout(() => { eatClick = false; }, 0);
    });
    // 끌고 난 뒤 손을 뗄 때 생기는 click 은 무시 (줄이 눌리지 않게)
    document.addEventListener('click', e => { if (eatClick) { e.preventDefault(); e.stopPropagation(); eatClick = false; } }, true);
  })();
  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    if (b.dataset.tab === 'chart') { if ($('#chart-modal').hidden) openModal(); }
    else if (!$('#chart-modal').hidden) closeModal();
    window.scrollTo(0, 0);
  });
  $('#wl-form').addEventListener('submit', e => {
    e.preventDefault();
    // 리포트 종목을 한 번에: "GEV BE CEG" 처럼 띄어 쓰거나 쉼표로 여러 개
    const ts = $('#wl-input').value.toUpperCase().split(/[\s,]+/).filter(Boolean);
    const ok = ts.filter(t => addWatch(t, $('#wl-kind').value === 'hold'));
    if (!ok.length) return;
    $('#wl-input').value = '';
    showModalTicker(ok[0]);
  });
  // "오늘 매수·청산 신호 종목만": 해당 종목이 없으면 안내 문구
  function updateOnly() {
    // 접힌 묶음 제목에 오늘 매수·청산 신호 수를 보여 줌
    $$('#wl-list .wl-grp').forEach(gl => {
      const rows = [...$$('#wl-list li[data-g]')].filter(x => x.dataset.g === gl.dataset.grp);
      const nb = rows.filter(x => x.dataset.sig === 'buy').length, ns = rows.filter(x => x.dataset.sig === 'sell').length;
      gl.querySelector('.wl-grp-sig').innerHTML = (nb ? `<span class="sig-pill buy">매수 ${nb}</span>` : '') + (ns ? `<span class="sig-pill sell">청산 ${ns}</span>` : '');
    });
    const on = $('#wl-only').checked;
    $('#wl-list').classList.toggle('only', on);
    $('#wl-none').hidden = !on || !!$('#wl-list li[data-sig="buy"], #wl-list li[data-sig="sell"]');
    const ex = $('#wl-ext-only').checked;
    $('#wl-list').classList.toggle('ext-only', ex);
    $('#wl-ext-none').hidden = !ex || !!$('#wl-list li[data-ext]');
  }
  // 두 칸은 하나만 켬
  $('#wl-only').addEventListener('change', () => { if ($('#wl-only').checked) $('#wl-ext-only').checked = false; updateOnly(); });
  $('#wl-ext-only').addEventListener('change', () => { if ($('#wl-ext-only').checked) $('#wl-only').checked = false; updateOnly(); });
  $('#wl-mode').addEventListener('click', e => {
    const b = e.target.closest('[data-wl-mode]');
    if (!b || b.dataset.wlMode === wlMode) return;
    wlMode = b.dataset.wlMode; lsSet(WL_MODE_KEY, wlMode); renderWatch();
  });
  $('#wl-themes').addEventListener('click', e => {
    if (e.target.closest('.wl-themes-fold')) { themeFold = !themeFold; lsSet('dcf-theme-fold', themeFold); renderThemes(); return; }
    const c = e.target.closest('[data-theme-pick]');
    if (!c) return;
    themePick = c.dataset.themePick;
    lsSet(THEME_PICK_KEY, themePick);
    renderWatch();
  });
  $('#wl-list').addEventListener('click', e => {
    const gb = e.target.closest('.wl-grp-btn');
    if (gb) {
      const g = gb.closest('li').dataset.grp;
      grpOpen = grpOpen.includes(g) ? grpOpen.filter(x => x !== g) : [...grpOpen, g];
      lsSet(GRP_KEY, grpOpen);
      renderWatch();
      return;
    }
    const del = e.target.closest('[data-del]'), add = e.target.closest('[data-add]'), kind = e.target.closest('[data-kind]'), pick = e.target.closest('.wl-pick');
    const th = e.target.closest('[data-theme-t]');
    if (th) {
      const t = th.dataset.themeT, have = themeList();
      const v = prompt(`${t} 테마 이름 (예: 전력, 우주)${have.length ? '\n지금 있는 테마: ' + have.join(', ') : ''}\n비우면 테마를 뺍니다.`, themes[t] || themePick || '');
      if (v == null) return;
      const name = v.trim().slice(0, 12);
      themes[t] = name; // 비우면 '' (자동 테마도 다시 붙이지 않음)
      saveThemes(); renderWatch(); return;
    }
    if (del) { watch = watch.filter(x => x !== del.dataset.del); holds = holds.filter(x => x !== del.dataset.del); delete themes[del.dataset.del]; forgetTicker(del.dataset.del); saveWl(watch); saveHolds(); saveThemes(); renderWatch(); return; }
    if (kind) { const t = kind.dataset.kind; holds = holds.includes(t) ? holds.filter(x => x !== t) : [...holds, t]; saveHolds(); renderWatch(); return; }
    if (add) { addWatch(add.dataset.add); renderWatch(); return; }
    if (pick) showModalTicker(pick.closest('li').dataset.t);
  });

  // 목록 칸 넓이 조절: 오른쪽 경계(휴대폰은 아래 경계)를 끌면 바뀌고, 두 번 누르면 처음 크기로. 이 브라우저에 저장.
  const WL_SIZE_KEY = 'dcf-wl-size';
  const narrow = () => matchMedia('(max-width: 760px)').matches;
  function applyWlSize() {
    const sz = lsGet(WL_SIZE_KEY, {}) || {}, wl = $('.wl');
    wl.style.width = !narrow() && sz.w ? sz.w + 'px' : '';
    wl.style.maxHeight = narrow() && sz.h ? sz.h + 'px' : '';
    wl.style.height = narrow() && sz.h ? sz.h + 'px' : '';
  }
  applyWlSize();
  window.addEventListener('resize', applyWlSize);
  let rs = null;
  $('#wl-resize').addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    e.preventDefault();
    const wl = $('.wl'), r = wl.getBoundingClientRect();
    rs = { id: e.pointerId, x: e.clientX, y: e.clientY, w: r.width, h: r.height, v: narrow() };
    $('#wl-resize').classList.add('on');
    document.body.classList.add('wl-resizing');
  });
  document.addEventListener('pointermove', e => {
    if (!rs || e.pointerId !== rs.id) return;
    const box = $('.modal-box').getBoundingClientRect(), sz = lsGet(WL_SIZE_KEY, {}) || {};
    if (rs.v) sz.h = Math.round(Math.max(80, Math.min(box.height * 0.75, rs.h + e.clientY - rs.y)));
    else sz.w = Math.round(Math.max(220, Math.min(box.width - 420, rs.w + e.clientX - rs.x)));
    lsSet(WL_SIZE_KEY, sz);
    applyWlSize();
  });
  const endResize = e => {
    if (!rs || e.pointerId !== rs.id) return;
    rs = null;
    $('#wl-resize').classList.remove('on');
    document.body.classList.remove('wl-resizing');
  };
  document.addEventListener('pointerup', endResize);
  document.addEventListener('pointercancel', endResize);
  $('#wl-resize').addEventListener('dblclick', () => {
    const sz = lsGet(WL_SIZE_KEY, {}) || {};
    delete sz[narrow() ? 'h' : 'w'];
    lsSet(WL_SIZE_KEY, sz);
    applyWlSize();
  });

  // 손잡이(⋮⋮)를 끌어 순서 바꾸기 · 보유/관심 칸 옮기기 (마우스·터치 모두)
  let drag = null;
  $('#wl-list').addEventListener('pointerdown', e => {
    const grip = e.target.closest('.wl-grip');
    if (!grip || e.button > 0) return;
    e.preventDefault();
    const li = grip.closest('li');
    li.classList.add('dragging');
    drag = { li, id: e.pointerId };
  });
  // 줄을 옮기면 포인터 캡처가 풀리므로 문서 전체에서 받습니다
  document.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const list = $('#wl-list'), box = list.closest('.wl'), r = box.getBoundingClientRect();
    if (e.clientY < r.top + 30) box.scrollTop -= 8;
    else if (e.clientY > r.bottom - 30) box.scrollTop += 8;
    const first = list.querySelector('.wl-sec');
    const others = [...list.children].filter(x => x !== drag.li && (x.dataset.saved || x.classList.contains('wl-sec')) && (first.compareDocumentPosition(x) & 4 || x === first));
    const below = others.find(x => { const b = x.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
    if (below === first) list.insertBefore(drag.li, first.nextSibling);
    else if (below) list.insertBefore(drag.li, below);
    else list.appendChild(drag.li);
  });
  const endDrag = e => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.li.classList.remove('dragging');
    drag = null;
    let kind = null; const order = [], hold = [];
    [...$('#wl-list').children].forEach(x => {
      if (x.dataset.sec) kind = x.dataset.sec;
      else if (x.dataset.saved) { order.push(x.dataset.t); if (kind === 'hold') hold.push(x.dataset.t); }
    });
    // 테마로 거른 상태면 화면에 보이던 종목 자리만 새 순서로 채우고, 안 보이던 종목은 그대로 둡니다
    let k = 0;
    watch = watch.map(t => order.includes(t) ? order[k++] : t);
    holds = [...holds.filter(t => !order.includes(t)), ...hold];
    saveWl(watch); saveHolds(); renderWatch();
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  // ---------- 브라우저 사이에 맞추는 설정 목록 (자동 동기화가 씀) ----------
  // 옮기는 것: 관심·보유 종목, 순서, 테마, 펼친 묶음, 고른 신호·지표, 추가·가린·삭제한 신호, 종목별 손절·익절, 성적 기간.
  // 옮기지 않는 것: Claude API 키(비밀), 목록 칸 크기(화면마다 다름), DCF 계산 칸.
  const XFER_KEYS = ['dcf-watchlist', 'dcf-holdings', 'dcf-themes', 'dcf-theme-pick', 'dcf-wl-open', 'dcf-strategy-id', 'dcf-indicators-off',
    'dcf-custom-items', 'dcf-hidden-items', 'dcf-deleted-items', 'dcf-sltp', 'dcf-ticker-strat', 'dcf-wl-mode', 'dcf-backtest'];
  function xferSnapshot() {
    const o = {};
    XFER_KEYS.forEach(k => { try { const v = localStorage.getItem(k); if (v != null) o[k] = JSON.parse(v); } catch (e) { /* 깨진 값은 건너뜀 */ } });
    return o;
  }
  function xferApply(o) {
    XFER_KEYS.forEach(k => { try { if (k in o) localStorage.setItem(k, JSON.stringify(o[k])); else localStorage.removeItem(k); } catch (e) { /* 저장 불가 */ } });
  }

  // ---------- 자동 동기화 (/api/sync) ----------
  // 한 번 켜 두면 위 설정이 바뀔 때마다 서버에 올리고, 사이트를 열거나 다시 볼 때 서버 것을 받아 맞춥니다.
  // 비밀번호는 이 브라우저에만 저장(dcf-sync-pw)되고 내보내기·동기화 대상이 아닙니다. 마지막에 서버와 맞춘 내용은 dcf-sync-last.
  const SYNC_PW = 'dcf-sync-pw', SYNC_LAST = 'dcf-sync-last', SYNC_AT = 'dcf-sync-at';
  const sGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsPut = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* 저장 불가 */ } };
  const snapStr = () => JSON.stringify(xferSnapshot());
  let syncBusy = false, syncErr = '';
  async function syncCall(action, password, data) {
    const r = await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, password, data }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || `서버 오류 ${r.status}`); e.status = r.status; throw e; }
    return j;
  }
  const syncOn = () => !!sGet(SYNC_PW);
  function syncMark(str, at) { lsPut(SYNC_LAST, str); lsPut(SYNC_AT, at || new Date().toISOString()); }
  async function syncPush() {
    const pw = sGet(SYNC_PW); if (!pw || syncBusy) return;
    const str = snapStr();
    if (str === sGet(SYNC_LAST)) return;
    syncBusy = true;
    try { const j = await syncCall('push', pw, JSON.parse(str)); syncMark(str, j.updatedAt); syncErr = ''; } catch (e) { syncFail(e); }
    syncBusy = false; syncLabel();
  }
  // 서버 것을 받아 다르면 맞춘다. 반환: 바뀌었으면 true
  async function syncPull() {
    const pw = sGet(SYNC_PW); if (!pw || syncBusy) return false;
    syncBusy = true;
    let changed = false;
    try {
      const j = await syncCall('pull', pw);
      const local = snapStr();
      if (!j.data) { syncBusy = false; await syncPush(); return false; }
      const remote = JSON.stringify(j.data);
      if (local !== sGet(SYNC_LAST) && sGet(SYNC_LAST) != null) {
        // 이 브라우저에서 아직 못 올린 변경이 있으면 이쪽이 이깁니다
        syncBusy = false; await syncPush(); return false;
      }
      if (remote !== local) { xferApply(j.data); changed = true; }
      syncMark(snapStr(), j.updatedAt); syncErr = '';
    } catch (e) { syncFail(e); }
    syncBusy = false; syncLabel();
    return changed;
  }
  function syncFail(e) {
    syncErr = e.message || String(e);
    if (e.status === 401) { lsPut(SYNC_PW, null); syncErr = '비밀번호가 바뀌어 동기화가 꺼졌습니다. 다시 켜 주세요.'; }
  }
  function syncLabel() {
    const b = $('#sync-btn'); if (!b) return;
    b.onclick = null;
    b.textContent = syncOn() ? (syncErr ? '☁ 동기화 오류' : '☁ 동기화 켜짐') : '☁ 자동 동기화';
    b.classList.toggle('on', syncOn() && !syncErr);
    b.classList.toggle('err', !!syncErr);
    if (!$('#sync-box').hidden) syncBox();
  }
  const fmtAt = iso => { try { const d = new Date(iso); return d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };
  async function syncBox() {
    const box = $('#sync-box'), msg = $('#sync-msg');
    box.hidden = false;
    $('#sync-form').hidden = true; $('#sync-choice').hidden = true; $('#sync-off').hidden = true; $('#sync-now').hidden = true;
    if (syncOn()) {
      msg.innerHTML = `<b>자동 동기화 켜짐.</b> 이 브라우저에서 종목·신호·손절익절을 바꾸면 몇 초 안에 서버에 올라가고, 다른 기기는 사이트를 열거나 다시 볼 때 받아 맞춥니다.` +
        (sGet(SYNC_AT) ? `<br><span class="muted">마지막으로 맞춘 때: ${esc(fmtAt(sGet(SYNC_AT)))}</span>` : '') +
        (syncErr ? `<br><span class="neg">${esc(syncErr)}</span>` : '');
      $('#sync-off').hidden = false; $('#sync-now').hidden = false;
      return;
    }
    msg.textContent = '서버 확인 중…';
    let st = {};
    try { st = await (await fetch('/api/sync', { cache: 'no-store' })).json(); } catch (e) { st = { error: '서버에 연결하지 못했습니다.' }; }
    if (syncOn()) return syncBox();
    if (!st.configured) {
      msg.innerHTML = '<b>서버 저장소가 아직 연결되지 않았습니다.</b> Vercel에서 저장소를 한 번만 연결하면 이 버튼으로 켤 수 있습니다. 연결 순서는 대화방에 적어 두었습니다.' +
        (syncErr ? `<br><span class="neg">${esc(syncErr)}</span>` : '');
      return;
    }
    msg.innerHTML = st.hasPassword
      ? '다른 기기에서 정한 <b>동기화 비밀번호</b>를 넣고 켜세요. 이 브라우저에서는 한 번만 넣으면 됩니다.'
      : '처음 켜는 거라 <b>동기화 비밀번호</b>를 새로 정합니다(4자 이상). 다른 기기에서도 이 비밀번호를 한 번 넣으면 같은 설정을 씁니다.' +
        (syncErr ? `<br><span class="neg">${esc(syncErr)}</span>` : '');
    if (st.hasPassword && syncErr) msg.innerHTML += `<br><span class="neg">${esc(syncErr)}</span>`;
    $('#sync-form').hidden = false;
    $('#sync-pw').focus();
  }
  // ---------- 카카오톡 알림 (/api/kakao) ----------
  // 서버가 매일 아침(미국 장 마감 뒤) 동기화된 관심 종목을 종목별 적용 신호로 확인해, 새 매수·청산·손절·익절이 있으면 내 카톡으로 보냅니다.
  // 동기화 비밀번호로만 연결·확인할 수 있습니다.
  async function kakaoCall(action) {
    const r = await fetch('/api/kakao', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, password: sGet(SYNC_PW) }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `서버 오류 ${r.status}`);
    return j;
  }
  const KK = { box: '#kakao-box', msg: '#kakao-msg', list: '#kakao-list' };
  async function kakaoBox(note) {
    const box = $(KK.box), msg = $(KK.msg);
    box.hidden = false;
    ['#kakao-connect', '#kakao-check', '#kakao-report', '#kakao-off'].forEach(s => { $(s).hidden = true; });
    if (note === undefined) $(KK.list).textContent = '';
    const tail = note ? `<br>${note}` : '';
    if (!syncOn()) { msg.innerHTML = '먼저 <b>☁ 자동 동기화</b>를 켜 주세요. 서버가 동기화된 종목과 종목별 적용 신호로 매일 확인합니다.' + tail; return; }
    msg.textContent = '서버 확인 중…';
    let st = {};
    try { st = await (await fetch('/api/kakao', { cache: 'no-store' })).json(); } catch (e) { st = {}; }
    $('#kakao-btn').classList.toggle('on', !!st.connected);
    if (!st.configured) {
      msg.innerHTML = '<b>카카오 앱 키가 아직 서버에 없습니다.</b> 카카오 개발자 사이트에서 앱을 만들고 REST API 키를 Vercel 환경 변수 <code>KAKAO_REST_API_KEY</code>에 넣은 뒤 다시 배포하면 됩니다. 순서는 대화방에 적어 두었습니다.' +
        (st.redirect ? `<br><span class="muted">카카오 앱에 등록할 Redirect URI: ${esc(st.redirect)}</span>` : '') + tail;
      return;
    }
    if (!st.connected) {
      msg.innerHTML = '카카오 로그인을 한 번 하면, 매일 아침 적용한 신호가 새로 나온 종목을 내 카톡으로 보내 드립니다.' + tail;
      $('#kakao-connect').hidden = false;
      return;
    }
    const L = st.last;
    let lastTxt = '';
    if (L && L.error) lastTxt = `<br><span class="neg">마지막 확인 오류 (${esc(fmtAt(L.at))}): ${esc(L.error)}</span>`;
    else if (L) lastTxt = `<br><span class="muted">마지막 확인: ${esc(fmtAt(L.at))} · ${esc(L.date || '')} 종가 · ${L.checked}종목 · 새 신호 ${L.events}개${L.sent ? ' · 카톡 보냄' : ''}</span>` +
      (L.errors && L.errors.length ? `<br><span class="neg">주가를 못 받은 종목: ${esc(L.errors.join(', '))}</span>` : '');
    msg.innerHTML = '<b>카카오톡 알림 켜짐.</b> 매일 아침 7시쯤(미국 장 마감 뒤) 종목별 적용 신호에 새 매수·청산·손절·익절이 있으면 카톡으로 보냅니다. 신호가 없는 날은 보내지 않습니다. 8시쯤엔 시장 국면·섹터·금리·유동성 리서치 보고서도 보냅니다.' + lastTxt + tail;
    $('#kakao-check').hidden = false; $('#kakao-report').hidden = false; $('#kakao-off').hidden = false;
  }
  async function kakaoDo(action, btn) {
    btn.disabled = true;
    try {
      if (action === 'report') {
        $(KK.msg).textContent = '뉴스 모으고 분석하는 중… (1분쯤)'; try { await kakaoCall('news'); } catch (e) { /* 뉴스 없이도 보고서는 보냄 */ }
        $(KK.msg).textContent = '새 후보 종목 찾는 중…'; try { await kakaoCall('discover'); } catch (e) { /* 없어도 보고서는 보냄 */ }
        $(KK.msg).textContent = '보고서 만드는 중…';
      }
      const j = await kakaoCall(action);
      if (action === 'start') { location.href = j.url; return; }
      if (action === 'report') {
        $(KK.list).textContent = (j.summary ? j.summary + '\n\n— 보고서 전체 —\n\n' : '') + (j.messages || []).join('\n\n');
        await kakaoBox(`<span class="pos">리서치 요약을 카톡으로 보냈습니다.</span>` + (j.url ? ` <a href="${esc(j.url)}" target="_blank" rel="noopener">보고서 열기</a>` : '') + (j.errors && j.errors.length ? `<br><span class="muted">못 받은 자료: ${esc(j.errors.slice(0, 5).join(', '))}</span>` : ''));
      } else if (action === 'check') {
        $(KK.list).textContent = (j.messages || []).join('\n\n');
        await kakaoBox(`<span class="pos">${j.sent ? '카톡으로 보냈습니다.' : '보낼 내용이 없습니다.'}</span>`);
      } else await kakaoBox(action === 'off' ? '연결을 끊었습니다.' : undefined);
    } catch (e) { await kakaoBox(`<span class="neg">${esc(e.message || String(e))}</span>`); }
    btn.disabled = false;
  }
  $('#kakao-btn').addEventListener('click', () => { const b = $(KK.box); if (!b.hidden) { b.hidden = true; return; } kakaoBox(); });
  $('#kakao-close').addEventListener('click', () => { $(KK.box).hidden = true; });
  $('#kakao-report').addEventListener('click', e => kakaoDo('report', e.currentTarget));
  $('#kakao-connect').addEventListener('click', e => kakaoDo('start', e.currentTarget));
  $('#kakao-check').addEventListener('click', e => kakaoDo('check', e.currentTarget));
  $('#kakao-off').addEventListener('click', e => { if (confirm('카카오톡 알림 연결을 끊을까요?')) kakaoDo('off', e.currentTarget); });
  // 카카오 로그인 뒤 돌아오면 (/?kakao=ok) 주소를 정리하고 차트 화면의 알림 창을 열어 보여 줌
  if (/[?&]kakao=ok/.test(location.search)) {
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* 무시 */ }
    setTimeout(() => { const c = $('#btn-chart'); if (c) c.click(); kakaoBox('<span class="pos">연결됐습니다. 카톡에 시험 메시지를 보냈습니다.</span>'); }, 300);
  }
  let syncPending = null; // { pw, data, updatedAt }
  $('#sync-btn').addEventListener('click', () => { const b = $('#sync-box'); if (!b.hidden) { b.hidden = true; return; } syncBox(); });
  $('#sync-close').addEventListener('click', () => { $('#sync-box').hidden = true; });
  $('#sync-form').addEventListener('submit', async e => {
    e.preventDefault();
    const pw = $('#sync-pw').value;
    const msg = $('#sync-msg');
    try {
      const j = await syncCall('pull', pw);
      $('#sync-pw').value = '';
      const local = snapStr();
      if (!j.data || JSON.stringify(j.data) === local) {
        lsPut(SYNC_PW, pw); syncErr = '';
        if (!j.data) { const r = await syncCall('push', pw, JSON.parse(local)); syncMark(local, r.updatedAt); } else syncMark(local, j.updatedAt);
        syncLabel(); syncBox();
        return;
      }
      // 서버와 이 브라우저 설정이 다르면 어느 쪽으로 맞출지 묻는다 (이 브라우저에 종목이 하나도 없으면 묻지 않고 서버 것으로)
      syncPending = { pw, data: j.data, updatedAt: j.updatedAt };
      const n = d => ((d['dcf-watchlist'] || []).length + (d['dcf-holdings'] || []).length);
      if (!n(JSON.parse(local))) { $('#sync-take').click(); return; }
      $('#sync-form').hidden = true; $('#sync-choice').hidden = false;
      msg.innerHTML = `서버에 다른 기기의 설정(종목 ${n(j.data)}개)이 있고, 이 브라우저(종목 ${n(JSON.parse(local))}개)와 다릅니다. 어느 쪽으로 맞출까요?`;
    } catch (x) {
      msg.innerHTML = `<span class="neg">${esc(x.message || x)}</span>`;
    }
  });
  $('#sync-take').addEventListener('click', () => {
    if (!syncPending) return;
    lsPut(SYNC_PW, syncPending.pw); xferApply(syncPending.data); syncMark(snapStr(), syncPending.updatedAt);
    syncPending = null;
    location.reload();
  });
  $('#sync-give').addEventListener('click', async () => {
    if (!syncPending) return;
    lsPut(SYNC_PW, syncPending.pw); lsPut(SYNC_LAST, null); syncPending = null; syncErr = '';
    await syncPush(); syncBox();
  });
  $('#sync-off').addEventListener('click', () => {
    if (!confirm('이 브라우저의 자동 동기화를 끌까요? 설정은 그대로 남고, 더 이상 다른 기기와 맞추지 않습니다.')) return;
    lsPut(SYNC_PW, null); lsPut(SYNC_LAST, null); lsPut(SYNC_AT, null); syncErr = ''; syncLabel(); syncBox();
  });
  $('#sync-now').addEventListener('click', async () => {
    await syncPush();
    if (await syncPull()) { location.reload(); return; }
    syncBox();
  });
  // 바뀌면 올리기: 3초마다 이 브라우저 설정을 마지막으로 맞춘 내용과 비교
  setInterval(() => { if (syncOn() && !document.hidden) syncPush(); }, 3000);
  // 다시 볼 때 받기: 다른 기기에서 바꾼 게 있으면 맞춘다 (차트를 보고 있으면 새로 고침 안내만)
  async function syncRefresh(onLoad) {
    if (!syncOn()) return;
    if (!(await syncPull())) return;
    if (onLoad || $('#chart-modal').hidden) { location.reload(); return; }
    syncErr = '';
    const b = $('#sync-btn'); b.textContent = '☁ 새 설정 받음 · 눌러서 새로 고침'; b.classList.add('err');
    b.onclick = e => { e.stopImmediatePropagation(); location.reload(); };
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncRefresh(false); });
  syncLabel();
  syncRefresh(true);

  // ---------- "＋ 신호 추가 / ＋ 지표 추가": 파인스크립트를 붙여 넣으면 사이트가 직접 읽어서(js/pine.js) 목록에 추가 ----------
  // 코드를 실행하지 않고 글자를 읽어 정해진 계산만 합니다. 추가한 것은 이 브라우저에만 저장됩니다 (localStorage).
  const CUSTOM_KEY = 'dcf-custom-items';
  const PALETTE = ['#00897b', '#3949ab', '#8e24aa', '#6d4c41', '#c0ca33', '#00acc1', '#fb8c00', '#5e35b1', '#43a047', '#e53935'];
  let customs = lsGet(CUSTOM_KEY, []).filter(x => x && x.id && x.kind && typeof x.code === 'string');
  function toItem(it) {
    const c = window.PINE.compile(it.code, { kind: it.kind, color: it.color });
    return it.kind === 'strategy'
      ? { id: it.id, name: it.name, short: it.name.length > 10 ? it.name.slice(0, 9) + '…' : it.name, color: it.color, desc: it.desc, commission: 0.0005, custom: true, run: d => c.run(d) }
      : { id: it.id, name: it.name, color: it.color, desc: it.desc, custom: true, plot: d => c.plot(d) };
  }
  function mountCustoms() {
    STRATS.splice(0, STRATS.length, ...BUILTIN_STRATS.filter(x => !offIds().includes(x.id)));
    INDS.splice(0, INDS.length, ...BUILTIN_INDS.filter(x => !offIds().includes(x.id)));
    customs.filter(it => !hiddenIds.includes(it.id)).forEach(it => {
      try { (it.kind === 'strategy' ? STRATS : INDS).push(toItem(it)); } catch (e) { console.warn('추가한 항목을 읽지 못했습니다', it.name, e); }
    });
  }
  mountCustoms();

  let draft = null; // 읽어 본 뒤 아직 추가하지 않은 것
  const addKind = () => (($$('input[name="add-kind"]').find(r => r.checked) || {}).value || 'strategy');
  function openAdd(kind) {
    $$('input[name="add-kind"]').forEach(r => { r.checked = r.value === kind; });
    $('#add-panel').hidden = false;
    $('#add-result').hidden = true;
    $('#add-save').disabled = true;
    draft = null;
    renderCustomList();
    $('#add-code').focus();
  }
  function renderCustomList() {
    $('#add-list').innerHTML = customs.length
      ? customs.map(it => `<li><span class="strat-name" style="--c:${it.color}"><i></i><b>${esc(it.name)}</b></span> <span class="muted small">${it.kind === 'strategy' ? '매매 신호' : '차트 지표'} · ${esc(it.desc || '')}</span> <button type="button" class="ghost mini" data-del-custom="${esc(it.id)}">삭제</button></li>`).join('')
      : '<li class="muted small">아직 없습니다.</li>';
  }
  const showAdd = html => { const b = $('#add-result'); b.hidden = false; b.innerHTML = html; };
  const CHAT_TIP = '<br><span class="muted">사이트가 못 읽는 코드는 채팅으로 보내 주시면 직접 넣어 드립니다.</span>';
  async function checkDraft() {
    draft = null;
    $('#add-save').disabled = true;
    const code = $('#add-code').value;
    if (!code.trim()) { showAdd('파인스크립트 코드를 붙여 넣으세요.'); return; }
    let kind = addKind(), comp;
    try { comp = window.PINE.compile(code, { kind }); } catch (e) { showAdd(`<span class="neg">코드를 읽지 못했습니다: ${esc(e.message || e)}</span>${CHAT_TIP}`); return; }
    if (comp.info.kind !== kind) { kind = comp.info.kind; $$('input[name="add-kind"]').forEach(r => { r.checked = r.value === kind; }); }
    const used = STRATS.concat(INDS).map(x => x.color);
    const color = PALETTE.find(c => !used.includes(c)) || PALETTE[customs.length % PALETTE.length];
    const name = $('#add-name').value.trim() || comp.info.title || (kind === 'strategy' ? '내 신호' : '내 지표');
    const t = modalTicker || 'SPY';
    showAdd(`${esc(t)} 주가로 시험 계산 중…`);
    let r;
    try { r = await getSig(t); } catch (e) { showAdd(`<span class="neg">${esc(t)} 주가를 불러오지 못해 시험하지 못했습니다: ${esc(e.message || e)}</span>`); return; }
    const item = { id: 'my-' + Date.now().toString(36), kind, name, color, code, desc: '' };
    let html;
    try {
      const obj = toItem(item), notes = [];
      if (kind === 'strategy') {
        const sim = simulate(r.d, obj, sltpOf(t, obj.id)), o = sim.out, ss = statsOf(sim);
        item.desc = `매수: ${o.buyText || '-'}${o.exitText ? ` · 청산: ${o.exitText}` : ''}`;
        notes.push(...(o.notes || []));
        html = `<p>${esc(item.desc)}</p><p>${esc(t)} ${r.d.time[0]} 이후로 시험: 매수 신호 ${o.buy.filter(Boolean).length}번 · 거래 ${ss ? ss.n : 0}번` +
          (ss ? ` · <b>승률 ${Math.round(ss.rate * 100)}%</b> · 누적 ${fmtR(ss.total)}` : '') + ` <span class="muted small">(수수료 ${(sim.fee * 100).toFixed(2)}%)</span></p>`;
      } else {
        const o = obj.plot(r.d);
        item.desc = (o.lines || []).map(l => l.title).join(', ') + ((o.marks || []).length ? ' + 표시' : '');
        notes.push(...(o.notes || []));
        const pane = (o.lines || []).some(l => l.pane === 'sub') ? '차트 아래 칸' : '가격 차트 위';
        html = `<p>${esc(pane)}에 선 ${(o.lines || []).length}개 (${esc((o.lines || []).map(l => l.title).join(', ') || '-')})${(o.marks || []).length ? ` · 최근 표시 ${o.marks.length}개` : ''}</p>` +
          (o.status ? `<p>${esc(t)} 지금: ${esc(o.status.text)}</p>` : '');
      }
      if (notes.length) html += `<ul class="add-notes small muted">${notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
    } catch (e) {
      showAdd(`<span class="neg">${esc(t)} 주가로 계산하지 못했습니다: ${esc(e.message || e)}</span>${CHAT_TIP}`);
      return;
    }
    draft = item;
    showAdd(`<p class="add-ok"><span class="strat-name" style="--c:${color}"><i></i><b>${esc(name)}</b></span> 읽기 성공 (${kind === 'strategy' ? '매매 신호' : '차트 지표'})</p>${html}`);
    $('#add-save').disabled = false;
  }
  $('#add-check').addEventListener('click', checkDraft);
  $('#add-code').addEventListener('paste', () => setTimeout(checkDraft, 0));
  $$('input[name="add-kind"]').forEach(r => r.addEventListener('change', () => { if ($('#add-code').value.trim()) checkDraft(); }));
  $('#add-close').addEventListener('click', () => { $('#add-panel').hidden = true; });
  $('#add-save').addEventListener('click', () => {
    if (!draft) return;
    customs.push(draft);
    lsSet(CUSTOM_KEY, customs);
    mountCustoms();
    if (draft.kind === 'strategy') { stratSel = baseSel = draft.id; lsSet('dcf-strategy-id', stratSel); } else { indOff = indOff.filter(x => x !== draft.id); lsSet('dcf-indicators-off', indOff); }
    draft = null;
    $('#add-code').value = '';
    $('#add-name').value = '';
    $('#add-panel').hidden = true;
    renderPickers();
    renderWatch();
    if (modalTicker) showModalTicker(modalTicker);
  });
  // ---------- "가리기·삭제": 신호·지표 잠깐 가리기 / 영구 삭제 ----------
  // 가리기: 목록에서만 빠지고 '가린 항목'에서 다시 보이기. 삭제: 내가 추가한 것은 지우고, 사이트 기본 항목은 다시 안 나옴
  let delKind = 'strategy';
  function afterItemsChanged() {
    mountCustoms();
    renderCustomList();
    renderDelList();
    renderPickers();
    renderWatch();
    if (modalTicker) showModalTicker(modalTicker);
  }
  const findItem = id => customs.find(x => x.id === id) || BUILTIN_STRATS.concat(BUILTIN_INDS).find(x => x.id === id);
  const isStrat = id => BUILTIN_STRATS.some(x => x.id === id) || customs.some(x => x.id === id && x.kind === 'strategy');
  function lastStratGuard(id) {
    if (isStrat(id) && STRATS.some(x => x.id === id) && STRATS.length <= 1) { alert('매매 신호는 하나 이상 남아 있어야 합니다.'); return true; }
    return false;
  }
  function hideItem(id) {
    if (!findItem(id) || lastStratGuard(id)) return;
    hiddenIds = hiddenIds.filter(x => x !== id).concat(id); lsSet(HIDDEN_KEY, hiddenIds);
    afterItemsChanged();
  }
  function deleteItem(id) {
    const custom = customs.find(x => x.id === id), it = findItem(id);
    if (!it || lastStratGuard(id)) return;
    if (!confirm(`'${it.name}'을(를) 영구 삭제할까요?\n다시 되돌릴 수 없습니다. 잠깐 안 보이게 하려면 '가리기'를 쓰세요.`)) return;
    hiddenIds = hiddenIds.filter(x => x !== id); lsSet(HIDDEN_KEY, hiddenIds);
    if (custom) { customs = customs.filter(x => x.id !== id); lsSet(CUSTOM_KEY, customs); }
    else { deletedIds = deletedIds.concat(id); lsSet(DELETED_KEY, deletedIds); }
    afterItemsChanged();
  }
  function restoreItem(id) {
    hiddenIds = hiddenIds.filter(x => x !== id);
    lsSet(HIDDEN_KEY, hiddenIds);
    afterItemsChanged();
  }
  const itemName = it => `<span class="strat-name" style="--c:${it.color || '#787B86'}"><i></i><b>${esc(it.name)}</b></span> <span class="muted small">${it.custom || it.code ? '내가 추가' : '사이트 기본'}</span>`;
  function renderDelList() {
    if ($('#del-panel').hidden) return;
    const strat = delKind === 'strategy';
    const list = strat ? STRATS : INDS;
    $('#del-title').textContent = strat ? '매매 신호 가리기·삭제' : '차트 지표 가리기·삭제';
    $('#del-list').innerHTML = list.length
      ? list.map(it => `<li>${itemName(it)} <span class="del-btns"><button type="button" class="ghost mini" data-hide-id="${esc(it.id)}">가리기</button><button type="button" class="ghost mini danger" data-del-id="${esc(it.id)}">영구 삭제</button></span></li>`).join('')
      : '<li class="muted small">없습니다.</li>';
    const gone = (strat ? BUILTIN_STRATS : BUILTIN_INDS).concat(customs.filter(x => x.kind === (strat ? 'strategy' : 'indicator'))).filter(x => hiddenIds.includes(x.id));
    $('#del-hidden-wrap').hidden = !gone.length;
    $('#del-hidden').innerHTML = gone.map(it => `<li>${itemName(it)} <span class="del-btns"><button type="button" class="ghost mini" data-restore-id="${esc(it.id)}">다시 보이기</button><button type="button" class="ghost mini danger" data-del-id="${esc(it.id)}">영구 삭제</button></span></li>`).join('');
  }
  function openDel(kind) {
    delKind = kind === 'indicator' ? 'indicator' : 'strategy';
    $('#del-panel').hidden = false;
    renderDelList();
  }
  $('#del-close').addEventListener('click', () => { $('#del-panel').hidden = true; });
  $('#del-panel').addEventListener('click', e => {
    if (e.target === $('#del-panel')) { $('#del-panel').hidden = true; return; }
    const d = e.target.closest('[data-del-id]'), r = e.target.closest('[data-restore-id]'), h = e.target.closest('[data-hide-id]');
    if (d) deleteItem(d.dataset.delId);
    else if (h) hideItem(h.dataset.hideId);
    else if (r) restoreItem(r.dataset.restoreId);
  });
  $('#add-list').addEventListener('click', e => {
    const b = e.target.closest('[data-del-custom]');
    if (b) deleteItem(b.dataset.delCustom);
  });

  syncMode();
  renderAll();
  if (state.info && state.info.history) renderHistory(state.info);
  const qs = new URLSearchParams(location.search), qt = qs.get('t');
  if (qt) { markTab('dcf'); lookup(qt); }
  // 첫 화면은 차트 (주소에 ?t= 가 있거나 마지막에 DCF 탭을 봤으면 DCF)
  else if (!/[?&]kakao=ok/.test(location.search) && lsGet(TAB_KEY, 'chart') !== 'dcf') openModal();
  else if ($('#chart-modal').hidden) markTab('dcf');
})();
