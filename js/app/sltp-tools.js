/* global DCF, SAParser, SAPdf, Tesseract, ExcelJS */
// 손절·익절 도구: 손절·익절 찾기, 최소 기준, 여러 종목 풀기, ⚡ 최적 자동 적용, 손절·익절 풀기
// js/app/ 파일들은 한 화면 코드를 기능별로 나눈 것. index.html 에 적힌 순서대로 불러오고, 서로의 이름(함수·변수)을 그대로 씀.
'use strict';

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
  const PER = 5e6;
  const money = st => PER * st.n * st.avg;
  const man = v => `${v >= 0 ? '+' : '-'}${Math.round(Math.abs(v) / 1e4).toLocaleString('ko-KR')}만원`;
  const won = v => `<span class="chg ${v >= 0 ? 'up' : 'down'}">${man(v)}</span>`;
  const okRows = out.filter(x => x.b), sumN = okRows.reduce((a, x) => a + x.b.st.n, 0), sumM = okRows.reduce((a, x) => a + money(x.b.st), 0);
  const sumFee = okRows.reduce((a, x) => a + x.b.st.n * PER * (feeOf(x.t) / 100) * 2, 0);
  const feeTxt = [...new Set(okRows.map(x => (isKR(x.t) ? '국내 ' : (okRows.some(y => isKR(y.t)) ? '해외 ' : '')) + feeOf(x.t) + '%'))].join(', ');
  optRender(`<p class="small pos">${done}종목에 적용했습니다${out.length > done ? `, ${out.length - done}종목은 기준을 넘는 조합이 없어 그대로 두었습니다` : ''}.</p>
      ${okRows.length ? `<p class="opt-sum">거래마다 500만원씩만 샀다면 (${esc(btName())}): 거래 ${sumN.toLocaleString('ko-KR')}번 · 누적 수익금 <b>${won(sumM)}</b> <span class="muted small">수수료 약 ${Math.round(sumFee / 1e4).toLocaleString('ko-KR')}만원 빼고 (한 번 살 때·팔 때 각 ${feeTxt}), 세금 전</span></p>` : ''}
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
