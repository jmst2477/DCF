// 주식 에이전트 1단계: ★(종목별 적용 신호)가 있는 관심 종목에 매수 신호가 나면 승인을 받아 한투에 예약 매수,
// 에이전트가 산 주식은 손절·익절·청산 신호대로 알아서 예약 매도한다.
// 하루 흐름 (미국 장 기준, 한국 시간)
//   07시대  close 단계 (Vercel Cron): 어제 체결 반영 → 신호 계산 → 매수 승인 요청 만들기 + 청산 계획 → 카톡
//   11시대  open 단계 (Vercel Cron): 청산 예약 매도 + 이미 승인된 매수 예약 주문 → 밤 장 시작에 나감
//   승인은 사이트의 에이전트 화면에서 비밀번호로. 10시~22시(UTC 13시) 사이에 승인하면 바로 예약 주문, 그 전이면 11시 단계에서 보냄.
// 안전장치: 매수 1건 500만원 고정(원화 환산, 내림), 이미 가진·주문 중인 종목은 안 삼, 하루 매수 3건까지,
//   이번 달 손실이 월초 계좌의 -5%를 넘으면 새 매수 멈춤(청산은 계속), 에이전트가 산 수량만 판다, 사이트에서 멈춤 가능.
// deps 를 바꿔 넣어 시험한다: { store, kis, bars, plan, simulate, TA, send, now, env }

import crypto from "node:crypto";
import { kisExchange } from "./_kis.js";
import { newsBlocks } from "./_news.js";
import { usClosed, kstDate } from "./_market.js";
import { tradeStats, feeOf, UNIVERSE, isKR } from "./_signals.js";
import { makeKrAgent } from "./_agentkr.js";

// 비밀번호 승인 없이 사는 조건 (★ 관심 종목만): 적용 신호 + 손절·익절로 지난 5년 승률 80% 이상, 거래 8번 이상, 최근 1년 누적 수익 +
// 추천 종목·관심 목록 밖 종목은 조건이 맞아도 언제나 승인을 받는다
export const AUTO = { rate: 0.8, n: 8 };
export const autoOk = st => !!(st && st.rate >= AUTO.rate && st.n >= AUTO.n && st.y1 != null && st.y1 > 0);
// 관심 목록 밖 큰 종목 찾기: 내 신호 중 지난 5년 승률 65%·5번 이상인 것만, 하루 많아야 5개 (승인 필요)
export const SCAN = { rate: 0.65, n: 5, max: 5 };
const pct = v => (v > 0 ? "+" : "") + (Math.abs(v) < 0.1 ? (v * 100).toFixed(1) : Math.round(v * 100)) + "%";
const statTxt = s => (s ? `5년 승률 ${Math.round(s.rate * 100)}% (${s.n}번)${s.y1 != null ? ` · 최근 1년 ${pct(s.y1)}` : " · 최근 1년 거래 없음"}` : "");

export const LIMITS = env => ({
  buyKrw: Number(env.AGENT_BUY_KRW) > 0 ? Number(env.AGENT_BUY_KRW) : 5000000,
  maxBuys: Number(env.AGENT_MAX_BUYS) > 0 ? Number(env.AGENT_MAX_BUYS) : 3,
  monthLoss: Number(env.AGENT_MONTH_LOSS) > 0 ? Number(env.AGENT_MONTH_LOSS) : 5,
  slip: Number(env.AGENT_BUY_SLIP) >= 0 && env.AGENT_BUY_SLIP !== undefined && env.AGENT_BUY_SLIP !== "" ? Number(env.AGENT_BUY_SLIP) : 1,
});

const K = {
  pos: "agent:pos", orders: "agent:orders", appr: "agent:appr", seen: "agent:seen", plan: "agent:exitplan",
  month: "agent:month", paused: "agent:paused", log: "agent:log", closeDone: "agent:closeDone", openDone: "agent:openDone",
  scanDone: "agent:scanDone", mstop: "agent:monthStop",
};

