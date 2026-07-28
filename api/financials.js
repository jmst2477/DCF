// Vercel 서버리스 함수: /api/financials?ticker=MU
// 1순위: 야후 파이낸스(비공식) — 전 종목, 횟수 제한 없음, API 키 불필요
// 2순위: FMP (환경변수 FMP_API_KEY 가 있을 때)
// 3순위: Alpha Vantage (환경변수 ALPHAVANTAGE_API_KEY 가 있을 때)
// ※ 재무제표가 비어 있으면 실패로 간주하고 다음 데이터원으로 자동 전환합니다.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// 달러 → 백만 달러 변환
const M = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && isFinite(n) ? Math.round((n / 1e6) * 10) / 10 : 0;
};

async function getJson(url, headers) {
  const r = await fetch(url, { headers });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text.slice(0, 200));
  }
}

/* ─────────── 1순위: 야후 파이낸스 ─────────── */
async function fromYahoo(ticker) {
  // 1) 쿠키 받기
  const r1 = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA } });
  const setCookie =
    (r1.headers.getSetCookie ? r1.headers.getSetCookie().join("; ") : r1.headers.get("set-cookie")) || "";
  const cookie = setCookie.split(",").map((s) => s.split(";")[0].trim()).filter(Boolean).join("; ");
  if (!cookie) throw new Error("야후 쿠키 발급 실패");
  const H = { "User-Agent": UA, Cookie: cookie };

  // 2) crumb(인증 토큰) 받기
  const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: H });
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.length > 30 || crumb.includes("<")) throw new Error("야후 crumb 발급 실패");

  // 3) 기업 개요 (이름·현재가·베타·주식수·시가총액)
  const qs = await getJson(
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
      ticker
    )}?modules=price,summaryDetail,defaultKeyStatistics&crumb=${encodeURIComponent(crumb)}`,
    H
  );
  const qerr = qs.quoteSummary && qs.quoteSummary.error;
  if (qerr) throw new Error("야후: " + (qerr.description || qerr.code || "조회 오류"));
  const q = (qs.quoteSummary && qs.quoteSummary.result && qs.quoteSummary.result[0]) || {};
  const price = q.price || {};
  const stats = q.defaultKeyStatistics || {};
  const sdet = q.summaryDetail || {};
  const raw = (o) => (o && typeof o === "object" ? o.raw : o);

  // 4) 최근 연간 재무제표 항목 (timeseries)
  const now = Math.floor(Date.now() / 1000);
  const types = [
    "annualNetIncome",
    "annualTaxProvision",
    "annualInterestExpense",
    "annualPretaxIncome",
    "annualDepreciationAmortizationDepletion",
    "annualDepreciationAndAmortization",
    "annualCapitalExpenditure",
    "annualChangeInWorkingCapital",
    "annualCashCashEquivalentsAndShortTermInvestments",
    "annualCashAndCashEquivalents",
    "annualTotalDebt",
  ].join(",");
  const ts = await getJson(
    `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(
      ticker
    )}?symbol=${encodeURIComponent(ticker)}&type=${types}&period1=${now - 3 * 365 * 86400}&period2=${now}&crumb=${encodeURIComponent(crumb)}`,
    H
  );
  const tserr = ts.finance && ts.finance.error;
  if (tserr) throw new Error("야후 재무제표: " + (tserr.description || tserr.code));
  const results = (ts.timeseries && ts.timeseries.result) || [];
  const latest = {};
  for (const item of results) {
    const type = item.meta && item.meta.type && item.meta.type[0];
    if (!type || !Array.isArray(item[type])) continue;
    for (const entry of item[type]) {
      if (entry && entry.reportedValue && isFinite(entry.reportedValue.raw)) {
        if (!latest[type] || entry.asOfDate > latest[type].date) {
          latest[type] = { value: entry.reportedValue.raw, date: entry.asOfDate };
        }
      }
    }
  }
  const g = (t) => (latest[t] ? latest[t].value : 0);

  // ★ 재무제표가 비어 있으면 실패 처리 → FMP/Alpha Vantage로 자동 전환
  const netIncome = g("annualNetIncome");
  if (!netIncome) throw new Error("야후에서 재무제표를 받지 못함(주가만 수신)");

  const curPrice = raw(price.regularMarketPrice) || 0;
  // 주식수: 통계값이 없으면 시가총액 ÷ 주가로 계산
  let sharesMM = M(raw(stats.sharesOutstanding) || 0);
  if (!sharesMM && curPrice > 0 && raw(price.marketCap)) {
    sharesMM = M(raw(price.marketCap) / curPrice);
  }
  if (!sharesMM) throw new Error("야후에서 발행주식수를 받지 못함");

  const taxe = g("annualTaxProvision");
  const ibt = g("annualPretaxIncome");
  return {
    source: "Yahoo Finance",
    companyName: price.longName || price.shortName || ticker,
    currentPrice: curPrice,
    beta: raw(stats.beta) || raw(sdet.beta) || 1.0,
    sharesOutstandingMillions: sharesMM,
    netIncome: M(netIncome),
    taxExpense: M(taxe),
    interestExpense: M(g("annualInterestExpense")),
    depreciationAmortization: M(g("annualDepreciationAmortizationDepletion") || g("annualDepreciationAndAmortization")),
    capex: M(Math.abs(g("annualCapitalExpenditure"))),
    nwcChange: M(g("annualChangeInWorkingCapital")),
    cash: M(g("annualCashCashEquivalentsAndShortTermInvestments") || g("annualCashAndCashEquivalents")),
    totalDebt: M(g("annualTotalDebt")),
    effectiveTaxRate: ibt && taxe ? Math.round((taxe / ibt) * 1000) / 1000 : 0.21,
    period: (latest.annualNetIncome && latest.annualNetIncome.date) || "",
  };
}

/* ─────────── 2순위: FMP ─────────── */
async function fromFMP(ticker, key) {
  const base = "https://financialmodelingprep.com/stable";
  const [profile, income, balance, cashflow] = await Promise.all([
    getJson(`${base}/profile?symbol=${ticker}&apikey=${key}`),
    getJson(`${base}/income-statement?symbol=${ticker}&apikey=${key}`),
    getJson(`${base}/balance-sheet-statement?symbol=${ticker}&apikey=${key}`),
    getJson(`${base}/cash-flow-statement?symbol=${ticker}&apikey=${key}`),
  ]);
  for (const r of [profile, income, balance, cashflow]) {
    if (r && !Array.isArray(r) && (r["Error Message"] || r.message)) {
      throw new Error(r["Error Message"] || r.message);
    }
  }
  const p = (Array.isArray(profile) && profile[0]) || {};
  const i = (Array.isArray(income) && income[0]) || {};
  const b = (Array.isArray(balance) && balance[0]) || {};
  const c = (Array.isArray(cashflow) && cashflow[0]) || {};
  if (!i.netIncome) throw new Error("FMP에 재무제표 없음");
  return {
    source: "FMP",
    companyName: p.companyName || ticker,
    currentPrice: p.price || 0,
    beta: p.beta || 1.0,
    sharesOutstandingMillions: M(i.weightedAverageShsOut || i.weightedAverageShsOutDil || 0),
    netIncome: M(i.netIncome),
    taxExpense: M(i.incomeTaxExpense),
    interestExpense: M(i.interestExpense),
    depreciationAmortization: M(c.depreciationAndAmortization || i.depreciationAndAmortization),
    capex: M(Math.abs(c.capitalExpenditure || 0)),
    nwcChange: M(c.changeInWorkingCapital || 0),
    cash: M(b.cashAndShortTermInvestments || b.cashAndCashEquivalents),
    totalDebt: M(b.totalDebt),
    effectiveTaxRate:
      i.incomeBeforeTax && i.incomeTaxExpense
        ? Math.round((i.incomeTaxExpense / i.incomeBeforeTax) * 1000) / 1000
        : 0.21,
    period: i.date || "",
  };
}

/* ─────────── 3순위: Alpha Vantage ─────────── */
async function fromAlphaVantage(ticker, key) {
  const base = "https://www.alphavantage.co/query";
  const [overview, quote, income, balance, cashflow] = await Promise.all([
    getJson(`${base}?function=OVERVIEW&symbol=${ticker}&apikey=${key}`),
    getJson(`${base}?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${key}`),
    getJson(`${base}?function=INCOME_STATEMENT&symbol=${ticker}&apikey=${key}`),
    getJson(`${base}?function=BALANCE_SHEET&symbol=${ticker}&apikey=${key}`),
    getJson(`${base}?function=CASH_FLOW&symbol=${ticker}&apikey=${key}`),
  ]);
  for (const r of [overview, quote, income, balance, cashflow]) {
    const note = r && (r.Note || r.Information || r["Error Message"]);
    if (note) throw new Error("Alpha Vantage 안내: " + String(note).slice(0, 180));
  }
  const i = (income.annualReports && income.annualReports[0]) || {};
  const b = (balance.annualReports && balance.annualReports[0]) || {};
  const c = (cashflow.annualReports && cashflow.annualReports[0]) || {};
  const q = (quote && quote["Global Quote"]) || {};
  if (!i.netIncome) throw new Error("Alpha Vantage에 재무제표 없음");
  const num = (v) => {
    const n = parseFloat(v);
    return isFinite(n) ? n : 0;
  };
  const nwcChange = -num(c.changeInOperatingAssets) + num(c.changeInOperatingLiabilities);
  const ibt = num(i.incomeBeforeTax), taxe = num(i.incomeTaxExpense);
  return {
    source: "Alpha Vantage",
    companyName: overview.Name || ticker,
    currentPrice: num(q["05. price"]),
    beta: num(overview.Beta) || 1.0,
    sharesOutstandingMillions: M(num(overview.SharesOutstanding)),
    netIncome: M(num(i.netIncome)),
    taxExpense: M(taxe),
    interestExpense: M(num(i.interestExpense)),
    depreciationAmortization: M(num(c.depreciationDepletionAndAmortization) || num(i.depreciationAndAmortization)),
    capex: M(Math.abs(num(c.capitalExpenditures))),
    nwcChange: M(nwcChange),
    cash: M(num(b.cashAndShortTermInvestments) || num(b.cashAndCashEquivalentsAtCarryingValue)),
    totalDebt: M(num(b.shortLongTermDebtTotal) || num(b.longTermDebt) + num(b.currentDebt)),
    effectiveTaxRate: ibt && taxe ? Math.round((taxe / ibt) * 1000) / 1000 : 0.21,
    period: i.fiscalDateEnding || "",
  };
}

/* ─────────── 메인 ─────────── */
export default async function handler(req, res) {
  const ticker = String(req.query.ticker || "").trim().toUpperCase();
  if (!ticker) {
    return res.status(400).json({ error: "ticker 파라미터가 필요합니다. 예: /api/financials?ticker=AAPL" });
  }

  const errors = [];

  try {
    const data = await fromYahoo(ticker);
    return res.status(200).json(data);
  } catch (e) {
    errors.push("[야후] " + e.message.slice(0, 120));
  }

  if (process.env.FMP_API_KEY) {
    try {
      const data = await fromFMP(ticker, process.env.FMP_API_KEY);
      return res.status(200).json(data);
    } catch (e) {
      errors.push("[FMP] " + e.message.slice(0, 120));
    }
  }

  if (process.env.ALPHAVANTAGE_API_KEY) {
    try {
      const data = await fromAlphaVantage(ticker, process.env.ALPHAVANTAGE_API_KEY);
      return res.status(200).json(data);
    } catch (e) {
      errors.push("[Alpha Vantage] " + e.message.slice(0, 120));
    }
  }

  return res.status(502).json({
    error: "모든 데이터원 조회에 실패했습니다. " + errors.join(" / "),
  });
}
