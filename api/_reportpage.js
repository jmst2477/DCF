// 리서치 보고서 한 장짜리 웹페이지 (카톡에는 요약 한 통 + "보고서 열기" 버튼만 보낸다).
// 주소에 추측할 수 없는 32자 id 가 들어가고 45일 뒤 지워진다. 검색엔진에는 안 나오게 한다.
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// 카톡 요약 한 통 (200자 안)
export function reportSummary(r, { newsWarn = 0, picks = 0 } = {}) {
  const o = r.overall;
  const lines = [`📊 리서치 ${r.date || ""}`];
  if (o) lines.push(`🧭 종합평가: ${o.level} (${o.score > 0 ? "+" : ""}${o.score})`, o.action);
  if (r.spy) lines.push(`시장: ${r.spy.kind}${r.vix != null ? ` · VIX ${r.vix.toFixed(1)} ${r.vixTxt}` : ""}`);
  if (r.strong && r.strong.length) lines.push(`강한 섹터: ${r.strong.map(s => s.ko).join(", ")}`);
  const extra = [];
  if (r.recs && r.recs.length) extra.push(`추천 ${r.recs.map(x => x.t).join("·")}`);
  if (newsWarn) extra.push(`뉴스 주의 ${newsWarn}종목`);
  if (picks) extra.push(`새 후보 ${picks}개`);
  if (extra.length) lines.push(extra.join(" · "));
  lines.push("전체 내용은 아래 '보고서 열기'");
  // 200자를 넘으면 가운데 줄부터 뺀다 (첫 줄·종합평가·마지막 안내는 남김)
  while (lines.join("\n").length > 200 && lines.length > 3) lines.splice(lines.length - 2, 1);
  return lines.join("\n").slice(0, 200);
}

export function reportPage(v) {
  const secs = (v.sections || []).map(s => {
    const [head, ...rest] = String(s).split("\n");
    return `<section class="card${/^🧭/.test(head) ? " top" : ""}"><h2>${esc(head)}</h2>${rest.length ? `<p>${esc(rest.join("\n"))}</p>` : ""}</section>`;
  });
  // 종합평가를 맨 위로
  const top = secs.findIndex(s => s.includes('class="card top"'));
  if (top > 0) secs.unshift(secs.splice(top, 1)[0]);
  const at = v.at ? new Date(v.at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>리서치 ${esc(v.date || "")}</title>
<style>
:root{--bg:#f2f4f6;--card:#fff;--tx:#191f28;--mu:#6b7684;--bl:#3182f6;--ln:#e5e8eb;--hi:#e8f3ff}
@media (prefers-color-scheme:dark){:root{--bg:#101012;--card:#1c1c20;--tx:#f2f4f6;--mu:#9aa0a6;--ln:#2c2c33;--hi:#16263d}}
body{margin:0;background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;line-height:1.6}
main{max-width:640px;margin:0 auto;padding:16px}
header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0 14px}
h1{font-size:21px;margin:0}.mu{color:var(--mu);font-size:13px}
.card{background:var(--card);border-radius:16px;padding:16px 18px;margin-bottom:12px}
.card.top{background:var(--hi)}
h2{font-size:16px;margin:0 0 6px}
p{margin:0;white-space:pre-wrap;font-size:15px}
button{font-size:14px;padding:9px 14px;border:0;border-radius:10px;background:var(--bl);color:#fff;font-weight:600;cursor:pointer;flex-shrink:0}
footer{font-size:12px;color:var(--mu);margin:16px 4px 32px}
@media print{body{background:#fff;color:#000}button{display:none}.card{border:1px solid #ddd;break-inside:avoid;background:#fff}.card.top{background:#f3f8ff}main{max-width:none}}
</style>
<main>
<header><div><h1>📊 리서치 보고서</h1><div class="mu">${esc(v.date || "")} 미국 종가 기준${at ? ` · ${esc(at)} 작성` : ""}</div></div><button onclick="window.print()">PDF로 저장</button></header>
${secs.join("\n")}
<footer>규칙으로 계산한 참고값이며 투자 판단은 본인 몫입니다.${v.errors && v.errors.length ? `<br>못 받은 자료: ${esc(v.errors.slice(0, 6).join(", "))}` : ""}</footer>
</main></html>`;
}
