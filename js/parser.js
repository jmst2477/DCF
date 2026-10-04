// 시킹알파 Earnings → Estimates 화면 OCR 텍스트에서 연도별 매출 추정치를 뽑아낸다.
// 화면 예: "FY 2027  614.82B  23.32%  ...  590.10B  640.00B  38"
//          "Jan 2028  1.92B  28.86% ..."  (회계연도 말 월 표기)
// 매출 값은 B/M/K/T 단위가 붙은 숫자, EPS는 단위가 없으므로 자연스럽게 걸러진다.
(function (root) {
  'use strict';

  const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
  const PERIOD_RE = new RegExp(
    '\\b(?:FY\\s?[\'’]?(\\d{4}|\\d{2})' +
      '|(' + MONTHS + ')[a-z]*\\.?\\s*[\'’]?(\\d{4}|\\d{2})' +
      '|(\\d{1,2})\\/(\\d{4}))\\b',
    'gi'
  );
  const MONEY_RE = /(-?\$?\s?\d{1,3}(?:[,.]\d{3})*(?:\.\d+)?|\$?\d+(?:\.\d+)?)\s?([KMBT])\b/g;
  const UNIT = { K: 0.001, M: 1, B: 1000, T: 1000000 }; // → 백만 달러

  // OCR이 자주 틀리는 글자 보정 (숫자 사이의 O→0, l/I→1, S→5 등)
  function clean(text) {
    return text
      .replace(/(?<=\d)[oO](?=[\d.,KMBT%])|(?<=[\s$])[oO](?=[.,]\d)/g, '0')
      .replace(/(?<=\d)[lI|](?=\d)/g, '1')
      .replace(/(?<=\d),(?=\d{1,2}[KMBT]\b)/g, '.') // "614,82B" → "614.82B"
      // 시킹알파는 소수 둘째 자리 + 단위로 표시 → "614.828"은 B를 8로 잘못 읽은 것
      .replace(/(\d\.\d{2})8(?=\s|$)/gm, '$1B')
      .replace(/[“”]/g, '"');
  }

  function toYear(s) {
    const n = parseInt(s, 10);
    return s.length === 2 ? 2000 + n : n;
  }

  function findPeriods(line) {
    const out = [];
    PERIOD_RE.lastIndex = 0;
    let m;
    while ((m = PERIOD_RE.exec(line))) {
      let year, month = null;
      if (m[1]) year = toYear(m[1]);
      else if (m[2]) { year = toYear(m[3]); month = m[2].slice(0, 3).toLowerCase(); }
      else { year = toYear(m[5]); month = parseInt(m[4], 10); }
      if (year < 2000 || year > 2100) continue;
      out.push({ year, month, label: m[0].trim(), index: m.index, end: m.index + m[0].length });
    }
    return out;
  }

  function findMoney(line) {
    const out = [];
    MONEY_RE.lastIndex = 0;
    let m;
    while ((m = MONEY_RE.exec(line))) {
      let raw = m[1].replace(/[\s$]/g, '');
      // 천 단위 구분자 제거: "1,234.5" → "1234.5"; "1.234.5"(OCR 오류)는 마지막 점만 소수점
      if (/,/.test(raw)) raw = raw.replace(/,/g, '');
      const dots = raw.split('.');
      if (dots.length > 2) raw = dots.slice(0, -1).join('') + '.' + dots[dots.length - 1];
      const v = parseFloat(raw);
      if (!Number.isFinite(v)) continue;
      out.push({ value: v * UNIT[m[2].toUpperCase()], raw: m[0].trim(), index: m.index });
    }
    return out;
  }

  // 결과: [{year, label, value(백만 달러), raw, source:'row'|'column'}], 연도 오름차순
  function parseEstimates(text) {
    const all = clean(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const lines = revenueSection(all);
    const warnings = [];
    let found = parseRows(lines);
    if (found.length < 2) {
      const col = parseColumns(lines);
      if (col.length > found.length) found = col;
    }

    // 같은 연도가 여러 번 나오면 분기 화면일 가능성
    const byYear = new Map();
    let dup = false;
    for (const r of found) {
      if (byYear.has(r.year)) { dup = true; continue; }
      byYear.set(r.year, r);
    }
    if (dup) warnings.push('같은 연도가 여러 번 나왔습니다. Quarterly(분기)가 아니라 Annual(연간) 화면인지 확인하세요. 연도별 첫 값만 사용했습니다.');
    const result = [...byYear.values()].sort((a, b) => a.year - b.year);
    if (!result.length) warnings.push('매출 추정치를 찾지 못했습니다. Revenue Estimates 표가 잘 보이게 다시 캡처하거나 값을 직접 입력하세요.');
    return { estimates: result, warnings, lines: all };
  }

  // "Revenue Estimates" 제목이 보이면 그 아래(다음 EPS 표 전까지)만 사용
  function revenueSection(lines) {
    const start = lines.findIndex(l => /revenue/i.test(l) && /estimate/i.test(l) && !findPeriods(l).length);
    if (start < 0) return lines;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) if (/^EPS\b/i.test(lines[i])) { end = i; break; }
    return lines.slice(start + 1, end);
  }

  // 행 방식: 한 줄에 "기간 + 매출값(단위 포함) ..." — 기간 다음에 처음 나오는 금액이 추정치
  function parseRows(lines) {
    const out = [];
    for (const line of lines) {
      const periods = findPeriods(line);
      if (periods.length !== 1) continue;
      const p = periods[0];
      const money = findMoney(line).filter(x => x.index >= p.end);
      if (!money.length) continue;
      out.push({ year: p.year, label: p.label, value: money[0].value, raw: money[0].raw, source: 'row' });
    }
    return out;
  }

  // 열 방식: 헤더 줄에 기간이 여러 개, 아래 "Revenue" 줄에 금액이 여러 개
  function parseColumns(lines) {
    for (let i = 0; i < lines.length; i++) {
      const periods = findPeriods(lines[i]);
      if (periods.length < 2) continue;
      for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
        const money = findMoney(lines[j]);
        if (money.length < 2) continue;
        if (!/revenue|estimate|consensus/i.test(lines[j]) && j !== i + 1) continue;
        const n = Math.min(periods.length, money.length);
        const out = [];
        for (let k = 0; k < n; k++) {
          out.push({ year: periods[k].year, label: periods[k].label, value: money[k].value, raw: money[k].raw, source: 'column' });
        }
        return out;
      }
    }
    return [];
  }

  const api = { parseEstimates, findPeriods, findMoney, clean };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SAParser = api;
})(this);
