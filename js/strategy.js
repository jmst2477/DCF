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
    // "신호 자세히"에 나오는 설명 (이게 뭔지 · 언제 사고파는지 · 읽는 법 · 조심할 점)
    about: [
      ['이게 뭔가요', '오르는 추세에 있는 종목이 며칠 사이 급하게 빠졌을 때 사서, 반등하면 바로 파는 단기 매매입니다. "좋은 종목이 잠깐 과하게 빠지면 곧 제자리로 돌아온다"(평균회귀)는 생각에 기댑니다.'],
      ['RSI(2)란', 'RSI는 최근 오른 폭과 내린 폭을 비교해 0~100으로 나타낸 값입니다. 보통은 14일로 계산하지만 여기서는 2일로 계산해 아주 예민합니다. 이틀 연속 크게 빠지면 10 아래로 떨어집니다.'],
      ['언제 사나요', '두 조건이 함께 맞는 날 종가 기준으로 신호가 나고, 다음 날 시가에 삽니다. ① RSI(2)가 10 아래(단기 과매도) ② 종가가 200일 이동평균선 위(긴 추세는 상승). ②는 하락 추세 종목을 거르는 장치입니다.'],
      ['언제 파나요', 'RSI(2)가 70 위로 올라가면(반등이 나오면) 청산 신호가 나고, 다음 날 시가에 팝니다. 손절 규칙은 따로 없습니다.'],
      ['이렇게 읽으세요', '차트의 ▲가 매수, ▼가 청산입니다. 보통 며칠 안에 끝나는 짧은 거래라 승률은 높은 편입니다. "보유" 표시가 길게 이어지면 반등이 안 나오고 있다는 뜻입니다.'],
      ['조심할 점', '이기는 거래는 작게 여러 번, 지는 거래는 한 번에 크게 날 수 있습니다. 승률만 보지 말고 "거래당 평균"과 "누적"을 같이 보세요. 실적 발표나 악재로 빠진 경우엔 반등이 안 올 수 있습니다.'],
    ],
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
    about: [
      ['이게 뭔가요', '주가가 최근 범위의 바닥 근처에서 다시 고개를 드는 순간에 사고, 천장 근처에서 꺾이는 순간에 파는 매매입니다. 형일님이 준 조건이 아니라 예시로 넣은 조건입니다.'],
      ['스토캐스틱이란', '지금 종가가 최근 5일 동안의 최저가~최고가 사이에서 어디쯤인지를 0~100으로 나타낸 값입니다. 0이면 5일 중 가장 낮은 곳, 100이면 가장 높은 곳입니다. 차트 아래 칸의 파란 선(%K)은 이 값을 3일 평균한 것, 주황 선(%D)은 %K를 다시 3일 평균한 느린 선입니다 (설정 5, 3, 3).'],
      ['언제 사나요', '%K가 20 아래(바닥권)에 있을 때 파란 선이 주황 선을 아래에서 위로 뚫고 올라가면 매수 신호, 다음 날 시가에 삽니다.'],
      ['언제 파나요', '%K가 80 위(천장권)에 있을 때 파란 선이 주황 선을 위에서 아래로 뚫고 내려가면 청산 신호, 다음 날 시가에 팝니다.'],
      ['이렇게 읽으세요', '위아래로 오가는 횡보장에서 잘 맞습니다. 차트 아래 칸에서 선이 20 아래로 내려가 있으면 매수 신호가 가까워진 상태입니다.'],
      ['조심할 점', '강하게 오르는 장에서는 80 위에 오래 머물러 너무 일찍 팔거나, 반대로 바닥권에 머물지 않아 매수 신호가 거의 안 납니다. 강하게 내리는 장에서는 바닥권 교차가 여러 번 실패할 수 있습니다.'],
    ],
    commission: 0.0005,
    run(d, ta) {
      const { k, d: dd } = window.IND.stoch(d, ta);
      const up = ta.crossover(k, dd), dn = ta.crossunder(k, dd);
      return { buy: k.map((v, i) => up[i] && v < 20), exit: k.map((v, i) => dn[i] && v > 80) };
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
