// Vercel 서버리스 함수: /api/sync
// 관심종목과 "＋ 추가"로 넣은 신호·지표를 PC·휴대폰이 같이 쓰도록 Upstash Redis 에 저장한다.
// Vercel → Storage → Upstash for Redis 를 이 프로젝트에 연결하면 KV_REST_API_URL / KV_REST_API_TOKEN 이 생긴다.
// 비밀번호: 처음 연결할 때 정한 것을 해시(scrypt)로만 저장하고, 읽기·쓰기 모두 비밀번호가 맞아야 한다.
//   GET  → { configured, hasPassword }
//   POST { action: 'pull' | 'push', password, state? } → { state } / { ok, updatedAt }

import crypto from "node:crypto";

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const K = { pw: "dcf:sync:pw", state: "dcf:sync:state", fails: "dcf:sync:fails" };
const MAX_FAILS = 20; // 한 시간에 틀린 비밀번호 허용 횟수

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

// 받은 내용 검사: 모양이 이상하거나 너무 크면 거절
const str = (v, max) => typeof v === "string" && v.length <= max;
function cleanState(s) {
  if (!s || typeof s !== "object") throw new Error("저장할 내용이 없습니다");
  const watch = Array.isArray(s.watch) ? s.watch.filter(t => str(t, 15) && /^[A-Z0-9.\-^=]+$/.test(t)).slice(0, 300) : [];
  const customs = (Array.isArray(s.customs) ? s.customs : [])
    .filter(x => x && str(x.id, 40) && (x.kind === "strategy" || x.kind === "indicator") && str(x.name, 80) && str(x.code, 60000))
    .slice(0, 100)
    .map(x => ({ id: x.id, kind: x.kind, name: x.name, code: x.code, color: str(x.color, 20) && /^#[0-9a-fA-F]{6}$/.test(x.color) ? x.color : "#00897b", desc: str(x.desc, 2000) ? x.desc : "" }));
  return { watch, customs, updatedAt: new Date().toISOString() };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!URL_ || !TOKEN) return res.status(req.method === "GET" ? 200 : 503).json({ configured: false, error: "저장소(Upstash Redis)가 아직 연결되지 않았습니다." });
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
      // 처음: 이 비밀번호로 저장소를 만든다 (이미 누가 만들었으면 NX 로 실패 → 다시 확인)
      const salt = crypto.randomBytes(16).toString("hex");
      created = (await redis("SET", K.pw, `${salt}:${hash(pw, salt)}`, "NX")) === "OK";
      if (!created && !checkPw(pw, await redis("GET", K.pw))) return res.status(401).json({ error: "비밀번호가 맞지 않습니다." });
    } else if (!checkPw(pw, stored)) {
      const n = await redis("INCR", K.fails);
      if (n === 1) await redis("EXPIRE", K.fails, 3600);
      return res.status(401).json({ error: "비밀번호가 맞지 않습니다." });
    }

    if (body.action === "pull") {
      const raw = await redis("GET", K.state);
      return res.status(200).json({ created, state: raw ? JSON.parse(raw) : null });
    }
    if (body.action === "push") {
      const state = cleanState(body.state);
      const raw = JSON.stringify(state);
      if (raw.length > 900000) return res.status(413).json({ error: "저장할 내용이 너무 큽니다." });
      await redis("SET", K.state, raw);
      return res.status(200).json({ ok: true, created, updatedAt: state.updatedAt });
    }
    return res.status(400).json({ error: "action 은 pull 또는 push" });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
