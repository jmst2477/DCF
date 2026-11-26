// Vercel 서버리스 함수: /api/kakao — 종목별로 적용한 신호가 새로 나오면 내 카카오톡("나에게 보내기")으로 알린다.
// 준비 (한 번만):
//   1) developers.kakao.com 에서 앱을 만들고 카카오 로그인 켜기, 동의 항목 "카카오톡 메시지 전송(talk_message)" 켜기,
//      Redirect URI 에 https://<사이트 주소>/api/kakao 등록, 플랫폼 Web 사이트 도메인에 https://<사이트 주소> 등록
//   2) Vercel 환경 변수 KAKAO_REST_API_KEY = 앱의 REST API 키 (클라이언트 시크릿을 켰다면 KAKAO_CLIENT_SECRET 도)
//   3) 사이트 "💬 카톡 알림"에서 카카오 로그인 한 번 → 토큰을 서버 저장소(Upstash)에 보관, 만료 전에 알아서 갱신
// 매일 아침 Vercel Cron(vercel.json)이 GET /api/kakao?action=cron 을 부르면 동기화된 관심 종목을 확인해 새 신호가 있을 때만 보낸다.
// 사이트에서 부르는 것은 모두 동기화 비밀번호가 맞아야 한다 (api/sync.js 와 같은 비밀번호·잠금).
//   GET                         → { configured, connected, redirect, last }
//   POST { action, password }  action = start(로그인 주소) | test(시험 보내기) | check(지금 확인해서 보내기) | report(리서치 보고서 보내기) | off(연결 끊기)
// 매일 아침 8시대 GET /api/kakao?action=report 로 리서치 보고서(api/_report.js)도 보낸다.

import crypto from "node:crypto";
import { checkAll, messages, strategies, plan, libs } from "./_signals.js";
import { makeReport, reportMessages, discoverCandidates, discoverMessage } from "./_report.js";
import { makeKis, kisConfig } from "./_kis.js";
import { splitMemo } from "./_memo.js";
import { reportSummary, reportPage } from "./_reportpage.js";
import { newsBlocks } from "./_news.js";
import { tickerNews, analyzeNews, newsMessages } from "./_news.js";
import { optionsOf, optionView } from "./options.js";
import { yahooSession } from "./dcf-inputs.js";
import { dailyBars, summary } from "./prices.js";
import { deepPromptText, deepParams, startBatch, batchResult, nextStep, deepPage, deepDoc, deepWaitPage, MAX_ROUNDS } from "./_deep.js";

function env(suffixes) {
  for (const s of suffixes) if (process.env[s]) return process.env[s];
  const k = Object.keys(process.env).find(k => suffixes.some(s => k.endsWith("_" + s)) && process.env[k]);
  return k ? process.env[k] : "";
}
const URL_ = env(["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"]);
const TOKEN = env(["KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN"]);
const KEY = process.env.KAKAO_REST_API_KEY || "";
const SECRET = process.env.KAKAO_CLIENT_SECRET || "";
const K = {
  pw: "dcf:sync2:pw", data: "dcf:sync2:data", fails: "dcf:sync2:fails",
  tok: "dcf:kakao:tok", report: "dcf:kakao:report", news: "dcf:news", discover: "dcf:discover", state: "dcf:kakao:state:", view: "dcf:rv:", deep: "dcf:deep:", deepMsg: "dcf:deep:msg:", deepCount: "dcf:deep:count:", sent: "dcf:kakao:sent", last: "dcf:kakao:last",
};
const MAX_FAILS = 20;

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
const jget = async k => { const v = await redis("GET", k); return v ? JSON.parse(v) : null; };
// 한투 (키가 있을 때만): 뉴스 예비, 새 후보 종목 조건검색
const kisStore = { get: jget, set: async (k, v) => { await redis("SET", k, JSON.stringify(v)); } };
const kisOn = () => !!(kisConfig().ok && URL_ && TOKEN);

