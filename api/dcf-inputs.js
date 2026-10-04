// Vercel 서버리스 함수: /api/dcf-inputs?ticker=GOOGL
// 「DCF 개선판 v2」 페이지에 필요한 입력값을 야후 파이낸스에서 한 번에 가져온다. API 키 불필요.
// - 최근 4개 회계연도: 매출, 영업이익률, 감가상각비/매출, 캐펙스/매출, 실효세율
// - 주가, 발행주식수, 현금+단기투자, 차입금(리스 제외 가능 시)
// - 애널리스트 매출 컨센서스 (보통 올해·내년 2개 연도)
// 단위: 백만 달러, 주식수 백만 주.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const M = (v) => (typeof v === "number" && isFinite(v) ? Math.round((v / 1e6) * 10) / 10 : 0);
const raw = (o) => (o && typeof o === "object" ? o.raw : o);
const round = (v, d = 4) => (isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

async function getJson(url, headers) {
  const r = await fetch(url, { headers });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text.slice(0, 200));
  }
}

async function yahooSession() {
  const r1 = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA } });
  const setCookie =
    (r1.headers.getSetCookie ? r1.headers.getSetCookie().join("; ") : r1.headers.get("set-cookie")) || "";
  const cookie = setCookie.split(",").map((s) => s.split(";")[0].trim()).filter(Boolean).join("; ");
  if (!cookie) throw new Error("야후 쿠키 발급 실패");
  const H = { "User-Agent": UA, Cookie: cookie };
  const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: H });
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.length > 30 || crumb.includes("<")) throw new Error("야후 crumb 발급 실패");
  return { H, crumb };
}

const TYPES = [
  "annualTotalRevenue",
  "annualOperatingIncome",
  "annualPretaxIncome",
  "annualTaxProvision",
  "annualDepreciationAmortizationDepletion",
  "annualDepreciationAndAmortization",
  "annualCapitalExpenditure",
  "annualCashCashEquivalentsAndShortTermInvestments",
  "annualCashAndCashEquivalents",
  "annualTotalDebt",
  "annualLongTermDebt",
  "annualCurrentDebt",
  "annualDilutedAverageShares",
];

