/* global DCF, SAParser, SAPdf, Tesseract, ExcelJS */
// DCF: 시킹알파 재무제표 PDF 읽기
// js/app/ 파일들은 한 화면 코드를 기능별로 나눈 것. index.html 에 적힌 순서대로 불러오고, 서로의 이름(함수·변수)을 그대로 씀.
'use strict';

// ---------- 시킹알파 재무제표 PDF → 실적·현금·차입금·주식수 덮어쓰기 ----------
// PDF 3개(Income Statement, Balance Sheet, Cash Flow, Annual)를 읽어 야후 값 대신 쓴다.
// 주가·베타·매출 컨센서스는 PDF에 없으므로 티커 조회 값(또는 현재 입력값)을 그대로 둔다.
const PDFJS = CDN + 'pdfjs-dist@3.11.174/build/';
let pdfjsReady = null;
function loadPdfJs() {
  if (!pdfjsReady) {
    pdfjsReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PDFJS + 'pdf.min.js';
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; resolve(window.pdfjsLib); };
      s.onerror = () => { pdfjsReady = null; reject(new Error('PDF 읽기 도구를 불러오지 못했습니다')); };
      document.head.appendChild(s);
    });
  }
  return pdfjsReady;
}
async function readPdf(file) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    pages.push(tc.items.map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width })));
  }
  return SAPdf.parsePages(pages);
}

const KIND_KO = { income: '손익계산서', balance: '대차대조표', cashflow: '현금흐름표' };
async function handlePdfs(files) {
  const out = $('#pdf-result');
  files = [...files].filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!files.length) return;
  out.innerHTML = '<p class="muted small">PDF 읽는 중...</p>';
  try {
    const st = {};
    const unknown = [];
    for (const f of files) {
      const r = await readPdf(f);
      if (r.kind && r.columns.length) st[r.kind] = r; else unknown.push(f.name);
    }
    if (!Object.keys(st).length) throw new Error('시킹알파 재무제표 PDF가 아닌 것 같습니다 (표 제목·연도 열을 못 찾음)');
    const p = SAPdf.toInputs(st);
    applyPdf(p, unknown);
  } catch (err) {
    out.innerHTML = `<p class="neg small">PDF 읽기 실패: ${esc(err.message)}</p>`;
  }
}