const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString("hex");
function checkPw(pw, stored) {
  const [salt, h] = String(stored).split(":");
  const a = Buffer.from(hash(pw, salt), "hex"), b = Buffer.from(h || "", "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// 동기화 비밀번호 확인. 틀리면 오류 문구, 맞으면 null
async function pwError(pw) {
  if (Number(await redis("GET", K.fails)) >= MAX_FAILS) return [429, "비밀번호를 너무 많이 틀렸습니다. 한 시간 뒤에 다시 해 주세요."];
  const stored = await redis("GET", K.pw);
  if (!stored) return [400, "먼저 ☁ 자동 동기화를 켜 주세요."];
  if (!pw || !checkPw(pw, stored)) {
    const n = await redis("INCR", K.fails);
    if (n === 1) await redis("EXPIRE", K.fails, 3600);
    return [401, "동기화 비밀번호가 맞지 않습니다."];
  }
  return null;
}

const originOf = req => {
  const h = req.headers || {};
  return `https://${h["x-forwarded-host"] || h.host}`;
};
const redirectOf = req => process.env.KAKAO_REDIRECT_URI || originOf(req) + "/api/kakao";

async function kakaoToken(params) {
  const body = new URLSearchParams({ client_id: KEY, ...params });
  if (SECRET) body.set("client_secret", SECRET);
  const r = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("카카오 토큰 오류: " + (j.error_description || j.error || r.status));
  return j;
}
function saveTok(old, j) {
  const now = Date.now();
  const t = {
    ...(old || {}),
    access: j.access_token,
    exp: now + (j.expires_in || 21599) * 1000,
  };
  if (j.refresh_token) { t.refresh = j.refresh_token; t.rexp = now + (j.refresh_token_expires_in || 5183999) * 1000; }
  return t;
}
// 쓸 수 있는 접근 토큰 (만료 1분 전이면 갱신. 갱신 토큰도 한 달 안 남았으면 카카오가 새로 준다)
async function accessToken() {
  let t = await jget(K.tok);
  if (!t) throw new Error("카카오톡이 아직 연결되지 않았습니다.");
  if (t.exp - 60000 > Date.now()) return t;
  if (!t.refresh || (t.rexp && t.rexp < Date.now())) throw new Error("카카오 연결이 만료됐습니다. 사이트에서 다시 연결해 주세요.");
  t = saveTok(t, await kakaoToken({ grant_type: "refresh_token", refresh_token: t.refresh }));
  await redis("SET", K.tok, JSON.stringify(t));
  return t;
}
// 200자가 넘으면 줄 단위로 나눠 여러 통으로 보낸다
export async function sendMemo(text, link, button) {
  for (const part of splitMemo(text)) await sendMemo1(part, link, button);
}
async function sendMemo1(text, link, button) {
  const t = await accessToken();
  if (typeof link === "function") link = link(t.origin);
  const tpl = { object_type: "text", text, link: { web_url: link || t.origin, mobile_web_url: link || t.origin }, button_title: button || "사이트 열기" };
  const r = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${t.access}`, "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: new URLSearchParams({ template_object: JSON.stringify(tpl) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.result_code !== 0) throw new Error("카카오톡 보내기 실패: " + (j.msg || j.result_code || r.status));
}

// 옵션 요약 → 보고서용 한 줄 판단. 야후 세션은 한 번만 받아 같이 씀. 실패한 종목은 { error } (보고서는 계속)
function optDeps() {
  let sess = null;
  return async t => {
    try {
      if (!sess) sess = yahooSession();
      return optionView(await optionsOf(t, await sess));
    } catch (e) { return { error: String((e && e.message) || e).slice(0, 80) }; }
  };
}

// 신호 확인 → 새 신호가 있으면 보냄. force = 사이트의 "지금 확인" (같은 날 이미 보냈어도, 신호가 없어도 결과를 보냄)
async function runCheck(force) {
  const s = await jget(K.data);
  if (!s || !s.data) throw new Error("동기화된 종목이 없습니다.");
  const check = await checkAll(s.data);
  const errors = check.results.filter(r => r.error).map(r => `${r.t}: ${r.error}`);
  const already = check.date && (await redis("GET", K.sent)) === check.date;
  const msgs = force || !already ? messages(check, { force }) : [];
  for (const m of msgs) await sendMemo(m);
  if (!force && check.date) await redis("SET", K.sent, check.date);
  const events = check.results.flatMap(r => (r.date === check.date ? (r.events || []).map(e => ({ t: r.t, name: r.name, ...e })) : []));
  const last = { at: new Date().toISOString(), date: check.date, checked: check.results.length, events: events.length, sent: msgs.length, skipped: !!already && !force, errors: errors.slice(0, 10) };
  await redis("SET", K.last, JSON.stringify(last));
  return { ...last, list: events, messages: msgs };
}

// FRED 공개 CSV (키 필요 없음). 최근 1년치
async function fred(id) {
  const from = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  const r = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}&cosd=${from}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error("FRED " + r.status);
  return (await r.text()).trim().split("\n").slice(1).map(l => l.split(",")).map(([date, v]) => ({ date, v: Number(v) })).filter(x => /^\d{4}-\d\d-\d\d$/.test(x.date) && isFinite(x.v));
}
// 에이전트 리서치 보고서를 만들어 카톡으로 보냄 (매일 아침 Cron, 사이트의 "리서치 미리 보내기")
async function runReport(manual = false) {
  const s = await jget(K.data);
  const data = (s && s.data) || {};
  const r = await makeReport({ bars: (t, range) => dailyBars(t, range), fred, profile: summary, strategies, plan, TA: libs().TA, options: optDeps() }, { data, pos: { ...((await jget("agent:pos")) || {}), ...((await jget("agent:kr:pos")) || {}) } });
  const news = await jget(K.news);
  const fresh = news && Date.now() - Date.parse(news.at) < 30 * 3600e3;
  const dsc = await jget(K.discover);
  // 새 후보는 찾은 날(월요일) 보고서와 직접 미리 보내기 때만 넣는다 (매일 같은 목록 반복 안 함)
  const dscMsg = dsc && Date.now() - Date.parse(dsc.at) < (manual ? 8 * 864e5 : 30 * 3600e3) ? discoverMessage(dsc) : [];
  const msgs = reportMessages(r).concat(fresh ? newsMessages(news) : [], dscMsg);
  // 전체는 웹페이지 한 장으로 저장하고, 카톡은 요약 한 통 + "보고서 열기" 버튼
  const id = crypto.randomBytes(8).toString("hex"); // 짧은 주소 (16자, 추측 불가)
  await redis("SET", K.view + id, JSON.stringify({ at: new Date().toISOString(), date: r.date, sections: msgs, errors: r.errors.slice(0, 10) }), "EX", 45 * 86400);
  const newsWarn = fresh && news.tickers ? news.tickers.filter(x => newsBlocks(x) || x.action === "보유 점검").length : 0;
  const picks = dscMsg.length && dsc.picks ? dsc.picks.length : 0;
  // 카카오가 버튼을 숨겨도 열 수 있게 요약 안에 보고서 주소를 직접 넣는다 (카톡이 주소를 링크로 바꿔 줌)
  const path = `/r/${id}`;
  const origin = (await accessToken()).origin;
  const summaryText = reportSummary(r, { newsWarn, picks, url: origin ? origin + path : null });
  await sendMemo(summaryText, origin => origin + path, "보고서 열기");
  await redis("SET", K.report, JSON.stringify({ at: new Date().toISOString(), date: r.date, sent: msgs.length, errors: r.errors.slice(0, 10),
    regime: r.spy ? r.spy.kind : null, strong: r.strong.map(s => s.ko).join(", ") }));
  return { date: r.date, messages: msgs, summary: summaryText, url: path, sent: 1, errors: r.errors };
}

// 새 후보 종목 (주 1회, 월요일 Cron · 리서치 미리 보내기 때 일주일 넘었으면)
async function runDiscover() {
  if (!kisOn()) return { skipped: "한투 키 없음" };
  const s = await jget(K.data);
  const data = (s && s.data) || {};
  const wl = (Array.isArray(data["dcf-watchlist"]) ? data["dcf-watchlist"] : []).filter(t => typeof t === "string");
  const kis = makeKis({ store: kisStore });
  const errors = [];
  const screen = async () => {
    const out = [];
    for (const ex of ["NAS", "NYS"]) { try { out.push(...(await kis.search(ex, { minCapK: 10000000, minPrice: 10 }))); } catch (e) { errors.push(`${ex}: ${e.message || e}`); } }
    return out;
  };
  const r = await discoverCandidates({ screen, bars: (t, range) => dailyBars(t, range), options: optDeps() }, { exclude: wl.concat(Object.keys((await jget("agent:pos")) || {})), strats: strategies(data), TA: libs().TA });
  const saved = { ...r, errors };
  await redis("SET", K.discover, JSON.stringify(saved));
  return saved;
}

// 관심 종목 뉴스 제목을 모아 Claude 로 분석해 저장 (매일 미국 장 마감 무렵 Cron, 리서치 미리 보내기 전에도)
async function runNews() {
  const s = await jget(K.data);
  const data = (s && s.data) || {};
  const star = Object.fromEntries(plan(data).map(x => [x.t, x.strat.name]));
  const pos = (await jget("agent:pos")) || {};
  const wl = (Array.isArray(data["dcf-watchlist"]) ? data["dcf-watchlist"] : []).filter(t => typeof t === "string" && t).slice(0, 25);
  Object.keys(pos).forEach(t => { if (!wl.includes(t)) wl.push(t); });
  const items = [], errors = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(5, wl.length) }, async () => {
    while (next < wl.length) {
      const t = wl[next++];
      let news = [], err = null;
      try { news = await tickerNews(t); } catch (e) { err = e; }
      // 야후가 막히거나 비었으면 한투 해외뉴스 제목으로
      if (!news.length && kisOn()) {
        try { const cut = Date.now() - 3 * 864e5; news = (await makeKis({ store: kisStore }).news(t)).filter(n => !n.at || n.at > cut).slice(0, 8); err = null; } catch (e) { err = err || e; }
      }
      if (news.length) items.push({ t, news, star: star[t], held: !!pos[t] });
      else if (err) errors.push(`${t}: ${err.message || err}`);
    }
  }));
  const count = items.reduce((n, x) => n + x.news.length, 0);
  let out;
  try {
    const last = await jget(K.report);
    out = items.length ? await analyzeNews(items, { regime: last && last.regime, strong: last && last.strong }) : { market: "", strategy: "", tickers: [] };
  } catch (e) { out = { error: String((e && e.message) || e), tickers: [] }; }
  const saved = { at: new Date().toISOString(), count, ...out, errors: errors.slice(0, 10) };
  await redis("SET", K.news, JSON.stringify(saved));
  return saved;
}

const page = (res, ok, text) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(ok ? 200 : 400).send(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>카카오톡 알림</title>` +
      `<body style="font-family:sans-serif;padding:24px;line-height:1.6"><p>${text}</p><p><a href="/">사이트로 돌아가기</a></p>` +
      (ok ? `<script>setTimeout(()=>location.href='/?kakao=ok',1200)</script>` : "")
  );
};

// ---------- 🔬 종목 심층 분석 보고서 (Claude, 배치로 맡김) ----------
const DEEP_PER_DAY = 5; // 하루 최대 요청 수 (Claude 비용)
const DEEP_TTL = 90 * 86400;
const todayKst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
async function deepStart(t) {
  const n = await redis("INCR", K.deepCount + todayKst());
  if (n === 1) await redis("EXPIRE", K.deepCount + todayKst(), 2 * 86400);
  if (n > DEEP_PER_DAY) return [429, `심층 분석은 하루 ${DEEP_PER_DAY}번까지만 요청할 수 있습니다 (Claude 비용). 내일 다시 해 주세요.`];
  const params = deepParams(t, { today: todayKst() });
  const batch = await startBatch(params);
  const id = crypto.randomBytes(16).toString("hex");
  await redis("SET", K.deep + id, JSON.stringify({ t, at: new Date().toISOString(), batch, round: 1, status: "running" }), "EX", DEEP_TTL);
  return [200, { id, path: "/d/" + id }];
}
// 쓰는 중이면 배치를 한 번 확인해 다음 단계로 넘긴다
async function deepAdvance(id, v) {
  if (v.status !== "running") return v;
  // 페이지를 여러 곳에서 동시에 열어도 다음 단계를 두 번 맡기지 않게
  if (!(await redis("SET", K.deep + id + ":lock", "1", "NX", "EX", 50))) return v;
  let r;
  try { r = await batchResult(v.batch); } catch (e) { v.lastError = String(e.message || e); return v; }
  if (!r.done) return v;
  if (r.error) { v.status = "error"; v.error = r.error; }
  else {
    const prev = v.round > 1 ? await jget(K.deepMsg + id) : null;
    const params = deepParams(v.t, { today: v.at.slice(0, 10) });
    if (prev) params.messages = prev;
    const st = nextStep(params, r.message);
    if (st.cont) {
      if (v.round >= MAX_ROUNDS) { v.status = "error"; v.error = "웹 자료를 너무 오래 찾아 멈췄습니다."; }
      else {
        await redis("SET", K.deepMsg + id, JSON.stringify(st.cont), "EX", 3 * 86400);
        v.batch = await startBatch({ ...params, messages: st.cont });
        v.round += 1;
      }
    } else if (st.error) { v.status = "error"; v.error = st.error; }
    else {
      v.status = "done"; v.text = st.text; v.cut = !!st.cut; v.doneAt = new Date().toISOString();
      await redis("DEL", K.deepMsg + id);
    }
  }
  await redis("SET", K.deep + id, JSON.stringify(v), "EX", DEEP_TTL);
  // 다 되면 카톡으로 한 번 알림 (카톡 알림을 켠 경우)
  if (v.status !== "running" && KEY && (await redis("GET", K.tok))) {
    await sendMemo(v.status === "done" ? `🔬 ${v.t} 종합 기업분석 보고서가 나왔어요.` : `🔬 ${v.t} 기업분석 보고서를 만들지 못했어요: ${v.error}`,
      origin => origin + "/d/" + id, "보고서 열기").catch(() => {});
  }
  return v;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {};
  const ready = !!(URL_ && TOKEN && KEY);
  try {
    // 매일 아침 자동 확인 (Vercel Cron). CRON_SECRET 을 정해 두면 Vercel 만 부를 수 있다. 같은 날은 한 번만 보냄
    if (req.method === "GET" && q.action === "cron") {
      if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: "unauthorized" });
      if (!ready || !(await redis("GET", K.tok))) return res.status(200).json({ skipped: "not connected" });
      try {
        const r = await runCheck(false);
        return res.status(200).json({ date: r.date, checked: r.checked, events: r.events, sent: r.sent, skipped: r.skipped });
      } catch (e) {
        // 사이트의 카톡 알림 창에 보이도록 남김
        await redis("SET", K.last, JSON.stringify({ at: new Date().toISOString(), error: String((e && e.message) || e) }));
        throw e;
      }
    }
    // 매일 아침 리서치 보고서 (Vercel Cron)
    if (req.method === "GET" && q.action === "report") {
      if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: "unauthorized" });
      if (!ready || !(await redis("GET", K.tok))) return res.status(200).json({ skipped: "not connected" });
      const r = await runReport();
      return res.status(200).json({ date: r.date, sent: r.sent, errors: r.errors.length });
    }
    // 뉴스 수집·분석 (Vercel Cron). 카톡은 리서치 보고서 때 같이 보냄
    if (req.method === "GET" && q.action === "news") {
      if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: "unauthorized" });
      if (!(URL_ && TOKEN)) return res.status(200).json({ skipped: "no store" });
      const r = await runNews();
      return res.status(200).json({ count: r.count, tickers: (r.tickers || []).length, error: r.error || null });
    }
    // 새 후보 종목 찾기 (Vercel Cron, 월요일)
    if (req.method === "GET" && q.action === "discover") {
      if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: "unauthorized" });
      const r = await runDiscover();
      return res.status(200).json({ picks: r.picks ? r.picks.length : 0, scanned: r.scanned || 0, skipped: r.skipped || null });
    }
    // 🔬 심층 분석 보고서 페이지 (/d/<id>). 쓰는 중이면 열 때마다 진행 상황을 확인한다
    if (req.method === "GET" && q.deep) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("X-Robots-Tag", "noindex");
      const id = String(q.deep);
      let v = /^[a-f0-9]{32}$/.test(id) && URL_ && TOKEN ? await jget(K.deep + id) : null;
      if (!v) return res.status(404).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;padding:24px">보고서가 없거나 90일이 지나 지워졌습니다. <a href="/">사이트로</a></body>`);
      v = await deepAdvance(id, v);
      if (v.status === "done" && q.fmt === "doc") {
        res.setHeader("Content-Type", "application/msword; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(v.t)}-analysis-${v.doneAt.slice(0, 10)}.doc"`);
        return res.status(200).send("\ufeff" + deepDoc(v));
      }
      return res.status(200).send(v.status === "done" ? deepPage(v, { docHref: `/d/${id}?fmt=doc` }) : deepWaitPage(v));
    }
    // 카카오 로그인 후 돌아오는 곳
    // 리서치 보고서 페이지 (카톡 "보고서 열기")
    // 심층 분석 프롬프트 글 (무료로 내 Claude 채팅에 붙여 넣기용, 비용 없음)
    if (req.method === "GET" && q.action === "deepprompt") {
      const t = String(q.ticker || "").trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(t)) return res.status(400).json({ error: "종목 코드가 이상합니다." });
      return res.status(200).json({ text: deepPromptText(t, todayKst()) });
    }
    if (req.method === "GET" && q.view) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("X-Robots-Tag", "noindex");
      const v = /^([a-f0-9]{16}|[a-f0-9]{32})$/.test(String(q.view)) && URL_ && TOKEN ? await jget(K.view + q.view) : null;
      if (!v) return res.status(404).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;padding:24px">보고서가 없거나 45일이 지나 지워졌습니다. <a href="/">사이트로</a></body>`);
      return res.status(200).send(reportPage(v));
    }
    if (req.method === "GET" && (q.code || q.error)) {
      if (!ready) return page(res, false, "서버 설정이 아직 끝나지 않았습니다.");
      if (q.error) return page(res, false, "카카오 로그인이 취소됐거나 동의하지 않았습니다. (" + String(q.error_description || q.error).replace(/[<>&]/g, "") + ")");
      const st = String(q.state || "");
      if (!/^[a-f0-9]{32}$/.test(st) || !(await redis("GET", K.state + st))) return page(res, false, "연결 요청이 만료됐습니다. 사이트에서 다시 눌러 주세요.");
      await redis("DEL", K.state + st);
      let got;
      try {
        got = await kakaoToken({ grant_type: "authorization_code", redirect_uri: redirectOf(req), code: String(q.code) });
      } catch (e) {
        const m = String(e.message || e);
        // 흔한 원인을 쉬운 말로 (KOE010 = 클라이언트 시크릿, KOE006 = 리다이렉트 URI, KOE101 = 앱 키)
        const hint = /client credentials|KOE010/i.test(m)
          ? (SECRET ? "Vercel의 KAKAO_CLIENT_SECRET 값이 카카오 앱의 클라이언트 시크릿과 다릅니다." : "카카오 앱에 클라이언트 시크릿이 켜져 있습니다. 그 코드를 Vercel 환경 변수 KAKAO_CLIENT_SECRET 에 넣고 다시 배포해 주세요.")
          : /redirect/i.test(m) ? `카카오 앱의 리다이렉트 URI에 ${redirectOf(req)} 를 그대로 등록해 주세요.`
          : /client_id|invalid_client/i.test(m) ? "KAKAO_REST_API_KEY 값이 카카오 앱의 REST API 키와 다릅니다."
          : "";
        return page(res, false, "카카오 연결에 실패했습니다: " + m.replace(/[<>&]/g, "") + (hint ? "<br><b>" + hint.replace(/[<>&]/g, "") + "</b>" : ""));
      }
      const t = saveTok({ origin: originOf(req) }, got);
      await redis("SET", K.tok, JSON.stringify(t));
      try {
        await sendMemo("카카오톡 알림이 연결됐습니다. 매일 아침(미국 장 마감 뒤) 적용한 신호가 새로 나온 종목이 있으면 여기로 알려 드립니다.");
      } catch (e) {
        return page(res, false, "연결은 됐지만 시험 메시지를 보내지 못했습니다: " + String(e.message).replace(/[<>&]/g, "") + "<br>카카오 앱의 동의 항목에서 ‘카카오톡 메시지 전송’을 켰는지 확인해 주세요.");
      }
      return page(res, true, "카카오톡 알림이 연결됐습니다. 카톡에 시험 메시지를 보냈습니다.");
    }
    if (req.method === "GET") {
      const connected = ready ? await jget(K.tok) : null;
      return res.status(200).json({
        configured: ready, store: !!(URL_ && TOKEN), key: !!KEY, redirect: redirectOf(req),
        connected: !!connected, refreshUntil: connected && connected.rexp ? new Date(connected.rexp).toISOString() : null,
        last: ready ? await jget(K.last) : null,
      });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "POST만 됩니다" });
    const body0 = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    if (body0.action === "deep") {
      if (!URL_ || !TOKEN) return res.status(503).json({ error: "서버 저장소가 없습니다." });
      if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: "서버에 ANTHROPIC_API_KEY 가 없습니다." });
      const t = String(body0.ticker || "").trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(t)) return res.status(400).json({ error: "종목 코드가 이상합니다." });
      const bad0 = await pwError(String(body0.password || ""));
      if (bad0) return res.status(bad0[0]).json({ error: bad0[1] });
      const [code, out] = await deepStart(t);
      return res.status(code).json(code === 200 ? out : { error: out });
    }
    if (!ready) return res.status(503).json({ error: "카카오 앱 키(KAKAO_REST_API_KEY) 또는 서버 저장소가 아직 없습니다." });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const bad = await pwError(String(body.password || ""));
    if (bad) return res.status(bad[0]).json({ error: bad[1] });

    if (body.action === "start") {
      const st = crypto.randomBytes(16).toString("hex");
      await redis("SET", K.state + st, "1", "EX", 600);
      const u = new URL("https://kauth.kakao.com/oauth/authorize");
      u.search = new URLSearchParams({ client_id: KEY, redirect_uri: redirectOf(req), response_type: "code", scope: "talk_message", state: st }).toString();
      return res.status(200).json({ url: u.toString() });
    }
    if (body.action === "test") {
      await sendMemo("카카오톡 알림 시험 메시지입니다. 잘 받으셨다면 설정이 끝난 겁니다.");
      return res.status(200).json({ ok: true });
    }
    if (body.action === "check") return res.status(200).json(await runCheck(true));
    if (body.action === "report") return res.status(200).json(await runReport(true));
    if (body.action === "discover") {
      // 일주일 안에 찾았으면 다시 안 함
      const d = await jget(K.discover);
      if (d && d.picks && Date.now() - Date.parse(d.at) < 6.5 * 864e5 && !body.force) return res.status(200).json({ cached: true, picks: d.picks.length });
      const r = await runDiscover();
      return res.status(200).json({ picks: r.picks ? r.picks.length : 0, skipped: r.skipped || null });
    }
    if (body.action === "news") {
      // 오늘(30시간 안) 이미 분석했으면 다시 안 함 (Claude 비용)
      const n = await jget(K.news);
      if (n && !n.error && Date.now() - Date.parse(n.at) < 30 * 3600e3 && !body.force) return res.status(200).json({ cached: true, count: n.count });
      const r = await runNews();
      return res.status(200).json({ count: r.count, error: r.error || null });
    }
    if (body.action === "off") {
      await redis("DEL", K.tok);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: "action 은 start · test · check · off" });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