async function fromYahoo(ticker) {
  const { H, crumb } = await yahooSession();
  const T = encodeURIComponent(ticker);
  const now = Math.floor(Date.now() / 1000);

  const [qs, ts] = await Promise.all([
    getJson(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${T}?modules=price,summaryDetail,defaultKeyStatistics,financialData,earningsTrend&crumb=${encodeURIComponent(crumb)}`,
      H
    ),
    getJson(
      `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${T}?symbol=${T}&type=${TYPES.join(",")}&period1=${now - 5 * 365 * 86400}&period2=${now}&crumb=${encodeURIComponent(crumb)}`,
      H
    ),
  ]);

  const qerr = qs.quoteSummary && qs.quoteSummary.error;
  if (qerr) throw new Error("야후: " + (qerr.description || qerr.code || "조회 오류"));
  const q = (qs.quoteSummary && qs.quoteSummary.result && qs.quoteSummary.result[0]) || {};
  const price = q.price || {};
  const stats = q.defaultKeyStatistics || {};
  const sdet = q.summaryDetail || {};
  const fin = q.financialData || {};

  // 연도별 표로 정리: byDate[asOfDate][type] = 값
  const byDate = {};
  for (const item of (ts.timeseries && ts.timeseries.result) || []) {
    const type = item.meta && item.meta.type && item.meta.type[0];
    if (!type || !Array.isArray(item[type])) continue;
    for (const e of item[type]) {
      if (!e || !e.reportedValue || !isFinite(e.reportedValue.raw)) continue;
      (byDate[e.asOfDate] = byDate[e.asOfDate] || {})[type] = e.reportedValue.raw;
    }
  }
  const dates = Object.keys(byDate).filter((d) => byDate[d].annualTotalRevenue).sort();
  if (!dates.length) throw new Error("야후에서 매출 실적을 받지 못했습니다");

  const history = dates.map((d) => {
    const v = byDate[d];
    const rev = v.annualTotalRevenue;
    const da = v.annualDepreciationAmortizationDepletion || v.annualDepreciationAndAmortization || 0;
    const ptx = v.annualPretaxIncome, tax = v.annualTaxProvision;
    return {
      fy: Number(d.slice(0, 4)),
      periodEnd: d,
      revenue: M(rev),
      ebitMargin: v.annualOperatingIncome != null ? round(v.annualOperatingIncome / rev) : null,
      daPct: round(da / rev),
      capexPct: round(Math.abs(v.annualCapitalExpenditure || 0) / rev),
      taxRate: ptx > 0 && tax != null ? round(tax / ptx) : null,
    };
  });
  const lastDate = dates[dates.length - 1];
  const last = byDate[lastDate];

  // 대차대조표 항목은 가장 최근 값(연간 기준)
  const latest = (type) => {
    for (let i = dates.length - 1; i >= 0; i--) if (byDate[dates[i]][type] != null) return byDate[dates[i]][type];
    return null;
  };
  const curPrice = raw(price.regularMarketPrice) || raw(fin.currentPrice) || 0;
  // 발행주식수: sharesOutstanding은 GOOGL처럼 주식 종류가 여럿이면 한 종류만 들어 있어서
  // 전체 주식 기준(impliedSharesOutstanding, 시가총액÷주가)을 먼저 쓴다.
  const mcap = raw(price.marketCap) || raw(sdet.marketCap);
  let shares = M(raw(stats.impliedSharesOutstanding) || 0);
  if (!shares && curPrice > 0 && mcap) shares = M(mcap / curPrice);
  if (!shares) shares = M(raw(stats.sharesOutstanding) || 0);
  const diluted = M(last.annualDilutedAverageShares || 0);
  if (!shares || diluted > shares * 1.2) shares = diluted;

  // 차입금: 장기+단기 차입금(리스 제외)을 우선, 없으면 총부채성 차입금
  const ltd = latest("annualLongTermDebt"), cd = latest("annualCurrentDebt");
  let debt, debtNote;
  if (ltd != null || cd != null) { debt = M((ltd || 0) + (cd || 0)); debtNote = "장기차입금+단기차입금 (리스 제외)"; }
  else { debt = M(latest("annualTotalDebt") || raw(fin.totalDebt) || 0); debtNote = "총차입금 (리스 포함일 수 있음)"; }
  const cash = M(latest("annualCashCashEquivalentsAndShortTermInvestments") || latest("annualCashAndCashEquivalents") || raw(fin.totalCash) || 0);

  // 애널리스트 매출 컨센서스 (0y = 진행 중인 회계연도, +1y = 다음 회계연도)
  const estimates = [];
  for (const t of (q.earningsTrend && q.earningsTrend.trend) || []) {
    if (t.period !== "0y" && t.period !== "+1y") continue;
    const avg = raw(t.revenueEstimate && t.revenueEstimate.avg);
    if (!avg || !t.endDate) continue;
    estimates.push({
      fy: Number(String(t.endDate).slice(0, 4)),
      periodEnd: t.endDate,
      revenue: M(avg),
      analysts: raw(t.revenueEstimate.numberOfAnalysts) || null,
    });
  }
  // 이미 실적이 나온 연도는 제외
  const lastFy = history[history.length - 1].fy;
  const est = estimates.filter((e) => e.fy > lastFy).sort((a, b) => a.fy - b.fy);

  return {
    source: "Yahoo Finance",
    ticker: ticker,
    companyName: price.longName || price.shortName || ticker,
    currency: price.currency || "USD",
    currentPrice: curPrice,
    beta: raw(stats.beta) || raw(sdet.beta) || null,
    sharesOutstandingMillions: shares,
    cash,
    debt,
    debtNote,
    balanceDate: lastDate,
    history,
    estimates: est,
  };
}

export default async function handler(req, res) {
  const ticker = String((req.query && req.query.ticker) || "").trim().toUpperCase();
  if (!ticker || !/^[A-Z0-9.\-^=]{1,15}$/.test(ticker)) {
    return res.status(400).json({ error: "ticker 파라미터가 필요합니다. 예: /api/dcf-inputs?ticker=GOOGL" });
  }
  try {
    const data = await fromYahoo(ticker);
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ error: "데이터 조회 실패: " + (e.message || e) });
  }
}

export { fromYahoo };
