/* global DCF, SAParser, SAPdf, Tesseract, ExcelJS */
// 매매 신호 계산: 국내 종목 이름, 신호·지표 목록, 성적 설정(기간·수수료·손절익절), 가상 매매(simulate)·성적(statsOf), 종목별 일봉 받기
// js/app/ 파일들은 한 화면 코드를 기능별로 나눈 것. index.html 에 적힌 순서대로 불러오고, 서로의 이름(함수·변수)을 그대로 씀.
'use strict';

// ---------- 매매 신호·차트 지표 (js/strategy.js 의 STRATEGIES, CHART_INDICATORS + "＋ 추가"로 넣은 것) ----------
// 국내 주식(.KS 코스피, .KQ 코스닥)은 원화로
const isKR = t => /\.(KS|KQ)$/.test(String(t || ''));
// 국내 종목 한글 이름 (api/prices?krlist=1, 하루 캐시). 받기 전에는 코드만 보임
let krList = null, krByCode = {};
const krNorm = s => String(s || '').toLowerCase().replace(/[\s().·&-]/g, '');
const krName = t => (isKR(t) && krByCode[t.slice(0, 6)] ? krByCode[t.slice(0, 6)].n : '');
let krLoading = null;
function loadKr() {
  if (krList || krLoading) return krLoading || Promise.resolve(krList);
  krLoading = fetch('api/prices?krlist=1').then(r => r.json()).then(j => {
    if (!j || !Array.isArray(j.list)) throw new Error((j && j.error) || '목록 없음');
    krList = j.list.map(([c, n, m]) => ({ c, n, m, k: krNorm(n) }));
    krByCode = Object.fromEntries(krList.map(x => [x.c, x]));
    return krList;
  }).catch(e => { krLoading = null; throw e; });
  return krLoading;
}
// 한글 이름(일부만 써도 됨) → 종목. 이름이 똑같은 것 → 이름이 그 글자로 시작하는 것 → 그 글자가 들어 있는 것, 그 안에서는 이름이 짧은 것 먼저
function krFind(q, max = 1) {
  if (!krList) return [];
  const k = krNorm(q);
  if (!k) return [];
  const rank = x => (x.k === k || x.c === k ? 0 : x.k.startsWith(k) || (/^\d+$/.test(k) && x.c.startsWith(k)) ? 1 : x.k.includes(k) ? 2 : 9);
  return krList.map(x => ({ x, r: rank(x) })).filter(y => y.r < 9).sort((a, b) => a.r - b.r || a.x.n.length - b.x.n.length).slice(0, max).map(y => y.x);
}
const krT = x => `${x.c}.${x.m}`;
const fmtP = (v, t) => isKR(t === undefined ? modalTicker : t) ? Math.round(Number(v)).toLocaleString('ko-KR') + '원'
  : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtR = r => `<span class="chg ${r >= 0 ? 'up' : 'down'}">${r >= 0 ? '+' : ''}${(r * 100).toFixed(1)}%</span>`;
