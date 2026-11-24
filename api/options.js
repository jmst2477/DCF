// Vercel 서버리스 함수: /api/options?ticker=AAPL
// 야후 파이낸스 옵션 체인(무료, 15분 지연일 수 있음)으로 미국 주식 옵션 요약을 만든다. API 키 불필요.
//   가까운 만기 하나(오늘 만기는 건너뜀)와 약 30일 뒤 만기 하나를 받아서:
//   풋·콜 비율(거래량·미결제약정), 등가격 내재 변동성(IV), 예상 변동폭(등가격 스트래들), 맥스 페인,
//   미결제약정이 많이 쌓인 행사가(콜 = 위쪽 벽, 풋 = 아래쪽 벽)

import { yahooSession } from "./dcf-inputs.js";

async function chain(ticker, H, crumb, date) {
  const q = (date ? `date=${date}&` : "") + `crumb=${encodeURIComponent(crumb)}`;
  const r = await fetch(`https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}?${q}`, { headers: H });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(text.slice(0, 200)); }
  const err = j.optionChain && j.optionChain.error;
  if (err) throw new Error("야후: " + (err.description || err.code || "옵션 조회 오류"));
  const res = j.optionChain && j.optionChain.result && j.optionChain.result[0];
  if (!res) throw new Error("야후: 옵션 데이터 없음");
  return res;
}

const num = v => (typeof v === "number" && isFinite(v) ? v : 0);
const day = s => new Date(s * 1000).toISOString().slice(0, 10);
const mid = o => (o && o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : num(o && o.lastPrice));

// 만기 하나 요약. price = 지금 주가
export function expirySummary(opt, price, now = Date.now()) {
  const calls = (opt.calls || []).filter(o => num(o.strike) > 0), puts = (opt.puts || []).filter(o => num(o.strike) > 0);
  const sum = (a, k) => a.reduce((s, o) => s + num(o[k]), 0);
  const cv = sum(calls, "volume"), pv = sum(puts, "volume"), co = sum(calls, "openInterest"), po = sum(puts, "openInterest");
  const strikes = [...new Set(calls.concat(puts).map(o => o.strike))].sort((a, b) => a - b);
  // 맥스 페인: 만기에 그 가격이면 옵션 매수자 전체가 받는 돈(= 매도자 손실)이 가장 적은 행사가
  let maxPain = null, best = Infinity;
  for (const k of strikes) {
    const pay = calls.reduce((s, o) => s + Math.max(0, k - o.strike) * num(o.openInterest), 0) + puts.reduce((s, o) => s + Math.max(0, o.strike - k) * num(o.openInterest), 0);
    if (pay < best) { best = pay; maxPain = k; }
  }
  // 등가격: 지금 주가에 가장 가까운 행사가
  const atmK = strikes.length ? strikes.reduce((a, k) => (Math.abs(k - price) < Math.abs(a - price) ? k : a), strikes[0]) : null;
  const ac = calls.find(o => o.strike === atmK), ap = puts.find(o => o.strike === atmK);
  const ivs = [ac, ap].map(o => num(o && o.impliedVolatility)).filter(v => v > 0.01 && v < 5);
  const iv = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
  const straddle = ac && ap ? mid(ac) + mid(ap) : null;
  const top = (a, side) => a.filter(o => (side === "call" ? o.strike >= price : o.strike <= price) && num(o.openInterest) > 0)
    .sort((x, y) => num(y.openInterest) - num(x.openInterest)).slice(0, 3).map(o => ({ strike: o.strike, oi: num(o.openInterest), vol: num(o.volume) }));
  const exp = num(opt.expirationDate);
  return {
    expiry: exp ? day(exp) : null,
    days: exp ? Math.max(0, Math.round((exp * 1000 - now) / 864e5)) : null,
    callVol: cv, putVol: pv, callOI: co, putOI: po,
    pcVol: cv > 0 ? pv / cv : null, pcOI: co > 0 ? po / co : null,
    maxPain, atm: atmK, iv,
    move: straddle && straddle > 0 ? { usd: straddle, pct: price > 0 ? straddle / price : null } : null,
    callWall: top(calls, "call"), putWall: top(puts, "put"),
  };
}

