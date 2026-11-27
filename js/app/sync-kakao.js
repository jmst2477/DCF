/* global DCF, SAParser, SAPdf, Tesseract, ExcelJS */
// 서버 연결: 기기 사이 자동 동기화, 카카오톡 알림, 동기화 시작
// js/app/ 파일들은 한 화면 코드를 기능별로 나눈 것. index.html 에 적힌 순서대로 불러오고, 서로의 이름(함수·변수)을 그대로 씀.
'use strict';

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
