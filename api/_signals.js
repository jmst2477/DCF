// 카카오톡 알림용: 동기화에 저장된 관심 종목마다 "종목별로 적용한 신호"를 서버에서 계산해 마지막 봉(오늘 종가)에 새 신호가 났는지 본다.
// 사이트와 똑같은 계산을 쓰려고 브라우저용 js/ta.js · js/strategy.js · js/pine.js 를 그대로 읽어 별도 공간(vm)에서 돌린다.
// (파일 이름이 _ 로 시작해서 Vercel 이 주소(/api/...)로 열지 않는다)

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { dailyBars } from "./prices.js";

let lib = null;
function load() {
  if (lib) return lib;
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  for (const f of ["ta.js", "strategy.js", "pine.js"]) {
    vm.runInContext(fs.readFileSync(path.join(process.cwd(), "js", f), "utf8"), sandbox, { filename: f });
  }
  lib = sandbox.window;
  return lib;
}

// js/app.js 의 simulate() 와 같은 계산 (다음 봉 시가 체결, 보유 중엔 매수 안 함, 손절·익절)
export function simulate(d, strat, rule, TA) {
  rule = rule || { sl: null, tp: null };
  const out = strat.run(d, TA);
  const n = d.close.length, fee = out && out.commission != null ? out.commission : strat.commission != null ? strat.commission : 0.0005;
  if (!out || !Array.isArray(out.buy) || !Array.isArray(out.exit)) throw new Error("buy·exit 배열을 돌려주지 않았습니다.");
  const sl = rule.sl / 100, tp = rule.tp / 100;
  const marks = [];
  let pos = false, entry = null, pendBuy = false, pendExit = false;
  const close = () => { pos = false; entry = null; };
  for (let i = 0; i < n; i++) {
    if (pendBuy && !pos) { pos = true; entry = { i, price: d.open[i] }; }
    if (pendExit && pos) close();
    if (pos && sl > 0 && d.low[i] <= entry.price * (1 - sl)) {
      const px = Math.min(d.open[i], entry.price * (1 - sl));
      close(); marks.push({ i, kind: "sell", reason: "손절", price: px });
    } else if (pos && tp > 0 && d.high[i] >= entry.price * (1 + tp)) {
      const px = Math.max(d.open[i], entry.price * (1 + tp));
      close(); marks.push({ i, kind: "sell", reason: "익절", price: px });
    }
    pendBuy = !!out.buy[i]; pendExit = !!out.exit[i];
  }
  return { out, marks, pos, entry, fee };
}

// 마지막 봉에서 생긴 일: 새 매수 신호 / 청산 신호 / 손절·익절 실행
export function lastEvents(d, sim) {
  const L = d.close.length - 1, ev = [];
  sim.marks.filter(m => m.i === L && m.reason).forEach(m => ev.push({ kind: m.reason === "손절" ? "stop" : "take", price: m.price }));
  if (sim.out.buy[L] && !sim.pos) ev.push({ kind: "buy", price: d.close[L] });
  if (sim.out.exit[L] && sim.pos) ev.push({ kind: "exit", price: d.close[L] });
  return ev;
}

const arr = v => (Array.isArray(v) ? v : []);
const obj = v => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

// 동기화 데이터(브라우저 localStorage 와 같은 이름)로 쓸 수 있는 신호 목록과 종목별 신호를 정한다
export function plan(data) {
  const W = load();
  const off = arr(data["dcf-hidden-items"]).concat(arr(data["dcf-deleted-items"]));
  const strats = (W.STRATEGIES || []).filter(s => !off.includes(s.id));
  arr(data["dcf-custom-items"]).forEach(it => {
    if (!it || it.kind !== "strategy" || typeof it.code !== "string" || off.includes(it.id)) return;
    try {
      const c = W.PINE.compile(it.code, { kind: it.kind, color: it.color });
      strats.push({ id: it.id, name: it.name, commission: 0.0005, run: d => c.run(d) });
    } catch { /* 사이트에서도 못 읽는 코드면 건너뜀 */ }
  });
  const byId = id => strats.find(s => s.id === id);
  const cur = byId(data["dcf-strategy-id"]) || strats[0];
  const tstrat = obj(data["dcf-ticker-strat"]), sltp = obj(data["dcf-sltp"]);
  const perTicker = data["dcf-wl-mode"] !== "current";
  const holdings = arr(data["dcf-holdings"]);
  return arr(data["dcf-watchlist"]).filter(t => typeof t === "string" && t).map(t => {
    const s = (perTicker && byId(tstrat[t])) || cur;
    const r = s && obj(obj(sltp[t])[s.id]);
    return { t, strat: s, rule: { sl: r && r.sl > 0 ? r.sl : null, tp: r && r.tp > 0 ? r.tp : null }, held: holdings.includes(t) };
  }).filter(x => x.strat);
}

// 모든 종목 확인. getBars 는 시험용으로 바꿔 넣을 수 있다
export async function checkAll(data, getBars = dailyBars) {
  const W = load(), items = plan(data), results = [];
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const it = items[next++];
      try {
        const d = await getBars(it.t);
        if (!d || !d.close || d.close.length < 2) throw new Error("주가 없음");
        const sim = simulate(d, it.strat, it.rule, W.TA);
        results.push({ t: it.t, sid: it.strat.id, name: it.strat.name, held: it.held, date: d.time[d.time.length - 1], events: lastEvents(d, sim) });
      } catch (e) {
        results.push({ t: it.t, sid: it.strat.id, name: it.strat.name, error: String((e && e.message) || e) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, items.length) }, worker));
  const order = Object.fromEntries(items.map((x, i) => [x.t, i]));
  results.sort((a, b) => order[a.t] - order[b.t]);
  const date = results.map(r => r.date).filter(Boolean).sort().pop() || null;
  return { date, results };
}

const LABEL = { buy: "매수", exit: "청산", stop: "손절 실행", take: "익절 실행" };
const money = v => "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// 카톡 한 통은 200자까지라 여러 통으로 나눈다
export function messages(check, { force } = {}) {
  // 오늘(가장 최근 거래일) 봉이 아닌 종목은 빼고 (거래 정지 등)
  const lines = [];
  check.results.forEach(r => (r.events || []).forEach(e => {
    if (r.date !== check.date) return;
    lines.push(`${LABEL[e.kind]} ${r.t}${r.held ? "(보유)" : ""} · ${r.name} · ${money(e.price)}`);
  }));
  if (!lines.length) return force ? [`${check.date || ""} 종가 기준 새 신호가 없습니다. (${check.results.length}종목 확인)`] : [];
  const head = `📈 ${check.date} 종가 신호`, tail = "매수·청산은 다음 날 시가 기준입니다.";
  const out = [];
  let cur = head;
  lines.forEach(l => {
    if ((cur + "\n" + l).length > 190) { out.push(cur); cur = l; } else cur += "\n" + l;
  });
  if ((cur + "\n" + tail).length <= 200) cur += "\n" + tail;
  out.push(cur);
  return out.slice(0, 5);
}
