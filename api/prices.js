// Vercel 서버리스 함수: /api/prices?ticker=AAPL
// 매수 신호 계산용 일봉(시가·고가·저가·종가·거래량) 약 2년치를 야후 파이낸스에서 가져온다. API 키 불필요.
// 가격은 트레이딩뷰 기본 차트처럼 액면분할만 반영하고 배당은 반영하지 않은 값(close)이다.

import { yahooSession } from "./dcf-inputs.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function chart(ticker, range, H, crumb) {
  const q = `range=${range}&interval=1d&includePrePost=false&events=div%2Csplit` + (crumb ? `&crumb=${encodeURIComponent(crumb)}` : "");
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

export default async function handler(req, res) {
  const ticker = String((req.query && req.query.ticker) || "").trim().toUpperCase();
  if (!ticker || !/^[A-Z0-9.\-^=]{1,15}$/.test(ticker)) {
    return res.status(400).json({ error: "ticker 파라미터가 필요합니다. 예: /api/prices?ticker=AAPL" });
  }
  const range = ["1y", "2y", "5y"].includes(req.query.range) ? req.query.range : "2y";
  try {
    let r;
    try {
      r = await chart(ticker, range, { "User-Agent": UA });
    } catch {
      const { H, crumb } = await yahooSession();
      r = await chart(ticker, range, H, crumb);
    }
    const bars = toBars(r);
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");
    return res.status(200).json({
      ticker,
      currency: (r.meta && r.meta.currency) || "USD",
      exchangeTz: (r.meta && r.meta.exchangeTimezoneName) || null,
      lastPrice: (r.meta && r.meta.regularMarketPrice) || bars.close[bars.close.length - 1],
      lastTime: r.meta && r.meta.regularMarketTime ? new Date(r.meta.regularMarketTime * 1000).toISOString() : null,
      ...bars,
    });
  } catch (e) {
    return res.status(502).json({ error: "주가 조회 실패: " + (e.message || e) });
  }
}
