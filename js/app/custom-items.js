/* global DCF, SAParser, SAPdf, Tesseract, ExcelJS */
// ＋ 신호·지표 추가(파인스크립트), 가리기·삭제
// js/app/ 파일들은 한 화면 코드를 기능별로 나눈 것. index.html 에 적힌 순서대로 불러오고, 서로의 이름(함수·변수)을 그대로 씀.
'use strict';

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
