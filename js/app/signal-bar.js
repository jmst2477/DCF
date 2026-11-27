/* global DCF, SAParser, SAPdf, Tesseract, ExcelJS */
// 신호 고르기 줄 · 성적 줄: 고른 신호·지표, 종목별 ★ 적용 신호, 기간 버튼, 손절·익절 칸
// js/app/ 파일들은 한 화면 코드를 기능별로 나눈 것. index.html 에 적힌 순서대로 불러오고, 서로의 이름(함수·변수)을 그대로 씀.
'use strict';

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
// 신호 줄 접기: 접으면 고른 신호 하나 + '다른 신호 N개 ▾'만. 이 브라우저에 기억 (기본 접힘)
let sigFold = lsGet('dcf-sig-fold', true) !== false;
function renderPickers() {
  activeStrats();
  const fold = sigFold && STRATS.length > 1;
  $$('.strat-pick').forEach(box => {
    box.innerHTML = (fold ? STRATS.filter(s => s.id === stratSel) : STRATS).map(s => {
      const st = pickRates[s.id];
      return `<button type="button" class="chip ${s.id === stratSel ? 'on' : ''}" data-sid="${esc(s.id)}" title="${esc(s.desc || '')}" style="--c:${s.color}"><i></i>${esc(s.name)}${st !== undefined ? `<span class="chip-rate">${rateTxt(st)}</span>` : ''}</button>`;
    }).join('')
      + (STRATS.length > 1 ? `<button type="button" class="chip more" data-sig-fold title="${fold ? '모든 신호와 승률을 펼쳐 봅니다' : '고른 신호 하나만 남기고 줄입니다'}">${fold ? '펼치기 ▾' : '접기 ▴'}</button>` : '')
      + (fold ? '' : '<button type="button" class="chip add" data-add-kind="strategy">＋ 신호 추가</button><button type="button" class="chip del" data-del-kind="strategy">가리기·삭제</button>');
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
  if (document.activeElement !== $('#bt-fee-kr')) $('#bt-fee-kr').value = bt.feeKr;
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
$('#bt-fee-kr').addEventListener('change', e => {
  const v = parseFloat(e.target.value);
  bt.feeKr = v >= 0 && v <= 3 ? v : FEE_KR_DEF;
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
