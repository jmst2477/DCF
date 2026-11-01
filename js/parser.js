// 시킹알파 Earnings → Estimates 화면 OCR 텍스트에서 연도별 추정치(매출, EBIT, EBITDA, 캐펙스)를 뽑아낸다.
// 화면 예: "FY 2027  614.82B  23.32%  ...  590.10B  640.00B  38"
//          "Jan 2028  1.92B  28.86% ..."  (회계연도 말 월 표기)
// 매출 값은 B/M/K/T 단위가 붙은 숫자, EPS는 단위가 없으므로 자연스럽게 걸러진다.
// 한국어 화면: "2026년 12월  499.57B ... 1.01톤"(T를 '톤'으로 번역). OCR(영어 글꼴)이 '년·월'을 "20304 128"처럼,
// '톤'을 8이나 E로 읽는 경우가 많아 줄 맨 앞 연도 + 월 숫자만으로 기간을 알아보고, 단위는 앞뒤 연도 크기로 바로잡는다.
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
  // 한국어 화면 기간: 줄 맨 앞 "2026년 12월" (OCR 오독 예: "20264 12", "2027'd 128", "2028 128")
  const KO_ROW_RE = /^(20\d{2})(?:\S{0,3}\s+|년\s*)(1[0-2]|[1-9])\S{0,2}(?=\s|$)/;

  // OCR이 자주 틀리는 글자 보정 (숫자 사이의 O→0, l/I→1, S→5 등)
  function clean(text) {
    return text
      .replace(/(?<=\d)[oO](?=[\d.,KMBT%])|(?<=[\s$])[oO](?=[.,]\d)/g, '0')
      .replace(/(?<=\d)[lI|](?=\d)/g, '1')
      .replace(/(\d)\s?[톤조](?=\s|$)/gm, '$1T') // 한국어 화면의 '톤'(=T), '조'
      .replace(/(\d\.\d{2})E(?=\s|$)/gm, '$1T') // '톤'을 E로 읽은 것
      // 소수점을 놓친 금액: "49957B"·"111E" → "499.57B"·"1.11T" (시킹알파는 늘 소수 둘째 자리까지)
      .replace(/(?<=[ \t])(\d{1,3})(\d{2})([BT8E])(?=\s|$)/gm, (m, a, b, u) => /^20\d8$/.test(m) ? m : `${a}.${b}${u === 'E' ? 'T' : u === '8' ? 'B' : u}`) // 2028 같은 연도는 그대로
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
    const ko = KO_ROW_RE.exec(line);
    if (ko) out.push({ year: +ko[1], month: +ko[2], label: `${ko[1]}년 ${ko[2]}월`, index: 0, end: ko[0].length, ko: true });
    while ((m = PERIOD_RE.exec(line))) {
      let year, month = null;
      if (m[1]) year = toYear(m[1]);
      else if (m[2]) { year = toYear(m[3]); month = m[2].slice(0, 3).toLowerCase(); }
      else { year = toYear(m[5]); month = parseInt(m[4], 10); }
      if (year < 2000 || year > 2100) continue;
      if (ko && m.index < out[0].end) continue; // 한국어 기간과 겹치는 부분
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

  // 표 제목 → 항목. 시킹알파 Estimates 화면은 Revenue 외에 EBIT, EBITDA, Capital Expenditure 등도 연도별로 보여 준다.
  // 한국어로 번역된 화면("CONSENSUS 매출 ESTIMATES")도 인식
  const METRICS = [
    { key: 'eps', re: /\bEPS\b|주당\s*순이익/i },
    { key: 'ebitda', re: /\bEBITDA\b/i },
    { key: 'ebit', re: /\bEBIT\b(?!DA)|영업\s*이익/i },
    { key: 'capex', re: /capital\s*expenditure|\bcapex\b|자본적\s*지출|설비\s*투자/i },
    { key: 'revenue', re: /\brevenue\b|\bsales\b|매출/i },
    { key: null, re: /net\s*income|cash\s*flow|dividend|book\s*value|pre-?tax|순이익|배당/i }, // 쓰지 않는 표
  ];
  const METRIC_KO = { revenue: '매출', eps: 'EPS', ebit: 'EBIT(영업이익)', ebitda: 'EBITDA', capex: '캐펙스' };

  function metricOf(line) {
    if (findPeriods(line).length || findMoney(line).length) return undefined; // 숫자가 있는 줄은 제목이 아님
    for (const m of METRICS) if (m.re.test(line)) return m.key;
    return undefined;
  }

  // 결과: [{metric, year, label, value(백만 달러), raw, source:'row'|'column'}], 항목·연도 순
  function parseEstimates(text, hint) {
    const all = clean(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const warnings = [];
    const out = [];
    for (const sec of sections(all, hint)) {
      let found = sec.metric === 'eps' ? parseEpsRows(sec.lines) : parseRows(sec.lines);
      if (found.length < 2 && sec.metric !== 'eps') {
        const col = parseColumns(sec.lines);
        if (col.length > found.length) found = col;
      }
      fixKoYears(found);
      // 같은 연도가 여러 번 나오면 분기 화면일 가능성
      const byYear = new Map();
      let dup = false;
      for (const r of found) {
        if (byYear.has(r.year)) { dup = true; continue; }
        byYear.set(r.year, Object.assign({ metric: sec.metric }, r));
      }
      if (dup) warnings.push(`${METRIC_KO[sec.metric]}: 같은 연도가 여러 번 나왔습니다. Quarterly(분기)가 아니라 Annual(연간) 화면인지 확인하세요. 연도별 첫 값만 사용했습니다.`);
      const rows = [...byYear.values()].sort((a, b) => a.year - b.year);
      if (sec.metric !== 'eps') fixUnits(rows);
      out.push(...rows);
    }
    if (!hint && out.length && !out.some(e => e.metric === 'revenue') && out.every(e => e.metric === 'eps')) {
      warnings.push('EPS만 읽었습니다. 같은 화면의 매출(Revenue) 표도 함께 캡처하면 EPS로 연도별 이익률을 추정합니다.');
    }
    if (!out.length) {
      warnings.push(hint ? '표를 읽지 못했습니다. 표가 잘 보이게 다시 캡처하거나 아래 행 추가로 값을 직접 넣으세요.' : looksLikeEps(all)
        ? 'EPS(주당순이익) 추정치 표를 캡처하셨습니다. 같은 Earnings → Estimates 화면에서 아래로 내려 "Revenue Estimates"(매출 추정치) 표를 캡처해 주세요. 매출 값은 1.92B처럼 B/M 단위가 붙어 있습니다.'
        : '추정치를 찾지 못했습니다. 표가 잘 보이게 다시 캡처하거나 값을 직접 입력하세요.');
    }
    return { estimates: out, warnings, lines: all };
  }

  // 한국어 표는 위에서부터 한 해씩 늘어남 → OCR이 연도 숫자를 잘못 읽은 줄(2029→2020, 2032→2052)은 순서로 바로잡음
  function fixKoYears(rows) {
    const ko = rows.filter(r => r.ko);
    ko.forEach((r, i) => {
      const prev = ko[i - 1] && ko[i - 1].year, next = ko[i + 1] && ko[i + 1].year;
      let y = r.year;
      if (prev && next && next - prev === 2) y = prev + 1; // 앞뒤 해 사이 한 칸
      else if (prev && !next && (y <= prev || y > prev + 5)) y = prev + 1; // 마지막 줄
      else if (!prev && next && ko[i + 2] && ko[i + 2].year === next + 1 && (y >= next || y < next - 5)) y = next - 1; // 첫 줄
      if (y !== r.year) { r.year = y; r.label = `${y}년`; }
    });
  }

  // 'T'(조 달러)를 OCR이 B(8)로 읽으면 다음 해 값이 1000분의 1로 뚝 떨어짐 → 앞뒤 해와 비교해 바로잡음.
  // 매출·이익이 한 해에 50배 넘게 변하는 일은 없다고 봄
  function fixUnits(rows) {
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      if (a.value > 0 && b.value > 0 && b.value < a.value / 50 && b.value * 1000 < a.value * 50) {
        b.value *= 1000; b.raw += ' (조 단위로 보정)';
      }
    }
  }

  // 표 제목 줄로 구간을 나눔. 제목이 하나도 없으면 전체를 hint 표(없으면 매출 표)로 봄
  function sections(lines, hint) {
    const heads = [];
    lines.forEach((l, i) => { const m = metricOf(l); if (m !== undefined) heads.push({ i, metric: m }); });
    if (!heads.length) return [{ metric: hint || 'revenue', lines }];
    const secs = [];
    heads.forEach((h, k) => {
      if (!h.metric) return;
      const end = k + 1 < heads.length ? heads[k + 1].i : lines.length;
      // 같은 항목 제목이 연달아 나오면(표 제목 + 열 제목) 하나로 합침
      const prev = secs[secs.length - 1];
      if (prev && prev.metric === h.metric && prev.end === h.i) { prev.lines.push(...lines.slice(h.i + 1, end)); prev.end = end; return; }
      secs.push({ metric: h.metric, lines: lines.slice(h.i + 1, end), end });
    });
    return secs;
  }

  // 기간 + 단위 없는 작은 숫자(예: "Jan 2027 3.48 103.36%")가 대부분이면 EPS 표
  function looksLikeEps(lines) {
    if (lines.some(l => /\bEPS\b/i.test(l))) return true;
    let n = 0;
    for (const l of lines) {
      const p = findPeriods(l);
      if (p.length === 1 && /^\s*-?\d{1,3}\.\d{2}\b/.test(l.slice(p[0].end))) n++;
    }
    return n >= 2;
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
      // 첫 숫자가 단위를 못 읽은 추정치면 뒤 칸(하단·상단 추정치) 값을 대신 잡지 않도록 건너뜀
      const first = /-?\$?\d/.exec(line.slice(p.end));
      if (first && p.end + first.index < money[0].index - 1) continue;
      out.push({ year: p.year, label: p.label, value: money[0].value, raw: money[0].raw, source: 'row', ko: p.ko });
    }
    return out;
  }

  // EPS 표: 단위 없는 주당 금액 — 기간 다음에 처음 나오는 소수 숫자 (예: "Jan 2027 3.48 103.36% ...")
  function parseEpsRows(lines) {
    const out = [];
    for (const line of lines) {
      const periods = findPeriods(line);
      if (periods.length !== 1) continue;
      const rest = line.slice(periods[0].end);
      const m = /^\s*\$?(-?\d{1,4}\.\d{1,3})(?![\d%])/.exec(rest);
      // 소수점을 놓친 값("2412" = 24.12)은 성장률(%)이 뒤따를 때만 둘째 자리 소수로 봄
      const n = !m && periods[0].ko && /^\s*(-?\d{3,5})\s+-?\d+(?:\.\d+)?%/.exec(rest);
      if (!m && !n) continue;
      const v = m ? parseFloat(m[1]) : parseInt(n[1], 10) / 100;
      out.push({ year: periods[0].year, label: periods[0].label, value: v, raw: m ? m[1] : n[1], source: 'row', ko: periods[0].ko });
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
        if (!/revenue|ebit|capital|capex|estimate|consensus/i.test(lines[j]) && j !== i + 1) continue;
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

  const api = { parseEstimates, findPeriods, findMoney, clean, METRIC_KO };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SAParser = api;
})(this);