function applyPdf(p, unknown) {
  const prev = state;
  const hadLookup = !!(lastLookup && lastLookup.ticker === prev.ticker);
  const base = hadLookup ? lastLookup : {
    ticker: prev.ticker, companyName: prev.ticker, currentPrice: prev.price, beta: prev.beta,
    sharesOutstandingMillions: prev.shares, cash: prev.cash, debt: prev.debt, debtNote: '입력값', history: [], estimates: [],
  };
  // 연도별: PDF 값이 있으면 PDF, 없으면 조회 값
  const baseH = new Map((base.history || []).map(x => [x.fy, x]));
  const years = p.history.length ? p.history : base.history || [];
  const history = years.map(x => {
    const b = baseH.get(x.fy) || {};
    const m = { ...b };
    for (const [k, v] of Object.entries(x)) if (v != null) m[k] = v;
    return m;
  });
  if (!history.length || !history[history.length - 1].revenue) {
    $('#pdf-result').innerHTML = '<p class="neg small">매출 실적이 없습니다. 손익계산서 PDF를 함께 올리거나 먼저 티커를 조회하세요.</p>';
    return;
  }
  const b = p.balance;
  const merged = {
    ...base, history,
    source: '시킹알파 PDF' + (hadLookup ? ' + 야후(주가·컨센서스)' : ''),
    sharesOutstandingMillions: b && b.shares ? b.shares : base.sharesOutstandingMillions,
    cash: b && b.cash != null ? b.cash : base.cash,
    debt: b && b.debt != null ? b.debt : base.debt,
    debtNote: b && b.debt != null ? '단기+유동성장기+장기차입금 (리스·금융 자회사 제외)' : base.debtNote,
    balanceDate: b ? b.column : base.balanceDate,
  };
  const next = assumptionsFrom(merged);
  // 같은 종목이면 이미 넣어 둔 매출 추정치(시킹알파 캡처 등)와 예측 기간은 그대로 둔다
  if (prev.ticker && prev.ticker === next.ticker && prev.baseFY === next.baseFY) {
    for (let t = 1; t <= N; t++) { next.revenue[t] = prev.revenue[t]; next.growth[t] = prev.growth[t]; }
    next.revAssumed = prev.revAssumed;
    next.horizon = prev.horizon;
    next.wacc = prev.wacc; next.g = prev.g; next.rf = prev.rf; next.erp = prev.erp;
    next.estRaw = prev.estRaw;
    applyMetricEstimates(next); // 캡처한 EBIT·EBITDA·캐펙스 추정치는 PDF 실적보다 우선
    next.basic = prev.basic;
  }
  // 운전자본은 PDF에서 금융 자회사 채권을 뺀 값이므로 20% 상한 안내는 필요 없음
  const last = history[history.length - 1];
  if (p.kinds.includes('balance') && last.nwcPct != null) {
    next.nwc = Array(N + 1).fill(+Math.max(-0.1, Math.min(0.5, last.nwcPct)).toFixed(4));
    next.nwcNote = '';
  }
  basicRefresh(next);

  const rows = [
    ['매출 (0년차)', prev.revenue[0], next.revenue[0], fmt],
    ['영업이익률', prev.margin[1], next.margin[1], pct],
    ['감가상각비/매출', prev.da[1], next.da[1], v => pct(v, 2)],
    ['캐펙스/매출', prev.capex[1], next.capex[1], v => pct(v, 2)],
    ['운전자본/매출', prev.nwc[1], next.nwc[1], pct],
    ['법인세율', prev.tax, next.tax, pct],
    ['발행주식수 (백만 주)', prev.shares, next.shares, v => fmt(v, 1)],
    ['현금+단기투자', prev.cash, next.cash, fmt],
    ['차입금', prev.debt, next.debt, fmt],
  ];
  const prevPS = activeResult().perShare;
  state = next;
  lastLookup = merged;
  renderAll();
  renderHistory(merged);
  const nowPS = activeResult().perShare;
  const notes = [];
  if (b && (b.financeDebt || b.financeLoans)) {
    notes.push(`금융 자회사(Finance Div.) 차입금 ${fmt(b.financeDebt)}와 대출채권 ${fmt(b.financeLoans)}은 차입금·운전자본에서 뺐습니다.`);
  }
  if (b && b.column === 'Last Report') notes.push('현금·차입금·주식수는 가장 최근 분기(Last Report) 값입니다.');
  const missing = ['income', 'balance', 'cashflow'].filter(k => !p.kinds.includes(k));
  if (missing.length) notes.push(`${missing.map(k => KIND_KO[k]).join(', ')} PDF가 없어 그 항목은 기존 값을 썼습니다.`);
  if (unknown.length) notes.push(`읽지 못한 파일: ${unknown.map(esc).join(', ')}`);
  if (!hadLookup) notes.push('주가·매출 컨센서스는 PDF에 없습니다. 티커를 먼저 조회하면 함께 채워집니다.');
  const same = (a, c) => a != null && c != null && Math.abs(a - c) <= Math.max(1e-4, Math.abs(c) * 1e-4);
  $('#pdf-result').innerHTML =
    `<p class="small"><b>${p.kinds.map(k => KIND_KO[k]).join(' · ')} PDF 값을 넣었습니다.</b> 1주당 가치 $${fmt(prevPS, 2)} → <b>$${fmt(nowPS, 2)}</b></p>` +
    `<div class="table-scroll"><table class="grid"><thead><tr><th>항목</th><th>이전 값</th><th>PDF 값</th></tr></thead><tbody>` +
    rows.map(([l, a, c, f]) => `<tr><td>${l}</td><td class="muted">${f(a)}</td><td${same(a, c) ? '' : ' class="pos"'}>${f(c)}</td></tr>`).join('') +
    '</tbody></table></div>' +
    (notes.length ? `<p class="muted small">${notes.join('<br>')}</p>` : '');
}

const pdfDrop = $('#pdf-drop');
pdfDrop.addEventListener('click', () => $('#pdf-file').click());
pdfDrop.addEventListener('keydown', e => { if (e.key === 'Enter') $('#pdf-file').click(); });
$('#pdf-file').addEventListener('change', e => { handlePdfs(e.target.files); e.target.value = ''; });
pdfDrop.addEventListener('dragover', e => { e.preventDefault(); pdfDrop.classList.add('over'); });
pdfDrop.addEventListener('dragleave', () => pdfDrop.classList.remove('over'));
pdfDrop.addEventListener('drop', e => { e.preventDefault(); pdfDrop.classList.remove('over'); handlePdfs(e.dataTransfer.files); });
