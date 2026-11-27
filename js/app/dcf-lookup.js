/* global DCF, SAParser, SAPdf, Tesseract, ExcelJS */
// DCF: 티커 → 야후 자동 입력, 지난 실적 표, 시킹알파 추정치를 연도별 가정으로
// js/app/ 파일들은 한 화면 코드를 기능별로 나눈 것. index.html 에 적힌 순서대로 불러오고, 서로의 이름(함수·변수)을 그대로 씀.
'use strict';

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
