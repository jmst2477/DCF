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
  {
    id: 'vmc-trend',
    name: 'VuManChu 정석 추세',
    short: 'VMC',
    color: '#00897b',
    desc: '머니 플로우(구름)가 초록이고, 파동이 0선 아래에서 위로 꺾이며 초록 동그라미가 찍히면 매수. 빨간 동그라미가 찍히면 청산',
    commission: 0.0005,
    about: [
      ['이게 뭔가요', '"VuManChu Cipher B"라는 트레이딩뷰 무료 지표로, 비싼 유료 지표(마켓사이퍼)를 흉내 낸 것입니다. 블로그 "지표의 정석"의 전략 1(정석 추세 매매)을 그대로 옮겼습니다. 돈이 들어오는 쪽으로만, 파동이 바닥에서 꺾일 때 들어가는 방식입니다.'],
      ['머니 플로우(구름)', '차트 아래 VuManChu 칸의 초록·빨강 막대입니다. 최근 60일 동안 봉마다 종가가 시가보다 얼마나 위(아래)에서 끝났는지를 평균 낸 값입니다. 0 위 초록이면 사는 힘(자금 유입)이 강한 상태, 0 아래 빨강이면 파는 힘(유출)이 강한 상태입니다. 블로그의 "연료 게이지"입니다.'],
      ['모멘텀 파동', '하늘색(wt1)·파란색(wt2) 두 선입니다. 가격이 최근 평균에서 얼마나 벗어났는지를 부드럽게 만든 값으로, 0선을 중심으로 오르내립니다. 0 아래 깊이(-53 아래) 내려가면 과매도, 0 위 높이(53 위) 올라가면 과매수입니다.'],
      ['동그라미', '하늘색 선이 파란 선을 아래에서 위로 뚫으면 초록 동그라미(상승 전환), 위에서 아래로 뚫으면 빨간 동그라미(하락 전환)입니다.'],
      ['언제 사나요', '세 가지가 같은 날 맞을 때 종가 기준으로 신호가 나고, 다음 날 시가에 삽니다. ① 머니 플로우가 초록(0 위) ② 파동(wt2)이 0선 아래 ③ 초록 동그라미가 찍힘.'],
      ['언제 파나요', '빨간 동그라미(하늘색 선이 파란 선을 아래로 뚫음)가 찍히면 청산 신호, 다음 날 시가에 팝니다. 블로그 표의 "빨간 점 = 롱 청산"입니다.'],
      ['이렇게 읽으세요', '차트 아래 VuManChu 칸에서 구름이 초록인데 파동이 0 아래로 깊이 내려가 있으면, 곧 매수 신호가 날 수 있는 자리입니다. 구름이 빨강일 때 나온 초록 동그라미는 "역추세"라 이 신호는 무시합니다.'],
      ['조심할 점', '블로그는 1시간·4시간봉을 권하지만 이 사이트는 일봉으로 계산합니다. 블로그의 블러드 다이아몬드와 다이버전스(전략 2)는 이번에 넣지 않았습니다. 신호는 하루가 끝난 종가 기준이라, 장중에는 동그라미가 생겼다 사라질 수 있습니다.'],
    ],
    run(d, ta) {
      const v = window.IND.vmc(d, ta);
      return {
        buy: v.up.map((x, i) => x && v.wt2[i] < 0 && v.mf[i] > 0),
        exit: v.down.slice(),
      };
    },
  },
  {
    id: 'vmc-ema200',
    name: 'VuManChu + 200 EMA',
    short: 'VMC+EMA',
    color: '#5e35b1',
    desc: 'VuManChu 정석 추세 매수 조건에 "종가가 200일 지수이동평균(EMA) 위"를 더함. 청산은 빨간 동그라미',
    commission: 0.0005,
    about: [
      ['이게 뭔가요', '블로그 전략 3(다른 지표와의 최강 조합)입니다. "VuManChu 정석 추세" 신호에 큰 추세 필터를 하나 더 걸어서, 상승장일 때만 매수합니다.'],
      ['200 EMA란', '최근 200일 종가의 지수이동평균입니다. 최근 가격에 가중치를 더 준 200일선입니다. 종가가 이 선 위면 긴 추세가 상승장, 아래면 하락장으로 봅니다. 사이트의 회색 "200일선"(단순평균)과 비슷하지만 조금 더 빨리 움직입니다.'],
      ['언제 사나요', '네 가지가 같은 날 맞을 때 매수 신호, 다음 날 시가에 삽니다. ① 종가가 200 EMA 위 ② 머니 플로우가 초록 ③ 파동(wt2)이 0선 아래 ④ 초록 동그라미.'],
      ['언제 파나요', '빨간 동그라미가 찍히면 청산 (정석 추세와 같음).'],
      ['이렇게 읽으세요', '정석 추세보다 신호가 적게 나오는 대신, 하락장에서 떨어지는 칼을 잡는 일을 줄입니다. 두 신호의 승률을 "전략별 지난 성적" 표에서 비교해 보세요.'],
      ['조심할 점', '블로그의 "55 EMA 눌림목"이나 슈퍼트렌드 조합은 넣지 않았습니다. 필요하면 말씀해 주세요. 하락장에서는 신호가 거의 나오지 않습니다.'],
    ],
    run(d, ta) {
      const v = window.IND.vmc(d, ta), e = ta.ema(d.close, 200);
      return {
        buy: v.up.map((x, i) => x && v.wt2[i] < 0 && v.mf[i] > 0 && d.close[i] > e[i]),
        exit: v.down.slice(),
      };
    },
  },
  {
    id: 'rsi2-vmc',
    name: 'RSI-2 급락 후 VuManChu 반등',
    short: 'RSI2+VMC',
    color: '#c2185b',
    desc: '최근 3거래일 안에 RSI(2)가 10 아래로 빠졌고, 종가가 200일선 위이며, 오늘 VuManChu 초록 동그라미가 찍히면 매수. 빨간 동그라미가 찍히면 청산',
    commission: 0.0005,
    about: [
      ['이게 뭔가요', '"RSI-2 평균회귀"와 "VuManChu"를 순서대로 엮은 조합 신호입니다. RSI-2로 "많이 빠졌다"를 확인하고, VuManChu 초록 동그라미로 "이제 돌아선다"를 확인한 뒤에 삽니다. 떨어지는 도중에 너무 일찍 사는 것을 줄이려는 시도입니다. 시험 삼아 넣은 신호입니다.'],
      ['왜 같은 날이 아니라 3일인가요', 'RSI(2)가 10 아래로 빠지는 날은 급락한 바로 그날이고, 초록 동그라미는 보통 바닥을 찍고 1~3일 뒤에 찍힙니다. 두 조건을 같은 날로 묶으면 신호가 거의 나오지 않아서, "최근 3거래일 안에 급락이 있었다"로 잡았습니다.'],
      ['언제 사나요', '세 가지가 맞는 날 종가 기준으로 신호가 나고, 다음 날 시가에 삽니다. ① 오늘 포함 최근 3거래일 중 하루라도 RSI(2)가 10 아래 ② 종가가 200일선 위(긴 추세는 상승) ③ 오늘 VuManChu 초록 동그라미(하늘색 선이 파란 선을 위로 뚫음).'],
      ['언제 파나요', 'VuManChu 빨간 동그라미(하늘색 선이 파란 선을 아래로 뚫음)가 찍히면 청산 신호, 다음 날 시가에 팝니다. RSI-2의 "70 위면 청산"은 쓰지 않습니다. 초록 동그라미가 찍히는 날은 이미 반등한 날이라 RSI(2)가 70 위인 경우가 많아, 사자마자 팔게 되기 때문입니다.'],
      ['이렇게 읽으세요', '"전략별 지난 성적" 표에서 RSI-2 평균회귀, VuManChu 정석 추세와 나란히 비교해 보세요. 거래 수가 너무 적으면(예: 5번 미만) 승률이 높아도 우연일 수 있습니다.'],
      ['조심할 점', 'RSI-2 신호보다 하루이틀 늦게 사므로, 반등 초반 일부를 놓치는 대신 계속 빠지는 경우를 일부 피합니다. 어느 쪽이 나은지는 종목마다 다릅니다. 하락장(200일선 아래)에서는 신호가 나오지 않습니다.'],
    ],
    run(d, ta) {
      const look = 3, rsi = ta.rsi(d.close, 2), trend = ta.sma(d.close, 200), v = window.IND.vmc(d, ta);
      const dipped = i => { for (let k = 0; k < look && i - k >= 0; k++) if (rsi[i - k] < 10) return true; return false; };
      return {
        buy: v.up.map((x, i) => !!x && d.close[i] > trend[i] && dipped(i)),
        exit: v.down.slice(),
      };
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
  // VuManChu Cipher B (트레이딩뷰 "VuManChu Cipher B + Divergences" 기본 설정)
  //  WaveTrend: hlc3, 채널 9, 평균 12, 이평 3 → wt1(빠른 파동), wt2(느린 파동). 과매도 -53, 과매수 53
  //  Money Flow(RSI+MFI 구름): ((종가-시가)/(고가-저가)) × 150 의 60일 평균 − 2.5. 0 위 초록(자금 유입), 아래 빨강(유출)
  //  동그라미: wt1 이 wt2 를 위로 교차하면 초록, 아래로 교차하면 빨강 (wt2 자리에 찍힘)
  vmc(d, ta) {
    if (d._vmc) return d._vmc;
    const src = d.close.map((c, i) => (d.high[i] + d.low[i] + c) / 3);
    const esa = ta.ema(src, 9);
    const de = ta.ema(src.map((v, i) => Math.abs(v - esa[i])), 9);
    const ci = src.map((v, i) => (v - esa[i]) / (0.015 * de[i]));
    const wt1 = ta.ema(ci, 12), wt2 = ta.sma(wt1, 3);
    const cross = ta.cross(wt1, wt2);
    const up = cross.map((x, i) => x && wt2[i] - wt1[i] <= 0), down = cross.map((x, i) => x && wt2[i] - wt1[i] >= 0);
    const mf = ta.sma(d.close.map((c, i) => (d.high[i] === d.low[i] ? 0 : ((c - d.open[i]) / (d.high[i] - d.low[i])) * 150)), 60).map(v => v - 2.5);
    return (d._vmc = { wt1, wt2, mf, up, down });
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
  {
    id: 'vmc',
    name: 'VuManChu Cipher B',
    color: '#4fc3f7',
    plot(d, ta) {
      const v = window.IND.vmc(d, ta), n = d.close.length - 1, since = Math.max(0, n - 400);
      const dots = [];
      for (let i = since; i <= n; i++) if (v.up[i] || v.down[i]) dots.push({ i, price: v.wt2[i], color: v.up[i] ? '#00c853' : '#ff1744' });
      let last = '';
      for (let i = n; i >= 0; i--) if (v.up[i] || v.down[i]) { last = ` · ${n - i ? n - i + '일 전' : '오늘'} ${v.up[i] ? '초록' : '빨간'} 동그라미`; break; }
      return {
        lines: [
          { title: '머니 플로우', values: v.mf, colors: v.mf.map(x => (x > 0 ? 'rgba(0,200,83,0.6)' : 'rgba(255,23,68,0.6)')), hist: true, pane: 'sub' },
          { title: 'wt1', values: v.wt1, color: '#4fc3f7', width: 1.5, pane: 'sub' },
          { title: 'wt2', values: v.wt2, color: '#1565c0', width: 1.5, pane: 'sub' },
        ],
        hlines: [{ price: 53, color: '#F23645' }, { price: 0, color: '#787B86' }, { price: -53, color: '#089981' }],
        dots,
        status: {
          text: `머니 플로우 ${v.mf[n] > 0 ? '초록(자금 유입)' : '빨강(자금 유출)'} · 파동 wt2 ${v.wt2[n].toFixed(1)}${v.wt2[n] <= -53 ? ' (과매도)' : v.wt2[n] >= 53 ? ' (과매수)' : ''}${last}`,
          tone: v.mf[n] > 0 ? 'up' : 'down',
        },
      };
    },
  },
];
