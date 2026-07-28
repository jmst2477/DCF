// Vercel 서버리스 함수: /api/financials?ticker=AAPL
// FMP(Financial Modeling Prep) 무료 API로 재무데이터를 가져옵니다.
// API 키는 Vercel 환경변수 FMP_API_KEY 에 저장됩니다 (코드에 노출 안 됨).

export default async function handler(req, res) {
  const ticker = String(req.query.ticker || "").trim().toUpperCase();
  if (!ticker) {
    return res.status(400).json({ error: "ticker 파라미터가 필요합니다. 예: /api/financials?ticker=AAPL" });
  }
  const key = process.env.FMP_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "Vercel 환경변수 FMP_API_KEY 가 설정되지 않았습니다." });
  }

  const base = "https://financialmodelingprep.com/api/v3";
  const get = (url) => fetch(url).then((r) => r.json());

  try {
    const [profile, income, balance, cashflow] = await Promise.all([
      get(`${base}/profile/${ticker}?apikey=${key}`),
      get(`${base}/income-statement/${ticker}?limit=1&apikey=${key}`),
      get(`${base}/balance-sheet-statement/${ticker}?limit=1&apikey=${key}`),
      get(`${base}/cash-flow-statement/${ticker}?limit=1&apikey=${key}`),
    ]);

    const p = (Array.isArray(profile) && profile[0]) || {};
    const i = (Array.isArray(income) && income[0]) || {};
    const b = (Array.isArray(balance) && balance[0]) || {};
    const c = (Array.isArray(cashflow) && cashflow[0]) || {};

    if (!i.netIncome && !p.companyName) {
      return res.status(404).json({
        error: `'${ticker}' 데이터를 찾지 못했습니다. 미국 상장 티커인지 확인해 주세요. (FMP 무료 플랜은 미국 주식 위주)`,
      });
    }

    // 달러 → 백만 달러 변환
    const M = (v) => (typeof v === "number" ? Math.round((v / 1e6) * 10) / 10 : 0);

    res.status(200).json({
      companyName: p.companyName || ticker,
      currentPrice: p.price || 0,
      beta: p.beta || 1.0,
      sharesOutstandingMillions: M(i.weightedAverageShsOut || 0),
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
    });
  } catch (e) {
    res.status(500).json({ error: "FMP 조회 실패: " + e.message });
  }
}
