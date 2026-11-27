/* global DCF, SAParser, SAPdf, Tesseract, ExcelJS */
// DCF: 엑셀로 내보내기, 전체 다시 그리기(renderAll)
// js/app/ 파일들은 한 화면 코드를 기능별로 나눈 것. index.html 에 적힌 순서대로 불러오고, 서로의 이름(함수·변수)을 그대로 씀.
'use strict';

// ---------- 상단 버튼 ----------
$('#btn-xlsx-basic').addEventListener('click', () => exportBasicXlsx().catch(err => alert('엑셀 만들기 실패: ' + err.message)));

// 기본(강의) 방식 엑셀: 강의의 「DCF Valuation Model」 시트와 같은 셀 배치·수식 (금액은 달러 단위)
async function exportBasicXlsx() {
  const wb = new ExcelJS.Workbook();
  wb.calcProperties.fullCalcOnLoad = true;
  const ws = wb.addWorksheet('DCF Valuation Model');
  const b = state.basic, r = DCF.simple(basicInput()), n = r.horizon;
  const M = 1e6;
  const cols = 'BCDEFGHIJKL'.split('').slice(0, n + 1), L = cols[n];
  const put = (addr, v, fmtStr, input) => {
    const c = ws.getCell(addr);
    c.value = v;
    if (fmtStr) c.numFmt = fmtStr;
    if (input) { c.font = { color: { argb: 'FF1A3FAE' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8D6' } }; }
    return c;
  };
  const f = (formula, result) => ({ formula, result });
  const NUMF = '#,##0', PCT = '0.0%';
  ws.getColumn(1).width = 44;
  cols.forEach(c => { ws.getColumn(c).width = 17; });
  put('A1', `${state.companyName || state.ticker || ''} DCF Valuation Model (현금흐름할인법 모델)`).font = { bold: true, size: 13 };
  put('A3', '1. 가정 (Assumptions)').font = { bold: true, color: { argb: 'FFC0362C' } };
  const A = [
    [4, '매출액 성장률 (Revenue Growth Rate)', b.growth, PCT], [5, '영업이익률 (EBIT Margin)', b.margin, PCT], [6, '법인세율 (Tax Rate)', b.tax, PCT],
    [7, '감가상각비/매출 (D&A % of Rev)', b.da, PCT], [8, '자본적지출/매출 (CapEx % of Rev)', b.capex, PCT],
    [9, '순운전자본증감/매출 (NWC % of Rev) 일상적인 활동을 유지', b.nwc, PCT], [10, '가중평균자본비용 (WACC) 할인율', state.wacc, PCT],
    [11, '영구성장률 (Terminal Growth Rate)', state.g, PCT], [12, '발행주식수 (Shares Outstanding)', state.shares * M, NUMF],
    [13, '보유현금 (Current Cash)', state.cash * M, NUMF], [14, '총차입금 (Current Debt)', state.debt * M, NUMF],
  ];
  for (const [row, label, v, nf] of A) { put('A' + row, label); put('B' + row, v, nf, true); }
  put('A16', '2. 현금흐름 추정 (Cash Flow Projections)').font = { bold: true, color: { argb: 'FFC0362C' } };
  cols.forEach((c, t) => put(c + '16', t === 0 ? '0년차 (현재)' : t + '년차'));
  const labels = { 17: '매출액 (Revenue)', 18: '영업이익 (EBIT) 매출액*영업이익률', 19: '법인세 (Taxes) 영업이익*법인세율', 20: '세후영업이익 (NOPAT) 영업이익*(1-법인세율)',
    21: '감가상각비 (D&A) 매출액*감가상각비', 22: '자본적지출 (CapEx) 매출액*자본적지출', 23: '순운전자본증감 (Change in NWC)', 24: '잉여현금흐름 (FCFF) B20+B21-B22-B23' };
  Object.entries(labels).forEach(([row, l]) => put('A' + row, l));
  const rev0 = b.rev0 * M;
  cols.forEach((c, t) => {
    const x = t ? r.rows[t - 1] : null, p = cols[t - 1];
    put(c + 17, t === 0 ? rev0 : f(`${p}17*(1+$B$4)`, x.revenue * M), NUMF, t === 0);
    put(c + 18, f(`${c}17*$B$5`, (t ? x.ebit : rev0 * b.margin / M) * M), NUMF);
    put(c + 19, f(`${c}18*$B$6`, (t ? x.taxes : rev0 * b.margin * b.tax / M) * M), NUMF);
    put(c + 20, f(`${c}18*(1-$B$6)`, (t ? x.nopat : rev0 * b.margin * (1 - b.tax) / M) * M), NUMF);
    put(c + 21, f(`${c}17*$B$7`, (t ? x.da : rev0 * b.da / M) * M), NUMF);
    put(c + 22, f(`${c}17*$B$8`, (t ? x.capex : rev0 * b.capex / M) * M), NUMF);
    put(c + 23, f(`${c}17*$B$9`, (t ? x.dNwc : rev0 * b.nwc / M) * M), NUMF);
    put(c + 24, f(`${c}20+${c}21-${c}22-${c}23`, t ? x.fcff * M : null), NUMF);
    put(c + 27, t === 0 ? 1 : f(`1/((1+$B$10)^${t})`, x.df), '0.0000');
    put(c + 28, f(`${c}24*${c}27`, t ? x.pv * M : null), NUMF);
  });
  put('A26', '3. 가치평가 (Valuation)').font = { bold: true, color: { argb: 'FFC0362C' } };
  put('A27', '할인계수 (Discount Factor) 미래현금흐름을 현재가치로 환산');
  put('A28', 'FCFF의 현재가치 (PV of FCF) B24*B27');
  const V = [
    [30, 'FCFF 현재가치 합계 (Sum of PV of FCF)', `SUM(C28:${L}28)`, r.pvSum * M],
    [31, '영구가치 (Terminal Value)', `${L}24*(1+$B$11)/($B$10-$B$11)`, r.tv * M],
    [32, '영구가치의 현재가치 (PV of Terminal Value)', `B31*${L}27`, r.pvTv * M],
    [33, '기업가치 (Enterprise Value)', 'B30+B32', r.ev * M],
    [34, '차감: 총차입금 (Less: Debt)', '-$B$14', -state.debt * M],
    [35, '가산: 보유현금 (Plus: Cash)', '$B$13', state.cash * M],
    [36, '자기자본가치 (Equity Value)', 'B33+B34+B35', r.equity * M],
    [37, '1주당 내재가치 (Implied Share Price)', 'B36/$B$12', r.perShare],
  ];
  for (const [row, label, formula, v] of V) { put('A' + row, label); put('B' + row, f(formula, v), row === 37 ? '#,##0.00' : NUMF); }
  ws.getCell('A37').font = { bold: true, color: { argb: 'FFC0362C' } };
  ws.getCell('B37').font = { bold: true };
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.ticker || 'DCF'}_DCF_기본_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
$('#btn-reset').addEventListener('click', () => {
  if (!confirm('입력값을 모두 지울까요?')) return;
  state = blank(); renderAll();
});
function renderAll() {
  renderBasicForm();
  recalc();
}