export const etDate = now => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
const ymd = s => s.replace(/-/g, "");
const addDays = (s, n) => new Date(Date.parse(s + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const r2 = v => Math.round(v * 100) / 100;
const up2 = v => Math.ceil(v * 100 - 1e-6) / 100;
const krw = v => Math.round(v / 10000).toLocaleString("ko-KR") + "만원";

// 예약 주문을 받는 시간: 한국 10:00 ~ 22:15 (UTC 01:00 ~ 13:15, 서머타임에도 되는 범위). 16:28~16:47 은 증권사 정산 시간
export function resvWindow(now) {
  if (now.getUTCDay() === 0 || now.getUTCDay() === 6) return "closed";
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (m < 60 || m > 13 * 60 + 15) return "closed";
  if (m >= 7 * 60 + 28 && m <= 7 * 60 + 47) return "settle";
  return "open";
}
// 승인 마감: 만든 뒤 처음 오는 평일 UTC 13:00 (한국 22시). 금요일 장 마감 신호는 월요일 22시까지
export function approvalDeadline(now) {
  const d = new Date(now);
  d.setUTCHours(13, 0, 0, 0);
  while (d <= now || d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

export function makeAgent(deps) {
  const { store, kis, bars, plan, simulate, TA, send, env = {} } = deps;
  const universe = deps.universe || UNIVERSE;
  const now = () => (deps.now ? deps.now() : new Date());
  const L = LIMITS(env);
  const get = async (k, d) => (await store.get(k)) ?? d;

  async function log(text) {
    const l = await get(K.log, []);
    l.unshift({ at: now().toISOString(), text });
    await store.set(K.log, l.slice(0, 100));
  }
  // 국내 주식은 api/_agentkr.js (승인 목록·멈춤·기록은 같이 씀)
  const kr = makeKrAgent({ ...deps, L, autoOk, log, statTxt, sendChunks, K });

  // 체결 내역을 에이전트 주문과 맞춰 보유 수량·평균가·실현 손익을 고친다
  async function reconcile() {
    const today = etDate(now());
    const orders = await get(K.orders, []), pos = await get(K.pos, {}), seen = await get(K.seen, {}), month = await get(K.month, null);
    const open = orders.filter(o => o.status === "sent" || o.status === "partial");
    const notes = [];
    if (open.length) {
      const from = open.map(o => o.sig).sort()[0];
      const fills = await kis.fills(ymd(from), ymd(today));
      for (const f of fills) {
        const prev = seen[f.key] || 0;
        let delta = f.qty - prev;
        if (delta <= 0) continue;
        // 같은 종목·같은 방향의 에이전트 주문(신호일 이후 5일 안)에만 붙인다. 넘치는 수량은 직접 매매로 보고 안 셈
        for (const o of open) {
          if (delta <= 0) break;
          if (o.t !== f.t || o.side !== f.side || f.date < ymd(o.sig) || f.date > ymd(addDays(o.sig, 5))) continue;
          const take = Math.min(delta, o.qty - (o.filled || 0));
          if (take <= 0) continue;
          o.filled = (o.filled || 0) + take;
          o.status = o.filled >= o.qty ? "filled" : "partial";
          delta -= take;
          seen[f.key] = (seen[f.key] || 0) + take;
          if (f.side === "buy") {
            const p = pos[f.t] || { qty: 0, avg: 0, sid: o.sid, rule: o.rule || null, exch: o.exch, since: f.date.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3") };
            p.avg = (p.avg * p.qty + f.price * take) / (p.qty + take);
            p.qty += take;
            pos[f.t] = p;
            notes.push(`매수 체결 ${f.t} ${take}주 $${f.price}`);
          } else if (pos[f.t]) {
            const p = pos[f.t], q = Math.min(take, p.qty), pnl = (f.price - p.avg) * q;
            p.qty -= q;
            if (month) month.realized = (month.realized || 0) + pnl;
            notes.push(`매도 체결 ${f.t} ${q}주 $${f.price} (${pnl >= 0 ? "+" : ""}$${r2(pnl)})`);
            if (p.qty <= 0) delete pos[f.t];
          }
        }
      }
    }
    // 한투 예약 주문 상태: 거부·취소된 주문은 바로 정리하고 이유를 남긴다
    const live = orders.filter(o => (o.status === "sent" || o.status === "partial") && o.no);
    if (live.length && kis.resvList) {
      try {
        const from = live.map(o => o.rcit || ymd(kstDate(new Date(o.at)))).sort()[0];
        const rs = await kis.resvList(from, ymd(kstDate(now())));
        for (const o of live) {
          const r = rs.find(x => x.no === o.no);
          if (!r || (o.filled || 0) > 0) continue;
          if (r.canceled) { o.status = "canceled"; notes.push(`${o.t} ${o.side === "buy" ? "매수" : "매도"} 예약 주문이 취소됨`); }
          else if (r.reason && !r.filled) { o.status = "rejected"; o.reason = r.reason; notes.push(`⚠ ${o.t} ${o.side === "buy" ? "매수" : "매도"} 주문 거부: ${r.reason}`); }
        }
        // 거부·취소된 매수는 승인 목록에도 표시
        const gone = live.filter(o => o.side === "buy" && (o.status === "rejected" || o.status === "canceled"));
        if (gone.length) {
          const appr = await get(K.appr, []);
          appr.forEach(a => { const o = gone.find(g => g.t === a.t && g.sig === a.sig); if (o && a.status === "sent") { a.status = o.status === "rejected" ? "failed" : "canceled"; if (o.reason) a.error = o.reason; } });
          await store.set(K.appr, appr);
        }
      } catch (e) { notes.push(`예약 주문 조회 실패: ${e.message || e}`); }
    }
    // 5일 넘게 안 채워진 주문은 끝난 것으로 (예약 주문은 당일만 유효)
    orders.forEach(o => { if ((o.status === "sent" || o.status === "partial") && addDays(o.sig, 5) < today) o.status = o.filled ? "partial-done" : "expired"; });
    // 실제 잔고보다 많이 가졌다고 적혀 있으면 잔고에 맞춘다 (직접 파신 경우)
    const bal = await kis.balance();
    // 액면분할·병합: 잔고 수량이 r 배, 평균가가 1/r 배로 바뀌었으면 에이전트 몫도 같이 바꾼다 (안 그러면 손절가가 엉뚱해짐)
    for (const t of Object.keys(pos)) {
      const b = bal.find(x => x.t === t), p = pos[t];
      if (!b || !(b.avg > 0) || !(p.avg > 0) || b.qty === p.qty) continue;
      const rQty = b.qty / p.qty, rAvg = p.avg / b.avg;
      if ((rQty >= 1.5 || rQty <= 0.67) && Math.abs(rAvg / rQty - 1) < 0.05) {
        const r = rAvg;
        p.qty = Math.round(p.qty * r); p.avg = p.avg / r; p.split = { at: today, r: Math.round(r * 1000) / 1000 };
        notes.push(`${t} 액면${r > 1 ? "분할" : "병합"} 반영: ${p.qty}주, 평균 $${r2(p.avg)}`);
      }
    }
    for (const t of Object.keys(pos)) {
      const b = bal.find(x => x.t === t);
      const real = b ? b.qty : 0;
      if (pos[t].qty > real) { notes.push(`${t} 잔고가 ${real}주라 에이전트 몫을 ${real}주로 맞춤`); pos[t].qty = real; }
      if (pos[t].qty <= 0) delete pos[t];
    }
    const keep = new Set(Object.keys(seen).sort().slice(-500));
    Object.keys(seen).forEach(k => { if (!keep.has(k)) delete seen[k]; });
    await store.set(K.orders, orders.slice(-200));
    await store.set(K.pos, pos);
    await store.set(K.seen, seen);
    if (month) await store.set(K.month, month);
    for (const n of notes) await log(n);
    return { pos, bal, notes };
  }

  // 월초 기준 금액 (현금 달러 + 보유 평가액)과 이번 달 손익. 한도를 넘으면 새 매수를 막는다
  async function monthCheck(bal, pos) {
    const m = etDate(now()).slice(0, 7);
    let month = await get(K.month, null);
    // 기준 금액이 0 이면(아직 달러가 없거나 조회 실패) 다음 확인 때 다시 잰다. 0 으로 굳으면 손실 한도가 안 걸린다
    if (!month || month.m !== m || !(month.base > 0)) {
      let cash = 0, cashErr = null;
      try { cash = Number((await kis.buyingPower("NASD", "AAPL", 1)).usd) || 0; } catch (e) { cashErr = String((e && e.message) || e); }
      month = { m, base: cash + bal.reduce((s, x) => s + x.value, 0), realized: (month && month.m === m && month.realized) || 0, cashErr };
      await store.set(K.month, month);
    }
    const unreal = Object.entries(pos).reduce((s, [t, p]) => {
      const b = bal.find(x => x.t === t);
      return s + (b && b.price ? (b.price - p.avg) * p.qty : 0);
    }, 0);
    // 실현 손익은 한투 기간손익(수수료·세금 반영)에서 에이전트가 판 종목만 더한다. 조회가 안 되면 직접 계산한 값
    let realized = month.realized || 0;
    if (kis.periodProfit) {
      try {
        const sold = new Set((await get(K.orders, [])).filter(o => o.side === "sell" && (o.filled || 0) > 0 && String(o.sig || "").slice(0, 7) === m).map(o => o.t));
        const pp = await kis.periodProfit(m.replace("-", "") + "01", ymd(etDate(now())));
        realized = r2(pp.rows.filter(r => sold.has(r.t)).reduce((s, r) => s + r.pnl, 0));
        month = { ...month, realized, kisAll: r2(pp.total), realizedSrc: "한투" };
        await store.set(K.month, month);
      } catch { /* 직접 계산값 사용 */ }
    }
    const pnl = realized + unreal;
    const stop = month.base > 0 && pnl < -(month.base * L.monthLoss) / 100;
    return { ...month, unreal, pnl, stop };
  }

  // ---------- 장 마감 뒤 (한국 07시대) ----------
  async function closeStep({ data, origin, force } = {}) {
    const today = etDate(now());
    if (!force && (await store.get(K.closeDone)) === today) return { skipped: "이미 함" };
    const { pos, bal, notes } = await reconcile();
    const month = await monthCheck(bal, pos);
    await store.set(K.mstop, !!month.stop);
    const paused = !!(await store.get(K.paused));
    const fee = feeOf(data || {});
    const items = plan(data || {}).filter(x => !isKR(x.t)); // 국내 종목은 국내 단계(api/_agentkr.js)에서
    const W = { byT: Object.fromEntries(items.map(x => [x.t, x])) };
    const exits = [], buys = [], errors = [];
    let date = null;

    // 1) 에이전트가 가진 종목: 청산 신호·손절·익절 확인
    for (const [t, p] of Object.entries(pos)) {
      try {
        const d = await bars(t);
        const i = d.close.length - 1;
        date = date && date > d.time[i] ? date : d.time[i];
        // 지금 ★ 신호·손절익절을 따르고, ★를 지웠으면 살 때의 것을 쓴다
        const it = W.byT[t];
        const strat = it ? it.strat : null;
        const rule = it ? it.rule : p.rule || { sl: null, tp: null };
        const exch = kisExchange(d.exch) || p.exch || "NASD";
        const sl = rule.sl ? p.avg * (1 - rule.sl / 100) : null, tp = rule.tp ? up2(p.avg * (1 + rule.tp / 100)) : null;
        // 액면분할·병합 앞뒤 3일: 차트(분할 반영)와 평균가(아직 반영 전)가 어긋날 수 있어 매도 판단을 쉰다
        if (kis.rights && !(p.split && p.split.at >= addDays(today, -5))) {
          let sp = null;
          try { sp = (await kis.rights(t, exch, ymd(addDays(today, -3)), ymd(addDays(today, 3)))).find(x => x.code === "14" || x.code === "15"); } catch { /* 조회 안 되면 평소대로 */ }
          if (sp) { errors.push(`${t}: ${sp.kind}(${sp.date}) 앞뒤라 오늘은 매도 판단을 쉼`); continue; }
        }
        if (d.time[i] !== today) { // 오늘 장이 없었음 (휴장): 새 판단 없이 익절 지정가만 다음 장에 다시 건다
          if (tp) exits.push({ t, exch, qty: p.qty, price: tp, why: "익절 대기" });
          continue;
        }
        const sig = strat ? strat.run(d, TA) : null;
        let why = null;
        if (sl && d.low[i] <= sl) why = `손절(-${rule.sl}%)`;
        else if (tp && d.high[i] >= tp) why = `익절(+${rule.tp}%)`; // 익절 지정가가 안 걸렸던 날
        else if (sig && sig.exit && sig.exit[i]) why = "청산 신호";
        if (why) exits.push({ t, exch, qty: p.qty, price: 0, why });
        else if (tp) exits.push({ t, exch, qty: p.qty, price: tp, why: "익절 대기" });
      } catch (e) { errors.push(`${t}: ${e.message || e}`); }
    }

    // 2) ★ 종목의 새 매수 신호
    const appr = (await get(K.appr, [])).filter(a => !a.kr && (a.status === "pending" || a.status === "approved"));
    const ordersOpen = (await get(K.orders, [])).filter(o => o.side === "buy" && (o.status === "sent" || o.status === "partial"));
    // 뉴스 분석 (하루 안): 중요한 악재가 있으면 매수 승인 요청을 만들지 않는다
    const news = await store.get("dcf:news");
    const newsOk = news && news.tickers && now().getTime() - Date.parse(news.at) < 30 * 3600e3;
    const newsOf = t => (newsOk ? news.tickers.find(x => x.t === t) : null);
    const busy = t => pos[t] || appr.some(a => a.t === t) || ordersOpen.some(o => o.t === t);
    // 오늘 신호로 이미 승인·주문된 매수도 하루 한도에 센다
    const taken = (await get(K.appr, [])).filter(a => !a.kr && a.sig === today && (a.status === "approved" || a.status === "sent")).length;
    for (const it of items) {
      try {
        const d = await bars(it.t);
        const i = d.close.length - 1;
        date = date && date > d.time[i] ? date : d.time[i];
        if (d.time[i] !== today) continue;
        const sim = simulate(d, it.strat, it.rule, TA, { fee });
        if (!(sim.out.buy[i] && !sim.pos)) continue;
        const exch = kisExchange(d.exch);
        const why = paused ? "에이전트 멈춤" : month.stop ? `이번 달 손실 한도(-${L.monthLoss}%)` : busy(it.t) ? "이미 보유·주문 중"
          : !exch ? `거래소 모름(${d.exch})` : newsBlocks(newsOf(it.t)) ? `뉴스 악재: ${newsOf(it.t).summary}` : buys.filter(b => !b.skip).length + taken >= L.maxBuys ? `하루 ${L.maxBuys}건 한도` : null;
        // 사이트와 같은 성적 (내 수수료 설정, 지난 5년·최근 1년)
        const s5 = tradeStats(d, sim, 5), s1 = tradeStats(d, sim, 1);
        const stat = s5 ? { rate: s5.rate, n: s5.n, y1: s1 ? s1.total : null } : null;
        buys.push({ t: it.t, sid: it.strat.id, rule: it.rule, name: it.strat.name, close: d.close[i], exch, skip: why, stat, auto: !!it.star && autoOk(stat) });
      } catch (e) { errors.push(`${it.t}: ${e.message || e}`); }
    }
    const created = [];
    let usdUsed = 0;
    for (const b of buys.filter(b => !b.skip)) {
      const limit = r2(b.close * (1 + L.slip / 100));
      let est = null, bp = null;
      try { bp = await kis.buyingPower(b.exch, b.t, limit); if (bp.rate > 0) est = Math.floor(L.buyKrw / bp.rate / limit); } catch { /* 승인 때 다시 계산 */ }
      const nw = newsOf(b.t);
      const a = { id: crypto.randomBytes(6).toString("hex"), t: b.t, sid: b.sid, rule: b.rule, name: b.name, news: nw ? `${nw.sentiment} · ${nw.summary}` : null, exch: b.exch, sig: today, close: b.close, limit, est,
        stat: b.stat, status: "pending", created: now().toISOString(), deadline: approvalDeadline(now()) };
      // 자동 매수 조건이면 승인된 것으로 두고 11시대 단계에서 예약 주문 (그 전에 에이전트 화면에서 취소 가능)
      if (b.auto) {
        const qty = est || 0, cost = qty * limit;
        const no = !(bp && bp.rate > 0) ? "환율·주문 가능 금액을 못 받음" : qty < 1 ? `1주 가격이 ${krw(L.buyKrw)}보다 비쌈` : cost > bp.usd - usdUsed ? `주문 가능 달러 부족 (필요 $${r2(cost)}, 가능 $${r2(Math.max(0, bp.usd - usdUsed))})` : null;
        if (no) a.note = `자동 매수 조건은 맞지만 ${no} → 승인 대기`;
        else {
          usdUsed += cost;
          Object.assign(a, { status: "approved", auto: true, qty, rate: bp.rate, approvedAt: now().toISOString() });
          const closed = usClosed(kstDate(now()));
          if (closed) a.note = `오늘 밤 미국 휴장(${closed}) — 다음 장 날 보냄`;
        }
      }
      created.push(a);
    }
    const all = (await get(K.appr, [])).map(a => (a.status === "pending" && a.deadline < now().toISOString() ? { ...a, status: "expired" } : a));
    await store.set(K.appr, all.concat(created).slice(-100));
    const prevPlan = await store.get(K.plan);
    if (!(prevPlan && prevPlan.date === today && prevPlan.sent)) await store.set(K.plan, { date: today, exits, sent: false }); // 이미 보낸 주문을 또 보내지 않게
    if (date === today) await store.set(K.closeDone, today);

    // 카톡
    const lines = notes.filter(n => n.startsWith("⚠") || n.includes("액면"));
    created.filter(a => a.auto).forEach(a => lines.push(`🤖 자동 매수 ${a.t} · ${a.name}\n  ${statTxt(a.stat)}\n  지정가 $${a.limit} × ${a.qty}주 → 오늘 11시대 예약 주문${a.news ? `\n  뉴스: ${a.news}` : ""}\n  원치 않으면 에이전트 화면에서 '취소'`));
    created.filter(a => !a.auto).forEach(a => lines.push(`🟢 매수 승인 필요 ${a.t} · ${a.name}${a.stat ? `\n  ${statTxt(a.stat)}` : ""}\n  지정가 $${a.limit}${a.est ? ` × 약 ${a.est}주` : ""}${a.news ? `\n  뉴스: ${a.news}` : ""}${a.note ? `\n  ${a.note}` : ""}`));
    buys.filter(b => b.skip).forEach(b => lines.push(`⚪ ${b.t} 매수 신호 → 안 삼 (${b.skip})`));
    exits.filter(x => !x.price).forEach(x => lines.push(`🔴 ${x.t} ${x.qty}주 ${x.why} → 오늘 밤 장 시작에 자동 매도`));
    Object.keys(pos).forEach(t => { const n = newsOf(t); if (n && n.action === "보유 점검") lines.push(`⚠ ${t} 보유 중 뉴스 악재: ${n.summary} (자동 매도는 신호·손절대로)`); });
    if (month.stop) lines.push(`⚠ 이번 달 손익 $${r2(month.pnl)} — 새 매수 멈춤`);
    if (lines.length && send) {
      const head = `🤖 에이전트 ${today} 종가`;
      const tail = created.some(a => a.status === "pending") ? `\n승인 마감: 오늘 22시` : "";
      await sendChunks(send, head, lines, tail, origin);
    }
    await log(`종가 확인 ${today}: 승인 요청 ${created.filter(a => !a.auto).length}, 자동 매수 ${created.filter(a => a.auto).length}, 청산 ${exits.filter(x => !x.price).length}, 익절 대기 ${exits.filter(x => x.price).length}` + (errors.length ? `, 오류 ${errors.length}` : ""));
    return { date: today, created, buys, exits, errors, month, paused };
  }

  // ---------- 장 마감 뒤: 나스닥100·S&P 상위 50 중 관심 목록 밖 종목의 오늘 매수 신호 → 언제나 승인 요청 ----------
  async function scanStep({ data, origin, force } = {}) {
    const today = etDate(now());
    if (!force && (await store.get(K.scanDone)) === today) return { skipped: "이미 함" };
    if (await store.get(K.paused)) return { skipped: "에이전트 멈춤" };
    if (await store.get(K.mstop)) return { skipped: `이번 달 손실 한도(-${L.monthLoss}%)` };
    const strats = deps.strategies ? deps.strategies(data || {}) : [];
    if (!strats.length) return { skipped: "쓸 신호 없음" };
    const fee = feeOf(data || {});
    // 사이트 '손절·익절 찾기'의 최소 기준(거래 수·승률)을 따름. 없으면 5번·65%
    const btSet = (data && data["dcf-backtest"]) || {};
    const minN = Number.isInteger(btSet.minN) && btSet.minN >= 1 ? btSet.minN : SCAN.n;
    const minRate = typeof btSet.minRate === "number" && btSet.minRate >= 0 && btSet.minRate <= 100 ? btSet.minRate / 100 : SCAN.rate;
    const wl = new Set((Array.isArray(data && data["dcf-watchlist"]) ? data["dcf-watchlist"] : []).map(t => String(t).toUpperCase()));
    const pos = await get(K.pos, {});
    const apprAll = await get(K.appr, []);
    const live = apprAll.filter(a => a.status === "pending" || a.status === "approved" || a.sig === today); // 오늘 이미 묻거나 거절한 종목은 다시 안 물음
    const openBuys = (await get(K.orders, [])).filter(o => o.side === "buy" && (o.status === "sent" || o.status === "partial"));
    const list = universe.filter(t => !wl.has(t) && !pos[t] && !live.some(a => a.t === t) && !openBuys.some(o => o.t === t));
    const found = [], errors = [];
    let next = 0, checked = 0, date = null;
    const t0 = Date.now(), budget = deps.scanBudgetMs || 45000;
    async function worker() {
      while (next < list.length && Date.now() - t0 < budget) {
        const t = list[next++];
        try {
          const d = await bars(t);
          const i = d.close.length - 1;
          checked++;
          date = date && date > d.time[i] ? date : d.time[i];
          if (d.time[i] !== today) continue;
          let best = null;
          for (const s of strats) {
            let sim;
            try { sim = simulate(d, s, { sl: null, tp: null }, TA, { fee }); } catch { continue; }
            if (!(sim.out.buy[i] && !sim.pos)) continue;
            const s5 = tradeStats(d, sim, 5);
            if (!s5 || s5.rate < minRate - 1e-9 || s5.n < minN) continue;
            const s1 = tradeStats(d, sim, 1);
            const stat = { rate: s5.rate, n: s5.n, total: s5.total, y1: s1 ? s1.total : null };
            if (!best || stat.rate > best.stat.rate || (stat.rate === best.stat.rate && stat.total > best.stat.total)) best = { t, sid: s.id, name: s.name, stat, close: d.close[i], exch: kisExchange(d.exch) };
          }
          if (best && best.exch) found.push(best);
        } catch (e) { errors.push(`${t}: ${e.message || e}`); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, list.length) }, worker));
    const cut = next < list.length ? list.length - next : 0; // 시간이 모자라 못 본 종목 수
    found.sort((a, b) => b.stat.rate - a.stat.rate || b.stat.n - a.stat.n);
    const created = [];
    for (const b of found.slice(0, SCAN.max)) {
      const limit = r2(b.close * (1 + L.slip / 100));
      let est = null;
      try { const bp = await kis.buyingPower(b.exch, b.t, limit); if (bp.rate > 0) est = Math.floor(L.buyKrw / bp.rate / limit); } catch { /* 승인 때 다시 계산 */ }
      created.push({ id: crypto.randomBytes(6).toString("hex"), t: b.t, sid: b.sid, rule: { sl: null, tp: null }, name: b.name, news: null, exch: b.exch, sig: today, close: b.close, limit, est,
        stat: b.stat, outside: true, status: "pending", created: now().toISOString(), deadline: approvalDeadline(now()) });
    }
    if (created.length) await store.set(K.appr, (await get(K.appr, [])).concat(created).slice(-100));
    if (date === today && !cut) await store.set(K.scanDone, today);
    if (created.length && send) {
      const lines = created.map(a => `🔵 ${a.t} · ${a.name}\n  ${statTxt(a.stat)}\n  지정가 $${a.limit}${a.est ? ` × 약 ${a.est}주` : ""} · 승인해야 삼`);
      await sendChunks(send, `🔎 관심 목록 밖 매수 신호 ${today} (나스닥100·S&P 상위 50)`, lines, `\n손절·익절 없이 신호 청산만 · 승인 마감: 오늘 22시`, origin);
    }
    await log(`큰 종목 찾기 ${today}: ${checked}/${list.length}종목 확인, 승인 요청 ${created.length}` + (found.length > created.length ? ` (조건 맞은 ${found.length}개 중 상위 ${created.length})` : "") + (cut ? `, 시간 부족으로 ${cut}종목 못 봄` : "") + (errors.length ? `, 오류 ${errors.length}` : ""));
    return { date: today, checked, total: list.length, found, created, errors, cut };
  }

  // 주문 보내기 (예약). 성공하면 주문 기록
  async function submit(o) {
    // 같은 종목·같은 방향 예약 주문이 오늘 이미 한투에 살아 있으면 또 넣지 않는다 (두 번 눌림·재시도 대비)
    if (kis.resvList) {
      let dup = null;
      try { const d = ymd(kstDate(now())); dup = (await kis.resvList(d, d)).find(x => x.t === o.t && x.side === o.side && !x.canceled && !x.reason); } catch { /* 조회 안 되면 그냥 보냄 */ }
      if (dup) throw new Error(`${o.t} ${o.side === "buy" ? "매수" : "매도"} 예약 주문이 이미 들어가 있어 다시 넣지 않았습니다.`);
    }
    const r = await kis.reserve(o.side, o.exch, o.t, o.qty, o.price);
    const orders = await get(K.orders, []);
    orders.push({ ...o, no: r.no, rcit: r.rcit || ymd(kstDate(now())), status: "sent", at: now().toISOString() });
    await store.set(K.orders, orders.slice(-200));
    return r;
  }

  // ---------- 한국 11시대: 청산 + 승인된 매수 예약 주문 ----------
  async function openStep({ origin } = {}) {
    const done = [], errors = [];
    // 오늘 밤 미국 장이 휴장이면 주문을 미룬다 (청산 계획·승인된 매수는 그대로 두고 다음 장 날 보냄)
    const closed = usClosed(kstDate(now()));
    if (closed) { await log(`오늘 밤 미국 휴장(${closed}) — 주문을 다음 장으로 미룸`); return { done, errors, skipped: `휴장: ${closed}` }; }
    const p = await get(K.plan, null);
    if (p && !p.sent) {
      for (const x of p.exits) {
        try {
          await submit({ side: "sell", t: x.t, exch: x.exch, qty: x.qty, price: x.price, sig: p.date, why: x.why });
          done.push(`${x.price ? "익절 대기 지정가" : "매도(장 시작 시장가)"} ${x.t} ${x.qty}주${x.price ? ` $${x.price}` : ""} · ${x.why}`);
        } catch (e) { errors.push(`${x.t} 매도 주문 실패: ${e.message || e}`); }
      }
      await store.set(K.plan, { ...p, sent: true });
    }
    const appr = await get(K.appr, []);
    for (const a of appr.filter(a => !a.kr && a.status === "approved")) {
      try {
        await submit({ side: "buy", t: a.t, exch: a.exch, qty: a.qty, price: a.limit, sig: a.sig, sid: a.sid, rule: a.rule, why: "승인" });
        a.status = "sent";
        done.push(`매수 예약 ${a.t} ${a.qty}주 지정가 $${a.limit}`);
      } catch (e) { a.status = "failed"; a.error = String(e.message || e); errors.push(`${a.t} 매수 주문 실패: ${a.error}`); }
    }
    await store.set(K.appr, appr);
    const msgs = done.concat(errors.map(e => "⚠ " + e));
    if (msgs.length && send) await sendChunks(send, `🤖 에이전트 주문 (오늘 밤 장 시작에 나감)`, msgs, "", origin);
    for (const m of msgs) await log(m);
    return { done, errors };
  }

  // ---------- 승인 ----------
  async function approve(id, { reject } = {}) {
    const appr = await get(K.appr, []);
    const a = appr.find(x => x.id === id);
    if (!a) throw new Error("승인 요청을 찾을 수 없습니다.");
    if (a.kr) return kr.approve(id, { reject });
    if (reject && a.status === "approved") { a.status = "rejected"; a.note = "주문 전에 취소함"; await store.set(K.appr, appr); await log(`매수 취소 ${a.t}${a.auto ? " (자동 매수)" : ""}`); return { status: "rejected" }; }
    if (a.status !== "pending") throw new Error(`이미 처리된 요청입니다 (${a.status}).`);
    const t = now();
    if (a.deadline < t.toISOString()) { a.status = "expired"; await store.set(K.appr, appr); throw new Error("승인 시간(22시)이 지났습니다."); }
    if (reject) { a.status = "rejected"; await store.set(K.appr, appr); await log(`매수 거절 ${a.t}`); return { status: "rejected" }; }
    if (await store.get(K.paused)) throw new Error("에이전트가 멈춰 있습니다. 다시 켜고 승인해 주세요.");
    const w = resvWindow(t);
    if (w === "settle") throw new Error("16:30~16:45 은 증권사 정산 시간이라 주문을 못 받습니다. 잠시 뒤에 다시 눌러 주세요.");
    const pos = await get(K.pos, {});
    if (pos[a.t]) throw new Error(`${a.t} 는 이미 에이전트가 가지고 있습니다.`);
    const sameDay = appr.filter(x => !x.kr && x.sig === a.sig && ["approved", "sent"].includes(x.status)).length;
    if (sameDay >= L.maxBuys) throw new Error(`하루 매수 ${L.maxBuys}건 한도를 넘습니다.`);
    const bp = await kis.buyingPower(a.exch, a.t, a.limit);
    if (!(bp.rate > 0)) throw new Error("환율을 받지 못했습니다. 잠시 뒤 다시 해 주세요.");
    const qty = Math.floor(L.buyKrw / bp.rate / a.limit);
    if (qty < 1) throw new Error(`1주 가격이 ${krw(L.buyKrw)}보다 비쌉니다.`);
    const cost = qty * a.limit;
    if (cost > bp.usd) throw new Error(`주문 가능 달러가 부족합니다 (필요 $${r2(cost)}, 가능 $${r2(bp.usd)}). 달러를 넣거나 환전해 주세요.`);
    a.qty = qty; a.rate = bp.rate; a.approvedAt = t.toISOString();
    const closed = usClosed(kstDate(t));
    if (w === "open" && !closed) {
      await submit({ side: "buy", t: a.t, exch: a.exch, qty, price: a.limit, sig: a.sig, sid: a.sid, rule: a.rule, why: "승인" });
      a.status = "sent";
    } else { a.status = "approved"; if (closed) a.note = `오늘 밤 미국 휴장(${closed}) — 다음 장 날 보냄`; } // 10시 전이나 휴장: 다음 11시대 단계에서 보냄
    await store.set(K.appr, appr);
    await log(`매수 승인 ${a.t} ${qty}주 지정가 $${a.limit} (약 ${krw(cost * bp.rate)})${a.status === "sent" ? " → 예약 주문 보냄" : closed ? ` → 미국 휴장(${closed}), 다음 장 날 보냄` : " → 10시 이후 보냄"}`);
    return { status: a.status, qty, cost: r2(cost), krw: Math.round(cost * bp.rate), note: a.note || null };
  }

  async function status() {
    return {
      paused: !!(await store.get(K.paused)), limits: L,
      pos: await get(K.pos, {}), appr: (await get(K.appr, [])).slice(-30).reverse(),
      orders: (await get(K.orders, [])).slice(-30).reverse(), plan: await get(K.plan, null),
      month: await get(K.month, null), log: (await get(K.log, [])).slice(0, 40),
      kr: await kr.status(),
    };
  }
  // 에이전트가 넣은 예약 주문 취소 (사이트 버튼)
  async function cancel(no) {
    const orders = await get(K.orders, []);
    const o = orders.find(x => x.no && x.no === no && (x.status === "sent" || x.status === "partial"));
    if (!o) { const r = await kr.cancel(no); if (r) return r; throw new Error("취소할 수 있는 에이전트 주문이 아닙니다."); }
    await kis.cancelResv(o.rcit || ymd(kstDate(new Date(o.at))), o.no);
    o.status = "canceled";
    await store.set(K.orders, orders);
    if (o.side === "buy") {
      const appr = await get(K.appr, []);
      appr.forEach(a => { if (a.t === o.t && a.sig === o.sig && a.status === "sent") a.status = "canceled"; });
      await store.set(K.appr, appr);
    }
    await log(`${o.t} ${o.side === "buy" ? "매수" : "매도"} 예약 주문 취소`);
    return { ok: true };
  }
  // 한투에 실제로 걸려 있는 주문 (어제·오늘 예약 + 장중 미체결). 직접 넣은 주문도 보이지만 취소는 에이전트 주문만
  async function broker() {
    const out = { resv: [], unfilled: [], errors: [] };
    const mine = new Set((await get(K.orders, [])).filter(o => (o.status === "sent" || o.status === "partial") && o.no).map(o => o.no));
    try { out.resv = (await kis.resvList(ymd(addDays(kstDate(now()), -1)), ymd(kstDate(now())))).filter(x => !x.canceled).map(x => ({ ...x, mine: mine.has(x.no) })); } catch (e) { out.errors.push(`예약 주문: ${e.message || e}`); }
    try { out.unfilled = await kis.unfilled(); } catch (e) { out.errors.push(`미체결: ${e.message || e}`); }
    return out;
  }
  async function setPaused(v) { await store.set(K.paused, !!v); await log(v ? "에이전트 멈춤" : "에이전트 다시 켬"); }

  return { closeStep, scanStep, openStep, approve, status, setPaused, reconcile, cancel, broker, note: log, krClose: kr.closeStep, krOpen: kr.openStep, krNxt: kr.nxtStep };
}

// 카톡 한 통 200자 제한
async function sendChunks(send, head, lines, tail, origin) {
  const link = origin ? origin + "/api/agent" : undefined;
  const out = [];
  let cur = head;
  lines.forEach(l => { if ((cur + "\n" + l).length > 185) { out.push(cur); cur = l; } else cur += "\n" + l; });
  if ((cur + tail).length <= 200) cur += tail; else { out.push(cur); cur = tail.trim(); }
  out.push(cur);
  for (const m of out.filter(Boolean)) await send(m, link);
}
