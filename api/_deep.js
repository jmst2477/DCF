// 🔬 종목 심층 분석 보고서: Claude 가 웹을 직접 찾아(공시·IR·어닝콜·뉴스) 기관 리서치 수준의 보고서를 쓴다.
// 오래 걸리고(수 분~수십 분) 길어서 Message Batches API 로 맡긴다 (반값, Vercel 시간 제한 없음).
// 서버가 웹을 찾다가 한 번에 다 못 끝내면(pause_turn) 이어서 다시 맡긴다 (최대 MAX_ROUNDS 번).
// 키(ANTHROPIC_API_KEY)는 서버에만 있다. fetchImpl 은 시험할 때 바꿔 넣는다.

export const DEEP_MODEL = "claude-opus-5-5";
export const MAX_ROUNDS = 6;
const API = "https://api.anthropic.com/v1";
const VERSION = "2026-10-21";

const headers = key => ({ "content-type": "application/json", "x-api-key": key, "anthropic-version": VERSION });

// 사용자가 받아 온 '월스트리트 선임 애널리스트' 프롬프트를 거의 그대로 쓰고, 형식·출처 규칙만 덧붙였다.
export const SYSTEM = `당신은 월스트리트 선임 애널리스트입니다. 기관투자자에게 제출하는 수준의 종합 기업분석 보고서를 한국어로 씁니다.
단순 회사 소개나 뉴스 요약이 아니라 '현재 주가에서 왜 사거나 피해야 하는지'를 판단할 수 있는 리서치 보고서여야 합니다.

[자료]
- 최신 자료를 웹 검색·웹 페이지 읽기로 직접 찾고, 보고서 맨 위에 기준일(주가·재무 자료의 날짜)을 적습니다.
- 미국 기업은 SEC 10-K·10-Q·8-K, 기업 IR, 최근 실적발표와 어닝콜 transcript 를 최우선으로 봅니다. 한국 기업은 DART 사업·분기·반기보고서, 주요사항보고서, 기업 IR 자료와 최근 증권사 리포트를 우선 봅니다.
- 로그인·유료 구독이 필요한 페이지는 쓰지 않습니다. 못 찾은 숫자는 지어내지 말고 '확인 못 함'이라고 적습니다.
- 문장마다 성격을 구분합니다: [공시] 공시로 확인된 사실, [회사] 회사의 주장, [컨센서스] 시장 컨센서스·증권사 추정치, [추론] 당신의 추론. 숫자 옆에는 출처와 날짜를 짧게 붙이고, 맨 끝에 출처 목록(제목·날짜·주소)을 둡니다.
- GAAP 과 Non-GAAP 숫자는 반드시 구분합니다.

[내용 순서]
1. 한눈에 보기: 결론(신규매수·조정매수·관망), 적정가치와 Base/Bull/Bear 목표가, 핵심 근거 3줄.
2. 사업모델과 제품: 무엇을 팔아 돈을 버는지 초보자도 알게. 매출이 P(가격)×Q(판매량) 중 무엇에 의해 움직이는지, 고객이 누구인지, 제품·지역·고객 집중도.
3. 산업 구조: TAM, 성장률, 밸류체인과 회사의 위치, 지금 산업의 실제 병목과 이익이 쌓이는 구간. 어려운 기술은 비유와 사례로 쉽게, 그러나 얕지 않게.
4. 경쟁우위(경제적 해자): 기술력, 특허, 고객 인증, 전환비용, 네트워크 효과, 규모의 경제, 원가우위, 수직계열화, 공급망 통제력을 주요 경쟁사와 직접 비교해 표로. 해자 점수 10점 만점. 그 차이가 매출총이익률과 점유율에 어떻게 이어지는지.
5. 재무(최근 5년 + 최근 6~8개 분기): 매출 성장률, 매출총이익률, 영업이익률, 순이익, EPS, EBITDA, 영업현금흐름, FCF, CapEx, 현금, 순부채, 이자비용, 재고, 매출채권, 운전자본, 주식보상, 주식수와 희석. 숫자 나열이 아니라 숫자 사이의 관계를 해석 ('매출은 늘었는데 현금흐름이 왜 나빠졌는지', '재고 증가가 증설 준비인지 수요 둔화인지').
6. 최근 분기 실적과 어닝콜 심층: 매출·EPS·마진의 컨센서스 대비 비트/미스, 사업부별 성장률, 이 회사의 핵심 KPI(주문·백로그·ASP·출하량·가동률 등) 변화, 이전 분기 대비 경영진 표현의 강약, 가이던스 상향·유지·하향, 애널리스트 Q&A 에서 반복된 불안요인, 발표 직후 주가 반응과 시장이 무엇에 반응했는지.
7. 밸류에이션: 과거 밴드와 Peer 대비 P/E, EV/EBITDA, EV/Sales, P/S, P/B 중 이 기업에 맞는 지표를 골라 표로. 프리미엄·디스카운트 이유. DCF 또는 정상화 EPS×적정 멀티플로 적정가치를 계산하고 가정(성장률, 마진, WACC, Terminal Growth, 멀티플)과 이유를 공개. reverse DCF 로 현재 주가가 반영한 내재 성장률 계산.
8. 촉매와 장기 성장: 향후 12~24개월 촉매를 시간순 표로. 5~10년 TAM 확대, 신제품, 신규 고객, 기술 전환, 해외진출.
9. 시나리오: Base/Bull/Bear 각각 매출·EPS, 적용 멀티플, 예상 주가, 대략의 확률과 시간 프레임을 표로. 무엇이 일어나야 Bull 이 되고 어떤 숫자가 나오면 Bear 로 내려가야 하는지.
10. 리스크: 투자논리를 깨뜨릴 가능성이 큰 순서로 (고객 집중, 경쟁사 추격, 가격하락, 규제, 공급망, 재고, 부채, 증설 실패, 수율, 고객 인증 지연 등 이 회사에 맞는 것). 각 위험의 선행지표와 투자논리 무효화 조건.
11. 경영진·지배구조·인센티브: 최근 3~5년 CEO/CFO 교체 이력과 배경, 스톡옵션·RSU·LTI 구조와 주주 정렬, 대주주·창업자 지분, 특수관계인 거래, 이사회 독립성, 주총 논란 안건. 경영진이 반복하는 키워드와 실제 숫자(가이던스 달성률, 자본배분)의 일치 여부.
12. 자본배분 품질: 최근 5년 FCF 사용처(자사주, 배당, M&A, 성장 CapEx, 부채 상환) 비율, 자사주 매입 시점(고점/저점)과 희석 상쇄 여부, ROIC 추이와 WACC 대비 스프레드, 신규 투자의 예상 회수기간.
13. 고객·공급망·재고: Top 1/3/5 고객 집중도와 그 고객들의 최근 실적·가이던스, 재고일수·매출채권일수·매입채무일수 추이 해석, 핵심 부품·원재료 공급처 집중도와 가격 전가력.
14. 회계 품질: 매출인식, 계약자산/부채, 이연수익, 충당금, 손상차손, 일회성 항목(최근 3년), GAAP vs Non-GAAP 조정 추이와 과도한 낙관 여부, 영업현금흐름과 순이익 괴리, Accruals 비율, 이익의 질 점수.
15. 기관투자자 관점: 살 이유와 피할 이유, 포트폴리오에서의 성격(성장주·턴어라운드·퀄리티·사이클·고베타).
16. 차트: 장기·중기·단기 추세, 20·50·200일 이동평균, 거래량, 52주 고점·저점 대비 위치, 매물대와 지지·저항, 펀더멘털 이벤트와 연결. 어느 가격·추세가 깨지면 시나리오를 재검토해야 하는지, 실적 개선이 이미 얼마나 선반영됐는지.
17. 낙관론 vs 비관론 토론: 같은 데이터로 각각 가장 강한 논거, 지금 어느 쪽이 더 강한지 균형 잡힌 판단.
18. 최종 결론: ① 투자포인트 3~5개 ② 가장 중요한 리스크 3개 ③ 앞으로 확인할 KPI 5개 ④ 적정가치와 Base/Bull/Bear ⑤ 신규매수·조정매수·관망 중 무엇이 맞는지와 이유. 좋은 이야기만 모으지 말고 현재 가격에서 기대수익률 대비 리스크가 실제로 매력적인지 판단.
19. 출처 목록.

[형식]
- 마크다운만 씁니다: '## 1. 제목' 같은 큰 제목, '###' 작은 제목, 표는 | 로 된 마크다운 표, 목록은 '- '. HTML 은 쓰지 않습니다.
- 정보 → 해석 → 투자적 함의 순서로 자연스럽게 잇고, 어려운 산업과 기술은 중학생도 알 만큼 쉽게 풉니다.
- 보고서 본문만 출력합니다 (앞뒤 인사말, 작업 과정 설명 없이).
- 이 보고서는 개인 투자자가 참고용으로 읽습니다. 맨 끝에 '투자 판단과 책임은 본인에게 있습니다'를 한 줄 넣습니다.`;

