// 매수·매도 신호 조건. 트레이딩뷰 파인스크립트 조건을 여기로 옮긴다.
// d = { time, open, high, low, close, volume } (일봉 배열), ta = 파인스크립트 ta.* 와 같은 함수 모음 (js/ta.js)
// run()은 봉마다 true/false 인 buy·sell 배열을 돌려준다. 신호는 그 봉 종가 기준이다.
window.STRATEGY = {
  name: '골든크로스 (예시)',
  desc: '20일 이동평균이 60일 이동평균을 위로 뚫으면 매수, 아래로 뚫으면 매도',
  run(d, ta) {
    const fast = ta.sma(d.close, 20);
    const slow = ta.sma(d.close, 60);
    return {
      buy: ta.crossover(fast, slow),
      sell: ta.crossunder(fast, slow),
    };
  },
};