// '가리기·삭제' (이 브라우저에 저장): 가린 것은 '다시 보이기'로 돌릴 수 있고, 삭제한 사이트 기본 항목은 다시 나오지 않음
const HIDDEN_KEY = 'dcf-hidden-items', DELETED_KEY = 'dcf-deleted-items';
const lsArr = k => { try { const v = JSON.parse(localStorage.getItem(k)); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
let hiddenIds = lsArr(HIDDEN_KEY), deletedIds = lsArr(DELETED_KEY);
const offIds = () => hiddenIds.concat(deletedIds);
const BUILTIN_STRATS = (window.STRATEGIES || []).slice(), BUILTIN_INDS = (window.CHART_INDICATORS || []).slice();
const STRATS = BUILTIN_STRATS.filter(x => !offIds().includes(x.id));
const INDS = BUILTIN_INDS.filter(x => !offIds().includes(x.id));

// 성적 계산 설정: 기간(최근 몇 년), 손절·익절 % (비우면 안 씀). 모든 신호에 똑같이 적용
const BT_KEY = 'dcf-backtest';
// 거래 수수료 (한 번 살 때, 한 번 팔 때 각각 %). 기본 0.25% = 신한투자증권 해외주식 온라인 기본 수수료. 이벤트·우대 요율이면 칸에서 바꿈
const FEE_DEF = 0.25, FEE_KR_DEF = 0.12; // 국내: 온라인 수수료 약 0.015% + 팔 때 세금 0.2% → 한쪽 평균 약 0.12%
// years: 1·3·5 = 최근 몇 년, 0 = 직접 정한 기간 (from ~ to, to 가 비면 마지막 날까지)
const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
// minN·minRate: '손절·익절 찾기'에 보여 줄 최소 기준 (거래 몇 번 이상, 승률 몇 % 이상). 기본 5번·65%
const MIN_N_DEF = 5, MIN_RATE_DEF = 65;
const okN = v => Number.isInteger(v) && v >= 1 && v <= 100, okR = v => typeof v === 'number' && v >= 0 && v <= 100;
const bt = (() => { try { const o = JSON.parse(localStorage.getItem(BT_KEY)) || {}; return { years: [0, 1, 3, 5].includes(o.years) ? o.years : 5, from: isDay(o.from) ? o.from : '', to: isDay(o.to) ? o.to : '', fee: typeof o.fee === 'number' && o.fee >= 0 && o.fee <= 3 ? o.fee : FEE_DEF, feeKr: typeof o.feeKr === 'number' && o.feeKr >= 0 && o.feeKr <= 3 ? o.feeKr : FEE_KR_DEF, minN: okN(o.minN) ? o.minN : MIN_N_DEF, minRate: okR(o.minRate) ? o.minRate : MIN_RATE_DEF }; } catch (e) { return { years: 5, from: '', to: '', fee: FEE_DEF, feeKr: FEE_KR_DEF, minN: MIN_N_DEF, minRate: MIN_RATE_DEF }; } })();
const saveBt = () => lsSet(BT_KEY, bt);
// 손절·익절은 종목+신호마다 따로 저장: { AEHR: { 'stoch-x': {sl:10, tp:30} } }. 없으면 안 씀
// (예전 형식 { AEHR: {sl, tp} } 은 아래 migrateSltp 에서 그 종목의 적용 신호 칸으로 옮김)
const SLTP_KEY = 'dcf-sltp';
let sltp = (() => { try { const o = JSON.parse(localStorage.getItem(SLTP_KEY)); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } })();
const sltpOf = (t, sid) => { const o = (t && sid && sltp[t] && sltp[t][sid]) || {}; return { sl: o.sl > 0 ? o.sl : null, tp: o.tp > 0 ? o.tp : null }; };
function setSltp(t, sid, rule) {
  if (!t || !sid) return;
  const m = sltp[t] || {};
  if (rule.sl || rule.tp) m[sid] = { sl: rule.sl || null, tp: rule.tp || null }; else delete m[sid];
  if (Object.keys(m).length) sltp[t] = m; else delete sltp[t];
  lsSet(SLTP_KEY, sltp);
}
const feeOf = t => (isKR(t) ? bt.feeKr : bt.fee); // % (살 때·팔 때 각각)
const simKey = (s, rule) => `${s.id}|${rule.sl || ''}|${rule.tp || ''}|${bt.fee}|${bt.feeKr}`;

// 트레이딩뷰 strategy와 같은 방식: 신호 봉 종가에서 판단 → 다음 봉 시가에 체결, 보유 중엔 매수 표시 안 함.
// 손절·익절: 보유 중 그날 저가가 손절가 아래면 손절가(시가가 이미 아래면 시가)에, 고가가 익절가 위면 익절가에 판다. 같은 날 둘 다 닿으면 손절로 본다.
function simulate(d, strat, rule) {
  const fu = feeOf(d.ticker);
  rule = rule || { sl: null, tp: null };
  const out = strat.run(d, window.TA);
  // 사용자가 정한 수수료(증권사 실제 요율)를 신호 기본값보다 먼저 씀
  const n = d.close.length, fee = fu >= 0 ? fu / 100 : out && out.commission != null ? out.commission : strat.commission != null ? strat.commission : 0.0005;
  if (!out || !Array.isArray(out.buy) || !Array.isArray(out.exit)) throw new Error('buy·exit 배열을 돌려주지 않았습니다.');
  const sl = rule.sl / 100, tp = rule.tp / 100;
  const marks = [], trades = [];
  let pos = false, entry = null, pendBuy = false, pendExit = false;
  const close = (i, price, reason) => {
    pos = false;
    trades.push({ from: entry, to: { i, price }, ret: (price * (1 - fee)) / (entry.price * (1 + fee)) - 1, reason });
    entry = null;
  };
  for (let i = 0; i < n; i++) {
    if (pendBuy && !pos) { pos = true; entry = { i, price: d.open[i] }; }
    if (pendExit && pos) close(i, d.open[i]);
    if (pos && sl > 0 && d.low[i] <= entry.price * (1 - sl)) {
      const px = Math.min(d.open[i], entry.price * (1 - sl));
      close(i, px, '손절'); marks.push({ i, kind: 'sell', reason: '손절', price: px });
    } else if (pos && tp > 0 && d.high[i] >= entry.price * (1 + tp)) {
      const px = Math.max(d.open[i], entry.price * (1 + tp));
      close(i, px, '익절'); marks.push({ i, kind: 'sell', reason: '익절', price: px });
    }
    pendBuy = !!out.buy[i]; pendExit = !!out.exit[i];
    if (out.buy[i] && !pos) marks.push({ i, kind: 'buy' });
    if (out.exit[i] && pos) marks.push({ i, kind: 'sell' });
  }
  return { out, marks, trades, pos, entry, fee, d };
}
// 지난 성적 (설정한 기간 안에 산 거래만): 거래 수, 승률, 거래당 평균, 누적, 최대 낙폭, 같은 기간 그냥 들고 있었을 때
// 성적을 셀 봉 범위 [시작, 끝]. years 를 주면 최근 그 햇수, 아니면 고른 기간 (직접 정한 기간 포함)
function btRange(d, years) {
  const L = d.close.length - 1;
  const y = years || bt.years;
  if (y) {
    const cut = new Date(d.time[L]);
    cut.setFullYear(cut.getFullYear() - y);
    const c = cut.toISOString().slice(0, 10), k = d.time.findIndex(t => t >= c);
    return [k < 0 ? 0 : k, L];
  }
  let s = bt.from ? d.time.findIndex(t => t >= bt.from) : 0;
  if (s < 0) s = L;
  let e = L;
  if (bt.to) { e = -1; for (let i = L; i >= 0; i--) if (d.time[i] <= bt.to) { e = i; break; } }
  if (e < s) e = s;
  return [s, e];
}
const btStart = (d, years) => btRange(d, years)[0];
// 화면에 쓰는 기간 이름: "2024-01-02 이후" 또는 "2024-01-02 ~ 2025-06-30"
function btSpanTxt(d) {
  const [s, e] = btRange(d), L = d.close.length - 1;
  return e < L ? `${d.time[s]} ~ ${d.time[e]}` : `${d.time[s]} 이후`;
}
// 문장 안에 넣을 때: "2024-01-02 이후" 또는 "2024-01-02 ~ 2025-06-30 동안"
const btDuring = d => { const t = btSpanTxt(d); return t.endsWith('이후') ? t : t + ' 동안'; };
const btName = () => (bt.years ? `최근 ${bt.years}년` : `${bt.from || '처음'} ~ ${bt.to || '오늘'}`);
// 지난 성적 (기간 안에 사서 기간 안에 판 거래): 거래 수, 승률, 거래당 평균, 누적, 최대 낙폭, 같은 기간 그냥 들고 있었을 때.
// 기간 끝에 아직 들고 있는 거래는 끝난 거래로 세지 않고 낙폭에만 넣음
function statsOf(sim, years) {
  if (!sim || sim.error || !sim.d) return null;
  const d = sim.d, [s0, e0] = btRange(d, years);
  const tr = (sim.trades || []).filter(x => x.from.i >= s0 && x.to.i <= e0);
  if (!tr.length) return null;
  const wins = tr.filter(x => x.ret > 0).length;
  // 최대 낙폭: 보유 중엔 매일 종가로 평가한 자산이 앞선 최고점에서 가장 많이 빠졌던 비율 (기간 끝까지 들고 있는 거래 포함)
  const legs = tr.map(x => ({ a: x.from.i, b: x.to.i, p: x.from.price, ret: x.ret }));
  const open = (sim.trades || []).find(x => x.from.i >= s0 && x.from.i <= e0 && x.to.i > e0) ||
    (sim.pos && sim.entry && sim.entry.i >= s0 && sim.entry.i <= e0 ? { from: sim.entry } : null);
  if (open) legs.push({ a: open.from.i, b: e0 + 1, p: open.from.price, ret: null });
  let eq = 1, peak = 1, mdd = 0;
  const mark = v => { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); };
  legs.forEach(g => {
    for (let k = g.a; k < g.b && k <= e0; k++) mark(eq * d.close[k] / g.p);
    if (g.ret != null) { eq *= 1 + g.ret; mark(eq); }
  });
  return {
    n: tr.length, wins, rate: wins / tr.length,
    avg: tr.reduce((a, x) => a + x.ret, 0) / tr.length,
    total: tr.reduce((a, x) => a * (1 + x.ret), 1) - 1,
    mdd, hold: d.close[e0] / d.open[s0] - 1, from: d.time[s0], to: d.time[e0],
    stops: tr.filter(x => x.reason).length,
    // 번 돈을 다시 넣어 굴릴 때 거래마다 들어간 금액의 합 (시작 금액 = 1). 수수료 금액 어림에 씀
    turn: tr.reduce((a, x) => { a.sum += a.eq * (2 + x.ret); a.eq *= 1 + x.ret; return a; }, { eq: 1, sum: 0 }).sum / 2,
  };
}
const rateTxt = st => (st ? `승률 ${Math.round(st.rate * 100)}%` : '거래 없음');

// 종목별 일봉. 신호·지표 결과는 받은 데이터마다 한 번만 계산.
// 화면이 열려 있으면 1분마다 새로 받음 (liveTick). 분 단위 꼬리표로 서버 캐시(5분)를 건너뜀
const sigCache = {};
const loadSig = t => fetch('api/prices?range=5y&ticker=' + encodeURIComponent(t) + '&m=' + Math.floor(Date.now() / 60000))
  .then(async res => {
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.close || !d.close.length) throw new Error(d.error || '주가 없음');
    return { t, d, sims: {}, inds: {} };
  });
