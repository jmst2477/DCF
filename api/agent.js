// Vercel 서버리스 함수: /api/agent — 주식 에이전트 1단계 (한투 실전 계좌, 매수는 비밀번호 승인, 청산은 자동)
// 준비 (Vercel 환경 변수, 채팅이나 코드에 쓰지 않기):
//   KIS_APP_KEY, KIS_APP_SECRET  한투 KIS Developers 에서 받은 실전 앱키·앱시크릿
//   KIS_ACCOUNT                  계좌번호 8자리-2자리 (예: 12345678-01)
//   AGENT_PASSWORD               매수 승인·멈춤 때 치는 비밀번호
//   (고를 수 있음) AGENT_BUY_KRW=5000000, AGENT_MAX_BUYS=3, AGENT_MONTH_LOSS=5, AGENT_BUY_SLIP=1 (종가보다 몇 % 위까지 지정가)
// 계산·규칙은 api/_agent.js, 한투 호출은 api/_kis.js
//   GET                          → 에이전트 화면 (HTML)
//   GET ?action=cron&step=close  → 장 마감 뒤 (Vercel Cron, 한국 07시대)
//   GET ?action=cron&step=open   → 예약 주문 (Vercel Cron, 한국 11시대)
//   POST { action, password, id? }  action = status | approve | reject | pause | resume | close(지금 종가 확인)

import crypto from "node:crypto";
import { makeAgent } from "./_agent.js";
import { makeKis, kisConfig } from "./_kis.js";
import { plan, simulate, libs } from "./_signals.js";
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

