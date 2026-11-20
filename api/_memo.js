// 카카오톡 "나에게 보내기" 한 통은 200자까지라, 긴 글은 줄 단위로 나눠 여러 통으로 보낸다 (잘리지 않게).
// 한 줄이 너무 길면 그 줄만 띄어쓰기 기준으로 다시 나눈다.
export const MEMO_MAX = 200;

function wrapLine(line, max) {
  if (line.length <= max) return [line];
  const out = [];
  let cur = "";
  for (const w of line.split(" ")) {
    const next = cur ? cur + " " + w : w;
    if (next.length <= max) { cur = next; continue; }
    if (cur) out.push(cur);
    // 띄어쓰기 없이 긴 덩어리
    let rest = w;
    while (rest.length > max) { out.push(rest.slice(0, max)); rest = rest.slice(max); }
    cur = rest;
  }
  if (cur) out.push(cur);
  return out;
}

export function splitMemo(text, max = MEMO_MAX) {
  const s = String(text ?? "");
  if (s.length <= max) return [s];
  const lines = s.split("\n").flatMap(l => wrapLine(l, max));
  const out = [];
  let cur = null;
  for (const l of lines) {
    if (cur === null) cur = l;
    else if ((cur + "\n" + l).length <= max) cur += "\n" + l;
    else { out.push(cur); cur = l; }
  }
  if (cur !== null && cur !== "") out.push(cur);
  return out;
}
