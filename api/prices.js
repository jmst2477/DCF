// Vercel 서버리스 함수: /api/prices?ticker=AAPL
// 매수 신호 계산용 일봉(시가·고가·저가·종가·거래량) 약 2년치를 야후 파이낸스에서 가져온다. API 키 불필요.
// 가격은 트레이딩뷰 기본 차트처럼 액면분할만 반영하고 배당은 반영하지 않은 값(close)이다.
// 다음 실적 발표일은 quoteSummary(calendarEvents)에서 받아 earnings 로 붙인다 (예정일이 안 잡혔으면 추정일, 범위면 첫날).
// 장전·장후(시간외) 가격은 일봉에 들어가지 않으므로 5분봉을 따로 받아 마지막 시간외 거래가를 ext 로 붙인다.

import { yahooSession } from "./dcf-inputs.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function chart(ticker, range, H, crumb, intraday) {
  const q = (intraday ? `range=${range}&interval=5m&includePrePost=true` : `range=${range}&interval=1d&includePrePost=false&events=div%2Csplit`) +
    (crumb ? `&crumb=${encodeURIComponent(crumb)}` : "");
  const r = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?${q}`, { headers: H });
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(text.slice(0, 200));
  }
  const err = j.chart && j.chart.error;
  if (err) throw new Error("야후: " + (err.description || err.code || "조회 오류"));
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.timestamp) throw new Error("야후: 주가 데이터 없음");
  return res;
}

export function toBars(res) {
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const off = (res.meta && res.meta.gmtoffset) || 0;
  const out = { time: [], open: [], high: [], low: [], close: [], volume: [] };
  res.timestamp.forEach((t, i) => {
    const c = q.close && q.close[i];
    if (c == null || !isFinite(c)) return; // 장 시작 전 빈 봉 등
    out.time.push(new Date((t + off) * 1000).toISOString().slice(0, 10));
    out.open.push(q.open[i] ?? c);
    out.high.push(q.high[i] ?? c);
    out.low.push(q.low[i] ?? c);
    out.close.push(c);
    out.volume.push(q.volume[i] ?? 0);
  });
  return out;
}

// 5분봉(장전·장후 포함)의 마지막 거래가. 정규장 시간(9:30~16:00, 거래소 현지 시각)이면 일봉에 이미 있으므로 null
export function extQuote(res) {
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const off = (res.meta && res.meta.gmtoffset) || 0;
  const ts = res.timestamp || [];
  for (let i = ts.length - 1; i >= 0; i--) {
    const c = q.close && q.close[i];
    if (c == null || !isFinite(c)) continue;
    const local = ts[i] + off, mins = Math.floor((((local % 86400) + 86400) % 86400) / 60);
    if (mins >= 570 && mins < 960) return null;
    return {
      session: mins < 570 ? "pre" : "post",
      price: c,
      time: new Date(ts[i] * 1000).toISOString(),
      date: new Date(local * 1000).toISOString().slice(0, 10),
    };
  }
  return null;
}

export function nextEarnings(qs) {
  const q = (qs && qs.quoteSummary && qs.quoteSummary.result && qs.quoteSummary.result[0]) || {};
  const e = (q.calendarEvents && q.calendarEvents.earnings) || {};
  const ds = (e.earningsDate || [])
    .map((x) => (x && x.raw ? new Date(x.raw * 1000).toISOString().slice(0, 10) : null))
    .filter(Boolean)
    .sort();
  if (!ds.length) return null;
  return { date: ds[0], end: ds.length > 1 ? ds[ds.length - 1] : null, estimate: !!e.isEarningsDateEstimate };
}

async function earnings(ticker) {
  const { H, crumb } = await yahooSession();
  const r = await fetch(
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=calendarEvents&crumb=${encodeURIComponent(crumb)}`,
    { headers: H }
  );
  return nextEarnings(JSON.parse(await r.text()));
}

export default async function handler(req, res) {
  const ticker = String((req.query && req.query.ticker) || "").trim().toUpperCase();
  if (!ticker || !/^[A-Z0-9.\-^=]{1,15}$/.test(ticker)) {
    return res.status(400).json({ error: "ticker 파라미터가 필요합니다. 예: /api/prices?ticker=AAPL" });
  }
  const range = ["1y", "2y", "5y"].includes(req.query.range) ? req.query.range : "2y";
  // 실적 발표일은 따로 받고, 실패해도 차트는 그린다
  const earn = earnings(ticker).catch(() => null);
  try {
    let r, H = { "User-Agent": UA }, crumb;
    try {
      r = await chart(ticker, range, H);
    } catch {
      ({ H, crumb } = await yahooSession());
      r = await chart(ticker, range, H, crumb);
    }
    const bars = toBars(r);
    let ext = null;
    try {
      ext = extQuote(await chart(ticker, "5d", H, crumb, true));
    } catch {
      /* 시간외 가격은 없어도 차트는 그린다 */
    }
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");
    return res.status(200).json({
      ticker,
      currency: (r.meta && r.meta.currency) || "USD",
      exchangeTz: (r.meta && r.meta.exchangeTimezoneName) || null,
      lastPrice: (r.meta && r.meta.regularMarketPrice) || bars.close[bars.close.length - 1],
      lastTime: r.meta && r.meta.regularMarketTime ? new Date(r.meta.regularMarketTime * 1000).toISOString() : null,
      ext,
      earnings: await earn,
      ...bars,
    });
  } catch (e) {
    return res.status(502).json({ error: "주가 조회 실패: " + (e.message || e) });
  }
}
