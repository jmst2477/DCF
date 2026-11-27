/* global DCF, SAParser, SAPdf, Tesseract, ExcelJS */
// 공통: 저장된 DCF 상태, 기본(강의) 방식 가정, P/E 방식, 숫자 표시 형식, $ · esc 같은 도우미
// js/app/ 파일들은 한 화면 코드를 기능별로 나눈 것. index.html 에 적힌 순서대로 불러오고, 서로의 이름(함수·변수)을 그대로 씀.
'use strict';

const N = DCF.YEARS;
const STORE_KEY = 'dcf-web-state-v1';
const KEY_STORE = 'dcf-web-anthropic-key';
const CLAUDE_MODEL = 'claude-opus-5-5';
const CDN = 'https://cdn.jsdelivr.net/npm/';

// ---------- 상태 ----------
function blank() {
  const arr = v => Array.from({ length: N + 1 }, () => v);
  return {
    ticker: '', baseFY: new Date().getFullYear() - 1, price: 0, shares: 0, cash: 0, debt: 0,
    tax: 0.21, wacc: 0.08, g: 0.02, normCapex: 0.05, normDA: 0.05,
    beta: 0, rf: 0.042, erp: 0.05, sbcOn: false, sbc: 0, horizon: 3,
    revenue: arr(0), growth: arr(0.05), margin: arr(0.2), da: arr(0.05), capex: arr(0.05), nwc: arr(0),
    mode: 'basic', basic: blankBasic(),
  };
}

// ---------- 기본(강의) 방식: 원본 「DCF Valuation Model」 엑셀과 같은 고정 가정 ----------
// 모든 해에 같은 가정을 쓰고 3년만 계산. 법인세 21%, 순운전자본 매출의 1%는 강의 기본값.
const MAX_YEARS = 3; // 예측은 3년까지 (사용자 결정 2026-10-10)
function blankBasic() {
  return { rev0: 0, growth: 0.1, margin: 0.2, tax: 0.21, da: 0.05, capex: 0.05, nwc: 0.01, years: 3, pe: 20, src: {} };
}
const BASIC_FIELDS = [
  { key: 'rev0', label: '0년차 매출 (백만 $)', type: 'num' },
  { key: 'growth', label: '매출 성장률 (%)', type: 'pct' },
  { key: 'margin', label: '영업이익률 (%)', type: 'pct' },
  { key: 'tax', label: '법인세율 (%)', type: 'pct' },
  { key: 'da', label: '감가상각비/매출 (%)', type: 'pct' },
  { key: 'capex', label: '캐펙스/매출 (%)', type: 'pct' },
  { key: 'nwc', label: '순운전자본증감/매출 (%)', type: 'pct' },
  { key: 'wacc', label: '할인율 (%)', type: 'pct', shared: true, hint: '좋은 회사 8%, 안 좋은 회사 12%' },
  { key: 'g', label: '영구성장률 (%)', type: 'pct', shared: true },
  { key: 'shares', label: '발행주식수 (백만 주)', type: 'num', shared: true },
  { key: 'cash', label: '보유현금 (백만 $)', type: 'num', shared: true },
  { key: 'debt', label: '총차입금 (백만 $)', type: 'num', shared: true },
  { key: 'price', label: '현재 주가 ($)', type: 'num', shared: true },
  { key: 'years', label: '예측 연수', type: 'int', hint: '기본 3년 (추정치가 더 있어도 3년까지)' },
  { key: 'pe', label: '적정 P/E (배, P/E 방식)', type: 'num' },
];

