// 매수·청산 신호 조건과 보조 지표. 사용자의 트레이딩뷰 파인스크립트를 그대로 옮긴 것이다.
// d = { time, open, high, low, close, volume } (일봉 배열), ta = 파인스크립트 ta.* 와 같은 함수 모음 (js/ta.js)

// 매매 신호 목록. 새 신호(파인스크립트 전략)는 여기에 하나씩 추가한다.
// id: 저장용 이름(영문), short: 차트·목록에 붙는 짧은 이름, color: 신호마다 구분되는 색
// run()은 봉마다 true/false 인 buy·exit 배열을 돌려준다. 트레이딩뷰 strategy처럼 주문은 다음 봉 시가에 체결되고,
// 이미 보유 중이면 매수 신호를 다시 표시하지 않는다.
window.STRATEGIES = [
  {
    id: 'rsi2',
    name: 'RSI-2 평균회귀',
    short: 'RSI2',
    color: '#7e57c2',
    desc: 'RSI(2)가 10 아래이고 종가가 200일선 위면 매수, RSI(2)가 70 위면 청산',
    commission: 0.0005, // 0.05%
    run(d, ta) {
      const rsiLen = 2, buyLevel = 10, exitLevel = 70, trendLen = 200;
      const rsi = ta.rsi(d.close, rsiLen);
      const trend = ta.sma(d.close, trendLen);
      return {
        buy: d.close.map((c, i) => rsi[i] < buyLevel && c > trend[i]),
        exit: rsi.map(r => r > exitLevel),
      };
    },
  },
  {
    id: 'stoch-x',
    name: '스토캐스틱 교차 (예시)',
    short: '스토',
    color: '#f57c00',
    desc: '%K가 20 아래에서 %D를 위로 교차하면 매수, 80 위에서 아래로 교차하면 청산 (사용자 확인 전 예시 조건)',
    commission: 0.0005,
    run(d, ta) {
      const { k, d: dd } = window.IND.stoch(d, ta);
      const up = ta.crossover(k, dd), dn = ta.crossunder(k, dd);
      return { buy: k.map((v, i) => up[i] && v < 20), exit: k.map((v, i) => dn[i] && v > 80) };
    },
  },
  {
    id: 'smc-choch',
    name: 'SMC 내부 구조 전환 (예시)',
    short: 'SMC',
    color: '#d81b60',
    desc: 'LuxAlgo SMC 내부 구조가 Bullish CHoCH면 매수, Bearish CHoCH면 청산 (사용자 확인 전 예시 조건)',
    commission: 0.0005,
    run(d) {
      const n = d.close.length, buy = new Array(n).fill(false), exit = new Array(n).fill(false);
      window.SMC.structure(d).internal.events.forEach(e => { if (e.tag === 'CHoCH') (e.bull ? buy : exit)[e.i] = true; });
      return { buy, exit };
    },
  },
];

// 보조 지표 계산 (차트에 그릴 때도 씀). 설정값은 사용자 트레이딩뷰 차트와 같게.
window.IND = {
  pwmaLen: 14, pwmaPower: 2,
  stochK: 5, stochSmooth: 3, stochD: 3,
  // Parabolic Weighted Moving Average (everget): 최근 값일수록 (length - i)^power 가중
  pwma(src, length = this.pwmaLen, power = this.pwmaPower) {
    return src.map((_, i) => {
      if (i < length - 1) return NaN;
      let sum = 0, w = 0;
      for (let k = 0; k < length; k++) { const wt = Math.pow(length - k, power); sum += src[i - k] * wt; w += wt; }
      return sum / w;
    });
  },
  // 트레이딩뷰 기본 스토캐스틱: k = sma(stoch(close, high, low, periodK), smoothK), d = sma(k, periodD)
  stoch(d, ta) {
    const k = ta.sma(ta.stoch(d.close, d.high, d.low, this.stochK), this.stochSmooth);
    return { k, d: ta.sma(k, this.stochD) };
  },
};