// 무료로 쓰기: 내 Claude 구독(claude.ai) 채팅창에 붙여 넣을 한 덩어리 글
export function deepPromptText(t, today) {
  return `${SYSTEM}\n\n---\n종목: ${t}\n오늘 날짜: ${today}\n\n위 순서와 형식대로 이 종목의 종합 기업분석 보고서를 써 주세요. 웹 검색으로 최신 자료를 찾아 주세요. 길면 잘릴 수 있으니 결과는 PDF 나 Word(docx) 파일로 주세요.`;
}

export function deepParams(t, { today, name } = {}) {
  return {
    model: DEEP_MODEL,
    max_tokens: 64000,
    output_config: { effort: "high" },
    system: SYSTEM,
    tools: [
      { type: "web_search_20260209", name: "web_search", max_uses: 30 },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 20 },
    ],
    messages: [{ role: "user", content: `종목: ${t}${name ? ` (${name})` : ""}\n오늘 날짜: ${today}\n\n위 순서와 형식대로 이 종목의 종합 기업분석 보고서를 써 주세요.` }],
  };
}

// 배치 하나에 요청 하나를 맡긴다. 반환 batch id
export async function startBatch(params, { key = process.env.ANTHROPIC_API_KEY, fetchImpl = fetch } = {}) {
  if (!key) throw new Error("ANTHROPIC_API_KEY 가 서버에 없습니다.");
  const r = await fetchImpl(`${API}/messages/batches`, { method: "POST", headers: headers(key), body: JSON.stringify({ requests: [{ custom_id: "deep", params }] }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Claude 오류: " + ((j.error && j.error.message) || r.status));
  return j.id;
}

// 배치 상태. 끝났으면 { done: true, message } 또는 { done: true, error }
export async function batchResult(id, { key = process.env.ANTHROPIC_API_KEY, fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`${API}/messages/batches/${encodeURIComponent(id)}`, { headers: headers(key) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Claude 오류: " + ((j.error && j.error.message) || r.status));
  if (j.processing_status !== "ended") return { done: false, status: j.processing_status };
  if (!j.results_url) return { done: true, error: "결과 주소가 없습니다." };
  const rr = await fetchImpl(j.results_url, { headers: headers(key) });
  if (!rr.ok) throw new Error("결과를 못 받았습니다: " + rr.status);
  const line = (await rr.text()).split("\n").map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l)).find(x => x.custom_id === "deep");
  if (!line) return { done: true, error: "결과가 비어 있습니다." };
  const res = line.result || {};
  if (res.type === "succeeded") return { done: true, message: res.message };
  if (res.type === "expired") return { done: true, error: "24시간 안에 처리되지 않아 만료됐습니다. 다시 요청해 주세요." };
  if (res.type === "canceled") return { done: true, error: "취소됐습니다." };
  return { done: true, error: "Claude 오류: " + ((res.error && (res.error.error && res.error.error.message || res.error.type)) || res.type) };
}

// 끝난 메시지 → 다음 할 일. { text } 완성, { cont: messages } 이어서, { error }
export function nextStep(params, message) {
  const text = (message.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  if (message.stop_reason === "pause_turn") return { cont: [...params.messages, { role: "assistant", content: message.content }] };
  if (message.stop_reason === "refusal") return { error: "Claude 가 이 요청을 거절했습니다." };
  if (!text.trim()) return { error: "보고서 내용이 비어 있습니다." };
  return { text, cut: message.stop_reason === "max_tokens" };
}

// ---------- 마크다운 → HTML (보고서에 쓰는 만큼만) ----------
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function inline(s) {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  h = h.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  return h;
}
export function mdToHtml(md) {
  const L = String(md || "").replace(/\r/g, "").split("\n"), out = [];
  let i = 0;
  const cells = l => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
  while (i < L.length) {
    const l = L[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) { const n = Math.min(4, m[1].length + 1); out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
    if (/^\s*\|/.test(l) && i + 1 < L.length && /^\s*\|?\s*:?-{2,}/.test(L[i + 1])) {
      const head = cells(l); i += 2; const rows = [];
      while (i < L.length && /^\s*\|/.test(L[i])) rows.push(cells(L[i++]));
      out.push(`<div class="tw"><table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(l)) { const b = []; while (i < L.length && /^\s*>/.test(L[i])) b.push(L[i++].replace(/^\s*>\s?/, "")); out.push(`<blockquote>${b.map(inline).join("<br>")}</blockquote>`); continue; }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) {
      const ol = /^\s*\d+[.)]\s+/.test(l), items = [];
      while (i < L.length && /^\s*([-*•]|\d+[.)])\s+/.test(L[i])) items.push(L[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
      out.push(`<${ol ? "ol" : "ul"}>${items.map(x => `<li>${inline(x)}</li>`).join("")}</${ol ? "ol" : "ul"}>`);
      continue;
    }
    const p = [];
    while (i < L.length && L[i].trim() && !/^(#{1,4})\s|^\s*\||^\s*>|^\s*([-*•]|\d+[.)])\s+/.test(L[i])) p.push(L[i++]);
    if (!p.length) { out.push(`<p>${inline(L[i++])}</p>`); continue; }
    out.push(`<p>${p.map(inline).join("<br>")}</p>`);
  }
  return out.join("\n");
}

const CSS = `:root{--bg:#f2f4f6;--card:#fff;--tx:#191f28;--mu:#6b7684;--bl:#3182f6;--ln:#e5e8eb}
@media (prefers-color-scheme:dark){:root{--bg:#101012;--card:#1c1c20;--tx:#f2f4f6;--mu:#9aa0a6;--ln:#2c2c33}}
body{margin:0;background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;line-height:1.7}
main{max-width:860px;margin:0 auto;padding:16px}
header{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin:8px 0 14px}
h1{font-size:22px;margin:0}.mu{color:var(--mu);font-size:13px}
article{background:var(--card);border-radius:16px;padding:8px 22px 20px}
h2{font-size:19px;margin:28px 0 8px;padding-top:12px;border-top:1px solid var(--ln)}h3{font-size:16px;margin:18px 0 6px}h4{font-size:15px;margin:14px 0 4px}
p{margin:8px 0}ul,ol{padding-left:22px}li{margin:3px 0}
blockquote{margin:10px 0;padding:8px 14px;border-left:4px solid var(--bl);background:color-mix(in srgb,var(--bl) 8%,var(--card));border-radius:6px}
.tw{overflow-x:auto;margin:10px 0}table{border-collapse:collapse;font-size:13.5px;min-width:100%}th,td{border:1px solid var(--ln);padding:6px 8px;text-align:left;vertical-align:top}th{background:color-mix(in srgb,var(--mu) 12%,var(--card))}
code{font-size:13px}a{color:var(--bl);word-break:break-all}
.btns{display:flex;gap:6px}.btn{font-size:14px;padding:9px 14px;border:0;border-radius:10px;background:var(--bl);color:#fff;font-weight:600;cursor:pointer;text-decoration:none}
.btn.g{background:var(--ln);color:var(--tx)}
footer{font-size:12px;color:var(--mu);margin:16px 4px 32px}
@media print{body{background:#fff;color:#000}.btns{display:none}article{padding:0}main{max-width:none}h2{break-after:avoid}tr,blockquote{break-inside:avoid}}`;

const shell = (title, body, extraHead = "") => `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">${extraHead}<title>${esc(title)}</title><style>${CSS}</style><main>${body}</main></html>`;

const kst = at => new Date(at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });

// 보고서 페이지 (끝났을 때)
export function deepPage(v, { docHref } = {}) {
  return shell(`${v.t} 기업 분석`, `<header><div><h1>🔬 ${esc(v.t)} 종합 기업분석</h1><div class="mu">${esc(kst(v.doneAt || v.at))} 작성 · Claude (웹 자료 직접 검색)</div></div>
<div class="btns"><button class="btn" onclick="window.print()">PDF로 저장</button>${docHref ? `<a class="btn g" href="${esc(docHref)}">Word로 받기</a>` : ""}</div></header>
<article>${mdToHtml(v.text)}</article>
<footer>${v.cut ? "보고서가 너무 길어 끝부분이 잘렸을 수 있습니다. " : ""}AI 가 공개 자료를 찾아 쓴 참고용 보고서입니다. 숫자는 원문 공시로 다시 확인하세요. 투자 판단과 책임은 본인에게 있습니다.</footer>`);
}
// Word(.doc) 로 받기: Word 가 여는 HTML 문서
export function deepDoc(v) {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${esc(v.t)} 기업 분석</title>
<style>body{font-family:"Malgun Gothic",sans-serif;font-size:10.5pt;line-height:1.6}table{border-collapse:collapse}th,td{border:1px solid #999;padding:4px 6px;font-size:9.5pt}th{background:#eee}h2{font-size:15pt}h3{font-size:12.5pt}blockquote{border-left:3pt solid #3182f6;padding-left:8pt}</style></head>
<body><h1>${esc(v.t)} 종합 기업분석</h1><p>${esc(kst(v.doneAt || v.at))} 작성 · Claude (웹 자료 직접 검색)</p>${mdToHtml(v.text)}</body></html>`;
}
// 아직 쓰는 중 / 실패 페이지
export function deepWaitPage(v) {
  const failed = v.status === "error";
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(v.at)) / 60000));
  return shell(`${v.t} 기업 분석`, `<header><div><h1>🔬 ${esc(v.t)} 종합 기업분석</h1><div class="mu">${esc(kst(v.at))} 요청</div></div></header>
<article><p>${failed ? `보고서를 만들지 못했습니다: ${esc(v.error || "")}<br>사이트에서 다시 요청해 주세요.` :
    `Claude 가 공시·IR·어닝콜·뉴스를 찾아 보고서를 쓰고 있습니다 (${mins}분째, ${v.round || 1}번째 단계).<br>보통 10~40분, 길면 몇 시간 걸립니다. 이 페이지를 열어 두면 1분마다 스스로 확인하고, 다 되면 카톡으로도 알려 드립니다(카톡 알림을 켠 경우). 창을 닫아도 계속 만들어집니다.`}</p></article>`,
    failed ? "" : '<meta http-equiv="refresh" content="60">');
}
