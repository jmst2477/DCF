// Vercel 서버리스 함수: /api/agent — 주식 에이전트 1단계 (한투 실전 계좌, 매수는 비밀번호 승인, 청산은 자동)
// 준비 (Vercel 환경 변수, 채팅이나 코드에 쓰지 않기):
//   KIS_APP_KEY, KIS_APP_SECRET  한투 KIS Developers 에서 받은 실전 앱키·앱시크릿
//   KIS_ACCOUNT                  계좌번호 8자리-2자리 (예: 12345678-01)
//   AGENT_PASSWORD               매수 승인·멈춤 때 치는 비밀번호
//   (고를 수 있음) AGENT_BUY_KRW=5000000, AGENT_MAX_BUYS=3, AGENT_MONTH_LOSS=5, AGENT_BUY_SLIP=1 (종가보다 몇 % 위까지 지정가)
// 계산·규칙은 api/_agent.js, 한투 호출은 api/_kis.js
//   GET                          → 에이전트 화면 (HTML)
//   GET ?action=cron&step=close  → 장 마감 뒤 (Vercel Cron, 한국 07시대)
//   GET ?action=cron&step=scan   → 나스닥100·S&P 상위 50 중 관심 목록 밖 매수 신호 → 승인 요청 (Vercel Cron, 한국 08시대)
//   GET ?action=cron&step=open   → 예약 주문 (Vercel Cron, 한국 11시대)
//   GET ?action=cron&step=krclose → 국내 어제 종가 확인 (Vercel Cron, 한국 07:50 아침)
//   GET ?action=cron&step=krnxt   → 승인된 국내 매수를 넥스트레이드 장전 시장에 (Vercel Cron, 한국 08:01)
//   GET ?action=cron&step=kropen  → 국내 주문 (Vercel Cron, 한국 08:40 장 전 동시호가)
//   POST { action, password, id? }  action = status | approve | reject | pause | resume | close(지금 종가 확인)

import crypto from "node:crypto";
import { makeAgent } from "./_agent.js";
import { makeKis, kisConfig } from "./_kis.js";
import { plan, simulate, libs, strategies } from "./_signals.js";
import { dailyBars } from "./prices.js";
import { sendMemo } from "./kakao.js";

function env(suffixes) {
  for (const s of suffixes) if (process.env[s]) return process.env[s];
  const k = Object.keys(process.env).find(k => suffixes.some(s => k.endsWith("_" + s)) && process.env[k]);
  return k ? process.env[k] : "";
}
const URL_ = env(["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"]);
const TOKEN = env(["KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN"]);
const PW = process.env.AGENT_PASSWORD || "";
const FAILS = "agent:fails", MAX_FAILS = 5;

async function redis(...cmd) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("저장소 오류: " + (j.error || r.status));
  return j.result;
}
const store = {
  async get(k) { const v = await redis("GET", k); return v == null ? null : JSON.parse(v); },
  async set(k, v) { await redis("SET", k, JSON.stringify(v)); },
};

// 사이트 관심 종목에 보여 줄 한투 잔고 (직접 산 종목 포함, 읽기만)
async function holdings(kis) {
  const out = { at: new Date().toISOString(), us: [], kr: [], usd: null, krw: null, errors: [] };
  try { out.us = (await kis.balance()).map(({ t, qty, avg, price }) => ({ t, qty, avg, price })); } catch (e) { out.errors.push(`미국 잔고: ${e.message || e}`); }
  try { out.usd = Number((await kis.buyingPower("NASD", "AAPL", 1)).usd); } catch { /* 달러 모름 */ }
  try { const b = await kis.krBalance(); out.kr = b.rows.map(({ t, name, qty, avg, price }) => ({ t, name, qty, avg, price })); out.krw = b.cash; } catch (e) { out.errors.push(`국내 잔고: ${e.message || e}`); }
  return out;
}

