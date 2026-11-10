// Vercel 서버리스 함수: /api/kakao — 종목별로 적용한 신호가 새로 나오면 내 카카오톡("나에게 보내기")으로 알린다.
// 준비 (한 번만):
//   1) developers.kakao.com 에서 앱을 만들고 카카오 로그인 켜기, 동의 항목 "카카오톡 메시지 전송(talk_message)" 켜기,
//      Redirect URI 에 https://<사이트 주소>/api/kakao 등록, 플랫폼 Web 사이트 도메인에 https://<사이트 주소> 등록
//   2) Vercel 환경 변수 KAKAO_REST_API_KEY = 앱의 REST API 키 (클라이언트 시크릿을 켰다면 KAKAO_CLIENT_SECRET 도)
//   3) 사이트 "💬 카톡 알림"에서 카카오 로그인 한 번 → 토큰을 서버 저장소(Upstash)에 보관, 만료 전에 알아서 갱신
// 매일 아침 Vercel Cron(vercel.json)이 GET /api/kakao?action=cron 을 부르면 동기화된 관심 종목을 확인해 새 신호가 있을 때만 보낸다.
// 사이트에서 부르는 것은 모두 동기화 비밀번호가 맞아야 한다 (api/sync.js 와 같은 비밀번호·잠금).
//   GET                         → { configured, connected, redirect, last }
//   POST { action, password }  action = start(로그인 주소) | test(시험 보내기) | check(지금 확인해서 보내기) | off(연결 끊기)

import crypto from "node:crypto";
import { checkAll, messages } from "./_signals.js";

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
  tok: "dcf:kakao:tok", state: "dcf:kakao:state:", sent: "dcf:kakao:sent", last: "dcf:kakao:last",
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
async function sendMemo(text, link) {
  const t = await accessToken();
  const tpl = { object_type: "text", text: text.slice(0, 200), link: { web_url: link || t.origin, mobile_web_url: link || t.origin }, button_title: "사이트 열기" };
  const r = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${t.access}`, "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: new URLSearchParams({ template_object: JSON.stringify(tpl) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.result_code !== 0) throw new Error("카카오톡 보내기 실패: " + (j.msg || j.result_code || r.status));
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

const page = (res, ok, text) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(ok ? 200 : 400).send(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>카카오톡 알림</title>` +
      `<body style="font-family:sans-serif;padding:24px;line-height:1.6"><p>${text}</p><p><a href="/">사이트로 돌아가기</a></p>` +
      (ok ? `<script>setTimeout(()=>location.href='/?kakao=ok',1200)</script>` : "")
  );
};

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
    // 카카오 로그인 후 돌아오는 곳
    if (req.method === "GET" && (q.code || q.error)) {
      if (!ready) return page(res, false, "서버 설정이 아직 끝나지 않았습니다.");
      if (q.error) return page(res, false, "카카오 로그인이 취소됐거나 동의하지 않았습니다. (" + String(q.error_description || q.error).replace(/[<>&]/g, "") + ")");
      const st = String(q.state || "");
      if (!/^[a-f0-9]{32}$/.test(st) || !(await redis("GET", K.state + st))) return page(res, false, "연결 요청이 만료됐습니다. 사이트에서 다시 눌러 주세요.");
      await redis("DEL", K.state + st);
      const t = saveTok({ origin: originOf(req) }, await kakaoToken({ grant_type: "authorization_code", redirect_uri: redirectOf(req), code: String(q.code) }));
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
    if (body.action === "off") {
      await redis("DEL", K.tok);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: "action 은 start · test · check · off" });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
