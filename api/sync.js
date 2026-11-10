// Vercel 서버리스 함수: /api/sync
// 여러 브라우저(PC·휴대폰)의 종목·신호·손절익절 설정을 자동으로 똑같이 맞추려고 서버 저장소(Redis)에 한 벌 저장한다.
// 저장소: Vercel → Storage → "Upstash for Redis"(무료)를 이 프로젝트에 연결하면 KV_REST_API_URL / KV_REST_API_TOKEN 이 자동으로 생긴다.
//   (이름 앞에 다른 말이 붙어도, UPSTASH_REDIS_REST_URL / _TOKEN 이어도 찾아 쓴다)
// 비밀번호: 처음 켤 때 정한 것을 해시(scrypt)로만 저장. 읽기·쓰기 모두 비밀번호가 맞아야 하고, 한 시간에 20번 넘게 틀리면 막는다.
//   GET  → { configured, hasPassword }
//   POST { action: 'pull' | 'push', password, data? } → { created, data, updatedAt }
// Claude API 키는 브라우저가 보내지 않고, 여기서도 정해진 설정 이름만 받는다.

import crypto from "node:crypto";

function env(suffixes) {
  for (const s of suffixes) if (process.env[s]) return process.env[s];
  const k = Object.keys(process.env).find(k => suffixes.some(s => k.endsWith("_" + s)) && process.env[k]);
  return k ? process.env[k] : "";
}
const URL_ = env(["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"]);
const TOKEN = env(["KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN"]);
const K = { pw: "dcf:sync2:pw", data: "dcf:sync2:data", fails: "dcf:sync2:fails" };
const MAX_FAILS = 20;

// 브라우저와 같은 목록 (js/app.js 의 XFER_KEYS)
const KEYS = ["dcf-watchlist", "dcf-holdings", "dcf-themes", "dcf-theme-pick", "dcf-wl-open", "dcf-strategy-id", "dcf-indicators-off",
  "dcf-custom-items", "dcf-hidden-items", "dcf-deleted-items", "dcf-sltp", "dcf-backtest"];

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

const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString("hex");
function checkPw(pw, stored) {
  const [salt, h] = String(stored).split(":");
  const a = Buffer.from(hash(pw, salt), "hex"), b = Buffer.from(h || "", "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cleanData(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("저장할 내용이 없습니다");
  const out = {};
  for (const k of KEYS) if (k in d) out[k] = d[k];
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!URL_ || !TOKEN) return res.status(req.method === "GET" ? 200 : 503).json({ configured: false, error: "서버 저장소가 아직 연결되지 않았습니다." });
  try {
    if (req.method === "GET") return res.status(200).json({ configured: true, hasPassword: !!(await redis("GET", K.pw)) });
    if (req.method !== "POST") return res.status(405).json({ error: "POST만 됩니다" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const pw = String(body.password || "");
    if (pw.length < 4 || pw.length > 100) return res.status(400).json({ error: "비밀번호는 4자 이상이어야 합니다." });
    if (Number(await redis("GET", K.fails)) >= MAX_FAILS) return res.status(429).json({ error: "비밀번호를 너무 많이 틀렸습니다. 한 시간 뒤에 다시 해 주세요." });

    const stored = await redis("GET", K.pw);
    let created = false;
    if (!stored) {
      const salt = crypto.randomBytes(16).toString("hex");
      created = (await redis("SET", K.pw, `${salt}:${hash(pw, salt)}`, "NX")) === "OK";
      if (!created && !checkPw(pw, await redis("GET", K.pw))) return res.status(401).json({ error: "비밀번호가 맞지 않습니다." });
    } else if (!checkPw(pw, stored)) {
      const n = await redis("INCR", K.fails);
      if (n === 1) await redis("EXPIRE", K.fails, 3600);
      return res.status(401).json({ error: "비밀번호가 맞지 않습니다." });
    }

    if (body.action === "pull") {
      const raw = await redis("GET", K.data);
      const s = raw ? JSON.parse(raw) : null;
      return res.status(200).json({ created, data: s ? s.data : null, updatedAt: s ? s.updatedAt : null });
    }
    if (body.action === "push") {
      const s = { data: cleanData(body.data), updatedAt: new Date().toISOString() };
      const raw = JSON.stringify(s);
      if (raw.length > 900000) return res.status(413).json({ error: "저장할 내용이 너무 큽니다." });
      await redis("SET", K.data, raw);
      return res.status(200).json({ ok: true, created, updatedAt: s.updatedAt });
    }
    return res.status(400).json({ error: "action 은 pull 또는 push" });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
