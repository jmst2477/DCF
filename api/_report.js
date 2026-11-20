// 에이전트 리서치 보고서 (2단계): 시장 국면 · 강한 섹터 · 금리·유동성 · 내 종목 추천과 신호 궁합
// 데이터: 야후 일봉(지수·섹터 ETF·금리·달러·VIX·내 종목), FRED 공개 CSV(연준 자산, 재무부 계좌, 역레포, 하이일드 스프레드. 키 필요 없음)
// 판단 규칙은 아래 숫자 그대로이고, 투자 조언이 아니라 규칙으로 계산한 참고값이다.
// deps: { bars(t, range), fred(id), profile(t), strategies(data), plan(data), TA, now }

export const SECTORS = [
  ["XLK", "기술", "Technology"], ["XLF", "금융", "Financial Services"], ["XLV", "헬스케어", "Healthcare"],
  ["XLE", "에너지", "Energy"], ["XLI", "산업재", "Industrials"], ["XLY", "임의소비재", "Consumer Cyclical"],
  ["XLP", "필수소비재", "Consumer Defensive"], ["XLU", "유틸리티", "Utilities"], ["XLB", "소재", "Basic Materials"],
  ["XLRE", "부동산", "Real Estate"], ["XLC", "커뮤니케이션", "Communication Services"],
];
const FEE = 0.0025; // 신한·한투 해외 온라인 한쪽 수수료 수준

const sma = (a, n, i = a.length - 1) => (i + 1 < n ? null : a.slice(i + 1 - n, i + 1).reduce((s, v) => s + v, 0) / n);
const ret = (a, n) => (a.length > n ? a[a.length - 1] / a[a.length - 1 - n] - 1 : null);
const pct = (v, d = 1) => (v == null ? "-" : (v >= 0 ? "+" : "") + (v * 100).toFixed(d) + "%");
const last = a => a[a.length - 1];

// 시장 국면: S&P500(SPY) 200일선 위·아래, 50일선과 200일선 순서, 200일선 기울기(한 달 전보다)
export function regimeOf(d) {
  const c = d.close, i = c.length - 1;
  const s50 = sma(c, 50), s200 = sma(c, 200), s200p = sma(c, 200, i - 21);
  if (s200 == null || s200p == null) return null;
  const up = s200 > s200p, above = c[i] > s200, golden = s50 > s200;
  const hi = Math.max(...c.slice(-252));
  const kind = above && golden && up ? "강세장" : !above && !golden ? "약세장" : "횡보·전환";
  return { kind, above, golden, up, dist: c[i] / s200 - 1, m1: ret(c, 21), dd: c[i] / hi - 1 };
}

// 신호만으로 매매했을 때 (다음 봉 시가 체결, 손절·익절 없음) — 신호 궁합 비교용
export function quickStats(d, strat, TA) {
  const o = strat.run(d, TA);
  if (!o || !Array.isArray(o.buy)) return null;
  let pos = null, pb = false, pe = false, eq = 1, wins = 0, n = 0;
  for (let i = 0; i < d.close.length; i++) {
    if (pb && !pos) pos = d.open[i];
    else if (pe && pos) { const r = (d.open[i] * (1 - FEE)) / (pos * (1 + FEE)); eq *= r; n++; if (r > 1) wins++; pos = null; }
    pb = !!o.buy[i]; pe = !!o.exit[i];
  }
  if (pos) { const r = (last(d.close) * (1 - FEE)) / (pos * (1 + FEE)); eq *= r; n++; if (r > 1) wins++; }
  return { ret: eq - 1, n, win: n ? wins / n : null, buyNow: !!o.buy[d.close.length - 1] };
}

async function pool(list, k, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(k, list.length) }, async () => {
    while (next < list.length) { const i = next++; try { out[i] = await fn(list[i]); } catch (e) { out[i] = { error: String((e && e.message) || e) }; } }
  }));
  return out;
}
// FRED 값: n 일(관측) 전과 비교
const fredLast = s => (s && s.length ? s[s.length - 1] : null);
const fredAgo = (s, days) => {
  if (!s || !s.length) return null;
  const cut = Date.parse(fredLast(s).date) - days * 864e5;
  for (let i = s.length - 1; i >= 0; i--) if (Date.parse(s[i].date) <= cut) return s[i];
  return null;
};

