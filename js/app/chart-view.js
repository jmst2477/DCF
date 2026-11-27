/* global DCF, SAParser, SAPdf, Tesseract, ExcelJS */
// 차트 화면: 관심종목·보유·테마·시장 저장값, 맨 위 탭, 차트 창 열기·그리기, 옵션, 심층 분석, 1분 자동 갱신, 목록 신호 기준
// js/app/ 파일들은 한 화면 코드를 기능별로 나눈 것. index.html 에 적힌 순서대로 불러오고, 서로의 이름(함수·변수)을 그대로 씀.
'use strict';

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
// 해외·국내 나눠 보기 ('' = 전체, us = 해외, kr = 국내). 이 브라우저에 기억
let mktPick = lsGet('dcf-wl-mkt', '');
const inMkt = t => !mktPick || (mktPick === 'kr') === isKR(t);
const mktWatch = () => watch.filter(inMkt);
function renderMkt() {
  const box = $('#wl-mkt'), kr = watch.filter(isKR).length;
  if (!kr && mktPick) { mktPick = ''; lsSet('dcf-wl-mkt', ''); }
  box.hidden = !kr;
  box.innerHTML = `<span class="muted">시장</span>` + [['', '전체', watch.length], ['us', '🇺🇸 해외', watch.length - kr], ['kr', '🇰🇷 국내', kr]]
    .map(([v, label, n]) => `<button type="button" class="chip ${v === mktPick ? 'on' : ''}" data-mkt-pick="${v}">${label} <span class="muted">${n}</span></button>`).join('');
}
const themeList = () => [...new Set(mktWatch().map(t => themes[t]).filter(Boolean))];
const shown = t => inMkt(t) && (!themePick || themes[t] === themePick);
function renderThemes() {
  renderMkt();
  const box = $('#wl-themes'), list = themeList();
  if (themePick && !list.includes(themePick)) { themePick = ''; lsSet(THEME_PICK_KEY, ''); }
  box.hidden = !list.length;
  const order = themeFold && themePick ? [themePick, ...list.filter(x => x !== themePick)] : list;
  box.classList.toggle('fold', themeFold);
  box.innerHTML = `<div class="wl-themes-row">${[['', '전체', mktWatch().length], ...order.map(x => [x, x, mktWatch().filter(t => themes[t] === x).length])]
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
  if (isKR(t)) {
    const showName = () => { if (modalTicker === t && krName(t)) $('#modal-title').textContent = `${krName(t)} · ${t}`; };
    showName();
    loadKr().then(() => { showName(); renderWatch(); }).catch(() => getSig(t).then(r => { if (modalTicker === t && r.d.name && !krName(t)) $('#modal-title').textContent = `${t} · ${r.d.name}`; }, () => {}));
  }
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
  if (isKR(t)) { body.innerHTML = '<p class="muted small">국내 주식은 옵션 정보를 받을 곳이 없어 보여 드리지 못합니다.</p>'; return; }
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
// 새 창처럼 뜨는 칸: 한 번에 하나만, 바깥(어두운 곳)을 누르거나 Esc 로 닫기
$$('.modal-info.popup').forEach(d => d.addEventListener('toggle', () => {
  if (d.open) $$('.modal-info.popup[open]').forEach(o => { if (o !== d) o.open = false; });
}));
document.addEventListener('pointerdown', e => {
  const o = $('.modal-info.popup[open]');
  if (o && !o.contains(e.target) && !e.target.closest('.add-panel, [data-pop]')) o.open = false;
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') { const o = $('.modal-info.popup[open]'); if (o) o.open = false; } });
// 🔬 심층 분석 보고서: 요청하면 서버가 Claude 에 맡기고 /d/<id> 주소를 돌려준다. 이 브라우저에 종목별로 지난 보고서 주소를 기억
const DEEP_KEY = 'dcf-deep';
// 프롬프트 글은 창을 펼칠 때 미리 받아 둔다 (누르는 순간 바로 복사되게)
const deepPromptCache = {};
const deepPrompt = t => (deepPromptCache[t] = deepPromptCache[t] || fetch('/api/kakao?action=deepprompt&ticker=' + encodeURIComponent(t))
  .then(async res => { const j = await res.json().catch(() => ({})); if (!res.ok) throw new Error(j.error || '프롬프트를 못 받았습니다'); return j.text; })
  .catch(err => { delete deepPromptCache[t]; throw err; }));
function renderDeep(t) {
  const body = $('#deep-body'); if (!body) return;
  if (t) deepPrompt(t).catch(() => {});
  const list = ((lsGet(DEEP_KEY, {}) || {})[t] || []).slice(-5).reverse();
  body.innerHTML = `<div class="deep-ways">
      <div class="deep-way"><b>무료</b> <span class="muted small">내 Claude 구독으로</span>
        <p class="small">프롬프트를 복사하고 claude.ai 를 엽니다. 새 채팅에 붙여 넣기(Ctrl+V)만 하면 됩니다. 추가 비용 없음.</p>
        <button type="button" class="mini" data-deep-copy>📋 ${esc(t || '')} 프롬프트 복사 + Claude 열기</button> <span class="muted small" id="deep-copy-msg"></span></div>
    </div>` +
    (list.length ? `<p class="small">예전에 사이트로 요청한 보고서: ${list.map(x => `<a href="${esc(x.path)}" target="_blank" rel="noopener">${esc(String(x.at).slice(0, 10))}</a>`).join(' · ')}</p>` : '');
}
$('#deep-box').addEventListener('toggle', () => { if ($('#deep-box').open) renderDeep(modalTicker); });
$('#deep-body').addEventListener('click', async e => {
  if (e.target.closest('[data-deep-copy]')) {
    const t = modalTicker, msg = $('#deep-copy-msg'); if (!t) return;
    // 복사를 먼저 하고(이 창에 포커스가 있어야 복사됨) 그다음 Claude 창을 연다
    const copy = async text => {
      try { await navigator.clipboard.writeText(text); return true; } catch (err) {
        // 예전 방식으로 한 번 더
        const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (e2) { /* 실패 */ }
        ta.remove(); return ok;
      }
    };
    try {
      const text = await deepPrompt(t);
      if (!(await copy(text))) throw new Error('브라우저가 복사를 막았습니다');
      const win = window.open('https://claude.ai/new', '_blank'); if (win) win.opener = null;
      msg.innerHTML = win ? '복사했습니다. 열린 Claude 창에 붙여 넣으세요 (Ctrl+V).'
        : '복사했습니다. <a href="https://claude.ai/new" target="_blank" rel="noopener">Claude 열기</a>를 눌러 붙여 넣으세요 (Ctrl+V).';
    } catch (err) { msg.textContent = '복사 실패: ' + (err.message || err); }
    return;
  }
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
