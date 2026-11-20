// 한국투자증권(KIS) Open API — 미국 주식 주문·조회만 쓴다. (한투 Open API에는 출금 기능이 없다)
// Vercel 환경 변수: KIS_APP_KEY, KIS_APP_SECRET, KIS_ACCOUNT(예: 12345678-01) (2026-11-20 등록)
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

// 주문용 거래소 코드 → 시세 조회용 코드, 상품유형코드
const PRICE_EXCH = { NASD: "NAS", NYSE: "NYS", AMEX: "AMS" };
const PRDT_TYPE = { NASD: "512", NYSE: "513", AMEX: "529" };
// 시세 코드 → 야후 거래소 이름 (kisExchange 가 다시 알아보게)
const YAHOO_EXCH = { NAS: "NMS", NYS: "NYQ", AMS: "ASE" };
const num = v => Number(String(v ?? "").replace(/,/g, "")) || 0;
const day = s => String(s || "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");

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
      return { no: o.OVRS_RSVN_ODNO || o.ODNO || "", rcit: o.RSVN_ORD_RCIT_DT || "", msg: j.msg1 || "" };
    },
    // 예약 주문 목록 (접수일 기준, 한국 날짜 YYYYMMDD). 거부·미처리 이유도 같이 온다
    async resvList(from, to) {
      const out = [];
      let fk = "", nk = "", cont = "";
      for (let page = 0; page < 5; page++) {
        const { j, more } = await call("GET", "/uapi/overseas-stock/v1/trading/order-resv-list", "TTTT3039R", {
          ...acct(), INQR_STRT_DT: from, INQR_END_DT: to, INQR_DVSN_CD: "00", OVRS_EXCG_CD: "NASD", PRDT_TYPE_CD: "", CTX_AREA_FK200: fk, CTX_AREA_NK200: nk,
        }, cont);
        (j.output || []).forEach(x => out.push({
          rcit: x.rsvn_ord_rcit_dt, no: x.ovrs_rsvn_odno, t: String(x.pdno || "").trim(),
          side: x.sll_buy_dvsn_cd === "02" ? "buy" : x.sll_buy_dvsn_cd === "01" ? "sell" : "",
          qty: num(x.ft_ord_qty), price: num(x.ft_ord_unpr3), filled: num(x.ft_ccld_qty),
          canceled: x.cncl_yn === "Y", state: x.ovrs_rsvn_ord_stat_cd_name || "", reason: String(x.nprc_rson_text || "").trim(), exch: x.ovrs_excg_cd || "",
        }));
        if (!more || !j.ctx_area_nk200) break;
        fk = j.ctx_area_fk200; nk = j.ctx_area_nk200; cont = "N";
      }
      return out;
    },
    // 예약 주문 취소
    async cancelResv(rcit, no) {
      const { j } = await call("POST", "/uapi/overseas-stock/v1/trading/order-resv-ccnl", "TTTT3017U", { ...acct(), RSVN_ORD_RCIT_DT: rcit, OVRS_RSVN_ODNO: no });
      return { msg: j.msg1 || "" };
    },
    // 장중 미체결 주문 (직접 넣은 주문 포함, 미국 전체)
    async unfilled() {
      const { j } = await call("GET", "/uapi/overseas-stock/v1/trading/inquire-nccs", "TTTS3018R",
        { ...acct(), OVRS_EXCG_CD: "NASD", SORT_SQN: "", CTX_AREA_FK200: "", CTX_AREA_NK200: "" });
      return (j.output || []).map(x => ({
        no: x.odno, date: day(x.ord_dt), t: String(x.pdno || "").trim(), exch: x.ovrs_excg_cd,
        side: x.sll_buy_dvsn_cd === "02" ? "buy" : "sell", qty: num(x.ft_ord_qty), left: num(x.nccs_qty), price: num(x.ft_ord_unpr3),
      })).filter(x => x.left > 0);
    },
    // 장중 주문 취소
    async cancelOrder(exch, t, no, qty) {
      const { j } = await call("POST", "/uapi/overseas-stock/v1/trading/order-rvsecncl", "TTTT1004U", {
        ...acct(), OVRS_EXCG_CD: exch, PDNO: t, ORGN_ODNO: no, RVSE_CNCL_DVSN_CD: "02", ORD_QTY: String(qty), OVRS_ORD_UNPR: "0", MGCO_APTM_ODNO: "", ORD_SVR_DVSN_CD: "0",
      });
      return { msg: j.msg1 || "" };
    },
    // 기간 실현 손익 (미국, 달러). rows = 종목·매매일별, total = 합계 (수수료·세금 반영된 한투 숫자)
    async periodProfit(from, to) {
      const rows = [];
      let fk = "", nk = "", cont = "", total = null;
      for (let page = 0; page < 5; page++) {
        const { j, more } = await call("GET", "/uapi/overseas-stock/v1/trading/inquire-period-profit", "TTTS3039R", {
          ...acct(), OVRS_EXCG_CD: "NASD", NATN_CD: "", CRCY_CD: "USD", PDNO: "", INQR_STRT_DT: from, INQR_END_DT: to, WCRC_FRCR_DVSN_CD: "01", CTX_AREA_FK200: fk, CTX_AREA_NK200: nk,
        }, cont);
        (j.output1 || []).forEach(x => rows.push({ date: day(x.trad_day), t: String(x.ovrs_pdno || "").trim(), qty: num(x.slcl_qty), pnl: num(x.ovrs_rlzt_pfls_amt) }));
        const o2 = Array.isArray(j.output2) ? j.output2[0] : j.output2;
        if (o2 && total == null) total = num(o2.ovrs_rlzt_pfls_tot_amt);
        if (!more || !j.ctx_area_nk200) break;
        fk = j.ctx_area_fk200; nk = j.ctx_area_nk200; cont = "N";
      }
      return { rows, total: total ?? rows.reduce((s, r) => s + r.pnl, 0) };
    },
    // 배당·액면분할·병합 등 권리 (현지 기준일, YYYYMMDD). exch = NASD/NYSE/AMEX
    async rights(t, exch, from, to) {
      const { j } = await call("GET", "/uapi/overseas-price/v1/quotations/period-rights", "CTRGT011R", {
        RGHT_TYPE_CD: "%%", INQR_DVSN_CD: "02", INQR_STRT_DT: from, INQR_END_DT: to, PDNO: t, PRDT_TYPE_CD: PRDT_TYPE[exch] || "512", NK50: "", FK50: "",
      });
      const KIND = { "03": "배당", "75": "특별배당", "14": "액면분할", "15": "액면병합", "17": "감자", "11": "합병", "02": "무상" };
      return (j.output || j.output1 || []).filter(x => String(x.pdno || "").trim() === t || !x.pdno).map(x => ({
        code: x.rght_type_cd, kind: KIND[x.rght_type_cd] || "권리", date: day(x.acpl_bass_dt || x.bass_dt),
        stockRate: num(x.stck_alct_rt), cash: num(x.stkp_dvdn_frcr_amt2), fixed: x.dfnt_yn === "Y",
      }));
    },
    // 일봉 (야후가 안 될 때 예비). 수정주가, 최신 100개씩 pages 번. 거래소를 모르면 나스닥→뉴욕→아멕스 순으로 찾음
    async daily(t, exch, pages = 3) {
      const tries = exch ? [PRICE_EXCH[exch] || exch] : ["NAS", "NYS", "AMS"];
      for (const ex of tries) {
        const rows = [];
        let bymd = "";
        for (let p = 0; p < pages; p++) {
          const { j } = await call("GET", "/uapi/overseas-price/v1/quotations/dailyprice", "HHDFS76240000", { AUTH: "", EXCD: ex, SYMB: t, GUBN: "0", BYMD: bymd, MODP: "1" });
          const o = (j.output2 || []).filter(x => x.xymd && num(x.clos) > 0);
          if (!o.length) break;
          rows.push(...o);
          const oldest = o[o.length - 1].xymd;
          bymd = day(oldest) ? new Date(Date.parse(day(oldest) + "T12:00:00Z") - 864e5).toISOString().slice(0, 10).replace(/-/g, "") : "";
          if (o.length < 100) break;
        }
        if (!rows.length) continue;
        const seen = new Set();
        const asc = rows.filter(x => !seen.has(x.xymd) && seen.add(x.xymd)).sort((a, b) => (a.xymd < b.xymd ? -1 : 1));
        return {
          time: asc.map(x => day(x.xymd)), open: asc.map(x => num(x.open)), high: asc.map(x => num(x.high)), low: asc.map(x => num(x.low)),
          close: asc.map(x => num(x.clos)), volume: asc.map(x => num(x.tvol)), exch: YAHOO_EXCH[ex], source: "한투",
        };
      }
      throw new Error(`한투 일봉 없음: ${t}`);
    },
    // 해외 뉴스 제목 (한투 HTS 해외뉴스종합, 종목별)
    async news(t) {
      const { j } = await call("GET", "/uapi/overseas-price/v1/quotations/news-title", "HHPSTH60100C1", {
        INFO_GB: "", CLASS_CD: "", NATION_CD: "US", EXCHANGE_CD: "", SYMB: t, DATA_DT: "", DATA_TM: "", CTS: "",
      });
      return (j.outblock1 || j.output || j.output1 || []).filter(x => x && x.title).map(x => {
        const d = String(x.data_dt || ""), tm = String(x.data_tm || "").padEnd(6, "0");
        const at = /^\d{8}$/.test(d) ? Date.parse(`${day(d)}T${tm.slice(0, 2)}:${tm.slice(2, 4)}:00+09:00`) : 0;
        return { title: String(x.title).trim().slice(0, 200), pub: x.source || "한투", at: isFinite(at) ? at : 0, link: "" };
      });
    },
    // 조건검색: 시가총액(천 달러)·주가·거래량 조건으로 미국 종목 찾기. excd = NAS/NYS/AMS
    async search(excd, { minCapK = 0, minPrice = 0, minVol = 0 } = {}) {
      const q = { AUTH: "", EXCD: excd, KEYB: "" };
      if (minPrice) Object.assign(q, { CO_YN_PRICECUR: "1", CO_ST_PRICECUR: String(minPrice), CO_EN_PRICECUR: "100000" });
      if (minCapK) Object.assign(q, { CO_YN_VALX: "1", CO_ST_VALX: String(minCapK), CO_EN_VALX: "99999999999" });
      if (minVol) Object.assign(q, { CO_YN_VOLUME: "1", CO_ST_VOLUME: String(minVol), CO_EN_VOLUME: "99999999999" });
      for (const k of ["PRICECUR", "RATE", "VALX", "SHAR", "VOLUME", "AMT", "EPS", "PER"]) for (const p of ["YN", "ST", "EN"]) if (q[`CO_${p}_${k}`] == null) q[`CO_${p}_${k}`] = "";
      const { j } = await call("GET", "/uapi/overseas-price/v1/quotations/inquire-search", "HHDFS76410000", q);
      return (j.output2 || []).filter(x => x && x.symb).map(x => ({
        t: String(x.symb).trim(), excd: x.excd || excd, name: x.name || x.ename || "", price: num(x.last), capK: num(x.valx), vol: num(x.tvol),
        per: num(x.per), eps: num(x.eps), rate: num(x.rate), tradable: x.e_ordyn !== "N" && x.e_ordyn !== "X",
      }));
    },
  };
}
