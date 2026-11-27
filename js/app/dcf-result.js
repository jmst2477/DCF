/* global DCF, SAParser, SAPdf, Tesseract, ExcelJS */
// DCF 결과: 다시 계산, 지금·내년·내후년 적정가, P/E 줄, 기본 방식 입력 칸과 표, 민감도 표
// js/app/ 파일들은 한 화면 코드를 기능별로 나눈 것. index.html 에 적힌 순서대로 불러오고, 서로의 이름(함수·변수)을 그대로 씀.
'use strict';

// ---------- 4. 결과 ----------
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