function agent(req) {
  const W = libs();
  return makeAgent({
    store, env: process.env, TA: W.TA, plan, simulate,
    kis: makeKis({ store }),
    bars: t => dailyBars(t, "2y"),
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
        const r = q.step === "open" ? await A.openStep({ origin: originOf(req) }) : await A.closeStep({ data: await syncData(), origin: originOf(req) });
        return res.status(200).json({ ok: true, created: r.created && r.created.length, done: r.done, errors: r.errors, skipped: r.skipped });
      } catch (e) {
        // 한투 접속 실패 등: 기록 남기고 카톡으로 알림
        const m = `⚠ 에이전트 ${q.step === "open" ? "예약 주문" : "종가 확인"} 실패: ${String((e && e.message) || e)}`;
        await A.note(m).catch(() => {});
        await sendMemo(m.slice(0, 200), originOf(req) + "/api/agent").catch(() => {});
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
    if (body.action === "status") return res.status(200).json(await A.status());
    return res.status(400).json({ error: "action 은 status · approve · reject · pause · resume · close" });
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
</style>
<main>
<h1>🤖 주식 에이전트</h1>
${!ready ? `<div class="card"><h2>아직 준비 중</h2><p class="mu">Vercel 환경 변수에 ${[!cfg.key && "KIS_APP_KEY", !cfg.secret && "KIS_APP_SECRET", !cfg.accountOk && "KIS_ACCOUNT(12345678-01 꼴)", !hasPw && "AGENT_PASSWORD"].filter(Boolean).join(", ") || "서버 저장소"} 를 넣고 다시 배포하면 켜집니다.</p></div>` : `
<div class="card" id="login"><h2>비밀번호</h2><form id="f"><input id="pw" type="password" autocomplete="current-password" placeholder="에이전트 비밀번호"><p></p><button>열기</button></form><p id="lmsg" class="mu"></p></div>
<div id="app" hidden>
<div class="card"><h2>매수 승인</h2><div id="appr"></div></div>
<div class="card"><h2>에이전트가 가진 종목</h2><div id="pos"></div></div>
<div class="card"><h2>오늘 밤 주문</h2><div id="plan"></div></div>
<div class="card"><h2>이번 달</h2><div id="month"></div><p></p><div class="btns"><button id="pause" class="ghost"></button><button id="close" class="ghost">지금 종가 확인</button></div><p id="amsg" class="mu"></p></div>
<div class="card"><h2>기록</h2><div id="log"></div></div>
</div>`}
</main>
<script>
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let PW='';
async function call(action,extra){const r=await fetch('/api/agent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,password:PW,...extra})});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.status);return j}
const ST={pending:'승인 대기',approved:'승인됨 · 10시 이후 주문',sent:'주문 보냄',rejected:'거절',expired:'시간 지남',failed:'주문 실패'};
const t2=s=>new Date(s).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
function render(s){
  const ap=s.appr||[];
  $('#appr').innerHTML=ap.length?ap.map(a=>'<div class="row"><div><b>'+esc(a.t)+'</b> <span class="mu">'+esc(a.name)+'</span><div class="mu">'+esc(a.sig)+' 종가 $'+a.close.toFixed(2)+' → 지정가 $'+a.limit.toFixed(2)+(a.qty?' × '+a.qty+'주':a.est?' × 약 '+a.est+'주':'')+'</div>'+(a.news?'<div class="mu">📰 '+esc(a.news)+'</div>':'')+'<div class="mu">'+(ST[a.status]||esc(a.status))+(a.status==='pending'?' · 마감 '+t2(a.deadline):'')+(a.error?' · '+esc(a.error):'')+'</div></div>'+(a.status==='pending'?'<div class="btns"><button data-ok="'+a.id+'">승인</button><button class="ghost" data-no="'+a.id+'">거절</button></div>':'')+'</div>').join(''):'<p class="mu">승인할 매수가 없습니다.</p>';
  const ps=Object.entries(s.pos||{});
  $('#pos').innerHTML=ps.length?ps.map(([t,p])=>'<div class="row"><div><b>'+esc(t)+'</b> '+p.qty+'주 · 평균 $'+p.avg.toFixed(2)+'<div class="mu">'+esc(p.since)+'부터'+(p.rule&&(p.rule.sl||p.rule.tp)?' · 손절 '+(p.rule.sl||'-')+'% 익절 '+(p.rule.tp||'-')+'%':'')+'</div></div></div>').join(''):'<p class="mu">없습니다. (직접 산 주식은 건드리지 않습니다)</p>';
  const pl=s.plan&&s.plan.exits||[];
  $('#plan').innerHTML=pl.length?pl.map(x=>'<div class="log">'+(x.price?'익절 대기 지정가 $'+x.price:'장 시작 시장가 매도')+' · '+esc(x.t)+' '+x.qty+'주 · '+esc(x.why)+(s.plan.sent?' (보냄)':'')+'</div>').join(''):'<p class="mu">청산할 것이 없습니다.</p>';
  const m=s.month,L=s.limits;
  $('#month').innerHTML=m?'<div>실현 손익 <b class="'+(m.realized<0?'neg':'pos')+'">$'+(m.realized||0).toFixed(2)+'</b></div><div class="mu">월초 계좌 $'+Math.round(m.base).toLocaleString()+' · 손실이 '+L.monthLoss+'% 넘으면 새 매수 멈춤</div>':'<p class="mu">첫 종가 확인 뒤에 보입니다.</p>';
  $('#month').innerHTML+='<div class="mu">매수 1건 '+(L.buyKrw/1e4).toLocaleString()+'만원 · 하루 '+L.maxBuys+'건까지 · 지정가 = 종가 +'+L.slip+'%</div>';
  $('#pause').textContent=s.paused?'▶ 다시 켜기':'⏸ 멈추기';$('#pause').className=s.paused?'':'ghost';
  $('#log').innerHTML=(s.log||[]).map(l=>'<div class="log">'+t2(l.at)+' · '+esc(l.text)+'</div>').join('')||'<p class="mu">아직 없습니다.</p>';
}
async function refresh(){render(await call('status'))}
const f=$('#f');
if(f)f.addEventListener('submit',async e=>{e.preventDefault();PW=$('#pw').value;try{await refresh();$('#login').hidden=true;$('#app').hidden=false}catch(err){$('#lmsg').textContent=err.message}});
document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b||!PW)return;
  const msg=$('#amsg');
  try{
    if(b.dataset.ok){if(!confirm('실제 돈으로 매수 주문을 넣습니다. 승인할까요?'))return;b.disabled=true;const r=await call('approve',{id:b.dataset.ok});alert(r.qty+'주 · $'+r.cost+' (약 '+Math.round(r.krw/1e4)+'만원) '+(r.status==='sent'?'예약 주문을 보냈습니다. 오늘 밤 장 시작에 나갑니다.':'승인했습니다. 오전 10시 이후에 예약 주문을 보냅니다.'))}
    else if(b.dataset.no){b.disabled=true;await call('reject',{id:b.dataset.no})}
    else if(b.id==='pause'){render(await call($('#pause').textContent.includes('멈추')?'pause':'resume'));return}
    else if(b.id==='close'){b.disabled=true;msg.textContent='확인 중…';const r=await call('close');msg.textContent=r.skipped?'오늘은 이미 확인했습니다.':'승인 요청 '+(r.created||[]).length+'건 · 청산 '+(r.exits||[]).filter(x=>!x.price).length+'건'+((r.errors||[]).length?' · 오류: '+r.errors.join(', '):'');b.disabled=false}
    await refresh();
  }catch(err){alert(err.message);b.disabled=false;refresh().catch(()=>{})}
});
</script></html>`;
