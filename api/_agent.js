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

export const LIMITS = env => ({
  buyKrw: Number(env.AGENT_BUY_KRW) > 0 ? Number(env.AGENT_BUY_KRW) : 5000000,
  maxBuys: Number(env.AGENT_MAX_BUYS) > 0 ? Number(env.AGENT_MAX_BUYS) : 3,
  monthLoss: Number(env.AGENT_MONTH_LOSS) > 0 ? Number(env.AGENT_MONTH_LOSS) : 5,
  slip: Number(env.AGENT_BUY_SLIP) >= 0 && env.AGENT_BUY_SLIP !== undefined && env.AGENT_BUY_SLIP !== "" ? Number(env.AGENT_BUY_SLIP) : 1,
});

const K = {
  pos: "agent:pos", orders: "agent:orders", appr: "agent:appr", seen: "agent:seen", plan: "agent:exitplan",
  month: "agent:month", paused: "agent:paused", log: "agent:log", closeDone: "agent:closeDone", openDone: "agent:openDone",
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
  const now = () => (deps.now ? deps.now() : new Date());
  const L = LIMITS(env);
  const get = async (k, d) => (await store.get(k)) ?? d;

  async function log(text) {
    const l = await get(K.log, []);
    l.unshift({ at: now().toISOString(), text });
    await store.set(K.log, l.slice(0, 100));
  }

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
    // 5일 넘게 안 채워진 주문은 끝난 것으로 (예약 주문은 당일만 유효)
    orders.forEach(o => { if ((o.status === "sent" || o.status === "partial") && addDays(o.sig, 5) < today) o.status = o.filled ? "partial-done" : "expired"; });
    // 실제 잔고보다 많이 가졌다고 적혀 있으면 잔고에 맞춘다 (직접 파신 경우)
    const bal = await kis.balance();
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
    if (!month || month.m !== m) {
      let cash = 0;
      try { cash = (await kis.buyingPower("NASD", "AAPL", 1)).usd; } catch { /* 모르면 보유 평가액만 */ }
      month = { m, base: cash + bal.reduce((s, x) => s + x.value, 0), realized: 0 };
      await store.set(K.month, month);
    }
    const unreal = Object.entries(pos).reduce((s, [t, p]) => {
      const b = bal.find(x => x.t === t);
      return s + (b && b.price ? (b.price - p.avg) * p.qty : 0);
    }, 0);
    const pnl = (month.realized || 0) + unreal;
    const stop = month.base > 0 && pnl < -(month.base * L.monthLoss) / 100;
    return { ...month, unreal, pnl, stop };
  }

  // ---------- 장 마감 뒤 (한국 07시대) ----------
  async function closeStep({ data, origin, force } = {}) {
    const today = etDate(now());
    if (!force && (await store.get(K.closeDone)) === today) return { skipped: "이미 함" };
    const { pos, bal } = await reconcile();
    const month = await monthCheck(bal, pos);
    const paused = !!(await store.get(K.paused));
    const items = plan(data || {});
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
    const appr = (await get(K.appr, [])).filter(a => a.status === "pending" || a.status === "approved");
    const ordersOpen = (await get(K.orders, [])).filter(o => o.side === "buy" && (o.status === "sent" || o.status === "partial"));
    const busy = t => pos[t] || appr.some(a => a.t === t) || ordersOpen.some(o => o.t === t);
    for (const it of items) {
      try {
        const d = await bars(it.t);
        const i = d.close.length - 1;
        date = date && date > d.time[i] ? date : d.time[i];
        if (d.time[i] !== today) continue;
        const sim = simulate(d, it.strat, it.rule, TA);
        if (!(sim.out.buy[i] && !sim.pos)) continue;
        const exch = kisExchange(d.exch);
        const why = paused ? "에이전트 멈춤" : month.stop ? `이번 달 손실 한도(-${L.monthLoss}%)` : busy(it.t) ? "이미 보유·주문 중"
          : !exch ? `거래소 모름(${d.exch})` : buys.filter(b => !b.skip).length >= L.maxBuys ? `하루 ${L.maxBuys}건 한도` : null;
        buys.push({ t: it.t, sid: it.strat.id, rule: it.rule, name: it.strat.name, close: d.close[i], exch, skip: why });
      } catch (e) { errors.push(`${it.t}: ${e.message || e}`); }
    }
    const created = [];
    for (const b of buys.filter(b => !b.skip)) {
      const limit = r2(b.close * (1 + L.slip / 100));
      let est = null;
      try { const bp = await kis.buyingPower(b.exch, b.t, limit); if (bp.rate > 0) est = Math.floor(L.buyKrw / bp.rate / limit); } catch { /* 승인 때 다시 계산 */ }
      const a = { id: crypto.randomBytes(6).toString("hex"), t: b.t, sid: b.sid, rule: b.rule, name: b.name, exch: b.exch, sig: today, close: b.close, limit, est,
        status: "pending", created: now().toISOString(), deadline: approvalDeadline(now()) };
      created.push(a);
    }
    const all = (await get(K.appr, [])).map(a => (a.status === "pending" && a.deadline < now().toISOString() ? { ...a, status: "expired" } : a));
    await store.set(K.appr, all.concat(created).slice(-100));
    const prevPlan = await store.get(K.plan);
    if (!(prevPlan && prevPlan.date === today && prevPlan.sent)) await store.set(K.plan, { date: today, exits, sent: false }); // 이미 보낸 주문을 또 보내지 않게
    if (date === today) await store.set(K.closeDone, today);

    // 카톡
    const lines = [];
    created.forEach(a => lines.push(`🟢 매수 승인 필요 ${a.t} · ${a.name}\n  지정가 $${a.limit}${a.est ? ` × 약 ${a.est}주` : ""}`));
    buys.filter(b => b.skip).forEach(b => lines.push(`⚪ ${b.t} 매수 신호 → 안 삼 (${b.skip})`));
    exits.filter(x => !x.price).forEach(x => lines.push(`🔴 ${x.t} ${x.qty}주 ${x.why} → 오늘 밤 장 시작에 자동 매도`));
    if (month.stop) lines.push(`⚠ 이번 달 손익 $${r2(month.pnl)} — 새 매수 멈춤`);
    if (lines.length && send) {
      const head = `🤖 에이전트 ${today} 종가`;
      const tail = created.length ? `\n승인 마감: 오늘 22시` : "";
      await sendChunks(send, head, lines, tail, origin);
    }
    await log(`종가 확인 ${today}: 승인 요청 ${created.length}, 청산 ${exits.filter(x => !x.price).length}, 익절 대기 ${exits.filter(x => x.price).length}` + (errors.length ? `, 오류 ${errors.length}` : ""));
    return { date: today, created, buys, exits, errors, month, paused };
  }

  // 주문 보내기 (예약). 성공하면 주문 기록
  async function submit(o) {
    const r = await kis.reserve(o.side, o.exch, o.t, o.qty, o.price);
    const orders = await get(K.orders, []);
    orders.push({ ...o, no: r.no, status: "sent", at: now().toISOString() });
    await store.set(K.orders, orders.slice(-200));
    return r;
  }

  // ---------- 한국 11시대: 청산 + 승인된 매수 예약 주문 ----------
  async function openStep({ origin } = {}) {
    const done = [], errors = [];
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
    for (const a of appr.filter(a => a.status === "approved")) {
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
    if (a.status !== "pending") throw new Error(`이미 처리된 요청입니다 (${a.status}).`);
    const t = now();
    if (a.deadline < t.toISOString()) { a.status = "expired"; await store.set(K.appr, appr); throw new Error("승인 시간(22시)이 지났습니다."); }
    if (reject) { a.status = "rejected"; await store.set(K.appr, appr); await log(`매수 거절 ${a.t}`); return { status: "rejected" }; }
    if (await store.get(K.paused)) throw new Error("에이전트가 멈춰 있습니다. 다시 켜고 승인해 주세요.");
    const w = resvWindow(t);
    if (w === "settle") throw new Error("16:30~16:45 은 증권사 정산 시간이라 주문을 못 받습니다. 잠시 뒤에 다시 눌러 주세요.");
    const pos = await get(K.pos, {});
    if (pos[a.t]) throw new Error(`${a.t} 는 이미 에이전트가 가지고 있습니다.`);
    const sameDay = appr.filter(x => x.sig === a.sig && ["approved", "sent"].includes(x.status)).length;
    if (sameDay >= L.maxBuys) throw new Error(`하루 매수 ${L.maxBuys}건 한도를 넘습니다.`);
    const bp = await kis.buyingPower(a.exch, a.t, a.limit);
    if (!(bp.rate > 0)) throw new Error("환율을 받지 못했습니다. 잠시 뒤 다시 해 주세요.");
    const qty = Math.floor(L.buyKrw / bp.rate / a.limit);
    if (qty < 1) throw new Error(`1주 가격이 ${krw(L.buyKrw)}보다 비쌉니다.`);
    const cost = qty * a.limit;
    if (cost > bp.usd) throw new Error(`주문 가능 달러가 부족합니다 (필요 $${r2(cost)}, 가능 $${r2(bp.usd)}). 달러를 넣거나 환전해 주세요.`);
    a.qty = qty; a.rate = bp.rate; a.approvedAt = t.toISOString();
    if (w === "open") {
      await submit({ side: "buy", t: a.t, exch: a.exch, qty, price: a.limit, sig: a.sig, sid: a.sid, rule: a.rule, why: "승인" });
      a.status = "sent";
    } else a.status = "approved"; // 10시 전: 11시대 단계에서 보냄
    await store.set(K.appr, appr);
    await log(`매수 승인 ${a.t} ${qty}주 지정가 $${a.limit} (약 ${krw(cost * bp.rate)})${a.status === "sent" ? " → 예약 주문 보냄" : " → 10시 이후 보냄"}`);
    return { status: a.status, qty, cost: r2(cost), krw: Math.round(cost * bp.rate) };
  }

  async function status() {
    return {
      paused: !!(await store.get(K.paused)), limits: L,
      pos: await get(K.pos, {}), appr: (await get(K.appr, [])).slice(-30).reverse(),
      orders: (await get(K.orders, [])).slice(-30).reverse(), plan: await get(K.plan, null),
      month: await get(K.month, null), log: (await get(K.log, [])).slice(0, 40),
    };
  }
  async function setPaused(v) { await store.set(K.paused, !!v); await log(v ? "에이전트 멈춤" : "에이전트 다시 켬"); }

  return { closeStep, openStep, approve, status, setPaused, reconcile, note: log };
}

// 카톡 한 통 200자 제한
async function sendChunks(send, head, lines, tail, origin) {
  const link = origin ? origin + "/api/agent" : undefined;
  const out = [];
  let cur = head;
  lines.forEach(l => { if ((cur + "\n" + l).length > 185) { out.push(cur); cur = l; } else cur += "\n" + l; });
  if ((cur + tail).length <= 200) cur += tail; else { out.push(cur); cur = tail.trim(); }
  out.push(cur);
  for (const m of out.filter(Boolean).slice(0, 6)) await send(m, link);
}