function getSig(t) {
  if (!sigCache[t]) {
    sigCache[t] = loadSig(t);
    sigCache[t].catch(() => delete sigCache[t]); // 실패하면 다음에 다시 시도
  }
  return sigCache[t];
}
// 이미 받은 종목만 새로 받기. 실패하면 이전 값을 그대로 둠 (화면이 멈추거나 비지 않게)
async function refreshSig(t) {
  try { const r = await loadSig(t); sigCache[t] = Promise.resolve(r); return true; } catch (e) { return false; }
}
function simOf(r, s) {
  const rule = sltpOf(r.t, s.id), k = simKey(s, rule);
  if (!(k in r.sims)) { try { r.sims[k] = simulate(r.d, s, rule); } catch (e) { r.sims[k] = { error: e.message || String(e) }; } }
  return r.sims[k];
}
function indOf(r, ind) {
  if (!(ind.id in r.inds)) { try { r.inds[ind.id] = ind.plot(r.d, window.TA) || {}; } catch (e) { r.inds[ind.id] = { error: e.message || String(e) }; } }
  return r.inds[ind.id];
}
// 장전·장후(시간외) 마지막 거래가: 마지막 일봉 종가 대비. 일봉보다 오래된 값이면 버림
function extOf(d) {
  const e = d.ext, L = d.close.length - 1;
  if (!e || !(e.price > 0) || !e.date || e.date < d.time[L]) return null;
  return { label: e.session === 'pre' ? '장전' : '장후', price: e.price, chg: e.price / d.close[L] - 1, time: e.time };
}
// 시간외 미리보기: 장전·장후 마지막 가격이 그대로 다음 종가가 된다고 가정하고 신호를 다시 계산.
// 진짜 신호·승률·카톡 알림은 정규장 종가만 씀. 이건 화면에 '미리보기'로만 보여 줌
function extPreview(r, s) {
  const d = r.d, ex = extOf(d), L = d.close.length - 1;
  if (!ex || !s) return null;
  const p = ex.price, d2 = {};
  for (const k in d) d2[k] = Array.isArray(d[k]) ? d[k].slice() : d[k];
  d2.time.push(d.ext.date > d.time[L] ? d.ext.date : d.time[L] + '+');
  d2.open.push(p); d2.high.push(p); d2.low.push(p); d2.close.push(p); if (d2.volume) d2.volume.push(0);
  let st;
  try { st = sigState(d2, simulate(d2, s, sltpOf(r.t, s.id))); } catch (e) { return null; }
  const now = sigState(d, simOf(r, s));
  const what = st.cls === 'buy' ? '매수 신호가 나옵니다' : st.cls === 'sell' ? '청산 신호가 나옵니다' : now.cls === 'hold' && st.cls === 'none' ? '손절·익절로 정리됩니다' : '새 신호는 없습니다';
  return { cls: st.cls, short: st.cls === 'buy' ? '매수' : st.cls === 'sell' ? '청산' : '', label: ex.label, price: p,
    text: `${ex.label} ${fmtP(p)} 그대로 마감하면 ${what}` };
}
// 다음 실적 발표일 (오늘 이후만). near = 7일 안: 발표 전후 큰 변동으로 신호가 잘 안 맞으니 주의
function earnOf(d) {
  const e = d.earnings;
  if (!e || !e.date) return null;
  const now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const [y, m, dd] = e.date.split('-').map(Number), dday = Math.round((new Date(y, m - 1, dd) - today) / 864e5);
  if (dday < 0) return null;
  return { date: e.date, dday, estimate: e.estimate, near: dday <= 7, text: `실적 발표 ${e.date.slice(5)}${e.estimate ? ' 예상' : ''} (${dday ? 'D-' + dday : '오늘'})` };
}
// 마지막 봉 기준 상태: 오늘 매수 / 오늘 청산 / 매수 유지 / 신호 없음
function sigState(d, sim) {
  const L = d.close.length - 1;
  if (!sim || sim.error) return { cls: 'none', text: '계산 오류', short: '' };
  // 이미 산 상태(매수 유지 중)에서 매수 조건이 또 나오면 새 매수가 아님: 성적 계산도 추가로 사지 않음 (물타기 없음)
  if (sim.out.buy[L] && sim.pos) return { cls: 'hold', text: '매수 유지 중 · 오늘 매수 조건이 또 나왔지만 이미 산 상태라 추가 매수 신호가 아닙니다', short: '매수 유지' };
  if (sim.out.buy[L]) return { cls: 'buy', text: '오늘 매수 신호', short: '매수' };
  if (sim.out.exit[L] && sim.pos) return { cls: 'sell', text: '오늘 청산 신호', short: '청산' };
  if (sim.pos) return { cls: 'hold', text: '매수 유지 중 · 청산 신호 기다리는 중', short: '매수 유지' };
  return { cls: 'none', text: '오늘은 신호 없음', short: '' };
}