// 만기 목록에서: 가까운 것(오늘 만기 제외) 하나 + 약 30일 뒤 하나
export function pickExpiries(dates, now = Date.now()) {
  const fut = (dates || []).filter(s => s * 1000 > now + 864e5).sort((a, b) => a - b);
  if (!fut.length) return [];
  const near = fut[0];
  const m = fut.reduce((a, s) => (Math.abs(s * 1000 - now - 30 * 864e5) < Math.abs(a * 1000 - now - 30 * 864e5) ? s : a), fut[0]);
  return m === near ? [near] : [near, m];
}

// 한 종목 옵션 요약: { ticker, price, at, expiries: [가까운 만기, 약 30일 만기] } 또는 { none }. sess = yahooSession() 결과 재사용
export async function optionsOf(ticker, sess) {
  const { H, crumb } = sess || (await yahooSession());
  const first = await chain(ticker, H, crumb);
  const price = num(first.quote && first.quote.regularMarketPrice);
  const picks = pickExpiries(first.expirationDates);
  if (!picks.length) return { ticker, none: "이 종목은 옵션이 없습니다." };
  const out = [];
  for (const d of picks) {
    const c = d === (first.options && first.options[0] && first.options[0].expirationDate) ? first : await chain(ticker, H, crumb, d);
    const opt = c.options && c.options[0];
    if (opt) out.push(expirySummary(opt, price));
  }
  return { ticker, price, at: new Date().toISOString(), expiries: out };
}

// 보고서·추천용 한 줄 판단 (api/_report.js). 약 30일 만기 기준.
//   풋·콜 미결제약정 비율 0.7 이하 = 콜 우세(+3), 1.3 이상 = 풋 우세(-3). 바로 위(+3% 안) 큰 콜 벽은 저항 메모(-1).
//   옵션은 방향을 맞히는 지표가 아니라서 점수 조정은 작게만 한다.
export function optionView(o) {
  if (!o || o.none || !o.expiries || !o.expiries.length) return null;
  const e = o.expiries[o.expiries.length - 1], p = o.price;
  let adj = 0;
  const notes = [];
  if (e.pcOI != null) {
    if (e.pcOI <= 0.7) { adj += 3; notes.push(`콜 우세(풋콜 ${e.pcOI.toFixed(2)})`); }
    else if (e.pcOI >= 1.3) { adj -= 3; notes.push(`풋 우세(풋콜 ${e.pcOI.toFixed(2)})`); }
    else notes.push(`풋콜 ${e.pcOI.toFixed(2)}`);
  }
  if (e.move && e.move.pct != null) notes.push(`${e.days}일 예상폭 ±${(e.move.pct * 100).toFixed(0)}%`);
  const wall = (e.callWall || []).filter(w => p > 0 && w.strike > p && w.strike <= p * 1.03).sort((a, b) => a.strike - b.strike)[0];
  if (wall) { adj -= 1; notes.push(`바로 위 $${wall.strike} 콜 벽`); }
  if (e.maxPain != null && p > 0) notes.push(`맥스페인 $${e.maxPain}`);
  return { adj, pcOI: e.pcOI, iv: e.iv, move: e.move ? e.move.pct : null, days: e.days, txt: notes.join(" · ") };
}

export default async function handler(req, res) {
  const ticker = String((req.query && req.query.ticker) || "").trim().toUpperCase();
  if (!ticker || !/^[A-Z0-9.\-^=]{1,15}$/.test(ticker)) return res.status(400).json({ error: "ticker 파라미터가 필요합니다. 예: /api/options?ticker=AAPL" });
  try {
    const out = await optionsOf(ticker);
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: "옵션 조회 실패: " + (e.message || e) });
  }
}
