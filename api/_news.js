// 종목 뉴스 수집·분석: 야후 파이낸스 뉴스 제목(무료) → Claude 가 종목별로 읽고 매매에 쓸 의견을 JSON 으로 낸다.
// Vercel 환경 변수 ANTHROPIC_API_KEY 가 있어야 분석한다 (없으면 제목만 모음). 키는 서버에만 있고 브라우저로 안 간다. (2026-11-20 키 등록)
// 뉴스는 매수를 "막는" 데만 쓴다: 중요한 악재가 있는 종목은 에이전트가 매수 승인 요청을 만들지 않는다. 뉴스로 새 매수를 만들지는 않는다.
// fetchImpl 은 시험할 때 바꿔 넣는다.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
export const NEWS_MODEL = "claude-opus-5-5";

// 종목 하나의 최근 뉴스 제목 (days 일 안)
export async function tickerNews(t, { fetchImpl = fetch, days = 3, now = Date.now() } = {}) {
  const r = await fetchImpl(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(t)}&quotesCount=0&newsCount=10`, { headers: { "User-Agent": UA } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("야후 뉴스 " + r.status);
  return (j.news || [])
    .filter(n => n && n.title && (!n.relatedTickers || n.relatedTickers.includes(t)))
    .map(n => ({ title: String(n.title).slice(0, 200), pub: n.publisher || "", at: (n.providerPublishTime || 0) * 1000, link: n.link || "" }))
    .filter(n => n.at === 0 || now - n.at < days * 864e5)
    .slice(0, 8);
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["market", "tickers", "strategy"],
  properties: {
    market: { type: "string", description: "뉴스로 본 오늘 시장 분위기, 한국어 한두 문장(80자 이내)" },
    strategy: { type: "string", description: "뉴스를 반영한 오늘 매매 전략, 한국어 2~3문장(150자 이내)" },
    tickers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["t", "sentiment", "importance", "action", "summary"],
        properties: {
          t: { type: "string" },
          sentiment: { type: "string", enum: ["호재", "중립", "악재"] },
          importance: { type: "integer", enum: [1, 2, 3], description: "1 사소함, 2 볼 만함, 3 주가에 큰 영향(실적 쇼크, 소송, 규제, 인수합병, 가이던스 변경 등)" },
          action: { type: "string", enum: ["매수 유리", "관망", "매수 보류", "보유 점검"] },
          summary: { type: "string", description: "핵심 뉴스와 이유, 한국어 60자 이내" },
        },
      },
    },
  },
};

const SYSTEM = `당신은 미국 주식 뉴스를 읽고 개인 투자자의 자동매매 에이전트에 의견을 주는 애널리스트입니다.
각 종목의 최근 뉴스 제목만 보고 판단합니다. 본문은 없으니 제목에서 확실히 읽히는 것만 말하고, 제목이 모호하거나 홍보성·광고성이면 중립·중요도 1로 둡니다.
action 기준: 실적 악화·가이던스 하향·소송·규제·대규모 증자처럼 주가를 크게 누를 악재가 있으면 "매수 보류", 에이전트가 보유 중인 종목에 그런 악재면 "보유 점검", 분명한 호재면 "매수 유리", 나머지는 "관망".
뉴스가 없는 종목은 tickers 에 넣지 않습니다. 모든 문장은 쉬운 한국어로 씁니다.`;

// Claude 로 분석. 반환 { market, strategy, tickers[] }
export async function analyzeNews(items, ctx, { key = process.env.ANTHROPIC_API_KEY, fetchImpl = fetch } = {}) {
  if (!key) throw new Error("ANTHROPIC_API_KEY 가 없어 뉴스 분석을 건너뜁니다.");
  const lines = items.map(x => `## ${x.t}${x.held ? " (에이전트 보유 중)" : ""}${x.star ? ` (적용 신호: ${x.star})` : ""}\n` +
    x.news.map(n => `- ${new Date(n.at || Date.now()).toISOString().slice(0, 10)} ${n.pub}: ${n.title}`).join("\n")).join("\n\n");
  const user = `오늘 시장 국면: ${ctx.regime || "모름"}. 강한 섹터: ${ctx.strong || "모름"}.\n\n종목별 최근 뉴스 제목:\n\n${lines}`;
  const r = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2026-10-21",
      "anthropic-beta": "server-side-fallback-2026-07-01",
    },
    body: JSON.stringify({
      model: NEWS_MODEL,
      max_tokens: 16000,
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Claude 오류: " + ((j.error && j.error.message) || r.status));
  if (j.stop_reason === "refusal") throw new Error("Claude 가 이 요청을 거절했습니다.");
  if (j.stop_reason === "max_tokens") throw new Error("Claude 답이 길어 잘렸습니다.");
  const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const out = JSON.parse(text);
  const known = new Set(items.map(x => x.t));
  out.tickers = (out.tickers || []).filter(x => known.has(x.t));
  return out;
}

// 이 종목 매수를 뉴스 때문에 막아야 하나 (중요한 악재)
export const newsBlocks = a => !!(a && (a.action === "매수 보류" || (a.sentiment === "악재" && a.importance >= 3)));

// 카톡 문구
export function newsMessages(res) {
  if (!res) return [];
  if (res.error) return [`📰 뉴스 분석: ${res.error}`];
  const out = [];
  const pick = (res.tickers || []).filter(x => x.importance >= 2 || x.action !== "관망")
    .sort((a, b) => b.importance - a.importance);
  const icon = { 호재: "🟢", 중립: "⚪", 악재: "🔴" };
  let cur = `📰 종목 뉴스 (${res.count || 0}건 읽음)`;
  pick.forEach(x => {
    const l = `${icon[x.sentiment] || ""}${x.t} ${x.action}: ${x.summary}`;
    if ((cur + "\n" + l).length > 195) { out.push(cur); cur = l; } else cur += "\n" + l;
  });
  if (!pick.length) cur += "\n눈에 띄는 뉴스가 없습니다.";
  out.push(cur);
  if (res.strategy) out.push(`🗺 오늘 전략 (뉴스 반영)\n${res.market ? res.market + "\n" : ""}${res.strategy}`);
  return out; // 200자 넘는 건 보낼 때 나눠 보냄
}