function agent(req) {
  const W = libs();
  const kis = makeKis({ store });
  return makeAgent({
    store, env: process.env, TA: W.TA, plan, simulate, strategies, kis,
    // 성적(지난 5년)을 사이트와 같게 내려고 5년치. 야후가 안 되면 한투 일봉(최근 300개)으로
    bars: async t => { try { return await dailyBars(t, "5y"); } catch (e) { try { return await kis.daily(t, null, 3); } catch { throw e; } } },
    send: async (text, link) => { try { await sendMemo(text, link); } catch { /* 카톡이 끊겨 있어도 주문 흐름은 계속 */ } },
  });
}
const originOf = req => `https://${(req.headers || {})["x-forwarded-host"] || (req.headers || {}).host}`;
const syncData = async () => { const s = await store.get("dcf:sync2:data"); return s && s.data; };

async function pwError(pw) {
  if (!PW) return [503, "Vercel 환경 변수 AGENT_PASSWORD 를 먼저 정해 주세요."];
  if (Number(await redis("GET", FAILS)) >= MAX_FAILS) return [429, "비밀번호를 5번 틀려서 한 시간 동안 잠겼습니다."];
  const a = crypto.createHash("sha256").update(String(pw)).digest(), b = crypto.createHash("sha256").update(PW).digest();
  if (!pw || !crypto.timingSafeEqual(a, b)) {
    const n = await redis("INCR", FAILS);
    if (n === 1) await redis("EXPIRE", FAILS, 3600);
    return [401, "비밀번호가 맞지 않습니다."];
  }
  await redis("DEL", FAILS);
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {};
  const cfg = kisConfig();
  const ready = !!(URL_ && TOKEN && cfg.ok);
  try {
    if (req.method === "GET" && q.action === "cron") {
      if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: "unauthorized" });
      if (!ready) return res.status(200).json({ skipped: "not configured" });
      const A = agent(req);
      try {
        const r = q.step === "krclose" ? await A.krClose({ data: await syncData(), origin: originOf(req) }) : q.step === "kropen" ? await A.krOpen({ origin: originOf(req) }) : q.step === "krnxt" ? await A.krNxt({ origin: originOf(req) })
          : q.step === "swap" ? await A.swapStep({ origin: originOf(req) }) : q.step === "krswap" ? await A.krSwap({ origin: originOf(req) })
          : q.step === "open" ? await A.openStep({ origin: originOf(req) }) : q.step === "scan" ? await A.scanStep({ data: await syncData(), origin: originOf(req) }) : await A.closeStep({ data: await syncData(), origin: originOf(req) });
        return res.status(200).json({ ok: true, created: r.created && r.created.length, done: r.done, errors: r.errors, skipped: r.skipped });
      } catch (e) {
        // 한투 접속 실패 등: 기록 남기고 카톡으로 알림
        const m = `⚠ 에이전트 ${{ open: "예약 주문", scan: "큰 종목 찾기", krclose: "국내 종가 확인", kropen: "국내 주문", krnxt: "국내 장전 매수", swap: "갈아타기 매수", krswap: "국내 갈아타기 매수" }[q.step] || "종가 확인"} 실패: ${String((e && e.message) || e)}`;
        await A.note(m).catch(() => {});
        await sendMemo(m, originOf(req) + "/api/agent").catch(() => {});
        throw e;
      }
    }
    if (req.method === "GET") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(PAGE(ready, cfg, !!PW));
    }
    if (req.method !== "POST") return res.status(405).json({ error: "POST만 됩니다" });
    if (!ready) return res.status(503).json({ error: "한투 키(KIS_APP_KEY·KIS_APP_SECRET·KIS_ACCOUNT) 또는 서버 저장소가 아직 없습니다." });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const bad = await pwError(body.password);
    if (bad) return res.status(bad[0]).json({ error: bad[1] });
    const A = agent(req);
    if (body.action === "approve" || body.action === "reject") return res.status(200).json(await A.approve(String(body.id || ""), { reject: body.action === "reject" }));
    if (body.action === "pause" || body.action === "resume") { await A.setPaused(body.action === "pause"); return res.status(200).json(await A.status()); }
    if (body.action === "close") return res.status(200).json(await A.closeStep({ data: await syncData(), origin: originOf(req), force: true }));
    if (body.action === "krclose") return res.status(200).json(await A.krClose({ data: await syncData(), origin: originOf(req), force: true }));
    if (body.action === "scan") return res.status(200).json(await A.scanStep({ data: await syncData(), origin: originOf(req), force: true }));
    if (body.action === "status") return res.status(200).json(await A.status());
    if (body.action === "broker") return res.status(200).json(await A.broker());
    if (body.action === "holdings") return res.status(200).json(await holdings(makeKis({ store })));
    if (body.action === "cancel") return res.status(200).json(await A.cancel(String(body.no || "")));
    return res.status(400).json({ error: "action 은 status · approve · reject · pause · resume · close · broker · cancel · holdings" });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}

