// 주식 에이전트 — 국내 주식(코스피 .KS, 코스닥 .KQ). 미국 쪽(api/_agent.js)과 같은 규칙, 따로 저장.
// 하루 흐름 (한국 시간)
//   07:50  close 단계 (Vercel Cron, 미국 카톡과 같은 아침): 어제 장 체결 반영 → 어제 종가로 신호 계산 → 매수 승인 요청·자동 매수 + 청산 계획 → 카톡
//   08:01  nxt 단계 (Vercel Cron): 승인된 매수를 넥스트레이드 장전 시장(08:00~08:50)에 지정가로. 넥스트레이드에 없는 종목은 08:40 으로 미룸
//   08:40  open 단계 (Vercel Cron, 장 시작 전 동시호가): 청산 매도(시장가)·익절 대기(지정가) + 아직 안 나간 승인 매수(지정가)
//   승인은 에이전트 화면에서 비밀번호로. 장중(08:30~15:20)에 승인하면 바로 주문, 그 밖이면 다음 08:40 에 보냄. 승인 마감 = 그날(주말이면 다음 장 날) 15시
// 안전장치(미국과 같음): 매수 1건 500만원 고정(내림), 이미 가진·주문 중인 종목은 안 삼, 하루 매수 3건까지(국내 따로),
//   이번 달 국내 손실이 월초 국내 계좌(예수금 + 국내 보유 평가액)의 -5%를 넘으면 새 국내 매수 멈춤, 에이전트가 산 수량만 판다.
// 국내 주문은 그날만 유효 (안 채워지면 장 마감에 사라짐). 지정가는 호가 단위에 맞춘다.

import crypto from "node:crypto";
import { kstDate } from "./_market.js";
import { newsBlocks } from "./_news.js";
import { tradeStats, feeKrOf, isKR } from "./_signals.js";

export const KK = {
  pos: "agent:kr:pos", orders: "agent:kr:orders", plan: "agent:kr:plan", month: "agent:kr:month",
  closeDone: "agent:kr:closeDone", mstop: "agent:kr:monthStop",
};
const code = t => String(t).slice(0, 6);
const ymd = s => s.replace(/-/g, "");
const won = v => Math.round(v).toLocaleString("ko-KR") + "원";
const man = v => Math.round(v / 10000).toLocaleString("ko-KR") + "만원";

// 국내 호가 단위 (2023년~ 코스피·코스닥 같음). ETF 는 더 잘지만 이 단위의 배수라 그대로 써도 맞다
export const tick = p => (p < 2000 ? 1 : p < 5000 ? 5 : p < 20000 ? 10 : p < 50000 ? 50 : p < 200000 ? 100 : p < 500000 ? 500 : 1000);
export const tickDown = p => Math.floor(p / tick(p) + 1e-9) * tick(p);
export const tickUp = p => Math.ceil(p / tick(p) - 1e-9) * tick(p);

// 한국 시간 (분, 요일)
const kst = now => { const k = new Date(now.getTime() + 9 * 3600e3); return { m: k.getUTCHours() * 60 + k.getUTCMinutes(), wd: k.getUTCDay() }; };
// 지금 주문이 바로 나가는 시간인가: 평일 08:30 ~ 15:20 = 한국거래소("open"), 08:00 ~ 08:30 = 넥스트레이드 장전만("nxt")
export function krWindow(now) {
  const { m, wd } = kst(now);
  if (!(wd >= 1 && wd <= 5)) return "closed";
  return m >= 8 * 60 + 30 && m < 15 * 60 + 20 ? "open" : m >= 8 * 60 && m < 8 * 60 + 30 ? "nxt" : "closed";
}
// 국내 '오늘 장': 한국 15:40 전이면 바로 앞 평일 (아침에 돌면 어제 장을 본다). 그날이 휴장이면 일봉 날짜가 안 맞아 새 판단을 안 함
export function krSession(now) {
  const k = new Date(now.getTime() + 9 * 3600e3);
  if (k.getUTCHours() * 60 + k.getUTCMinutes() < 15 * 60 + 40) k.setUTCDate(k.getUTCDate() - 1);
  while (k.getUTCDay() === 0 || k.getUTCDay() === 6) k.setUTCDate(k.getUTCDate() - 1);
  return k.toISOString().slice(0, 10);
}
const kmd = iso => { const k = new Date(Date.parse(iso) + 9 * 3600e3); return `${k.getUTCMonth() + 1}/${k.getUTCDate()}`; };
// 승인 마감: 만든 뒤 처음 오는 평일 한국 15:00
export function krDeadline(now) {
  const k = new Date(now.getTime() + 9 * 3600e3);
  const d = new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate(), 15, 0));
  while (d <= k || d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return new Date(d.getTime() - 9 * 3600e3).toISOString();
}

