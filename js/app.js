/* global DCF, SAParser, Tesseract, ExcelJS */
(function () {
  'use strict';

  const N = DCF.YEARS;
  const STORE_KEY = 'dcf-web-state-v1';
  const KEY_STORE = 'dcf-web-anthropic-key';
  const CLAUDE_MODEL = 'claude-opus-5-5';
  const CDN = 'https://cdn.jsdelivr.net/npm/';

  // ---------- 상태 ----------
  const COMMON = [
    { key: 'ticker', label: '종목 (티커)', type: 'text' },
    { key: 'baseFY', label: '0년차 회계연도 (최근 실적)', type: 'int', hint: '예: 2025 → 1년차 = FY2026' },
    { key: 'horizon', label: '예측 기간 (년, 1~10)', type: 'int', hint: '추정치가 있는 마지막 해까지 자동. 그 다음 해부터 영구가치' },
    { key: 'price', label: '현재 주가 ($)', type: 'num' },
    { key: 'shares', label: '발행주식수 (백만 주)', type: 'num' },
    { key: 'cash', label: '보유현금+단기투자 (백만 $)', type: 'num' },
    { key: 'debt', label: '총차입금 (백만 $, 양수로)', type: 'num' },
    { key: 'tax', label: '법인세율 (%)', type: 'pct' },
    { key: 'wacc', label: '할인율 WACC (%)', type: 'pct', hint: '우량주 8%, 위험 종목 12%' },
    { key: 'g', label: '영구성장률 (%)', type: 'pct', hint: '할인율보다 작아야 합니다' },
    { key: 'normCapex', label: '정상화 캐펙스/매출 (%)', type: 'pct', hint: '영구가치 계산에만 사용' },
    { key: 'normDA', label: '정상화 감가상각비/매출 (%)', type: 'pct', hint: '영구가치 계산에만 사용' },
    { key: 'beta', label: '베타 (CAPM 참고용)', type: 'num' },
    { key: 'rf', label: '무위험이자율 (%, CAPM)', type: 'pct', hint: '미국 10년 국채 금리' },
    { key: 'erp', label: '시장위험프리미엄 (%, CAPM)', type: 'pct', hint: '보통 4~6%' },
    { key: 'sbcOn', label: 'SBC를 비용으로 차감', type: 'bool', hint: '주식보상비용만큼 FCFF를 줄임' },
    { key: 'sbc', label: '주식보상비용/매출 (SBC %)', type: 'pct' },
  ];

  function blank() {
    const arr = v => Array.from({ length: N + 1 }, () => v);
    return {
      ticker: '', baseFY: new Date().getFullYear() - 1, price: 0, shares: 0, cash: 0, debt: 0,
      tax: 0.21, wacc: 0.08, g: 0.02, normCapex: 0.05, normDA: 0.05,
      beta: 0, rf: 0.042, erp: 0.05, sbcOn: false, sbc: 0, horizon: 10,
      revenue: arr(0), growth: arr(0.05), margin: arr(0.2), da: arr(0.05), capex: arr(0.05), nwc: arr(0),
    };
  }

  // DCF_개선판_v2_GOOGL.xlsx 와 같은 값 (검증용: 1주당 $307.47)
  function googl() {
    const s = blank();
    Object.assign(s, {
      ticker: 'GOOGL', baseFY: 2025, price: 343.5, shares: 12230, cash: 242474, debt: 100164,
      tax: 0.17, wacc: 0.08, g: 0.02, normCapex: 0.15, normDA: 0.12,
    });
    s.revenue = [402836, 498550, 614820, 725488, 827056, 918032, 0, 0, 0, 0, 0];
    s.growth = [0, 0, 0, 0, 0, 0, 0.1, 0.09, 0.08, 0.07, 0.06];
    s.margin = [0.32, 0.33, 0.33, 0.33, 0.33, 0.33, 0.33, 0.33, 0.33, 0.33, 0.33];
    s.da = [0.052, 0.06, 0.08, 0.1, 0.11, 0.12, 0.12, 0.12, 0.12, 0.12, 0.12];
    s.capex = [0.227, 0.4, 0.35, 0.28, 0.22, 0.18, 0.16, 0.15, 0.15, 0.15, 0.15];
    s.nwc = Array(N + 1).fill(0);
    return s;
  }

  let state = load() || googl();

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

  // ---------- 2. 공통 가정 ----------
  function renderCommon() {
    $('#common').innerHTML = COMMON.map(f => {
      if (f.type === 'bool') {
        return `<label>${f.label}
        <input data-common="${f.key}" type="checkbox" ${state[f.key] ? 'checked' : ''} style="width:auto">
        ${f.hint ? `<span class="hint">${f.hint}</span>` : ''}</label>`;
      }
      const v = f.type === 'pct' ? toInput(state[f.key], true) : state[f.key];
      const type = f.type === 'text' ? 'text' : 'number';
      return `<label>${f.label}
        <input data-common="${f.key}" type="${type}" step="any" value="${esc(v)}">
        ${f.hint ? `<span class="hint">${f.hint}</span>` : ''}</label>`;
    }).join('');
  }
  $('#common').addEventListener('input', e => {
    const key = e.target.dataset.common;
    if (!key) return;
    const f = COMMON.find(x => x.key === key);
    if (f.type === 'bool') state[key] = e.target.checked;
    else if (f.type === 'text') state[key] = e.target.value.toUpperCase();
    else if (f.type === 'int') state[key] = parseInt(e.target.value, 10) || 0;
    else state[key] = fromInput(e.target.value, f.type === 'pct');
    if (key === 'horizon') state.horizon = Math.max(1, Math.min(N, state.horizon || 1));
    if (key === 'baseFY' || key === 'horizon') renderYears(); // 회계연도 라벨·사용 범위 갱신
    recalc();
  });

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
    s.horizon = known || 5;
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
    s.sbc = last.sbcPct || 0;
    s.sbcOn = false;
    s.normCapex = +(avg(h.map(x => x.capexPct)) || last.capexPct || 0).toFixed(4);
    s.normDA = +Math.min(s.normCapex, Math.max(avg(h.map(x => x.daPct)) || 0, s.normCapex * 0.8)).toFixed(4);
    return s;
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
      state = assumptionsFrom(j);
      lastLookup = j;
      renderAll();
      renderHistory(j);
      const assumed = state.revAssumed.map((a, t) => (a && t <= state.horizon ? t : 0)).filter(Boolean);
      st.innerHTML = `${esc(j.companyName)} · FY${state.baseFY + state.horizon}까지 ${state.horizon}년 예측 (애널리스트 컨센서스)` +
        (assumed.length ? ` · <span class="legend-assumed">${assumed[0]}~${assumed[assumed.length - 1]}년차 매출은 임시 가정</span>` : '') +
        ' · 시킹알파 매출 추정치 캡처를 올리면 그 마지막 해까지 늘어납니다' +
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
  function capm() { return state.beta > 0 ? state.rf + state.beta * state.erp : null; }
  $('#capm').addEventListener('click', e => {
    if (!e.target.matches('button')) return;
    const c = capm();
    if (c == null) return;
    state.wacc = +c.toFixed(4);
    renderCommon();
    recalc();
  });

  // 계산에 넘길 입력 (SBC 체크 해제 시 0)
  function modelInput() { return Object.assign({}, state, { sbc: state.sbcOn ? state.sbc : 0 }); }

  // ---------- 3. 연도별 가정 ----------
  const YEAR_ROWS = [
    { key: 'margin', label: '영업이익률', pct: true },
    { key: 'da', label: '감가상각비/매출', pct: true },
    { key: 'capex', label: '캐펙스/매출', pct: true },
    { key: 'nwc', label: '운전자본/매출증가분', pct: true },
  ];

  function renderYears() {
    const fy = t => 'FY' + (state.baseFY + t);
    let h = '<thead><tr><th></th>';
    const H = Math.max(1, Math.min(N, state.horizon || 1)); // 예측 기간까지만 보여줌
    for (let t = 0; t <= H; t++) h += `<th>${t === 0 ? '0년차 실적' : t + '년차'}<br><span class="muted small">${fy(t)}</span></th>`;
    h += '<th class="qf">한 번에 넣기</th></tr></thead><tbody>';

    // 성장률
    h += '<tr><td>매출 성장률</td>';
    for (let t = 0; t <= H; t++) {
      if (t === 0) h += '<td></td>';
      else if (t <= 5) h += `<td class="calc" id="g-${t}"></td>`;
      else h += `<td><input data-y="growth" data-t="${t}" data-pct="1" type="number" step="any" value="${toInput(state.growth[t], true)}"></td>`;
    }
    h += '<td class="qf"></td></tr>';

    // 매출
    h += '<tr><td><b>매출액</b> <span class="muted small">(추정치)</span></td>';
    for (let t = 0; t <= H; t++) {
      const assumed = state.revAssumed && state.revAssumed[t];
      if (t <= 5) h += `<td><input class="wide${assumed ? ' assumed' : ''}" data-y="revenue" data-t="${t}" type="number" step="any" value="${state.revenue[t]}"${assumed ? ' title="임시 가정값 - 시킹알파 추정치로 바꾸세요"' : ''}></td>`;
      else h += `<td class="calc" id="rev-${t}"></td>`;
    }
    h += '<td class="qf"></td></tr>';

    for (const r of YEAR_ROWS) {
      h += `<tr><td>${r.label} (%)</td>`;
      for (let t = 0; t <= H; t++) {
        if (t === 0) { h += `<td class="muted">${r.key === 'nwc' ? '' : pct(state[r.key][0])}</td>`; continue; }
        h += `<td><input data-y="${r.key}" data-t="${t}" data-pct="1" type="number" step="any" value="${toInput(state[r.key][t], true)}"></td>`;
      }
      h += `<td class="qf"><input data-qf="${r.key}" type="number" step="any" placeholder="%"> <button class="mini ghost" data-qfbtn="${r.key}">전체</button></td></tr>`;
    }
    h += '</tbody>';
    $('#years').innerHTML = h;
  }

  $('#years').addEventListener('input', e => {
    const { y, t, pct: isPct } = e.target.dataset;
    if (!y) return;
    state[y][+t] = fromInput(e.target.value, !!isPct);
    if (y === 'revenue' && state.revAssumed) { state.revAssumed[+t] = false; e.target.classList.remove('assumed'); }
    recalc();
  });
  $('#years').addEventListener('click', e => {
    const key = e.target.dataset.qfbtn;
    if (!key) return;
    const inp = $(`[data-qf="${key}"]`);
    if (inp.value === '') return;
    const v = fromInput(inp.value, true);
    for (let t = 1; t <= N; t++) state[key][t] = v; // 모든 연도 (예측 기간이 늘어날 때 대비)
    renderYears();
    recalc();
  });

  // ---------- 4. 결과 ----------
  function recalc() {
    save();
    const warn = [];
    if (state.wacc <= state.g) warn.push('할인율이 영구성장률보다 커야 합니다.');
    if (!state.shares) warn.push('발행주식수를 넣어주세요.');
    for (let t = 0; t <= Math.min(5, state.horizon); t++) if (!state.revenue[t]) { warn.push(`${t}년차 매출이 비어 있습니다.`); break; }

    const inp = modelInput();
    const r = DCF.compute(inp);
    const c = capm();
    $('#capm').innerHTML = c == null ? '' :
      `CAPM 자기자본비용 = ${pct(state.rf)} + 베타 ${(+state.beta).toFixed(2)} × ${pct(state.erp)} = <b>${pct(c)}</b> ` +
      `<button class="mini ghost">할인율에 넣기</button> <span class="muted">(차입금이 많으면 WACC는 이보다 조금 낮습니다)</span>`;
    const revG = ok0() ? DCF.reverse(inp, 'g') : null;
    const revM = ok0() ? DCF.reverse(inp, 'margin') : null;
    for (let t = 1; t <= 5; t++) { const el = $('#g-' + t); if (el) el.textContent = r.rows[t - 1] ? pct(r.rows[t - 1].growth) : pct(state.revenue[t] / state.revenue[t - 1] - 1); }
    for (let t = 6; t <= N; t++) { const el = $('#rev-' + t); if (el) el.textContent = r.rows[t - 1] ? fmt(r.rows[t - 1].revenue) : '–'; }

    const ok = !warn.length;
    const up = r.upside;
    $('#kpis').innerHTML =
      (warn.length ? `<div class="warn" style="grid-column:1/-1">${warn.join('<br>')}</div>` : '') +
      kpi('1주당 내재가치', ok ? '$' + fmt(r.perShare, 2) : '–', 'main') +
      kpi('현재가 대비', ok && up != null ? `<span class="${up >= 0 ? 'pos' : 'neg'}">${up >= 0 ? '+' : ''}${pct(up)}</span>` : '–') +
      kpi('기업가치 (EV)', fmt(r.ev)) +
      kpi('자기자본가치', fmt(r.equity)) +
      kpi('1~10년 FCFF 현재가치 합', fmt(r.pvSum)) +
      kpi('영구가치 현재가치', fmt(r.pvTv)) +
      kpi('EV 중 영구가치 비중', pct(r.tvShare)) +
      kpi(`예측 기간`, `${r.horizon}년 <span class="muted small">(~FY${state.baseFY + r.horizon})</span>`) +
      kpi('현재가가 가정하는 영구성장률', revG == null ? '범위 밖' : pct(revG)) +
      kpi(`현재가가 가정하는 영업이익률 (1~${r.horizon}년차)`, revM == null ? '범위 밖' : pct(revM));

    const lines = [
      ['매출액', 'revenue'], ['성장률', 'growth', true], ['영업이익 (EBIT)', 'ebit'], ['법인세', 'taxes'],
      ['NOPAT', 'nopat'], ['감가상각비', 'da'], ['캐펙스', 'capex'], ['운전자본 증감', 'dNwc'], ...(state.sbcOn ? [['주식보상비용 (SBC)', 'sbc']] : []),
      ['<b>잉여현금흐름 FCFF</b>', 'fcff'], ['할인계수', 'df', 'df'], ['FCFF 현재가치', 'pv'],
    ];
    let h = '<thead><tr><th>백만 $</th>' + r.rows.map(x => `<th>${x.t}년차<br><span class="muted small">FY${state.baseFY + x.t}</span></th>`).join('') + '</tr></thead><tbody>';
    for (const [label, key, kind] of lines) {
      h += `<tr><td>${label}</td>` + r.rows.map(x => `<td>${kind === true ? pct(x[key]) : kind === 'df' ? x[key].toFixed(4) : fmt(x[key])}</td>`).join('') + '</tr>';
    }
    h += '</tbody>';
    $('#flows').innerHTML = h;

    renderSens();
  }

  function ok0() { return state.wacc > state.g && state.shares > 0 && state.price > 0; }

  function kpi(k, v, cls = '') {
    return `<div class="kpi ${cls}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  }

  function renderSens() {
    const step = 0.01;
    const waccs = [-2, -1, 0, 1, 2].map(i => +(state.wacc + i * step).toFixed(4));
    const gs = [-1, -0.5, 0, 0.5, 1].map(i => +(state.g + i * step).toFixed(4));
    const m = DCF.sensitivity(modelInput(), waccs, gs);
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

  // ---------- 1. 캡처 업로드 & 읽기 ----------
  let currentImage = null; // {blob, dataUrl}
  let estimates = [];

  const drop = $('#drop');
  drop.addEventListener('click', e => { if (e.target.id !== 'preview') $('#file').click(); });
  drop.addEventListener('keydown', e => { if (e.key === 'Enter') $('#file').click(); });
  $('#file').addEventListener('change', e => e.target.files[0] && setImage(e.target.files[0]));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('over');
    const f = [...e.dataTransfer.files].find(x => x.type.startsWith('image/'));
    if (f) setImage(f);
  });
  document.addEventListener('paste', e => {
    const item = [...(e.clipboardData || {}).items || []].find(x => x.type.startsWith('image/'));
    if (item) { e.preventDefault(); setImage(item.getAsFile()); }
  });

  function setImage(blob) {
    const reader = new FileReader();
    reader.onload = () => {
      currentImage = { blob, dataUrl: reader.result };
      const img = $('#preview');
      img.src = reader.result;
      img.hidden = false;
      $('#btn-ocr').disabled = false;
      $('#ocr-status').textContent = '이미지 준비됨. "숫자 읽기"를 누르세요.';
    };
    reader.readAsDataURL(blob);
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

  $('#btn-ocr').addEventListener('click', async () => {
    if (!currentImage) return;
    const btn = $('#btn-ocr');
    btn.disabled = true;
    const status = $('#ocr-status');
    try {
      let result;
      if (modeSel.value === 'claude') {
        status.textContent = 'Claude가 이미지를 읽는 중...';
        result = await readWithClaude(currentImage);
      } else {
        status.textContent = 'OCR 준비 중... (처음 한 번은 언어 데이터를 내려받느라 조금 걸립니다)';
        const text = await readWithTesseract(currentImage, p => { status.textContent = p; });
        result = SAParser.parseEstimates(text);
        result.text = text;
      }
      estimates = result.estimates.map(x => Object.assign({ use: true }, x));
      renderEstimates(result.warnings || [], result.text || '');
      status.textContent = `추정치 ${estimates.length}개를 찾았습니다.`;
    } catch (err) {
      console.error(err);
      status.textContent = '읽기 실패: ' + (err.message || err);
    } finally {
      btn.disabled = false;
    }
  });

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
  function getWorker(onProgress) {
    if (!workerPromise) {
      workerPromise = Tesseract.createWorker('eng', 1, {
        workerPath: CDN + 'tesseract.js@5.1.1/dist/worker.min.js',
        corePath: CDN + 'tesseract.js-core@5.1.1',
        langPath: CDN + '@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
        logger: m => {
          if (m.status && typeof m.progress === 'number') onProgress(`OCR: ${m.status} ${Math.round(m.progress * 100)}%`);
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
    const worker = await getWorker(onProgress);
    const { data } = await worker.recognize(canvas);
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
              period_label: { type: 'string' },
              fiscal_year: { type: 'integer' },
              revenue_millions_usd: { type: 'number' },
            },
            required: ['period_label', 'fiscal_year', 'revenue_millions_usd'],
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
              text: 'This is a Seeking Alpha "Earnings Estimates" screenshot. Extract the annual REVENUE consensus estimates ' +
                '(the "Revenue Estimate" column, not EPS, not Low/High). For each fiscal period give the label as shown, ' +
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
      estimates: parsed.estimates.map(x => ({ year: x.fiscal_year, label: x.period_label, value: x.revenue_millions_usd, raw: 'Claude' })),
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
      warnings = warnings.concat(`0년차 회계연도를 FY${state.baseFY}로 바꿨습니다 (첫 추정치 바로 전 해). 다르면 2번 칸에서 고치세요.`);
      renderCommon(); renderYears(); recalc();
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
        <td>${esc(e.label)}</td>
        <td><input data-e="year" data-i="${i}" type="number" value="${e.year}" style="width:76px"></td>
        <td class="muted">${esc(e.raw)}</td>
        <td><input class="wide" data-e="value" data-i="${i}" type="number" step="any" value="${+e.value.toFixed(2)}"></td>
        <td>${t ? t + '년차 (FY' + e.year + ')' : '<span class="muted">범위 밖</span>'}</td>
      </tr>`;
    }).join('');
  }

  $('#est-table').addEventListener('input', e => {
    const { e: field, i } = e.target.dataset;
    if (!field) return;
    const row = estimates[+i];
    if (field === 'use') row.use = e.target.checked;
    else if (field === 'year') { row.year = parseInt(e.target.value, 10) || row.year; drawEstRows(); }
    else row.value = parseFloat(e.target.value) || 0;
  });
  $('#btn-add-row').addEventListener('click', () => {
    const last = estimates.length ? estimates[estimates.length - 1].year : state.baseFY;
    estimates.push({ use: true, year: last + 1, label: '직접 입력', raw: '', value: 0 });
    drawEstRows();
  });
  $('#btn-apply').addEventListener('click', () => {
    let n = 0, maxT = 0;
    for (const e of estimates) {
      const t = slotFor(e.year);
      if (e.use && t && e.value > 0) { state.revenue[t] = e.value; if (state.revAssumed) state.revAssumed[t] = false; n++; maxT = Math.max(maxT, t); }
    }
    // 예측 기간 = 추정치가 있는 마지막 해 (10년으로 늘려 둔 경우는 유지)
    if (maxT && state.horizon <= 5) state.horizon = maxT;
    renderCommon();
    renderYears();
    recalc();
    $('#ocr-status').textContent = `매출 ${n}개를 넣었습니다.`;
    $('#years').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // ---------- 상단 버튼 ----------
  $('#btn-example').addEventListener('click', () => { state = googl(); renderAll(); });
  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('입력값을 모두 지울까요?')) return;
    state = blank(); renderAll();
  });
  $('#btn-xlsx').addEventListener('click', () => exportXlsx().catch(err => alert('엑셀 만들기 실패: ' + err.message)));

  // ---------- 엑셀 내보내기 (DCF_개선판_v2 와 같은 셀 배치·수식) ----------
  async function exportXlsx() {
    const wb = new ExcelJS.Workbook();
    wb.calcProperties.fullCalcOnLoad = true;
    const ws = wb.addWorksheet('DCF');
    const inp = modelInput();
    const r = DCF.compute(inp);
    const cols = 'BCDEFGHIJKL'.split('').slice(0, r.horizon + 1);
    const L = cols[cols.length - 1]; // 예측 마지막 해 열
    const inputStyle = c => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
      c.font = { color: { argb: 'FF0000FF' } };
    };
    const PCT = '0.0%', NUM = '#,##0', USD = '$#,##0.00';
    const put = (addr, value, fmtStr, isInput) => {
      const c = ws.getCell(addr);
      c.value = value;
      if (fmtStr) c.numFmt = fmtStr;
      if (isInput) inputStyle(c);
      return c;
    };
    const f = (formula, result) => ({ formula, result });

    ws.getColumn(1).width = 40;
    cols.forEach(c => { ws.getColumn(c).width = 13; });
    put('A1', `DCF Valuation Model v2 (10년 연도별 + 정상화 영구가치) - ${state.ticker || ''}`).font = { bold: true, size: 13 };
    put('A2', '단위: 백만 달러, 주식수 백만 주. 노란 칸(파란 글씨)만 입력하면 나머지는 자동 계산됩니다. 생성일 ' + new Date().toISOString().slice(0, 10));
    put('A4', '1. 공통 가정').font = { bold: true };
    const common = [
      [5, '법인세율 (Tax Rate)', state.tax, PCT], [6, '할인율 (WACC)', state.wacc, PCT], [7, '영구성장률 (Terminal Growth)', state.g, PCT],
      [8, '정상화 캐펙스/매출 (영구가치용)', state.normCapex, PCT], [9, '정상화 감가상각비/매출 (영구가치용)', state.normDA, PCT],
      [10, '발행주식수 (Shares Outstanding)', state.shares, NUM], [11, '보유현금+단기투자 (Cash)', state.cash, NUM],
      [12, '총차입금 (Debt, 리스 제외)', state.debt, NUM], [13, '현재 주가 (Current Price)', state.price, USD],
      [14, '주식보상비용/매출 (SBC, 0이면 미반영)', inp.sbc, PCT],
    ];
    for (const [row, label, v, nf] of common) { put('A' + row, label); put('B' + row, v, nf, true); }

    put('A15', `2. 연도별 가정 및 현금흐름 (B열 = 0년차 실적, C~${L} = 1~${r.horizon}년차 예측)`).font = { bold: true };
    put('A16', '연차'); put('A17', '회계연도');
    cols.forEach((c, t) => { put(c + '16', t === 0 ? '0년차' : t + '년차'); put(c + '17', 'FY' + (state.baseFY + t), null, true); });

    const labels = {
      18: '매출 성장률', 19: '매출액 (Revenue)', 20: '영업이익률 (EBIT Margin)', 21: '감가상각비/매출 (D&A %)',
      22: '캐펙스/매출 (CapEx %)', 23: '순운전자본/매출증가분 (NWC % of ΔRev)', 25: '영업이익 (EBIT)', 26: '법인세 (Taxes)',
      27: '세후영업이익 (NOPAT)', 28: '감가상각비 (D&A)', 29: '자본적지출 (CapEx)', 30: '순운전자본증감 (ΔNWC)',
      31: '잉여현금흐름 (FCFF, SBC 차감)', 32: '할인계수 (Discount Factor)', 33: 'FCFF 현재가치 (PV)',
    };
    Object.entries(labels).forEach(([row, l]) => put('A' + row, l));
    put('A24', '  ↑ 1~5년차 매출은 시킹알파 추정치 입력, 6~10년차는 성장률 입력. 비율은 연도별로 입력').font = { italic: true, color: { argb: 'FF808080' } };

    cols.forEach((c, t) => {
      const p = cols[t - 1];
      const row = t ? r.rows[t - 1] : null;
      // 18, 19
      if (t >= 1 && t <= 5) put(c + '18', f(`${c}19/${p}19-1`, row.growth), PCT);
      if (t >= 6) put(c + '18', state.growth[t], PCT, true);
      if (t <= 5) put(c + '19', state.revenue[t], NUM, true);
      else put(c + '19', f(`${p}19*(1+${c}18)`, row.revenue), NUM);
      // 20~23 (B열은 실적 참고용)
      ['margin', 'da', 'capex', 'nwc'].forEach((k, i) => put(c + (20 + i), state[k][t], PCT, true));
      if (!t) return;
      put(c + '25', f(`${c}19*${c}20`, row.ebit), NUM);
      put(c + '26', f(`${c}25*$B$5`, row.taxes), NUM);
      put(c + '27', f(`${c}25-${c}26`, row.nopat), NUM);
      put(c + '28', f(`${c}19*${c}21`, row.da), NUM);
      put(c + '29', f(`${c}19*${c}22`, row.capex), NUM);
      put(c + '30', f(`(${c}19-${p}19)*${c}23`, row.dNwc), NUM);
      put(c + '31', f(`${c}27+${c}28-${c}29-${c}30-${c}19*$B$14`, row.fcff), NUM).font = { bold: true };
      put(c + '32', f(`1/(1+$B$6)^${t}`, row.df), '0.0000');
      put(c + '33', f(`${c}31*${c}32`, row.pv), NUM);
    });

    put('A35', '3. 가치평가').font = { bold: true };
    const val = [
      [36, `FCFF 현재가치 합계 (1~${r.horizon}년차)`, `SUM(C33:${L}33)`, r.pvSum, NUM, `${r.horizon}년치 PV 합`],
      [37, `영구가치 기준 FCFF (${r.horizon + 1}년차, 정상화)`, `${L}19*(1+B7)*(${L}20*(1-B5)+B9-B8-B14)-${L}19*B7*${L}23`, r.fcf11, NUM, '다음 해 매출 × (세후이익률 + 정상화 D&A − 정상화 캐펙스 − SBC) − 운전자본'],
      [38, '영구가치 (Terminal Value)', 'B37/(B6-B7)', r.tv, NUM, 'FCF11 / (WACC − g)'],
      [39, '영구가치의 현재가치', `B38*${L}32`, r.pvTv, NUM, `${r.horizon}년차 할인계수 적용`],
      [40, '기업가치 (Enterprise Value)', 'B36+B39', r.ev, NUM],
      [41, '차감: 총차입금', '-B12', -state.debt, NUM],
      [42, '가산: 보유현금', 'B11', state.cash, NUM],
      [43, '자기자본가치 (Equity Value)', 'B40+B41+B42', r.equity, NUM],
      [44, '1주당 내재가치 (Implied Share Price)', 'B43/B10', r.perShare, USD],
      [45, '현재가 대비 상승/하락 여력', 'B44/B13-1', r.upside, PCT],
      [46, '기업가치 중 영구가치 비중', 'B39/B40', r.tvShare, PCT, '높을수록 영구가치 가정에 민감'],
    ];
    for (const [row, label, formula, result, nf, note] of val) {
      put('A' + row, label);
      put('B' + row, f(formula, result), nf);
      if (note) put('C' + row, note).font = { color: { argb: 'FF808080' } };
    }
    ws.getCell('A44').font = { bold: true };
    ws.getCell('B44').font = { bold: true };
    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 0 }];

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.ticker || 'DCF'}_DCF_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function renderAll() {
    renderCommon();
    renderYears();
    recalc();
  }

  syncMode();
  renderAll();
  const qt = new URLSearchParams(location.search).get('t');
  if (qt) lookup(qt);
})();
