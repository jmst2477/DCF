/* global DCF, SAParser, SAPdf, Tesseract, ExcelJS */
// 한투 잔고(보유 수량·평단가)와 관심종목 목록 그리기(renderWatch)·종목 추가
// js/app/ 파일들은 한 화면 코드를 기능별로 나눈 것. index.html 에 적힌 순서대로 불러오고, 서로의 이름(함수·변수)을 그대로 씀.
'use strict';

// ---------- 한투 잔고 (보유 수량·평단가) ----------
// 🤖 에이전트 화면(/api/agent)에서 비밀번호로 불러오면 그 화면이 이 브라우저에 저장(dcf-kis-hold)하고, 여기서는 읽어서 목록 줄에만 보여 줌
let kisHold = lsGet('dcf-kis-hold', null);
const kisRow = t => {
  if (!kisHold) return null;
  return isKR(t) || /^\d{6}$/.test(t) ? (kisHold.kr || []).find(x => x.t === String(t).slice(0, 6)) || null : (kisHold.us || []).find(x => x.t === t) || null;
};
const kisMoney = (kr, v) => (kr ? Math.round(v).toLocaleString('ko-KR') + '원' : '$' + Number(v).toFixed(2));
const kisTxt = t => {
  const h = kisRow(t);
  if (!h) return '';
  const kr = isKR(t) || /^\d{6}$/.test(t), pl = h.avg > 0 && h.price > 0 ? h.price / h.avg - 1 : null;
  return `🏦 ${h.qty}주 · 평단 ${kisMoney(kr, h.avg)}${pl != null ? ` · <span class="chg ${pl >= 0 ? 'up' : 'down'}" title="한투 현재가 ${kisMoney(kr, h.price)} 기준">${pl >= 0 ? '+' : '−'}${kisMoney(kr, Math.abs((h.price - h.avg) * h.qty))} (${pl >= 0 ? '+' : ''}${(pl * 100).toFixed(1)}%)</span>` : ''}`;
};
function renderKis() {
  const box = $('#kis-box'), miss = $('#kis-miss');
  if (!box) return;
  if (!kisHold) { box.hidden = true; miss.innerHTML = ''; return; }
  // 한투에 있는데 목록에 없는 종목 → 보유로 추가
  const codes = new Set(watch.map(t => String(t).slice(0, 6)));
  const out = (kisHold.us || []).filter(x => !watch.includes(x.t)).map(x => ({ k: x.t, label: x.t, qty: x.qty }))
    .concat((kisHold.kr || []).filter(x => !codes.has(x.t)).map(x => ({ k: x.t, label: x.name || x.t, qty: x.qty })));
  miss.innerHTML = out.length ? `<span class="muted">목록에 없는 보유 종목</span> ${out.map(x => `<button type="button" class="chip" data-kis-add="${esc(x.k)}" title="보유 종목으로 추가">＋ ${esc(x.label)} ${x.qty}주</button>`).join('')}${out.length > 1 ? `<button type="button" class="chip" data-kis-add="${esc(out.map(x => x.k).join(' '))}">＋ 모두 추가</button>` : ''}` : '';
  box.hidden = !out.length; // 목록에 없는 보유 종목이 있을 때만 보임
}
// 에이전트 화면(다른 탭)에서 잔고를 새로 불러오면 바로 반영
window.addEventListener('storage', e => {
  if (e.key !== 'dcf-kis-hold') return;
  kisHold = lsGet('dcf-kis-hold', null);
  renderWatch();
});
$('#kis-miss').addEventListener('click', e => {
  const b = e.target.closest('[data-kis-add]');
  if (!b) return;
  // 추가 칸으로 넣음 (국내 6자리 코드는 코스피·코스닥을 찾아 붙여 줌), 보유로
  $('#wl-input').value = b.dataset.kisAdd; $('#wl-kind').value = 'hold';
  $('#wl-form').requestSubmit();
});
function renderWatch() {
  renderWlMode();
  renderKis();
  const list = $('#wl-list');
  const cur = (state.ticker || '').trim().toUpperCase();
  renderThemes();
  const held = watch.filter(t => holds.includes(t) && shown(t)), rest = watch.filter(t => !holds.includes(t) && shown(t));
  const items = [...(cur && !watch.includes(cur) ? [cur] : []), ...held, ...rest];
  const row = t => {
    const saved = watch.includes(t), h = holds.includes(t);
    return `
      <li class="${t === modalTicker ? 'on' : ''}" data-t="${esc(t)}"${saved ? ' data-saved="1"' : ''}>
        ${saved ? '<span class="wl-grip" title="끌어서 순서 바꾸기 · 보유/관심 칸 옮기기">⋮⋮</span>' : ''}<button type="button" class="wl-pick"><span class="wl-left"><span class="wl-name">${krName(t) ? `<b>${esc(krName(t))}</b> <span class="muted small">${esc(t.slice(0, 6))}</span>` : `<b>${esc(t)}</b>`}${saved ? `<span class="wl-theme ${themes[t] ? '' : 'none'}" data-theme-t="${esc(t)}" title="테마 정하기 (예: 전력, 우주)">${themes[t] ? esc(themes[t]) : '＋테마'}</span>` : ''}</span><span class="wl-rate" data-r="${esc(t)}"></span>${kisTxt(t) ? `<span class="wl-kis">${kisTxt(t)}</span>` : ''}</span><span class="wl-val" data-v="${esc(t)}">…</span></button>
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
