/* 시킹알파 재무제표 PDF(Income Statement / Balance Sheet / Cash Flow, Annual) 읽기.
 * 시킹알파 → Financials → 각 표 → 다운로드한 PDF는 글자가 들어 있는 PDF라 OCR 없이 정확히 읽힌다.
 * 레이아웃: 왼쪽에 항목 이름(여러 줄로 접힘), 오른쪽에 열(TTM 또는 Last Report, Dec 2025, Dec 2024 ...).
 * 숫자는 각 열 제목과 오른쪽 끝이 맞춰져 있고, 항목 이름 블록의 세로 가운데쯤에 놓인다.
 * 브라우저에서는 window.SAPdf, Node에서는 module.exports 로 쓴다. */
(function (root) {
  'use strict';

  const NUM_RE = /^\(?-?\$?[\d,]*\.?\d+%?\)?$/;
  const COL_RE = /^(TTM|Last Report|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4})$/;
  const LABEL_X = 40; // 항목 이름은 왼쪽 여백(x≈27)에서 시작

  // pdf.js 글자 조각 → 같은 줄에서 붙어 있는 조각끼리 합친 토큰
  function tokens(items) {
    const its = items
      .filter(it => it.str && it.str.trim())
      .map(it => ({ str: it.str, x: it.x, y: it.y, r: it.x + it.w }))
      .sort((a, b) => b.y - a.y || a.x - b.x);
    const out = [];
    for (const it of its) {
      const last = out[out.length - 1];
      const gap = last ? it.x - last.r : Infinity;
      if (last && Math.abs(last.y - it.y) < 1.5 && gap > -1 && gap < 4) {
        last.str += (gap > 1 ? ' ' : '') + it.str;
        last.r = it.r;
      } else out.push({ ...it });
    }
    out.forEach(t => { t.str = t.str.replace(/\s+/g, ' ').trim(); });
    return out;
  }

  function num(s) {
    if (s === '-' || s === '–') return null;
    let neg = false;
    let t = s;
    if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
    const isPct = t.endsWith('%');
    t = t.replace(/[$,%]/g, '');
    let v = parseFloat(t);
    if (!Number.isFinite(v)) return null;
    if (neg) v = -v;
    return isPct ? v / 100 : v;
  }

  // 한 PDF(여러 쪽) → { kind, unit, columns:[이름], rows: { 정규화된 항목명: {열이름: 값} } }
  function parsePages(pages) {
    let kind = null, unit = 1, cols = null;
    const rows = {};
    const order = [];
    for (const items of pages) {
      const toks = tokens(items);
      for (const t of toks) {
        if (!kind) {
          if (/^INCOME STATEMENT/i.test(t.str)) kind = 'income';
          else if (/^BALANCE SHEET/i.test(t.str)) kind = 'balance';
          else if (/^CASH FLOW/i.test(t.str)) kind = 'cashflow';
        }
        const m = /In (Thousands|Millions|Billions) of/i.exec(t.str);
        if (m) unit = { thousands: 0.001, millions: 1, billions: 1000 }[m[1].toLowerCase()];
      }
      // 열 제목 줄: 열 이름 토큰이 3개 이상 있는 줄
      const byY = new Map();
      for (const t of toks) {
        const k = Math.round(t.y);
        if (!byY.has(k)) byY.set(k, []);
        byY.get(k).push(t);
      }
      for (const line of byY.values()) {
        const hs = line.filter(t => COL_RE.test(t.str));
        if (hs.length >= 3) { cols = hs.sort((a, b) => a.x - b.x).map(t => ({ name: t.str, r: t.r, y: t.y })); break; }
      }
      if (!cols) continue;
      const headerY = cols[0].y;

      // 숫자 → (줄 y, 열)
      const numRows = new Map();
      for (const t of toks) {
        if (t.x < LABEL_X || t.y >= headerY - 1 || !NUM_RE.test(t.str) && t.str !== '-') continue;
        let best = null, bd = 9;
        for (const c of cols) { const d = Math.abs(c.r - t.r); if (d < bd) { bd = d; best = c; } }
        if (!best) continue;
        const k = Math.round(t.y);
        if (!numRows.has(k)) numRows.set(k, { y: t.y, vals: {} });
        numRows.get(k).vals[best.name] = num(t.str);
      }

      // 항목 이름 줄을 블록으로 묶음 (줄 간격 ~8pt, 항목 사이 ~16pt)
      const labels = toks.filter(t => t.x < LABEL_X && t.y < headerY - 1 && !COL_RE.test(t.str));
      const blocks = [];
      for (const t of labels) {
        const b = blocks[blocks.length - 1];
        if (b && b.minY - t.y <= 10) { b.parts.push(t.str); b.minY = t.y; } else blocks.push({ parts: [t.str], maxY: t.y, minY: t.y });
      }
      for (const r of numRows.values()) {
        let best = null, bd = Infinity;
        for (const b of blocks) {
          if (r.y > b.maxY + 3 || r.y < b.minY - 3) continue;
          const d = Math.abs((b.maxY + b.minY) / 2 - r.y);
          if (d < bd) { bd = d; best = b; }
        }
        if (!best) continue;
        if (best.key == null) {
          // 같은 이름이 두 번 나오면 (예: 유동/비유동 Finance Div. Loans and Leases) 뒤에 번호를 붙임
          let key = norm(best.parts.join(' ')), n = 2;
          while (rows[key]) key = norm(best.parts.join(' ')) + ' #' + n++;
          best.key = key; rows[key] = {}; order.push(key);
        }
        Object.assign(rows[best.key], r.vals);
      }
    }
    // 금액 단위를 백만 달러로 (주당 값·비율·주식수는 그대로 둠)
    if (unit !== 1) {
      for (const k of order) {
        if (/per share|eps|rate|ratio|margin|shares|employees/.test(k)) continue;
        for (const c of Object.keys(rows[k])) if (rows[k][c] != null) rows[k][c] *= unit;
      }
    }
    return { kind, unit, columns: cols ? cols.map(c => c.name) : [], rows, order };
  }

  const norm = s => s.toLowerCase().replace(/\s+/g, ' ').trim();

  // 여러 이름 중 처음 있는 항목
  function pick(st, names) {
    if (!st) return null;
    for (const n of names) if (st.rows[n]) return st.rows[n];
    return null;
  }
  const val = (row, col) => (row && row[col] != null ? row[col] : null);
  const round = (v, d = 4) => (v != null && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
  const annualCols = st => (st ? st.columns.filter(c => /\d{4}$/.test(c)) : []);
  const fyOf = c => Number(c.slice(-4));

  /* 세 표 → /api/dcf-inputs 와 같은 모양의 값 (없는 항목은 null)
   * 금융 자회사(시킹알파 표기 "Finance Div.", 예: Cat Financial)의 대출채권과 차입금은 제외한다.
   * 영업용 운전자본 = 매출채권 + 재고 − 매입채무 − 미지급비용, 차입금 = 단기차입금 + 유동성장기부채 + 장기차입금 (리스 제외). */
  function toInputs(st) {
    const is = st.income, bs = st.balance, cf = st.cashflow;
    const R = {
      revenue: pick(is, ['total revenues', 'revenues']),
      ebit: pick(is, ['operating income']),
      ebt: pick(is, ['ebt, incl. unusual items', 'ebt, excl. unusual items']),
      tax: pick(is, ['income tax expense']),
      etr: pick(is, ['effective tax rate']),
      da: pick(cf, ['depreciation & amortization, total', 'depreciation & amortization']),
      capex: pick(cf, ['capital expenditure']),
      sbc: pick(cf, ['stock-based compensation', 'stock based compensation']),
      ar: pick(bs, ['accounts receivable', 'total receivables']),
      inv: pick(bs, ['inventory']),
      ap: pick(bs, ['accounts payable']),
      accr: pick(bs, ['accrued expenses']),
      cash: pick(bs, ['total cash & st investments', 'cash and equivalents']),
      std: pick(bs, ['short-term borrowings']),
      cpltd: pick(bs, ['current portion of lt debt']),
      ltd: pick(bs, ['long-term debt']),
      totalDebt: pick(bs, ['total debt']),
      shares: pick(bs, ['total common shares outstanding', 'total shares out. on filing date']),
    };
    const finDebtRows = bs ? bs.order.filter(k => /^finance div\./.test(k) && /debt/.test(k)).map(k => bs.rows[k]) : [];
    const finLoanRows = bs ? bs.order.filter(k => /^finance div\./.test(k) && /loans/.test(k)).map(k => bs.rows[k]) : [];
    const leaseRows = bs ? bs.order.filter(k => /lease/.test(k) && !/^finance div\./.test(k)).map(k => bs.rows[k]) : [];

    // 연도별 실적: 손익계산서에 매출이 있는 연도 (최근 4개)
    const years = (is ? annualCols(is) : annualCols(bs).length ? annualCols(bs) : annualCols(cf))
      .filter(c => !is || val(R.revenue, c))
      .sort((a, b) => fyOf(a) - fyOf(b))
      .slice(-4);
    const history = years.map(c => {
      const rev = val(R.revenue, c);
      const ar = val(R.ar, c), inv = val(R.inv, c), ap = val(R.ap, c), accr = val(R.accr, c);
      const ebt = val(R.ebt, c), tax = val(R.tax, c), etr = val(R.etr, c);
      return {
        fy: fyOf(c),
        periodEnd: c,
        revenue: rev,
        ebitMargin: rev && val(R.ebit, c) != null ? round(val(R.ebit, c) / rev) : null,
        daPct: rev && val(R.da, c) != null ? round(val(R.da, c) / rev) : null,
        capexPct: rev && val(R.capex, c) != null ? round(Math.abs(val(R.capex, c)) / rev) : null,
        taxRate: etr != null ? round(etr) : ebt > 0 && tax != null ? round(tax / ebt) : null,
        nwcPct: rev && bs && ar != null ? round(((ar || 0) + (inv || 0) - (ap || 0) - (accr || 0)) / rev) : null,
        sbcPct: rev && val(R.sbc, c) != null ? round(val(R.sbc, c) / rev) : null,
      };
    });

    // 대차대조표 값: 가장 최근 열 (Last Report가 있으면 그 값)
    let bal = null;
    if (bs) {
      const cols = bs.columns.slice();
      const recent = cols.find(c => c === 'Last Report') || annualCols(bs).sort((a, b) => fyOf(b) - fyOf(a))[0];
      const has = c => val(R.cash, c) != null || val(R.ltd, c) != null;
      const col = has(recent) ? recent : annualCols(bs).sort((a, b) => fyOf(b) - fyOf(a)).find(has);
      if (col) {
        const sum = rs => rs.reduce((s, r) => s + (val(r, col) || 0), 0);
        const debtParts = [R.std, R.cpltd, R.ltd].filter(Boolean);
        bal = {
          column: col,
          cash: val(R.cash, col),
          debt: debtParts.length ? round(sum(debtParts), 1) : null,
          totalDebt: val(R.totalDebt, col),
          financeDebt: finDebtRows.length ? round(sum(finDebtRows), 1) : 0,
          financeLoans: finLoanRows.length ? round(sum(finLoanRows), 1) : 0,
          leases: leaseRows.length ? round(sum(leaseRows), 1) : 0,
          shares: val(R.shares, col),
        };
      }
    }
    const found = Object.entries(R).filter(([, v]) => v).map(([k]) => k);
    return { history, balance: bal, found, kinds: Object.keys(st).filter(k => st[k]) };
  }

  const api = { parsePages, toInputs, tokens, num };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SAPdf = api;
})(typeof window !== 'undefined' ? window : this);