// 휴대폰에서 카톡 링크로 여는 화면. 비밀번호는 저장하지 않는다 (이 화면을 닫으면 사라짐)
const PAGE = (ready, cfg, hasPw) => `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>주식 에이전트</title>
<style>
:root{--bg:#f2f4f6;--card:#fff;--tx:#191f28;--mu:#6b7684;--bl:#3182f6;--rd:#f04452;--gn:#0f9d58;--ln:#e5e8eb}
@media (prefers-color-scheme:dark){:root{--bg:#101012;--card:#1c1c20;--tx:#f2f4f6;--mu:#9aa0a6;--ln:#2c2c33}}
body{margin:0;background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;line-height:1.5}
main{max-width:560px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:8px 0 12px}h2{font-size:15px;margin:0 0 8px}
.card{background:var(--card);border-radius:16px;padding:16px;margin-bottom:12px}
.mu{color:var(--mu);font-size:13px}.pos{color:var(--gn)}.neg{color:var(--rd)}
input{font-size:16px;padding:12px;border:1px solid var(--ln);border-radius:10px;width:100%;box-sizing:border-box;background:var(--card);color:var(--tx)}
button{font-size:15px;padding:10px 14px;border:0;border-radius:10px;background:var(--bl);color:#fff;font-weight:600;cursor:pointer}
button.ghost{background:var(--ln);color:var(--tx)}button.red{background:var(--rd)}button:disabled{opacity:.5}
.row{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:10px 0;border-top:1px solid var(--ln)}
.row:first-of-type{border-top:0}.btns{display:flex;gap:6px;flex-shrink:0}
.log{font-size:13px;color:var(--mu);margin:2px 0}
.tag{font-size:12px;padding:1px 6px;border-radius:6px;background:var(--ln);color:var(--tx)}
.up{color:var(--rd)}.dn{color:var(--bl)}
.num{text-align:right;flex-shrink:0;font-size:14px}.num div{font-size:12px}
.top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0 12px}.top h1{margin:0}
.state{font-size:13px;font-weight:600;padding:3px 8px;border-radius:999px;background:var(--ln)}.state.on{background:rgba(49,130,246,.15);color:var(--bl)}.state.off{background:rgba(240,68,82,.15);color:var(--rd)}
h3{font-size:13px;color:var(--mu);margin:14px 0 2px;font-weight:600}h3:first-child{margin-top:0}
.sum{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:13px;color:var(--mu);margin-top:6px}.sum b{color:var(--tx)}
#app .card>.btns{flex-wrap:wrap}button{white-space:nowrap}
details summary{cursor:pointer;color:var(--mu);font-size:13px;margin-top:8px}
</style>
<main>
<div class="top"><h1>🤖 주식 에이전트</h1><span id="state" class="state" hidden></span></div>
${!ready ? `<div class="card"><h2>아직 준비 중</h2><p class="mu">Vercel 환경 변수에 ${[!cfg.key && "KIS_APP_KEY", !cfg.secret && "KIS_APP_SECRET", !cfg.accountOk && "KIS_ACCOUNT(12345678-01 꼴)", !hasPw && "AGENT_PASSWORD"].filter(Boolean).join(", ") || "서버 저장소"} 를 넣고 다시 배포하면 켜집니다.</p></div>` : `
<div class="card" id="login"><h2>비밀번호</h2><form id="f"><input id="pw" type="password" autocomplete="current-password" placeholder="에이전트 비밀번호"><p></p><button>열기</button></form><p id="lmsg" class="mu"></p></div>
<div id="app" hidden>
<div class="card"><h2>매수 승인</h2><div id="appr"></div></div>
<div class="card"><h2>💼 내 계좌 <span class="mu">한투 잔고 · 직접 산 종목 포함</span></h2><div id="hold"><p class="mu">불러오는 중…</p></div></div>
<div class="card"><h2>주문</h2><h3>🇺🇸 오늘 밤 청산</h3><div id="plan"></div><h3>🇰🇷 국내 청산 · 오늘 주문</h3><div id="kr"></div><h3>한투에 걸린 주문</h3><div id="broker"><p class="mu">불러오는 중…</p></div></div>
<div class="card"><h2>이번 달</h2><div id="month"></div><p></p><div class="btns"><button id="pause" class="ghost"></button><button id="close" class="ghost">미국 종가 확인</button><button id="krclose" class="ghost">국내 종가 확인</button></div><p id="amsg" class="mu"></p><p id="krmsg" class="mu"></p></div>
<div class="card"><h2>기록</h2><div id="log"></div></div>
</div>`}
</main>
<script>
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let PW='';
async function call(action,extra){const r=await fetch('/api/agent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,password:PW,...extra})});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.status);return j}
const ST={pending:'승인 대기',approved:'승인됨 · 11시대 주문',sent:'주문 보냄',sending:'주문 보내는 중',rejected:'거절',expired:'시간 지남',failed:'주문 실패',swapping:'갈아타기 · 파는 중, 체결되면 삼',canceled:'취소함',unfilled:'안 채워짐'};
const won=v=>Math.round(v).toLocaleString('ko-KR')+'원',pr=(a,v)=>a.kr?won(v):'$'+v.toFixed(2);
const t2=s=>new Date(s).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
const apprRow=a=>'<div class="row"><div><b>'+esc(a.t)+'</b> '+(a.kr?'<span class="tag">🇰🇷 국내</span> ':'')+(a.auto?'<span class="tag">🤖 자동</span> ':'')+(a.outside?'<span class="tag">관심 목록 밖</span> ':'')+'<span class="mu">'+esc(a.name)+'</span>'+(a.stat?'<div class="mu">5년 승률 '+Math.round(a.stat.rate*100)+'% ('+a.stat.n+'번)'+(a.stat.y1!=null?' · 최근 1년 '+(a.stat.y1>0?'+':'')+Math.round(a.stat.y1*100)+'%':'')+'</div>':'')+(a.swap?'<div class="mu">🔁 갈아타기: <b>'+esc(a.swap.t)+'</b> '+a.swap.qty+'주 팔고 이 종목 사기 · 점수 '+a.swap.score.score+' → '+(a.score?a.score.score:'?')+'</div>':'')+'<div class="mu">'+esc(a.sig)+' 종가 '+pr(a,a.close)+' → 지정가 '+pr(a,a.limit)+(a.qty?' × '+a.qty+'주':a.est?' × 약 '+a.est+'주':'')+'</div>'+(a.news?'<div class="mu">📰 '+esc(a.news)+'</div>':'')+'<div class="mu">'+(a.kr&&a.status==='approved'?'승인됨 · 08:00 장전 또는 08:40 주문':a.kr&&a.status==='sent'&&a.ex==='NXT'?'넥스트레이드 장전 주문 보냄':ST[a.status]||esc(a.status))+(a.status==='pending'?' · 마감 '+t2(a.deadline):'')+(a.error?' · '+esc(a.error):'')+(a.note?' · '+esc(a.note):'')+'</div></div>'+(a.status==='pending'?'<div class="btns"><button data-ok="'+a.id+'"'+(a.swap?' data-swap="'+esc(a.swap.t)+'"':'')+'>승인</button><button class="ghost" data-no="'+a.id+'">거절</button></div>':a.status==='approved'?'<div class="btns"><button class="ghost" data-no="'+a.id+'" data-ask="1">취소</button></div>':'')+'</div>';
const ACTIVE={pending:1,approved:1,sending:1,swapping:1};
const sg=v=>v>=0?'+':'−',pctx=r=>sg(r)+(Math.abs(r)*100).toFixed(1)+'%';
let LAST=null,HOLD=null;
function render(s){
  LAST=s;
  const L0=s.limits;
  const ap=s.appr||[],act=ap.filter(a=>ACTIVE[a.status]),past=ap.filter(a=>!ACTIVE[a.status]);
  $('#appr').innerHTML=(act.length?act.map(apprRow).join(''):'<p class="mu">승인할 매수가 없습니다.</p>')
    +(past.length?'<details><summary>지난 요청 '+past.length+'개</summary>'+past.map(apprRow).join('')+'</details>':'');
  renderHold();
  // 국내 (원화): 청산 예정 + 오늘 주문
  const k=s.kr||{},kpl=k.plan&&k.plan.exits||[],ko=(k.orders||[]).filter(o=>o.status==='sent'||o.status==='partial'),km=k.month;
  $('#kr').innerHTML=(kpl.map(x=>'<div class="log">'+(x.price?'익절 대기 지정가 '+won(x.price):'장 시작 시장가 매도')+' · '+esc(x.t)+' '+x.qty+'주 · '+esc(x.why)+(k.plan.sent?' (보냄)':' (08:40 에 보냄)')+'</div>').join('')
    +ko.map(o=>'<div class="row"><div><b>'+esc(o.t)+'</b> '+(o.side==='buy'?'매수':'매도')+' '+o.qty+'주 '+(o.price?won(o.price):'시장가')+'<div class="mu">오늘 주문 · '+esc(o.why||'')+(o.filled?' · '+o.filled+'주 체결':'')+'</div></div><div class="btns"><button class="ghost" data-cancel="'+esc(o.no)+'">취소</button></div></div>').join(''))||'<p class="mu">없습니다.</p>';
  const pl=s.plan&&s.plan.exits||[];
  $('#plan').innerHTML=pl.length?pl.map(x=>'<div class="log">'+(x.price?'익절 대기 지정가 $'+x.price:'장 시작 시장가 매도')+' · '+esc(x.t)+' '+x.qty+'주 · '+esc(x.why)+(s.plan.sent?' (보냄)':'')+'</div>').join(''):'<p class="mu">청산할 것이 없습니다.</p>';
  const m=s.month,L=s.limits;
  $('#month').innerHTML='<h3>🇺🇸 미국</h3>'+(m?'<div>실현 손익 <b class="'+(m.realized<0?'dn':'up')+'">'+sg(m.realized||0)+'$'+Math.abs(m.realized||0).toFixed(2)+'</b>'+(m.realizedSrc?' <span class="mu">(한투 기준)</span>':'')+'</div>'+(m.kisAll!=null?'<div class="mu">계좌 전체 이번 달 실현 손익(직접 매매 포함) $'+m.kisAll.toFixed(2)+'</div>':'')+'<div class="mu">월초 계좌 $'+Math.round(m.base).toLocaleString()+' · 손실이 '+L.monthLoss+'% 넘으면 새 매수 멈춤</div>'+(m.cashErr?'<div class="mu neg">달러 잔고 조회 실패: '+esc(m.cashErr)+'</div>':(m.base>0?'':'<div class="mu neg">계좌에 달러가 없어요. 매수하려면 달러로 환전해 두세요.</div>')):'<p class="mu">첫 종가 확인 뒤에 보입니다.</p>')
    +'<h3>🇰🇷 국내</h3>'+(km?'<div>실현 손익 <b class="'+((km.realized||0)<0?'dn':'up')+'">'+sg(km.realized||0)+won(Math.abs(km.realized||0))+'</b></div><div class="mu">월초 국내 계좌 '+won(km.base)+' · 손실이 '+L0.monthLoss+'% 넘으면 새 국내 매수 멈춤</div>':'<p class="mu">첫 국내 종가 확인 뒤에 보입니다.</p>')
    +'<h3>규칙</h3><div class="mu">매수 1건 '+(L.buyKrw/1e4).toLocaleString()+'만원 · 하루 '+L.maxBuys+'건까지 · 지정가 = 종가 +'+L.slip+'% · 청산·손절·익절은 자동</div>';
  $('#pause').textContent=s.paused?'▶ 다시 켜기':'⏸ 멈추기';$('#pause').className=s.paused?'':'ghost';
  const st=$('#state');st.hidden=false;st.textContent=s.paused?'⏸ 멈춤':'● 켜짐';st.className='state '+(s.paused?'off':'on');
  const lg=s.log||[],lr=l=>'<div class="log">'+t2(l.at)+' · '+esc(l.text)+'</div>';
  $('#log').innerHTML=(lg.slice(0,10).map(lr).join('')||'<p class="mu">아직 없습니다.</p>')+(lg.length>10?'<details><summary>더 보기 '+(lg.length-10)+'개</summary>'+lg.slice(10).map(lr).join('')+'</details>':'');
}
// 한투 잔고 (직접 산 종목 포함). 에이전트가 산 종목은 🤖 표시와 손절·익절. 사이트 관심 목록에도 보이게 이 브라우저에 저장
function renderHold(){
  const s=LAST||{},h=HOLD,box=$('#hold');
  if(!h)return;
  if(h.error){box.innerHTML='<p class="mu neg">'+esc(h.error)+'</p>';return}
  const ap=s.pos||{},kp=(s.kr&&s.kr.pos)||{};
  const agKr=c=>{const x=Object.keys(kp).find(t=>String(t).slice(0,6)===c);return x?kp[x]:null};
  const row=(kr,x,a)=>{const ok=x.avg>0&&x.price>0,pl=ok?(x.price-x.avg)*x.qty:0,r=ok?x.price/x.avg-1:0;
    return '<div class="row"><div><b>'+esc(kr?(x.name||x.t):x.t)+'</b> '+(kr&&x.name?'<span class="mu">'+esc(x.t)+'</span> ':'')+(a?'<span class="tag">🤖 에이전트</span>':'')
      +'<div class="mu">'+x.qty+'주 · 평단 '+pr({kr},x.avg)+(ok?' · 지금 '+pr({kr},x.price):'')+(a&&a.rule&&(a.rule.sl||a.rule.tp)?' · 손절 '+(a.rule.sl||'-')+'% 익절 '+(a.rule.tp||'-')+'%':'')+'</div></div>'
      +(ok?'<div class="num '+(pl>=0?'up':'dn')+'"><b>'+sg(pl)+pr({kr},Math.abs(pl))+'</b><div>'+pctx(r)+'</div></div>':'')+'</div>'};
  const part=(kr,list,cash,ag)=>{const v=list.reduce((t,x)=>t+(x.avg>0&&x.price>0?(x.price-x.avg)*x.qty:0),0),c=list.reduce((t,x)=>t+x.avg*x.qty,0);
    return list.map(x=>row(kr,x,ag(x))).join('')+(list.length||cash!=null?'<div class="sum">'+(list.length?'<span>평가 손익 <b class="'+(v>=0?'up':'dn')+'">'+sg(v)+pr({kr},Math.abs(v))+(c>0?' ('+pctx(v/c)+')':'')+'</b></span>':'')+(cash!=null?'<span>'+(kr?'원화':'달러')+' 예수금 <b>'+pr({kr},Number(cash))+'</b></span>':'')+'</div>':'')};
  const us=h.us||[],kr=h.kr||[];
  box.innerHTML=(us.length||h.usd!=null?'<h3>🇺🇸 미국</h3>'+part(false,us,h.usd,x=>ap[x.t]):'')
    +(kr.length||h.krw!=null?'<h3>🇰🇷 국내</h3>'+part(true,kr,h.krw,x=>agKr(x.t)):'')
    +(!us.length&&!kr.length?'<p class="mu">가진 종목이 없습니다.</p>':'')
    +((h.errors||[]).length?'<p class="mu neg">'+esc(h.errors.join(' / '))+'</p>':'')
    +'<p class="mu">'+t2(h.at)+' 기준 · 사이트 관심 목록에도 수량·평단·수익이 보입니다.</p>';
}
function renderBroker(b){
  const rows=(b.resv||[]).map(x=>'<div class="row"><div><b>'+esc(x.t)+'</b> '+(x.side==='buy'?'매수':'매도')+' '+x.qty+'주 '+(x.price?'$'+x.price.toFixed(2):'시장가')+'<div class="mu">예약 · '+esc(x.state||'접수')+(x.reason?' · <span class="neg">'+esc(x.reason)+'</span>':'')+(x.mine?' · 에이전트 주문':' · 직접 넣은 주문')+'</div></div>'+(x.mine?'<div class="btns"><button class="ghost" data-cancel="'+esc(x.no)+'">취소</button></div>':'')+'</div>')
    .concat((b.unfilled||[]).map(x=>'<div class="row"><div><b>'+esc(x.t)+'</b> '+(x.side==='buy'?'매수':'매도')+' 미체결 '+x.left+'/'+x.qty+'주 $'+x.price.toFixed(2)+'<div class="mu">장중 주문 · 한투 앱에서 정리</div></div></div>'));
  $('#broker').innerHTML=(rows.join('')||'<p class="mu">걸린 주문이 없습니다.</p>')+((b.errors||[]).length?'<p class="mu neg">'+esc(b.errors.join(' / '))+'</p>':'');
}
async function refresh(){render(await call('status'));call('broker').then(renderBroker).catch(e=>{$('#broker').innerHTML='<p class="mu neg">'+esc(e.message)+'</p>'});call('holdings').then(h=>{HOLD=h;try{localStorage.setItem('dcf-kis-hold',JSON.stringify(h))}catch(e){}renderHold()}).catch(e=>{HOLD={error:e.message};renderHold()})}
const f=$('#f');
if(f)f.addEventListener('submit',async e=>{e.preventDefault();PW=$('#pw').value;try{await refresh();$('#login').hidden=true;$('#app').hidden=false}catch(err){$('#lmsg').textContent=err.message}});
document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b||!PW)return;
  const msg=$('#amsg');
  try{
    if(b.dataset.ok){if(!confirm(b.dataset.swap?'실제 돈으로 '+b.dataset.swap+' 를 팔고 이 종목을 삽니다. 승인할까요?':'실제 돈으로 매수 주문을 넣습니다. 승인할까요?'))return;b.disabled=true;const r=await call('approve',{id:b.dataset.ok});alert(r.msg?r.msg:r.kr?r.qty+'주 · '+won(r.cost)+' '+(r.status==='sent'?'주문을 보냈습니다.':'승인했습니다. '+(r.note||'08:00 장전(넥스트레이드), 안 되면 08:40 에 주문합니다.')):r.qty+'주 · $'+r.cost+' (약 '+Math.round(r.krw/1e4)+'만원) '+(r.status==='sent'?'예약 주문을 보냈습니다. 오늘 밤 장 시작에 나갑니다.':r.note?'승인했습니다. '+r.note:'승인했습니다. 오전 10시 이후에 예약 주문을 보냅니다.'))}
    else if(b.dataset.no){if(b.dataset.ask&&!confirm('주문 전에 이 매수를 취소할까요?'))return;b.disabled=true;await call('reject',{id:b.dataset.no})}
    else if(b.dataset.cancel){if(!confirm('이 예약 주문을 취소할까요?'))return;b.disabled=true;await call('cancel',{no:b.dataset.cancel})}
    else if(b.id==='pause'){render(await call($('#pause').textContent.includes('멈추')?'pause':'resume'));return}
    else if(b.id==='krclose'){b.disabled=true;const m2=$('#krmsg');m2.textContent='확인 중…';const r=await call('krclose');m2.textContent=r.skipped?(r.skipped==='이미 함'?'오늘은 이미 확인했습니다.':r.skipped):'승인 요청 '+(r.created||[]).length+'건 · 청산 '+(r.exits||[]).filter(x=>!x.price).length+'건'+((r.errors||[]).length?' · 오류 '+r.errors.join(', '):'');b.disabled=false}
    else if(b.id==='close'){b.disabled=true;msg.textContent='확인 중…';const r=await call('close');msg.textContent=r.skipped?'오늘은 이미 확인했습니다.':'승인 요청 '+(r.created||[]).length+'건 · 청산 '+(r.exits||[]).filter(x=>!x.price).length+'건'+((r.errors||[]).length?' · 오류: '+r.errors.join(', '):'');b.disabled=false}
    await refresh();
  }catch(err){alert(err.message);b.disabled=false;refresh().catch(()=>{})}
});
</script></html>`;