// 지금 갖고 있는 자료(티커 조회·캡처·PDF)로 기본 가정을 채움. 직접 고친 칸('user')은 건드리지 않음.
function basicRefresh(s) {
  const b = s.basic = Object.assign(blankBasic(), s.basic || {});
  b.src = b.src || {};
  const set = (k, v, label) => { if (b.src[k] === 'user' || v == null || !Number.isFinite(v)) return; b[k] = +(+v).toFixed(k === 'rev0' ? 1 : 4); b.src[k] = label; };
  const H = Math.max(1, Math.min(N, s.horizon || 1));
  set('rev0', s.revenue[0] || null, '최근 실적');
  // 매출 성장률: 애널리스트 매출 추정치가 있는 마지막 해까지의 연평균 (없으면 최근 실적 성장률)
  let tk = 0;
  for (let t = 1; t <= Math.min(H, MAX_YEARS); t++) if (s.revenue[t] > 0 && !(s.revAssumed && s.revAssumed[t])) tk = t;
  if (tk && s.revenue[0] > 0) set('growth', Math.pow(s.revenue[tk] / s.revenue[0], 1 / tk) - 1, `애널리스트 매출 추정치 ${tk}년 연평균`);
  else {
    const h = s.info && s.info.history;
    if (h && h.length > 1 && h[h.length - 2].revenue > 0) set('growth', h[h.length - 1].revenue / h[h.length - 2].revenue - 1, '최근 실적 성장률');
  }
  // 이익률·감가상각비·캐펙스: 시킹알파 추정치(EBIT/EPS 등)가 있으면 그 평균, 없으면 최근 실적
  // 한 해만 튀는 EPS(일회성 투자이익 등)로 추정한 이익률은 평균에서 뺌. 그 해밖에 없으면 그대로 씀
  const spikes = epsSpikes(s);
  const avgSrc = key => {
    const v = [], kinds = new Set(), skipped = [];
    for (let t = 1; t <= H; t++) {
      const k = s.src && s.src[key] && s.src[key][t];
      if (k === 'eps' && spikes.has(s.baseFY + t)) { skipped.push(s.baseFY + t); continue; }
      if (k === 'est' || k === 'eps') { v.push(s[key][t]); kinds.add(k); }
    }
    if (!v.length && skipped.length) { for (const y of skipped) v.push(s[key][y - s.baseFY]); kinds.add('eps'); skipped.length = 0; }
    const skip = skipped.length ? `, ${skipped.join('·')}년 일회성 EPS 제외` : '';
    return v.length ? { v: v.reduce((a, c) => a + c, 0) / v.length, label: kinds.has('est') ? '시킹알파 추정치 평균' : `EPS로 추정 (평균${skip})` } : null;
  };
  const fromEps = {};
  for (const key of ['margin', 'da', 'capex']) {
    const e = avgSrc(key);
    fromEps[key] = !!e && e.label.startsWith('EPS');
    if (e) set(key, e.v, e.label);
    else set(key, s[key][0], key === 'capex' && s.capexAvgN > 1 ? `최근 ${s.capexAvgN}년 평균` : '최근 실적');
  }
  // 시킹알파 EPS는 조정(Non-GAAP) EPS라 주식보상비용(SBC)과 인수 무형자산 상각비가 빠져 있음.
  // 그대로 쓰면 이익률이 높아지고, 감가상각비(상각비 포함)를 또 더해 현금흐름이 두 번 부풀려짐 (예: 브로드컴).
  if (fromEps.margin) {
    const sbc = s.sbc > 0 ? s.sbc : 0;
    if (sbc) set('margin', b.margin - sbc, `${b.src.margin} − 주식보상 ${(sbc * 100).toFixed(1)}%`);
    if (b.src.da !== 'user' && !(avgSrc('da') || {}).v && b.da > b.capex) set('da', b.capex, '캐펙스와 같게 (조정 EPS는 상각비를 이미 뺌)');
  }
  for (const [k, v] of [['tax', 0.21], ['nwc', 0.01]]) if (!b.src[k]) { b[k] = v; b.src[k] = '강의 기본값'; }
  // 적정 P/E: EPS 추정치가 2개 이상이면 PEG 1.5 × EPS 연평균 성장률(%) (10~40배), 없으면 20배
  const eg = epsGrowth(s);
  const sp = [...spikes].filter(y => y <= s.baseFY + 3);
  if (eg != null) set('pe', Math.max(10, Math.min(40, 1.5 * eg * 100)), `PEG 1.5 × EPS 성장률 ${(eg * 100).toFixed(1)}%${sp.length ? ` (${sp.join('·')}년 일회성 EPS 제외)` : ''}`);
  else if (!b.src.pe) { b.pe = 20; b.src.pe = '시장 평균 수준 20배'; }
  if (!b.src.years || b.src.years === '강의 기본값') { b.years = MAX_YEARS; b.src.years = '기본 3년'; }
  return s;
}
// ---------- P/E 방식: 적정가 = 예상 EPS × 적정 P/E ----------
// 지금 = 1년차 EPS, 내년 = 2년차, 내후년 = 3년차. 시킹알파 EPS 추정치가 없으면 계산값(매출 × 이익률 × (1 − 세율) ÷ 주식수).
// 한 해만 튀는 EPS: 다음 해 추정치가 10% 넘게 떨어지는 해 (예: GOOG 2026년 19.70 → 2027년 14.81).
// 지분 평가이익 같은 일회성 이익이 섞인 것으로 보고 이익률 평균과 P/E 계산에서 뺀다.
function epsSpikes(s) {
  const raw = s.estRaw && s.estRaw.eps, out = new Set();
  if (!raw) return out;
  for (let t = 1; t <= 5; t++) {
    const y = s.baseFY + t;
    if (raw[y] > 0 && raw[y + 1] > 0 && raw[y + 1] < raw[y] * 0.9) out.add(y);
  }
  return out;
}
function epsAt(s, t) {
  const raw = s.estRaw && s.estRaw.eps, y = s.baseFY + t;
  if (raw && raw[y] > 0 && epsSpikes(s).has(y)) {
    // 튀는 해는 다음 해 EPS를 EPS 성장률만큼 되돌려 씀
    const eg = epsGrowth(s);
    if (raw[y + 1] > 0 && eg != null && eg > -1) return { v: raw[y + 1] / (1 + eg), est: true, adj: raw[y] };
  }
  if (raw && raw[y] > 0) return { v: raw[y], est: true };
  const b = s.basic;
  if (!(b && b.rev0 > 0 && s.shares > 0)) return { v: NaN, est: false };
  return { v: b.rev0 * Math.pow(1 + b.growth, t) * b.margin * (1 - b.tax) / s.shares, est: false };
}
function epsGrowth(s) {
  const raw = s.estRaw && s.estRaw.eps;
  if (!raw) return null;
  const sp = epsSpikes(s);
  const ys = [1, 2, 3, 4, 5].map(t => s.baseFY + t).filter(y => raw[y] > 0 && !sp.has(y)).slice(0, 3);
  if (ys.length < 2) return null;
  const a = ys[0], z = ys[ys.length - 1];
  return Math.pow(raw[z] / raw[a], 1 / (z - a)) - 1;
}

function basicInput() {
  const b = state.basic;
  return { rev0: b.rev0, growth: b.growth, margin: b.margin, tax: b.tax, da: b.da, capex: b.capex, nwc: b.nwc, years: b.years,
    wacc: state.wacc, g: state.g, shares: state.shares, cash: state.cash, debt: state.debt, price: state.price };
}

let state = load() || blank();
state.mode = 'basic'; // 계산 방식은 하나 (강의 방식, 3년)
if (!state.basic || !state.basic.src) basicRefresh(state);

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? Object.assign(blank(), JSON.parse(raw)) : null;
  } catch (e) { return null; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* 저장 불가 환경 무시 */ }
}

// ---------- 표시 형식 ----------
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const fmt = (v, d = 0) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v, d = 1) => (v == null || !Number.isFinite(v) ? '–' : (v * 100).toFixed(d) + '%');
const toInput = (v, isPct) => (isPct ? +(v * 100).toFixed(4) : v);
const fromInput = (s, isPct) => {
  const n = parseFloat(String(s).replace(/,/g, ''));
  if (!Number.isFinite(n)) return 0;
  return isPct ? n / 100 : n;
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
