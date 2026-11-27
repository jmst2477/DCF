/* global DCF, SAParser, SAPdf, Tesseract, ExcelJS */
// 관심종목 칸 조작: 끌어서 옆으로 보기, 해외·국내 찾기, 목록 클릭, 오늘 신호만, 칸 넓이 조절, 순서 바꾸기
// js/app/ 파일들은 한 화면 코드를 기능별로 나눈 것. index.html 에 적힌 순서대로 불러오고, 서로의 이름(함수·변수)을 그대로 씀.
'use strict';

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
// 찾을 시장: 해외(미국 티커) / 국내(한글·영문 이름, 코드). 국내면 'SK'도 국내 종목 이름으로 찾음. 이 브라우저에 기억
const wlSrc = () => $('#wl-src').value;
function setSrc(v) {
  $('#wl-src').value = v === 'kr' ? 'kr' : 'us';
  lsSet('dcf-wl-src', $('#wl-src').value);
  $('#wl-input').placeholder = wlSrc() === 'kr' ? '예: SK하이닉스, 삼성전자, 005930' : '예: GEV, AAPL (국내는 왼쪽에서 국내 선택)';
  $('#wl-input').dispatchEvent(new Event('input'));
}
$('#wl-src').addEventListener('change', () => setSrc(wlSrc()));
$('#wl-input').addEventListener('input', () => {
  const v = $('#wl-input').value, dl = $('#wl-dl');
  const last = v.split(',').pop().trim();
  if (!dl || !last || !(wlSrc() === 'kr' || /[가-힣]/.test(last))) { if (dl) dl.innerHTML = ''; return; }
  loadKr().then(() => {
    const head = v.slice(0, v.length - v.split(',').pop().length);
    dl.innerHTML = krFind(last, 12).map(x => `<option value="${esc(head + x.n)}">${esc(x.c)} ${x.m === 'KS' ? '코스피' : '코스닥'}</option>`).join('');
  }).catch(() => {});
});
// 관심종목에 국내 종목이 있으면 한글 이름을 받아 다시 그림
if (watch.some(isKR)) loadKr().then(() => { if (!$('#chart-modal').hidden) renderWatch(); }).catch(() => {});
setSrc(lsGet('dcf-wl-src', 'us'));
$('#wl-form').addEventListener('submit', async e => {
  e.preventDefault();
  // 리포트 종목을 한 번에: "GEV BE CEG" 처럼 띄어 쓰거나 쉼표로 여러 개
  const input = $('#wl-input').value.trim(), hold = $('#wl-kind').value === 'hold';
  const msg = $('#wl-msg');
  // 한글 이름: 쉼표로 나눈 칸이 이름과 딱 맞으면 그대로 (예: "KODEX 200"), 아니면 띄어쓰기로 나눠 하나씩
  const kr = wlSrc() === 'kr', hasKo = kr || /[가-힣]/.test(input);
  if (hasKo) { try { await loadKr(); } catch (err) { if (msg) msg.textContent = '국내 종목 목록을 못 받았습니다. 6자리 종목코드로 넣어 주세요.'; return; } }
  const raw = [];
  input.split(',').map(s => s.trim()).filter(Boolean).forEach(part => {
    const exact = hasKo && krList && krList.find(x => x.k === krNorm(part));
    if (exact) raw.push(krT(exact));
    else if (kr && !/^\d{6}$/.test(part) && part.split(/\s+/).length > 1 && krFind(part)[0]) raw.push('@' + part); // 국내: 띄어 쓴 이름 통째로
    else part.split(/\s+/).filter(Boolean).forEach(w => raw.push(kr && !/^\d{6}$/.test(w) ? '@' + w : w));
  });
  const miss = [];
  // 국내 주식: 6자리 종목코드(예: 005930)면 코스피·코스닥 중 어디인지 찾아 005930.KS 처럼 붙임
  const ts = await Promise.all(raw.map(async t => {
    // '@' = 국내에서 이름으로 찾기 (국내 선택 시 영문도. 예: SK → SK하이닉스 …)
    if (t[0] === '@' || /[가-힣]/.test(t)) { t = t.replace(/^@/, ''); const f = krFind(t)[0]; if (!f) miss.push(t); return f ? krT(f) : null; }
    t = t.toUpperCase();
    if (!/^\d{6}$/.test(t)) return t;
    if (krByCode[t]) return krT(krByCode[t]);
    try {
      const res = await fetch('api/prices?range=1y&ticker=' + t), j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ticker) throw new Error(j.error || '못 찾음');
      return j.ticker;
    } catch (err) { if (msg) msg.textContent = String(err.message || err); return null; }
  }));
  if (miss.length && msg) msg.textContent = `'${miss.join("', '")}' 종목을 ${kr ? '국내에서' : ''} 찾지 못했습니다.${kr ? ' 미국 종목이면 왼쪽에서 해외를 고르세요.' : ''}`;
  const ok = ts.filter(Boolean).filter(t => addWatch(t, hold));
  if (!ok.length) return;
  if (msg && ok.length === ts.length) msg.textContent = '';
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
$('#wl-mkt').addEventListener('click', e => {
  const b = e.target.closest('[data-mkt-pick]');
  if (!b) return;
  mktPick = b.dataset.mktPick;
  if (mktPick) setSrc(mktPick);
  lsSet('dcf-wl-mkt', mktPick);
  renderWatch();
});
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