// deps: { store, kis, bars, plan, simulate, TA, send, now, L, autoOk, log, statTxt, sendChunks, K }  (K = 미국 쪽 공용 키: appr, paused)
export function makeKrAgent(deps) {
  const { store, kis, bars, plan, simulate, TA, send, L, autoOk, log, statTxt, sendChunks, K, swapScore, planSwaps, scoreTxt, SWAP } = deps;
  const now = () => (deps.now ? deps.now() : new Date());
  const get = async (k, d) => (await store.get(k)) ?? d;

  // 체결(주문번호로 맞춤) → 보유 수량·평균가·실현 손익. 그날 지난 주문은 끝난 것으로. 잔고보다 많이 적혀 있으면 잔고에 맞춤
  async function reconcile() {
    const today = kstDate(now());
    const orders = await get(KK.orders, []), pos = await get(KK.pos, {});
    let month = await get(KK.month, null);
    const notes = [];
    const open = orders.filter(o => o.status === "sent" || o.status === "partial");
    if (open.length) {
      const from = open.map(o => o.day).sort()[0];
      const fills = await kis.krFills(ymd(from), ymd(today));
      for (const o of open) {
        const f = fills.find(x => x.no && x.no === o.no && x.t === code(o.t));
        if (!f) continue;
        const take = Math.min(f.qty, o.qty) - (o.filled || 0);
        if (take <= 0) continue;
        o.filled = (o.filled || 0) + take;
        o.status = o.filled >= o.qty ? "filled" : "partial";
        if (o.side === "buy") {
          const p = pos[o.t] || { qty: 0, avg: 0, sid: o.sid, rule: o.rule || null, since: o.day };
          p.avg = (p.avg * p.qty + f.price * take) / (p.qty + take);
          p.qty += take;
          pos[o.t] = p;
          notes.push(`매수 체결 ${o.t} ${take}주 ${won(f.price)}`);
        } else if (pos[o.t]) {
          const p = pos[o.t], q = Math.min(take, p.qty), pnl = (f.price - p.avg) * q;
          p.qty -= q;
          if (month) month.realized = (month.realized || 0) + pnl;
          notes.push(`매도 체결 ${o.t} ${q}주 ${won(f.price)} (${pnl >= 0 ? "+" : ""}${won(pnl)})`);
          if (p.qty <= 0) delete pos[o.t];
        }
      }
    }
    // 국내 주문은 그날만 유효: 지난 날 주문, 또는 오늘 장이 끝난 뒤(15:40~)면 정리
    const over = o => o.day < today || (o.day === today && kst(now()).m >= 15 * 60 + 40);
    const appr = await get(K.appr, []);
    let apprChanged = false;
    orders.forEach(o => {
      if (!(o.status === "sent" || o.status === "partial") || !over(o)) return;
      o.status = o.filled ? "partial-done" : "expired";
      if (o.side === "buy" && !o.filled) {
        appr.forEach(a => { if (a.kr && a.t === o.t && a.sig === o.sig && a.status === "sent") { a.status = "unfilled"; apprChanged = true; } });
        notes.push(`${o.t} 매수 지정가 ${won(o.price)}가 안 채워져 끝남`);
      }
    });
    if (apprChanged) await store.set(K.appr, appr);
    const bal = await kis.krBalance();
    for (const t of Object.keys(pos)) {
      const b = bal.rows.find(x => x.t === code(t));
      const real = b ? b.qty : 0;
      if (pos[t].qty > real) { notes.push(`${t} 잔고가 ${real}주라 에이전트 몫을 ${real}주로 맞춤`); pos[t].qty = real; }
      if (pos[t].qty <= 0) delete pos[t];
    }
    await store.set(KK.orders, orders.slice(-200));
    await store.set(KK.pos, pos);
    if (month) await store.set(KK.month, month);
    for (const n of notes) await log("🇰🇷 " + n);
    return { pos, bal, notes };
  }

  // 월초 국내 기준 금액(예수금 + 국내 보유 평가액)과 이번 달 국내 손익
  async function monthCheck(bal, pos) {
    const m = kstDate(now()).slice(0, 7);
    let month = await get(KK.month, null);
    if (!month || month.m !== m || !(month.base > 0)) {
      month = { m, base: (bal.cash || 0) + bal.rows.reduce((s, x) => s + x.value, 0), realized: (month && month.m === m && month.realized) || 0 };
      await store.set(KK.month, month);
    }
    const unreal = Object.entries(pos).reduce((s, [t, p]) => {
      const b = bal.rows.find(x => x.t === code(t));
      return s + (b && b.price ? (b.price - p.avg) * p.qty : 0);
    }, 0);
    const pnl = (month.realized || 0) + unreal;
    return { ...month, unreal, pnl, stop: month.base > 0 && pnl < -(month.base * L.monthLoss) / 100 };
  }

  // ---------- 장 마감 뒤 (한국 16시대) ----------
  async function closeStep({ data, origin, force } = {}) {
    const today = krSession(now());
    if (!force && (await store.get(KK.closeDone)) === today) return { skipped: "이미 함" };
    const items = plan(data || {}).filter(x => isKR(x.t));
    const posNow = await get(KK.pos, {});
    const hasOrders = (await get(KK.orders, [])).some(o => o.status === "sent" || o.status === "partial");
    if (!items.length && !Object.keys(posNow).length && !hasOrders) { await store.set(KK.closeDone, today); return { skipped: "국내 종목 없음", created: [], exits: [], buys: [], errors: [] }; }
    const { pos, bal, notes } = await reconcile();
    const month = await monthCheck(bal, pos);
    await store.set(KK.mstop, !!month.stop);
    const paused = !!(await store.get(K.paused));
    const fee = feeKrOf(data || {});
    const W = Object.fromEntries(items.map(x => [x.t, x]));
    const exits = [], buys = [], errors = [];
    let date = null;
    // 갈아타기 점수 재료 (원화 종목끼리만): 코스피 지수, 뉴스. 국내는 섹터 순위가 없어 섹터 점수는 가운데 값
    let bench = null;
    try { bench = await bars("^KS11"); } catch { /* 없으면 가운데 값 */ }
    const news = await store.get("dcf:news");
    const newsOk = news && news.tickers && now().getTime() - Date.parse(news.at) < 30 * 3600e3;
    const newsOf = t => (newsOk ? news.tickers.find(x => x.t === t) : null);
    const scoreOf = (t, stat, d) => swapScore({ stat, d, bench, secRank: null, secN: 0, news: newsOf(t) });
    const holds = [];

    // 1) 에이전트가 가진 국내 종목: 손절·익절·청산 신호
    for (const [t, p] of Object.entries(pos)) {
      try {
        const d = await bars(t);
        const i = d.close.length - 1;
        date = date && date > d.time[i] ? date : d.time[i];
        const it = W[t];
        const rule = it ? it.rule : p.rule || { sl: null, tp: null };
        const sl = rule.sl ? p.avg * (1 - rule.sl / 100) : null, tp = rule.tp ? tickUp(p.avg * (1 + rule.tp / 100)) : null;
        if (d.time[i] !== today) { if (tp) exits.push({ t, qty: p.qty, price: tp, why: "익절 대기" }); continue; } // 오늘 장 없음
        const sig = it ? it.strat.run(d, TA) : null;
        let why = null;
        if (sl && d.low[i] <= sl) why = `손절(-${rule.sl}%)`;
        else if (tp && d.high[i] >= tp) why = `익절(+${rule.tp}%)`;
        else if (sig && sig.exit && sig.exit[i]) why = "청산 신호";
        if (why) exits.push({ t, qty: p.qty, price: 0, why });
        else if (tp) exits.push({ t, qty: p.qty, price: tp, why: "익절 대기" });
        if (it && !why) {
          try {
            const sm = simulate(d, it.strat, rule, TA, { fee });
            const s5 = tradeStats(d, sm, 5), s1 = tradeStats(d, sm, 1);
            const stat = s5 ? { rate: s5.rate, n: s5.n, y1: s1 ? s1.total : null } : null;
            holds.push({ t, qty: p.qty, close: d.close[i], since: p.since, nearTp: !!(tp && d.close[i] >= tp * SWAP.nearTp), stat, name: it.strat.name, ...scoreOf(t, stat, d) });
          } catch { /* 점수 못 매기면 안 팖 */ }
        }
      } catch (e) { errors.push(`${t}: ${e.message || e}`); }
    }

    // 2) ★ 국내 종목의 새 매수 신호
    const apprAll = await get(K.appr, []);
    const appr = apprAll.filter(a => a.kr && (a.status === "pending" || a.status === "approved"));
    const ordersOpen = (await get(KK.orders, [])).filter(o => o.side === "buy" && (o.status === "sent" || o.status === "partial"));
    const busy = t => pos[t] || appr.some(a => a.t === t) || ordersOpen.some(o => o.t === t);
    const taken = apprAll.filter(a => a.kr && a.sig === today && (a.status === "approved" || a.status === "sent")).length;
    for (const it of items) {
      try {
        const d = await bars(it.t);
        const i = d.close.length - 1;
        date = date && date > d.time[i] ? date : d.time[i];
        if (d.time[i] !== today) continue;
        const sim = simulate(d, it.strat, it.rule, TA, { fee });
        if (!(sim.out.buy[i] && !sim.pos)) continue;
        const why = paused ? "에이전트 멈춤" : month.stop ? `이번 달 국내 손실 한도(-${L.monthLoss}%)` : busy(it.t) ? "이미 보유·주문 중"
          : newsBlocks(newsOf(it.t)) ? `뉴스 악재: ${newsOf(it.t).summary}` : buys.filter(b => !b.skip).length + taken >= L.maxBuys ? `국내 하루 ${L.maxBuys}건 한도` : null;
        const s5 = tradeStats(d, sim, 5), s1 = tradeStats(d, sim, 1);
        const stat = s5 ? { rate: s5.rate, n: s5.n, y1: s1 ? s1.total : null } : null;
        buys.push({ t: it.t, sid: it.strat.id, rule: it.rule, name: it.strat.name, close: d.close[i], skip: why, stat, auto: !!it.star && autoOk(stat), sc: why ? null : scoreOf(it.t, stat, d) });
      } catch (e) { errors.push(`${it.t}: ${e.message || e}`); }
    }
    const created = [], cands = [];
    let used = 0, cashFree = null;
    for (const b of buys.filter(b => !b.skip)) {
      const limit = tickDown(b.close * (1 + L.slip / 100));
      const est = Math.floor(L.buyKrw / limit);
      let bp = null;
      try { bp = await kis.krBuyingPower(code(b.t), limit); if (cashFree == null && bp && bp.cash >= 0) cashFree = Number(bp.cash); } catch { /* 승인 때 다시 */ }
      const nw = newsOf(b.t);
      const a = { id: crypto.randomBytes(6).toString("hex"), kr: true, t: b.t, sid: b.sid, rule: b.rule, name: b.name, news: nw ? `${nw.sentiment} · ${nw.summary}` : null,
        sig: today, close: b.close, limit, est, stat: b.stat, status: "pending", created: now().toISOString(), deadline: krDeadline(now()) };
      if (b.auto) {
        const qty = est, cost = qty * limit;
        const no = !bp ? "주문 가능 금액을 못 받음" : qty < 1 ? `1주 가격이 ${man(L.buyKrw)}보다 비쌈` : cost > bp.cash - used ? `주문 가능 원화 부족 (필요 ${won(cost)}, 가능 ${won(Math.max(0, bp.cash - used))})` : null;
        if (no) a.note = `자동 매수 조건은 맞지만 ${no} → 승인 대기`;
        else { used += cost; Object.assign(a, { status: "approved", auto: true, qty, approvedAt: now().toISOString() }); }
      }
      if (b.sc) a.score = b.sc;
      if (a.status === "pending" && b.sc) cands.push({ a, cost: est * limit, score: b.sc.score });
      created.push(a);
    }
    // 원화가 모자란 매수 → 점수가 15점 이상 낮은 국내 보유 종목과 갈아타기 (달러 종목은 절대 안 팖)
    if (cashFree != null && cands.length) {
      planSwaps(cands, holds, Math.max(0, cashFree - used), today);
      for (const c of cands) {
        if (c.swap) {
          const h = c.swap;
          c.a.swap = { t: h.t, qty: h.qty, close: h.close, name: h.name, stat: h.stat, score: { score: h.score, sig: h.sig, flow: h.flow, news: h.news } };
          c.a.note = `원화가 모자라 ${h.t}(${h.score}점)를 팔고 사는 갈아타기`;
        } else if (c.short && !c.a.note) c.a.note = `원화 부족 · 바꿔 팔 국내 종목 없음 (${SWAP.gap}점 이상 낮은 보유 종목이 없음)`;
      }
    }
    const all = (await get(K.appr, [])).map(a => (a.status === "pending" && a.deadline < now().toISOString() ? { ...a, status: "expired" } : a));
    await store.set(K.appr, all.concat(created).slice(-100));
    const prev = await store.get(KK.plan);
    if (!(prev && prev.date === today && prev.sent)) await store.set(KK.plan, { date: today, exits, sent: false });
    if (date === today) await store.set(KK.closeDone, today);

    const lines = notes.filter(n => n.includes("안 채워져"));
    created.filter(a => a.auto).forEach(a => lines.push(`🤖 자동 매수 ${a.t} · ${a.name}\n  ${statTxt(a.stat)}\n  지정가 ${won(a.limit)} × ${a.qty}주 → 08:00 장전(넥스트레이드) 주문, 안 되는 종목은 08:40\n  원치 않으면 에이전트 화면에서 '취소'`));
    created.filter(a => a.swap).forEach(a => lines.push(`🔁 갈아타기 승인 필요\n  ${a.swap.t} ${a.swap.qty}주 팔기 · ${scoreTxt(a.swap.score)}\n  → ${a.t} 사기 · ${scoreTxt(a.score)}\n  ${a.name}${a.stat ? ` · ${statTxt(a.stat)}` : ""}\n  승인하면 ${a.swap.t} 시장가 매도 → 체결되면 ${a.t} 지정가 ${won(a.limit)} 매수`));
    created.filter(a => !a.auto && !a.swap).forEach(a => lines.push(`🟢 매수 승인 필요 ${a.t} · ${a.name}${a.stat ? `\n  ${statTxt(a.stat)}` : ""}\n  지정가 ${won(a.limit)} × 약 ${a.est}주${a.news ? `\n  뉴스: ${a.news}` : ""}${a.note ? `\n  ${a.note}` : ""}`));
    buys.filter(b => b.skip).forEach(b => lines.push(`⚪ ${b.t} 매수 신호 → 안 삼 (${b.skip})`));
    exits.filter(x => !x.price).forEach(x => lines.push(`🔴 ${x.t} ${x.qty}주 ${x.why} → 다음 장 시작에 시장가 매도`));
    if (month.stop) lines.push(`⚠ 이번 달 국내 손익 ${won(month.pnl)} — 새 국내 매수 멈춤`);
    if (lines.length && send) await sendChunks(send, `🇰🇷 에이전트 국내 ${today} 종가`, lines, created.some(a => a.status === "pending") ? `\n승인 마감: ${kmd(krDeadline(now()))} 15시 (08:00~08:30 승인은 넥스트레이드 장전, 그 뒤엔 바로 주문)` : "", origin);
    await log(`🇰🇷 국내 종가 확인 ${today}: 승인 요청 ${created.filter(a => !a.auto).length}, 자동 매수 ${created.filter(a => a.auto).length}, 청산 ${exits.filter(x => !x.price).length}, 익절 대기 ${exits.filter(x => x.price).length}` + (errors.length ? `, 오류 ${errors.length}` : ""));
    return { date: today, created, buys, exits, errors, month, paused };
  }

  async function submit(o) {
    const ex = o.ex || "KRX";
    const r = await kis.krOrder(o.side, code(o.t), o.qty, o.price, ex);
    const orders = await get(KK.orders, []);
    orders.push({ ...o, ex, no: r.no, org: r.org, day: kstDate(now()), status: "sent", at: now().toISOString() });
    await store.set(KK.orders, orders.slice(-200));
    return r;
  }

  // ---------- 한국 08:01: 승인된 매수를 넥스트레이드 장전 시장에 ----------
  // 넥스트레이드 거래 종목이 아니거나 거부되면 그대로 '승인됨'으로 두고 08:40 한국거래소 단계에서 보낸다
  async function nxtStep({ origin } = {}) {
    const done = [], later = [];
    const today = kstDate(now());
    let open = null;
    try { open = await kis.krOpen(ymd(today)); } catch { /* 모르면 해 봄 */ }
    if (open === false) return { done, later, skipped: "국내 휴장" };
    const appr = await get(K.appr, []);
    for (const a of appr.filter(a => a.kr && a.status === "approved" && !a.swap)) {
      const r = await tryNxt(a, appr);
      if (r.ok) done.push(`장전(NXT) 매수 주문 ${a.t} ${a.qty}주 지정가 ${won(a.limit)}`); else later.push(`${a.t}: ${r.why} → 08:40 장 시작에`);
    }
    await store.set(K.appr, appr);
    const msgs = done.concat(later);
    if (msgs.length && send) await sendChunks(send, `🇰🇷 에이전트 장전 매수 (넥스트레이드 08:00~08:50)`, msgs, "", origin);
    for (const m of msgs) await log("🇰🇷 " + m);
    return { done, later };
  }
  // 넥스트레이드로 한 번 넣어 봄. 실패해도 주문이 안 들어간 것이라 '승인됨'으로 남김
  async function tryNxt(a, appr) {
    a.status = "sending"; await store.set(K.appr, appr);
    try {
      await submit({ side: "buy", t: a.t, qty: a.qty, price: a.limit, sig: a.sig, sid: a.sid, rule: a.rule, why: "승인", ex: "NXT" });
      a.status = "sent"; a.ex = "NXT";
      return { ok: true };
    } catch (e) {
      a.status = "approved"; a.nxtErr = String(e.message || e).slice(0, 120);
      return { ok: false, why: /종목|대상|거래불가|NXT|넥스트/.test(a.nxtErr) ? "넥스트레이드 거래 종목 아님" : `장전 주문 실패(${a.nxtErr})` };
    }
  }

  // ---------- 한국 08:40: 청산 + 승인된 매수 ----------
  async function openStep({ origin } = {}) {
    const done = [], errors = [];
    const today = kstDate(now());
    let open = null;
    try { open = await kis.krOpen(ymd(today)); } catch { /* 모르면 그냥 보냄 (휴장이면 한투가 거부) */ }
    if (open === false) { await log(`🇰🇷 오늘 국내 휴장 — 주문을 다음 장으로 미룸`); return { done, errors, skipped: "국내 휴장" }; }
    const p = await get(KK.plan, null);
    const swapT = new Set((await get(K.appr, [])).filter(a => a.kr && a.status === "approved" && a.swap).map(a => a.swap.t));
    if (p && !p.sent) {
      await store.set(KK.plan, { ...p, sent: true }); // 먼저 표시해서 두 번 보내지 않게
      for (const x of p.exits.filter(x => !(swapT.has(x.t) && x.price > 0))) {
        try {
          await submit({ side: "sell", t: x.t, qty: x.qty, price: x.price, sig: p.date, why: x.why });
          done.push(`${x.price ? `익절 대기 지정가 ${won(x.price)}` : "시장가 매도"} ${x.t} ${x.qty}주 · ${x.why}`);
        } catch (e) { errors.push(`${x.t} 매도 주문 실패: ${e.message || e}`); }
      }
    }
    const appr = await get(K.appr, []);
    for (const a of appr.filter(a => a.kr && a.status === "approved")) {
      if (a.swap) {
        try { await sellSwap(a); done.push(`갈아타기: ${a.swap.t} ${a.swap.qty}주 시장가 매도 → 체결되면 ${a.t} 지정가 ${won(a.limit)} 매수 (09:10 확인)`); }
        catch (e) { a.status = "failed"; a.error = String(e.message || e); errors.push(`갈아타기 ${a.swap.t}→${a.t} 실패: ${a.error}`); }
        continue;
      }
      a.status = "sending";
      await store.set(K.appr, appr);
      try {
        await submit({ side: "buy", t: a.t, qty: a.qty, price: a.limit, sig: a.sig, sid: a.sid, rule: a.rule, why: "승인" });
        a.status = "sent";
        done.push(`매수 주문 ${a.t} ${a.qty}주 지정가 ${won(a.limit)}`);
      } catch (e) { a.status = "failed"; a.error = String(e.message || e); errors.push(`${a.t} 매수 주문 실패: ${a.error}`); }
    }
    await store.set(K.appr, appr);
    const msgs = done.concat(errors.map(e => "⚠ " + e));
    if (msgs.length && send) await sendChunks(send, `🇰🇷 에이전트 국내 주문 (09시 장 시작에 체결)`, msgs, "", origin);
    for (const m of msgs) await log("🇰🇷 " + m);
    return { done, errors };
  }

  // ---------- 승인 (api/_agent.js approve 가 국내 요청이면 여기로) ----------
  async function approve(id, { reject } = {}) {
    const appr = await get(K.appr, []);
    const a = appr.find(x => x.id === id);
    if (!a) throw new Error("승인 요청을 찾을 수 없습니다.");
    if (reject && a.status === "approved") { a.status = "rejected"; a.note = "주문 전에 취소함"; await store.set(K.appr, appr); await log(`🇰🇷 매수 취소 ${a.t}${a.auto ? " (자동 매수)" : ""}`); return { status: "rejected", kr: true }; }
    if (a.status !== "pending") throw new Error(`이미 처리된 요청입니다 (${a.status}).`);
    const t = now();
    if (a.deadline < t.toISOString()) { a.status = "expired"; await store.set(K.appr, appr); throw new Error("승인 시간(다음 장 날 15시)이 지났습니다."); }
    if (reject) { a.status = "rejected"; await store.set(K.appr, appr); await log(`🇰🇷 매수 거절 ${a.t}`); return { status: "rejected", kr: true }; }
    if (await store.get(K.paused)) throw new Error("에이전트가 멈춰 있습니다. 다시 켜고 승인해 주세요.");
    if (await store.get(KK.mstop)) throw new Error(`이번 달 국내 손실 한도(-${L.monthLoss}%)를 넘어 새 국내 매수를 멈췄습니다.`);
    const pos = await get(KK.pos, {});
    if (pos[a.t]) throw new Error(`${a.t} 는 이미 에이전트가 가지고 있습니다.`);
    const sameDay = appr.filter(x => x.kr && x.sig === a.sig && ["approved", "sent", "sending", "swapping"].includes(x.status)).length;
    if (sameDay >= L.maxBuys) throw new Error(`국내 하루 매수 ${L.maxBuys}건 한도를 넘습니다.`);
    if (a.swap) return approveSwap(a, appr, t);
    const qty = Math.floor(L.buyKrw / a.limit);
    if (qty < 1) throw new Error(`1주 가격이 ${man(L.buyKrw)}보다 비쌉니다.`);
    const cost = qty * a.limit;
    const bp = await kis.krBuyingPower(code(a.t), a.limit);
    if (cost > bp.cash) throw new Error(`주문 가능 원화가 부족합니다 (필요 ${won(cost)}, 가능 ${won(bp.cash)}).`);
    a.qty = qty; a.approvedAt = t.toISOString();
    const win = krWindow(t);
    let now0 = win === "open" || win === "nxt";
    if (now0) { try { if ((await kis.krOpen(ymd(kstDate(t)))) === false) now0 = false; } catch { /* 모르면 보냄 */ } }
    if (now0 && win === "nxt") {
      const r = await tryNxt(a, appr);
      if (!r.ok) a.note = `${r.why} → 08:40 장 시작에 주문`;
    } else if (now0) {
      a.status = "sending"; await store.set(K.appr, appr);
      try { await submit({ side: "buy", t: a.t, qty, price: a.limit, sig: a.sig, sid: a.sid, rule: a.rule, why: "승인" }); a.status = "sent"; }
      catch (e) { a.status = "failed"; a.error = String(e.message || e); await store.set(K.appr, appr); throw e; }
    } else a.status = "approved";
    await store.set(K.appr, appr);
    await log(`🇰🇷 매수 승인 ${a.t} ${qty}주 지정가 ${won(a.limit)} (약 ${man(cost)})${a.status === "sent" ? (a.ex === "NXT" ? " → 넥스트레이드 장전 주문 보냄" : " → 주문 보냄") : " → 08:40 에 보냄"}`);
    return { status: a.status, qty, cost, krw: cost, kr: true, ex: a.ex || null, note: a.note || null };
  }

  // ---------- 갈아타기 (원화 종목끼리) ----------
  // 팔 종목에 걸린 익절 대기 주문은 빼고 취소 (같은 주식을 두 번 팔 수 없음)
  async function dropExits(t) {
    const p = await get(KK.plan, null);
    if (p && !p.sent && p.exits.some(x => x.t === t)) await store.set(KK.plan, { ...p, exits: p.exits.filter(x => x.t !== t) });
    const orders = await get(KK.orders, []);
    let ch = false;
    for (const o of orders.filter(o => o.t === t && o.side === "sell" && o.no && (o.status === "sent" || o.status === "partial") && !(o.filled > 0))) {
      try { await kis.krCancel(o.org, o.no, o.ex || "KRX"); o.status = "canceled"; ch = true; }
      catch (e) { throw new Error(`${t} 에 걸린 매도 주문을 취소하지 못했습니다: ${e.message || e}`); }
    }
    if (ch) await store.set(KK.orders, orders);
  }
  async function sellSwap(a) {
    await dropExits(a.swap.t);
    await submit({ side: "sell", t: a.swap.t, qty: a.swap.qty, price: 0, sig: a.sig, why: `갈아타기 → ${a.t}`, swapId: a.id });
    a.status = "swapping"; a.swapAt = now().toISOString();
  }
  // 매도가 체결됐으면 판 원화로 매수 주문. { done } / { wait } / { fail }
  async function swapBuy(a) {
    await reconcile();
    const orders = await get(KK.orders, []), pos = await get(KK.pos, {});
    const o = orders.filter(x => x.swapId === a.id && x.side === "sell").pop();
    const sold = o && (o.status === "filled" || ((o.filled || 0) > 0 && !pos[a.swap.t]));
    if (!sold) {
      if (!o || ["canceled", "expired", "rejected"].includes(o.status)) return { fail: `${a.swap.t} 매도가 안 돼서 ${a.t} 는 안 샀습니다` };
      return { wait: true };
    }
    const bp = await kis.krBuyingPower(code(a.t), a.limit);
    const qty = Math.min(a.qty || 0, Math.floor(Number(bp.cash) / a.limit));
    if (qty < 1) return { fail: `${a.swap.t}는 팔렸지만 주문 가능 원화가 ${won(Number(bp.cash) || 0)}라 ${a.t}를 못 샀습니다` };
    await submit({ side: "buy", t: a.t, qty, price: a.limit, sig: a.sig, sid: a.sid, rule: a.rule, why: `갈아타기 (${a.swap.t} 판 돈)` });
    a.qty = qty; a.status = "sent";
    return { done: `갈아타기: ${a.swap.t} 매도 체결 → ${a.t} ${qty}주 지정가 ${won(a.limit)} 매수 주문 (오늘만 유효)` };
  }
  async function approveSwap(a, appr, t) {
    const pos = await get(KK.pos, {}), h = pos[a.swap.t];
    if (!h || !(h.qty >= 1)) throw new Error(`${a.swap.t} 를 에이전트가 더는 갖고 있지 않아 갈아타기를 할 수 없습니다.`);
    if (appr.some(x => x !== a && x.kr && x.swap && x.swap.t === a.swap.t && ["approved", "swapping"].includes(x.status))) throw new Error(`${a.swap.t} 는 이미 다른 갈아타기로 팔기로 했습니다.`);
    const qty = Math.floor(L.buyKrw / a.limit);
    if (qty < 1) throw new Error(`1주 가격이 ${man(L.buyKrw)}보다 비쌉니다.`);
    const cost = qty * a.limit, proceeds = h.qty * a.swap.close * 0.97;
    const bp = await kis.krBuyingPower(code(a.t), a.limit);
    if (cost > Number(bp.cash) + proceeds) throw new Error(`${a.swap.t}를 팔아도 원화가 모자랍니다 (필요 ${won(cost)}, 지금 ${won(Number(bp.cash))} + 판 돈 약 ${won(proceeds)}).`);
    a.qty = qty; a.approvedAt = t.toISOString(); a.swap.qty = h.qty;
    let open = krWindow(t) === "open";
    if (open) { try { if ((await kis.krOpen(ymd(kstDate(t)))) === false) open = false; } catch { /* 모르면 보냄 */ } }
    let msg = `갈아타기 승인: ${a.swap.t} ${h.qty}주를 시장가로 팔고, 체결되면 ${a.t} ${qty}주를 지정가 ${won(a.limit)}에 삽니다 (약 ${man(cost)}).`;
    if (open) {
      await sellSwap(a);
      await store.set(K.appr, appr);
      await new Promise(r => setTimeout(r, deps.swapWaitMs ?? 2500)); // 장중 시장가는 바로 체결됨
      const r = await swapBuy(a);
      if (r.done) msg += " 매도가 체결돼서 매수 주문도 보냈습니다.";
      else if (r.fail) { a.status = "failed"; a.error = r.fail; msg += " " + r.fail; }
      else msg += " 매도 체결을 확인하면 (14:00 확인 때) 삽니다.";
    } else { a.status = "approved"; a.note = "다음 장 08:40 동시호가에 매도, 체결되면 09:10 에 매수"; msg += " " + a.note; }
    await store.set(K.appr, appr);
    await log("🇰🇷 " + msg);
    return { status: a.status, qty, cost, krw: cost, kr: true, note: a.note || null, msg };
  }
  // 한국 09:10 · 14:00 (Vercel Cron): 갈아타기 매도가 체결됐으면 매수
  async function swapStep({ origin } = {}) {
    const appr = await get(K.appr, []);
    const list = appr.filter(a => a.kr && a.status === "swapping");
    if (!list.length) return { skipped: "갈아타기 없음", done: [], errors: [] };
    const done = [], errors = [];
    for (const a of list) {
      try {
        const r = await swapBuy(a);
        if (r.done) done.push(r.done);
        else if (r.fail || now().getTime() - Date.parse(a.swapAt || a.approvedAt) > 20 * 3600e3) {
          a.status = "failed"; a.error = r.fail || `${a.swap.t} 매도가 하루 안에 안 채워져서 ${a.t} 매수는 그만둠`; errors.push(a.error);
        }
      } catch (e) { a.status = "failed"; a.error = String(e.message || e); errors.push(`갈아타기 ${a.swap.t}→${a.t}: ${a.error}`); }
    }
    const fresh = await get(K.appr, []); // reconcile 이 바꾼 것 위에 갈아타기 상태만 덮어씀
    list.forEach(a => { const i = fresh.findIndex(x => x.id === a.id); if (i >= 0) fresh[i] = a; });
    await store.set(K.appr, fresh);
    const msgs = done.concat(errors.map(e => "⚠ " + e));
    if (msgs.length && send) await sendChunks(send, `🇰🇷 🔁 에이전트 국내 갈아타기`, msgs, "", origin);
    for (const m of msgs) await log("🇰🇷 " + m);
    return { done, errors };
  }

  // 에이전트가 넣은 국내 주문 취소
  async function cancel(no) {
    const orders = await get(KK.orders, []);
    const o = orders.find(x => x.no && x.no === no && (x.status === "sent" || x.status === "partial"));
    if (!o) return null;
    await kis.krCancel(o.org, o.no, o.ex || "KRX");
    o.status = "canceled";
    await store.set(KK.orders, orders);
    if (o.side === "buy") {
      const appr = await get(K.appr, []);
      appr.forEach(a => { if (a.kr && a.t === o.t && a.sig === o.sig && a.status === "sent") a.status = "canceled"; });
      await store.set(K.appr, appr);
    } else if (o.swapId) {
      const appr = await get(K.appr, []);
      appr.forEach(a => { if (a.id === o.swapId && a.status === "swapping") { a.status = "canceled"; a.note = `${o.t} 매도를 취소해서 갈아타기도 취소`; } });
      await store.set(K.appr, appr);
    }
    await log(`🇰🇷 ${o.t} ${o.side === "buy" ? "매수" : "매도"} 주문 취소`);
    return { ok: true };
  }

  async function status() {
    return {
      pos: await get(KK.pos, {}), plan: await get(KK.plan, null), month: await get(KK.month, null),
      orders: (await get(KK.orders, [])).slice(-30).reverse(),
    };
  }

  return { closeStep, openStep, nxtStep, swapStep, approve, cancel, status, reconcile };
}
