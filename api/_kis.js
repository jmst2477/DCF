// 한국투자증권(KIS) Open API — 미국 주식 주문·조회만 쓴다. (한투 Open API에는 출금 기능이 없다)
// Vercel 환경 변수: KIS_APP_KEY, KIS_APP_SECRET, KIS_ACCOUNT(예: 12345678-01)
// 접근 토큰은 하루짜리이고 1분에 한 번만 새로 받을 수 있어 서버 저장소(Redis)에 보관해 같이 쓴다.
// 필드 이름은 한투 공식 예제(github.com/koreainvestment/open-trading-api, examples_llm/overseas_stock)를 따랐다.
// (파일 이름이 _ 로 시작해서 Vercel 이 주소로 열지 않는다)

export const KIS_BASE = "https://openapi.koreainvestment.com:9443";

export function kisConfig() {
  const key = process.env.KIS_APP_KEY || "", secret = process.env.KIS_APP_SECRET || "";
  const m = String(process.env.KIS_ACCOUNT || "").replace(/\s/g, "").match(/^(\d{8})-?(\d{2})$/);
  return { ok: !!(key && secret && m), key, secret, cano: m ? m[1] : "", prod: m ? m[2] : "", accountOk: !!m };
}

// 야후 거래소 이름 → 한투 거래소 코드 (ETF 가 많은 NYSE Arca·BATS 는 한투에서 AMEX 로 주문)
export function kisExchange(yahooExch) {
  const x = String(yahooExch || "").toUpperCase();
  if (["NMS", "NGM", "NCM", "NAS", "NASDAQ"].includes(x)) return "NASD";
  if (["NYQ", "NYS", "NYSE"].includes(x)) return "NYSE";
  if (["ASE", "PCX", "BTS", "BATS", "AMEX", "NYSEARCA"].includes(x)) return "AMEX";
  return null;
}

// fetchImpl·store 는 시험할 때 바꿔 넣는다. store = { get(k), set(k, v) } (JSON 값)
export function makeKis({ fetchImpl = fetch, store, cfg = kisConfig() } = {}) {
  const TOK = "agent:kis:tok";

  async function token() {
    const t = await store.get(TOK);
    if (t && t.access && t.exp - 10 * 60000 > Date.now()) return t.access;
    const r = await fetchImpl(KIS_BASE + "/oauth2/tokenP", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ grant_type: "client_credentials", appkey: cfg.key, appsecret: cfg.secret }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error("한투 접속 토큰 오류: " + (j.error_description || j.msg1 || j.error_code || r.status));
    await store.set(TOK, { access: j.access_token, exp: Date.now() + (Number(j.expires_in) || 86400) * 1000 });
    return j.access_token;
  }

  async function call(method, path, trId, params, trCont = "") {
    const headers = {
      "content-type": "application/json; charset=utf-8",
      authorization: "Bearer " + (await token()),
      appkey: cfg.key, appsecret: cfg.secret, tr_id: trId, custtype: "P", tr_cont: trCont,
    };
    const url = KIS_BASE + path + (method === "GET" ? "?" + new URLSearchParams(params).toString() : "");
    const r = await fetchImpl(url, { method, headers, body: method === "GET" ? undefined : JSON.stringify(params) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.rt_cd !== "0") throw new Error(`한투 ${trId} 실패: ${j.msg1 || j.msg_cd || r.status}`);
    const h = r.headers && r.headers.get ? r.headers.get("tr_cont") : "";
    return { j, more: h === "M" || h === "F" };
  }
  const acct = () => ({ CANO: cfg.cano, ACNT_PRDT_CD: cfg.prod });

  return {
    // 미국 보유 잔고 (NASD = 미국 전체)
    async balance() {
      const { j } = await call("GET", "/uapi/overseas-stock/v1/trading/inquire-balance", "TTTS3012R",
        { ...acct(), OVRS_EXCG_CD: "NASD", TR_CRCY_CD: "USD", CTX_AREA_FK200: "", CTX_AREA_NK200: "" });
      return (j.output1 || []).map(x => ({
        t: String(x.ovrs_pdno || "").trim(), qty: Number(x.ovrs_cblc_qty) || 0, sellable: Number(x.ord_psbl_qty) || 0,
        avg: Number(x.pchs_avg_pric) || 0, price: Number(x.now_pric2) || 0, value: Number(x.ovrs_stck_evlu_amt) || 0,
      })).filter(x => x.t && x.qty > 0);
    },
    // 주문 가능 달러·환율
    async buyingPower(exch, t, price) {
      const { j } = await call("GET", "/uapi/overseas-stock/v1/trading/inquire-psamount", "TTTS3007R",
        { ...acct(), OVRS_EXCG_CD: exch, OVRS_ORD_UNPR: String(price), ITEM_CD: t });
      const o = j.output || {};
      return { usd: Number(o.ord_psbl_frcr_amt) || 0, rate: Number(o.exrt) || 0, maxQty: Number(o.max_ord_psbl_qty) || 0 };
    },
    // 체결 내역 (날짜는 미국 현지 YYYYMMDD)
    async fills(from, to) {
      const out = [];
      let fk = "", nk = "", cont = "";
      for (let page = 0; page < 10; page++) {
        const { j, more } = await call("GET", "/uapi/overseas-stock/v1/trading/inquire-ccnl", "TTTS3035R", {
          ...acct(), PDNO: "%", ORD_STRT_DT: from, ORD_END_DT: to, SLL_BUY_DVSN: "00", CCLD_NCCS_DVSN: "01",
          OVRS_EXCG_CD: "%", SORT_SQN: "DS", ORD_DT: "", ORD_GNO_BRNO: "", ODNO: "", CTX_AREA_NK200: nk, CTX_AREA_FK200: fk,
        }, cont);
        (j.output || []).forEach(x => out.push({
          key: `${x.ord_dt}-${x.odno}`, date: x.ord_dt, t: String(x.pdno || "").trim(),
          side: x.sll_buy_dvsn_cd === "02" ? "buy" : x.sll_buy_dvsn_cd === "01" ? "sell" : "",
          qty: Number(x.ft_ccld_qty) || 0, price: Number(x.ft_ccld_unpr3) || 0,
        }));
        if (!more || !j.ctx_area_nk200) break;
        fk = j.ctx_area_fk200; nk = j.ctx_area_nk200; cont = "N";
      }
      return out.filter(x => x.side && x.qty > 0);
    },
    // 예약 주문 (미국 장 시작 때 나감, 한국 시간 10:00~23:20 접수, 서머타임엔 22:20). 매수는 지정가만, 매도는 지정가 또는 MOO(장 시작 시장가)
    async reserve(side, exch, t, qty, price) {
      const moo = side === "sell" && !(price > 0);
      const body = {
        ...acct(), PDNO: t, OVRS_EXCG_CD: exch, FT_ORD_QTY: String(qty), FT_ORD_UNPR3: moo ? "0" : Number(price).toFixed(2),
        ORD_SVR_DVSN_CD: "0", ORD_DVSN: moo ? "31" : "00",
      };
      const { j } = await call("POST", "/uapi/overseas-stock/v1/trading/order-resv", side === "buy" ? "TTTT3014U" : "TTTT3016U", body);
      const o = j.output || {};
      return { no: o.ODNO || o.OVRS_RSVN_ODNO || "", msg: j.msg1 || "" };
    },
  };
}
