// Vercel 서버리스 함수: /api/financials?ticker=AAPL
// FMP(Financial Modeling Prep) "Stable" API로 재무데이터를 가져옵니다.
// ※ 무료 플랜에서는 limit 같은 일부 조회 옵션이 유료 전용이라 사용하지 않습니다.
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

  const base = "https://financialmodelingprep.com/stable";

  // 응답이 JSON이 아니면(안내 문구 등) 그 원문을 오류로 돌려줍니다.
  async function get(url) {
    const r = await fetch(url);
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("FMP 안내: " + text.slice(0, 200));
    }
  }

  try {
    const [profile, income, balance, cashflow] = await Promise.all([
      get(`${base}/profile?symbol=${ticker}&apikey=${key}`),
      get(`${base}/income-statement?symbol=${ticker}&apikey=${key}`),
      get(`${base}/balance-sheet-statement?symbol=${ticker}&apikey=${key}`),
      get(`${base}/cash-flow-statement?symbol=${ticker}&apikey=${key}`),
    ]);

    // FMP가 JSON 형태의 오류를 보낸 경우 그 메시지를 그대로 표시
    for (const r of [profile, income, balance, cashflow]) {
      if (r && !Array.isArray(r) && (r["Error Message"] || r.message)) {
        return res.status(502).json({ error: "FMP 응답: " + (r["Error Message"] || r.message) });
      }
    }

    // 배열의 첫 번째 항목이 가장 최근 연도입니다.
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
    });
  } catch (e) {
    res.status(500).json({ error: "FMP 조회 실패: " + e.message });
  }
}
