// 매수·청산 신호 조건과 보조 지표. 사용자의 트레이딩뷰 파인스크립트를 그대로 옮긴 것이다.
// d = { time, open, high, low, close, volume } (일봉 배열), ta = 파인스크립트 ta.* 와 같은 함수 모음 (js/ta.js)

// 매매 전략: "RSI-2 평균회귀" (strategy). run()은 봉마다 true/false 인 buy·exit 배열을 돌려준다.
// 트레이딩뷰 strategy처럼 주문은 다음 봉 시가에 체결되고, 이미 보유 중이면 매수 신호를 다시 표시하지 않는다.
window.STRATEGY = {
  name: 'RSI-2 평균회귀',
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
};

// 보조 지표: 매수 조건이 없는 지표는 마지막 봉 상태만 글로 보여 준다. tone: 'up'(빨강) | 'down'(파랑) | ''
window.INDICATORS = [
  {
    name: 'PWMA (14, 2)',
    run(d) {
      // Parabolic Weighted Moving Average (everget): 최근 값일수록 (length - i)^power 가중
      const length = 14, power = 2, src = d.close;
      const pwma = src.map((_, i) => {
        if (i < length - 1) return NaN;
        let sum = 0, w = 0;
        for (let k = 0; k < length; k++) { const wt = Math.pow(length - k, power); sum += src[i - k] * wt; w += wt; }
        return sum / w;
      });
      const n = pwma.length - 1, up = pwma[n] > pwma[n - 1];
      let run = 0;
      for (let i = n; i > 0 && (pwma[i] > pwma[i - 1]) === up; i--) run++;
      return { text: `${up ? '상승 중' : '하락 중'} (${run}일째) · ${pwma[n].toFixed(2)}`, tone: up ? 'up' : 'down' };
    },
  },
  {
    name: '스토캐스틱 (14, 1, 3)',
    run(d, ta) {
      const k = ta.sma(ta.stoch(d.close, d.high, d.low, 14), 1);
      const dd = ta.sma(k, 3);
      const n = k.length - 1;
      const zone = k[n] >= 80 ? '과매수(80 위)' : k[n] <= 20 ? '과매도(20 아래)' : '중간';
      const xo = ta.crossover(k, dd), xu = ta.crossunder(k, dd);
      let last = '';
      for (let i = n; i >= 0; i--) {
        if (xo[i] || xu[i]) { last = ` · ${n - i ? n - i + '일 전' : '오늘'} %K가 %D를 ${xo[i] ? '위로' : '아래로'} 교차`; break; }
      }
      return { text: `%K ${k[n].toFixed(1)} · %D ${dd[n].toFixed(1)} · ${zone}${last}`, tone: k[n] <= 20 ? 'up' : k[n] >= 80 ? 'down' : '' };
    },
  },
  {
    name: '스마트머니 구조 (LuxAlgo SMC)',
    run(d) {
      const s = window.SMC.structure(d);
      const trend = b => (b > 0 ? '상승' : b < 0 ? '하락' : '판단 전');
      const ev = e => (e ? `${e.bull ? 'Bullish' : 'Bearish'} ${e.tag} ${e.time}` : '없음');
      return {
        text: `스윙 추세 ${trend(s.swing.bias)} (최근 ${ev(s.swing.last)}) · 내부 추세 ${trend(s.internal.bias)} (최근 ${ev(s.internal.last)})`,
        tone: s.swing.bias > 0 ? 'up' : s.swing.bias < 0 ? 'down' : '',
      };
    },
  },
];