export async function makeReport(deps, { data = {}, pos = {} } = {}) {
  const { bars, fred, profile, strategies, plan, TA } = deps;
  const errors = [];
  const got = {};
  const tick = ["SPY", "QQQ", "^VIX", "^TNX", "^IRX", "DX-Y.NYB", ...SECTORS.map(s => s[0])];
  (await pool(tick, 6, t => bars(t, "2y"))).forEach((d, i) => { if (d && d.close) got[tick[i]] = d; else errors.push(`${tick[i]}: ${d && d.error}`); });

  // 1) 시장 국면
  const spy = got.SPY && regimeOf(got.SPY), qqq = got.QQQ && regimeOf(got.QQQ);
  const vix = got["^VIX"] ? last(got["^VIX"].close) : null;
  const vixTxt = vix == null ? "" : vix < 15 ? "안정" : vix < 20 ? "보통" : vix < 30 ? "불안" : "공포";
  const date = got.SPY ? last(got.SPY.time) : null;

  // 2) 섹터 상대 강도: 3개월 수익률 - S&P500 (1개월도 같이)
  const spy3 = got.SPY ? ret(got.SPY.close, 63) : 0, spy1 = got.SPY ? ret(got.SPY.close, 21) : 0;
  const sectors = SECTORS.filter(s => got[s[0]]).map(([t, ko, en]) => {
    const c = got[t].close;
    return { t, ko, en, rs3: ret(c, 63) - spy3, rs1: ret(c, 21) - spy1, above: last(c) > sma(c, 200) };
  }).sort((a, b) => b.rs3 + b.rs1 * 0.5 - (a.rs3 + a.rs1 * 0.5));
  const strong = sectors.slice(0, 3), weak = sectors.slice(-2);

  // 3) 금리·유동성
  const tnx = got["^TNX"], irx = got["^IRX"], dxy = got["DX-Y.NYB"];
  const y10 = tnx ? last(tnx.close) : null, y10m = tnx && tnx.close.length > 21 ? tnx.close[tnx.close.length - 22] : null;
  const curve = tnx && irx ? y10 - last(irx.close) : null;
  const dxy1 = dxy ? ret(dxy.close, 21) : null;
  const fr = {};
  for (const id of ["WALCL", "WTREGEN", "RRPONTSYD", "BAMLH0A0HYM2"]) {
    try { fr[id] = await fred(id); } catch (e) { errors.push(`FRED ${id}: ${e.message || e}`); }
  }
  // 순유동성 = 연준 총자산 - 재무부 일반계좌 - 역레포 (십억 달러)
  let liq = null, liq4 = null;
  if (fr.WALCL && fr.WTREGEN && fr.RRPONTSYD) {
    const at = (s, dt) => { for (let i = s.length - 1; i >= 0; i--) if (s[i].date <= dt) return s[i].v; return null; };
    const nl = dt => { const a = at(fr.WALCL, dt), b = at(fr.WTREGEN, dt), c = at(fr.RRPONTSYD, dt); return a == null || b == null || c == null ? null : a / 1000 - b - c; };
    const d0 = fredLast(fr.WALCL).date, d4 = fredAgo(fr.WALCL, 28);
    liq = nl(d0); liq4 = d4 ? nl(d4.date) : null;
  }
  const hy = fredLast(fr.BAMLH0A0HYM2), hy1 = fredAgo(fr.BAMLH0A0HYM2, 30);
  const sig = [];
  if (y10 != null && y10m != null) sig.push(y10 - y10m >= 0.25 ? -1 : y10 - y10m <= -0.25 ? 1 : 0);
  if (liq != null && liq4 != null) sig.push(liq - liq4 > 50 ? 1 : liq - liq4 < -50 ? -1 : 0);
  if (hy && hy1) sig.push(hy.v - hy1.v >= 0.3 ? -1 : hy.v - hy1.v <= -0.3 ? 1 : 0);
  if (dxy1 != null) sig.push(dxy1 >= 0.02 ? -1 : dxy1 <= -0.02 ? 1 : 0);
  const macro = sig.reduce((s, v) => s + v, 0);
  const macroTxt = !sig.length ? "자료 없음" : macro >= 2 ? "우호적" : macro <= -2 ? "부담" : "중립";
  const rates = { y10, y10chg: y10 != null && y10m != null ? y10 - y10m : null, curve, dxy1, liq, liqChg: liq != null && liq4 != null ? liq - liq4 : null, hy: hy && hy.v, hyChg: hy && hy1 ? hy.v - hy1.v : null, macroTxt };

  // 4) 내 종목: 추세·상대강도·섹터 → 추천, ★ 신호 궁합과 더 나은 신호
  const strats = strategies(data);
  const star = Object.fromEntries(plan(data).map(x => [x.t, x]));
  const wl = (Array.isArray(data["dcf-watchlist"]) ? data["dcf-watchlist"] : []).filter(t => typeof t === "string" && t).slice(0, 40);
  const rank = Object.fromEntries(sectors.map((s, i) => [s.en, i]));
  const rows = (await pool(wl, 5, async t => {
    const d = await bars(t, "5y");
    if (!d || !d.close || d.close.length < 260) return null;
    let pf = null;
    try { pf = await profile(t); } catch { /* 업종 모르면 섹터 점수 없이 */ }
    const c = d.close, s200 = sma(c, 200);
    const rs3 = ret(c, 63) - spy3;
    const sec = pf && pf.profile && pf.profile.sector;
    const secRank = sec != null && rank[sec] != null ? rank[sec] : null;
    // 추천 점수: 200일선 위 + 3개월 상대강도 + 강한 섹터 가산
    const score = (last(c) > s200 ? 1 : -1) * 10 + rs3 * 100 + (secRank != null && secRank < 3 ? 8 : secRank != null && secRank >= sectors.length - 2 ? -5 : 0);
    const recent = { time: d.time.slice(-504), open: d.open.slice(-504), high: d.high.slice(-504), low: d.low.slice(-504), close: c.slice(-504), volume: d.volume.slice(-504) };
    const fits = strats.map(s => { try { const q = quickStats(recent, s, TA); return q && q.n >= 3 ? { id: s.id, name: s.short || s.name, ...q } : null; } catch { return null; } }).filter(Boolean)
      .sort((a, b) => b.ret - a.ret);
    const st = star[t];
    const cur = st ? fits.find(f => f.id === st.strat.id) : null;
    const best = fits[0] || null;
    const ed = pf && pf.earnings && pf.earnings.date;
    return { t, sec, secKo: (SECTORS.find(s => s[2] === sec) || [])[1] || null, above: last(c) > s200, rs3, score, star: st ? st.strat.name : null,
      cur, best, better: !!(best && cur && best.id !== cur.id && best.ret - cur.ret > 0.15), held: !!pos[t], earnings: ed || null };
  })).filter(r => r && !r.error);
  const recs = rows.filter(r => r.above && r.rs3 > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  const now = deps.now ? deps.now() : new Date();
  const soon = rows.filter(r => r.earnings && r.star && Date.parse(r.earnings) - now.getTime() < 8 * 864e5 && Date.parse(r.earnings) >= now.getTime() - 864e5);

  const out = { date, spy, qqq, vix, vixTxt, sectors, strong, weak, rates, rows, recs, better: rows.filter(r => r.better), soon, errors };
  out.overall = overallOf(out);
  return out;
}

// 종합평가: 시장 국면 ±2, 나스닥 ±1, VIX +1~-2, 금리·유동성 ±1, 200일선 위 섹터 수 ±1 → 합계로 4단계
export function overallOf(r) {
  const why = [];
  let s = 0;
  const reg = { 강세장: 2, "횡보·전환": 0, 약세장: -2 };
  if (r.spy) { s += reg[r.spy.kind]; why.push(`S&P ${r.spy.kind}`); }
  if (r.qqq) { s += reg[r.qqq.kind] / 2; }
  if (r.vix != null) { const v = r.vix < 15 ? 1 : r.vix < 20 ? 0 : r.vix < 30 ? -1 : -2; s += v; if (v) why.push(`VIX ${r.vixTxt}`); }
  const m = { 우호적: 1, 중립: 0, 부담: -1 }[r.rates.macroTxt] || 0;
  s += m; if (m) why.push(`금리·유동성 ${r.rates.macroTxt}`);
  const up = r.sectors.filter(x => x.above).length;
  if (r.sectors.length) { const b = up >= 8 ? 1 : up <= 3 ? -1 : 0; s += b; why.push(`섹터 ${up}/${r.sectors.length}개 상승 추세`); }
  const [level, action] = s >= 3 ? ["공격", "매수 신호는 대부분 승인해도 좋은 환경"]
    : s >= 0 ? ["보통", "강한 섹터·추천 종목 신호 위주로 골라서 승인"]
    : s >= -2 ? ["조심", "승인을 줄이고 손절을 지키기"]
    : ["방어", "새 매수는 쉬는 것을 권함 (청산은 계속)"];
  return { score: s, level, action, why };
}

// 카톡 메시지 (한 통 200자)
export function reportMessages(r) {
  const out = [];
  const m1 = [`📊 에이전트 리서치 ${r.date || ""}`];
  if (r.spy) m1.push(`시장: ${r.spy.kind} (S&P500 200일선 ${pct(r.spy.dist)}, 한 달 ${pct(r.spy.m1)})`);
  if (r.qqq) m1.push(`나스닥100: ${r.qqq.kind} (${r.qqq.dd > -0.005 ? "1년 고점 근처" : `1년 고점 대비 ${pct(r.qqq.dd)}`})`);
  if (r.vix != null) m1.push(`VIX ${r.vix.toFixed(1)} ${r.vixTxt}`);
  out.push(m1.join("\n"));
  if (r.sectors.length) out.push(`🔥 강한 섹터 (3개월, S&P 대비)\n${r.strong.map(s => `${s.ko} ${pct(s.rs3)}`).join(" · ")}\n🧊 약한 섹터\n${r.weak.map(s => `${s.ko} ${pct(s.rs3)}`).join(" · ")}`);
  const R = r.rates, m3 = [`💧 금리·유동성: ${R.macroTxt}`];
  if (R.y10 != null) m3.push(`미 10년 ${R.y10.toFixed(2)}% (한 달 ${R.y10chg >= 0 ? "+" : ""}${(R.y10chg || 0).toFixed(2)}%p)${R.curve != null ? ` · 장단기 차 ${R.curve.toFixed(2)}%p` : ""}`);
  if (R.liq != null) m3.push(`연준 순유동성 $${(R.liq / 1000).toFixed(2)}조${R.liqChg != null ? ` (4주 ${R.liqChg >= 0 ? "+" : ""}${Math.round(R.liqChg * 10).toLocaleString("ko-KR")}억 달러)` : ""}`);
  if (R.hy != null) m3.push(`하이일드 스프레드 ${R.hy.toFixed(2)}%${R.hyChg != null ? ` (한 달 ${R.hyChg >= 0 ? "+" : ""}${R.hyChg.toFixed(2)})` : ""}`);
  if (R.dxy1 != null) m3.push(`달러지수 한 달 ${pct(R.dxy1)}`);
  out.push(m3.join("\n"));
  if (r.recs.length) out.push(`⭐ 내 종목 중 추천 (추세·상대강도·섹터)\n${r.recs.map(x => `${x.t}${x.secKo ? `(${x.secKo})` : ""} 3개월 ${pct(x.rs3, 0)} · 잘 맞는 신호 ${x.best ? `${x.best.name} ${pct(x.best.ret, 0)}` : "-"}${x.star ? "" : " · ★없음"}`).join("\n")}`);
  else if (r.rows.length) out.push("⭐ 내 종목 중 지금 추세·상대강도 조건을 모두 넘는 종목이 없습니다.");
  const m5 = [];
  r.better.slice(0, 3).forEach(x => m5.push(`${x.t}: 지금 ★ ${x.cur.name} ${pct(x.cur.ret, 0)} → ${x.best.name} ${pct(x.best.ret, 0)} 이 2년간 더 좋았음`));
  r.soon.slice(0, 3).forEach(x => m5.push(`⚠ ${x.t} 실적 발표 ${x.earnings.slice(5).replace("-", "/")} — 매수 승인 전에 확인`));
  if (m5.length) out.push(`🔁 신호 점검\n${m5.join("\n")}`);
  const o = r.overall;
  if (o) out.push(`🧭 종합평가: ${o.level} (점수 ${o.score > 0 ? "+" : ""}${o.score})\n${o.action}\n근거: ${o.why.join(" · ") || "-"}\n※ 규칙으로 계산한 참고값이며 투자 판단은 본인 몫입니다.`);
  return out; // 200자 넘는 건 보낼 때 나눠 보냄 (sendMemo)
}

// 새 후보 종목 찾기 (주 1회): 한투 조건검색(시가총액 100억 달러 이상·주가 10달러 이상) → 관심 목록 밖 큰 종목 중
// 200일선·50일선 위, 3개월 상대강도 플러스, 1년 고점 10% 안쪽인 종목을 점수순 5개. 매수는 하지 않고 보고서에만 올린다.
// deps: { screen() → [{t, excd, name, capK}], bars(t, range), strategies list, TA }
export async function discoverCandidates(deps, { exclude = [], strats = [], TA, max = 60 } = {}) {
  const { screen, bars } = deps;
  const skip = new Set(exclude.map(t => String(t).toUpperCase()));
  const seen = new Set();
  const list = (await screen()).filter(x => x && x.t && /^[A-Z]{1,5}$/.test(x.t) && !skip.has(x.t) && x.tradable !== false && !seen.has(x.t) && seen.add(x.t))
    .sort((a, b) => (b.capK || 0) - (a.capK || 0)).slice(0, max);
  const spy = await bars("SPY", "2y");
  const spy3 = ret(spy.close, 63), spy1 = ret(spy.close, 21);
  const rows = (await pool(list, 8, async x => {
    const d = await bars(x.t, "2y");
    if (!d || !d.close || d.close.length < 260) return null;
    const c = d.close, p = last(c), s200 = sma(c, 200), s50 = sma(c, 50);
    const hi = Math.max(...c.slice(-252)), dist = p / hi - 1;
    const rs3 = ret(c, 63) - spy3, rs1 = ret(c, 21) - spy1;
    if (!(p > s200 && p > s50 && rs3 > 0 && dist >= -0.1)) return null;
    const fits = strats.map(s => { try { const q = quickStats(d, s, TA); return q && q.n >= 3 ? { id: s.id, name: s.short || s.name, ...q } : null; } catch { return null; } })
      .filter(Boolean).sort((a, b) => b.ret - a.ret);
    const best = fits[0] || null;
    const score = rs3 * 100 + rs1 * 50 + (dist > -0.03 ? 5 : 0) + (best && best.win >= 0.6 ? 5 : 0);
    return { t: x.t, name: x.name, capB: x.capK ? Math.round(x.capK / 1e6) : null, rs3, rs1, dist, best, score };
  })).filter(r => r && !r.error);
  return { at: new Date().toISOString(), scanned: list.length, picks: rows.sort((a, b) => b.score - a.score).slice(0, 5) };
}
// 카톡 한 통 200자라 종목이 많으면 여러 통으로 나눈다 (잘리지 않게). 반환: 메시지 배열
export function discoverMessage(dsc) {
  if (!dsc || !dsc.picks) return [];
  if (!dsc.picks.length) return [`🔎 이번 주 새 후보: ${dsc.scanned}종목을 봤지만 조건(추세·상대강도·고점 근처)을 다 넘는 종목이 없습니다.`];
  const lines = dsc.picks.map(x => {
    const l = `${x.t}${x.name ? ` ${String(x.name).slice(0, 14)}` : ""}\n  3개월 S&P대비 ${pct(x.rs3, 0)} · 1년 고점 ${x.dist > -0.005 ? "근처" : pct(x.dist, 0)}${x.best ? `\n  잘 맞는 신호: ${x.best.name} ${pct(x.best.ret, 0)}` : ""}`;
    return l;
  });
  const out = [];
  let cur = `🔎 이번 주 새로 볼 종목 (관심 목록 밖, 시총 100억$↑, 상승 추세)`;
  lines.forEach(l => { if ((cur + "\n" + l).length > 195) { out.push(cur); cur = l; } else cur += "\n" + l; });
  out.push(cur);
  return out;
}
