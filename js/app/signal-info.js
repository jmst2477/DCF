/* global DCF, SAParser, SAPdf, Tesseract, ExcelJS */
// 신호 설명 · 신호 자세히 창 (위쪽 버튼 눌린 모양 포함)
// js/app/ 파일들은 한 화면 코드를 기능별로 나눈 것. index.html 에 적힌 순서대로 불러오고, 서로의 이름(함수·변수)을 그대로 씀.
'use strict';

// "ⓘ 신호 설명" 버튼은 아래 설명 칸이 열려 있을 때 눌린 모양으로 (칸 제목을 눌러 닫아도 같이 바뀜)
// 위쪽 버튼(신호 자세히·옵션·심층 분석): 열려 있는 창의 버튼을 눌린 모양으로
const syncAbout = () => $$('[data-pop]').forEach(c => c.classList.toggle('on', !!document.getElementById(c.dataset.pop)?.open));
$$('.modal-info.popup').forEach(d => d.addEventListener('toggle', syncAbout));
document.addEventListener('click', e => {
  const b = e.target.closest('.strat-pick .chip[data-sid]'), ib = e.target.closest('.ind-pick .chip[data-iid]'), add = e.target.closest('.chip.add');
  if (add) { openAdd(add.dataset.addKind); return; }
  const del = e.target.closest('.chip.del');
  if (del) { openDel(del.dataset.delKind); return; }
  if (e.target.closest('.chip[data-sig-fold]')) { sigFold = !sigFold; lsSet('dcf-sig-fold', sigFold); renderPickers(); return; }
  const pop = e.target.closest('[data-pop]');
  if (pop) {
    // 한 번 누르면 창을 열고, 다시 누르면 닫는다
    const d = document.getElementById(pop.dataset.pop);
    if (d) d.open = !d.open;
    return;
  }
  if (b) {
    if (b.dataset.sid === stratSel) return;
    stratSel = baseSel = b.dataset.sid;
    lsSet('dcf-strategy-id', stratSel);
    searchRefresh(); // 열려 있으면 새 신호로 다시 계산
  } else if (ib) {
    const id = ib.dataset.iid;
    indOff = indOff.includes(id) ? indOff.filter(x => x !== id) : [...indOff, id];
    lsSet('dcf-indicators-off', indOff);
  } else return;
  renderPickers();
  if (!$('#chart-modal').hidden) { if (b) renderWatch(); if (modalTicker) showModalTicker(modalTicker); }
});