// 차트 지표 목록. 새 지표는 여기에 하나씩 추가한다 (사이트의 "＋ 추가"로 넣은 지표는 그 브라우저에만 저장됨).
// plot(d, ta)가 돌려주는 것 (모두 선택):
//   lines:    [{ title, values(봉마다 숫자), color 또는 colors(봉마다 색), width, pane: 'main'(가격 위) | 'sub'(아래 칸), dashed, range: [최소, 최대] }]
//   hlines:   [{ price, color }]                      아래 칸 가로선
//   segments: [{ from, to, price, color, dashed, text, textPos: 'above'|'below' }]  봉 번호 from~to 가로 선분
//   marks:    [{ i, text, color, position: 'above'|'below', shape: 'arrowUp'|'arrowDown'|'circle'|'square' }]
//   status:   { text, tone: 'up'|'down'|'' }        마지막 봉 상태 한 줄 (신호 자세히에 표시)
const UPC = '#089981', DNC = '#F23645';
window.CHART_INDICATORS = [
  {
    id: 'sma200',
    name: '200일선',
    color: '#9598a1',
    plot(d, ta) {
      const v = ta.sma(d.close, 200), n = v.length - 1;
      return {
        lines: [{ title: '200일선', values: v, color: '#9598a1', width: 1 }],
        status: { text: `${v[n].toFixed(2)} · 종가가 ${d.close[n] > v[n] ? '위' : '아래'}`, tone: d.close[n] > v[n] ? 'up' : 'down' },
      };
    },
  },
  {
    id: 'pwma',
    name: 'PWMA (14, 2)',
    color: '#4caf50',
    plot(d) {
      const pw = window.IND.pwma(d.close), n = pw.length - 1, up = pw[n] > pw[n - 1];
      let run = 0;
      for (let i = n; i > 0 && (pw[i] > pw[i - 1]) === up; i--) run++;
      return {
        lines: [{ title: 'PWMA', values: pw, colors: pw.map((v, i) => (v > pw[i - 1] ? '#4caf50' : '#f23645')), width: 2 }],
        status: { text: `${up ? '상승 중' : '하락 중'} (${run}일째) · ${pw[n].toFixed(2)}`, tone: up ? 'up' : 'down' },
      };
    },
  },
  {
    id: 'smc',
    name: '스마트머니 구조 (LuxAlgo SMC)',
    color: '#d81b60',
    plot(d) {
      const s = window.SMC.structure(d), n = d.close.length, since = Math.max(0, n - 260);
      const segments = [];
      [['swing', false], ['internal', true]].forEach(([k, dashed]) => s[k].events.filter(e => e.i >= since && e.from < e.i).forEach(e => segments.push({
        from: e.from, to: e.i, price: e.level, color: e.bull ? UPC : DNC, dashed, text: e.tag, textPos: e.bull ? 'above' : 'below',
      })));
      const trend = b => (b > 0 ? '상승' : b < 0 ? '하락' : '판단 전');
      const ev = e => (e ? `${e.bull ? 'Bullish' : 'Bearish'} ${e.tag} ${e.time}` : '없음');
      return {
        segments,
        status: {
          text: `스윙 추세 ${trend(s.swing.bias)} (최근 ${ev(s.swing.last)}) · 내부 추세 ${trend(s.internal.bias)} (최근 ${ev(s.internal.last)})`,
          tone: s.swing.bias > 0 ? 'up' : s.swing.bias < 0 ? 'down' : '',
        },
      };
    },
  },
  {
    id: 'stoch',
    name: '스토캐스틱 (5, 3, 3)',
    color: '#2962FF',
    plot(d, ta) {
      const { k, d: dd } = window.IND.stoch(d, ta), n = k.length - 1;
      const zone = k[n] >= 80 ? '과매수(80 위)' : k[n] <= 20 ? '과매도(20 아래)' : '중간';
      const xo = ta.crossover(k, dd), xu = ta.crossunder(k, dd);
      let last = '';
      for (let i = n; i >= 0; i--) {
        if (xo[i] || xu[i]) { last = ` · ${n - i ? n - i + '일 전' : '오늘'} %K가 %D를 ${xo[i] ? '위로' : '아래로'} 교차`; break; }
      }
      return {
        lines: [
          { title: '%K', values: k, color: '#2962FF', width: 1.5, pane: 'sub', range: [0, 100] },
          { title: '%D', values: dd, color: '#FF6D00', width: 1.5, pane: 'sub', range: [0, 100] },
        ],
        hlines: [{ price: 80 }, { price: 50 }, { price: 20 }],
        status: { text: `%K ${k[n].toFixed(1)} · %D ${dd[n].toFixed(1)} · ${zone}${last}`, tone: k[n] <= 20 ? 'up' : k[n] >= 80 ? 'down' : '' },
      };
    },
  },
];