// 신호 설명 (js/strategy.js 의 about: [제목, 내용] 목록). 직접 추가한 신호는 읽어 낸 조건을 보여 줌
function aboutHtml(s) {
  const rows = s.about || (s.desc ? [['조건', s.desc]] : []);
  if (!rows.length) return '';
  return `<div id="sig-about" class="sig-about" style="--c:${s.color}"><h4>이 신호는? <span class="muted small">${esc(s.name)}</span></h4><dl>` +
    rows.map(([t, p]) => `<dt>${esc(t)}</dt><dd>${esc(p)}</dd>`).join('') + '</dl></div>';
}
// 실적 발표가 7일 안인데 매수 신호이거나 보유 중이면 경고
function earnWarn(d, st) {
  const ea = earnOf(d);
  if (!ea || !ea.near || !['buy', 'hold'].includes(st.cls)) return '';
  return `<p class="earn-warn small">⚠ ${esc(ea.text)}: 실적 발표 전후로는 주가가 크게 튀어 신호가 잘 안 맞습니다. ${st.cls === 'buy' ? '발표 뒤에 들어가는 것도 방법입니다.' : '발표 전에 정리할지 생각해 보세요.'}</p>`;
}
const btFromTxt = d => btSpanTxt(d);
const btRuleTxt = ss => { const r = sltpOf(modalTicker, stratSel); return r.sl || r.tp ? ` · ${[r.sl ? `손절 -${r.sl}%` : '', r.tp ? `익절 +${r.tp}%` : ''].filter(Boolean).join(' · ')}${ss && ss.stops ? ` (${ss.stops}번 발동)` : ''}` : ''; };
// 차트 아래 "신호 자세히": 고른 신호, 모든 전략 승률 비교, 켜 둔 지표 상태, 최근 신호
function renderSigInfo(r) {
  const d = r.d, n = d.close.length, L = n - 1, last = d.close[L];
  const s = activeStrats()[0];
  let html = '';
  if (s) {
    const sim = simOf(r, s);
    if (sim.error) html = `<div class="strat-row" style="--c:${s.color}"><div class="strat-head"><i></i><b>${esc(s.name)}</b><span class="sig-badge">계산 오류</span></div><p class="small muted">${esc(sim.error)}</p></div>`;
    else {
      const st = sigState(d, sim), latest = sim.marks[sim.marks.length - 1], ss = statsOf(sim);
      let lastTxt = `${d.time[0]} 이후로 신호가 한 번도 없었습니다.`;
      if (latest) {
        const days = L - latest.i;
        lastTxt = `마지막 신호: <b>${latest.kind === 'buy' ? '매수' : '청산'}</b> · ${d.time[latest.i]}${days ? ` (${days}거래일 전)` : ''} · ${fmtP(d.close[latest.i])}` + (days ? ` → 지금 ${fmtP(last)} ${fmtR(last / d.close[latest.i] - 1)}` : '');
      }
      const stats = ss ? `${esc(btDuring(d))} 이 조건대로 사고팔았다면: 거래 ${ss.n}번 · 이긴 거래 ${ss.wins}번 (<b>${Math.round(ss.rate * 100)}%</b>) · 거래당 평균 ${fmtR(ss.avg)} · 누적 ${fmtR(ss.total)} · 최대 낙폭 ${fmtR(ss.mdd)}` +
        ` · 같은 기간 그냥 들고 있었다면 ${fmtR(ss.hold)} <span class="muted">(다음 날 시가 체결, 수수료 ${(sim.fee * 100).toFixed(2)}%${btRuleTxt(ss)})</span>` : `<span class="muted">${esc(btDuring(d))} 끝난 거래가 없습니다.</span>`;
      html = `<div class="strat-row" style="--c:${s.color}">
          <div class="strat-head"><i></i><b>${esc(s.name)}</b><span class="sig-badge ${st.cls}">${st.text}</span></div>
          <p class="strat-desc muted small">${esc(s.desc || '')}</p>
          <p class="sig-last">${lastTxt}</p>${(pv => pv ? `<p class="ext-prev small"><span class="sig-tag ${pv.cls}">미리보기</span> ${esc(pv.text)} <span class="muted">(시간외는 거래가 적어 정규장 종가와 다를 수 있습니다. 실제 신호·알림은 정규장 종가 기준)</span></p>` : '')(extPreview(r, s))}${earnWarn(d, st)}${stats ? `<p class="sig-stats small">${stats}</p>` : ''}</div>`;
    }
    html += aboutHtml(s);
  }
  // 전략별 승률 비교 (이 종목)
  const rows = STRATS.map(x => {
    const sim = simOf(r, x), ss = statsOf(sim), st = sigState(d, sim);
    return `<tr class="${x.id === stratSel ? 'sel' : ''}"><td><span class="strat-name" style="--c:${x.color}"><i></i>${esc(x.name)}</span></td>` +
      (sim.error ? '<td colspan="6" class="muted">계산 오류</td>' :
        `<td>${ss ? ss.n : 0}</td><td>${ss ? `<b>${Math.round(ss.rate * 100)}%</b>` : '-'}</td><td>${ss ? fmtR(ss.avg) : '-'}</td><td>${ss ? fmtR(ss.total) : '-'}</td><td>${ss ? fmtR(ss.mdd) : '-'}</td><td><span class="sig-tag ${st.cls}">${st.short || '-'}</span></td>`) + '</tr>';
  }).join('');
  const [s0, e0] = btRange(d);
  html += `<h4 class="cmp-title">전략별 지난 성적 <span class="muted small">${esc(modalTicker || '')} · ${esc(btSpanTxt(d))} · 그냥 들고 있었다면 ${fmtR(d.close[e0] / d.open[s0] - 1)}${btRuleTxt()}</span></h4>
      <div class="table-scroll"><table class="grid cmp"><thead><tr><th>신호</th><th>거래</th><th>승률</th><th>거래당 평균</th><th>누적</th><th>최대 낙폭</th><th>오늘</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  $('#sig-strats').innerHTML = html;

  // 최근 신호 (고른 신호)
  const sim = s && simOf(r, s);
  if (sim && sim.marks && sim.marks.length) {
    const rows2 = sim.marks.slice(-15).reverse().map(m => {
      const px = m.price || d.close[m.i];
      return `<tr><td>${d.time[m.i]}</td><td><span class="sig-tag ${m.kind}">${m.kind === 'buy' ? '매수' : m.reason || '청산'}</span></td><td>${fmtP(px)}</td><td>${m.i === L ? '-' : fmtR(last / px - 1)}</td></tr>`;
    }).join('');
    $('#sig-table').innerHTML = `<thead><tr><th>날짜</th><th>신호</th><th>가격</th><th>지금까지</th></tr></thead><tbody>${rows2}</tbody>`;
    $('#sig-more').hidden = false;
  }
  $('#sig-ind').innerHTML = activeInds().map(ind => {
    const o = indOf(r, ind);
    const st = o.error ? { text: '계산 오류: ' + o.error, tone: '' } : o.status;
    return st ? `<li><span class="ind-name">${esc(ind.name)}</span><span class="ind-val ${st.tone ? 'chg ' + st.tone : ''}">${esc(st.text)}</span></li>` : '';
  }).join('');
}
