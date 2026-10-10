// 신호 차트: 트레이딩뷰가 만든 무료 차트 라이브러리(Lightweight Charts)로 야후 일봉을 그리고,
// 그 위에 사용자의 트레이딩뷰 지표·신호(RSI-2 매수·매도, 200일선, PWMA, SMC 구조, 스토캐스틱)를 입힌다.
(function (g) {
  'use strict';
  const UP = '#089981', DOWN = '#F23645'; // 트레이딩뷰 기본 캔들 색
  const PWMA_UP = '#4caf50', PWMA_DOWN = '#f23645';
  const fix = v => (Number.isFinite(v) ? v : undefined);

  function theme() {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    return dark
      ? { bg: '#131722', text: '#d1d4dc', grid: '#232632', border: '#2a2e39', vol: 0.35 }
      : { bg: '#ffffff', text: '#191f28', grid: '#f0f3fa', border: '#e0e3eb', vol: 0.3 };
  }
  const alpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, '0');

  function draw(el, d, sim, opts = {}) {
    const LC = g.LightweightCharts;
    if (!LC) { el.innerHTML = '<p class="muted small" style="padding:16px">차트 라이브러리를 불러오지 못했습니다.</p>'; return null; }
    el.innerHTML = '';
    const th = theme(), n = d.close.length, T = d.time;
    const chart = LC.createChart(el, {
      autoSize: true,
      layout: { background: { color: th.bg }, textColor: th.text, fontFamily: 'Pretendard Variable, Pretendard, sans-serif', panes: { separatorColor: th.border } },
      grid: { vertLines: { color: th.grid }, horzLines: { color: th.grid } },
      rightPriceScale: { borderColor: th.border },
      timeScale: { borderColor: th.border, rightOffset: 4 },
      crosshair: { mode: 0 },
      localization: { locale: 'ko-KR', dateFormat: 'yyyy-MM-dd' },
    });

    // 캔들 + 거래량
    const candles = chart.addSeries(LC.CandlestickSeries, { upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN });
    candles.setData(T.map((t, i) => ({ time: t, open: d.open[i], high: d.high[i], low: d.low[i], close: d.close[i] })));
    const vol = chart.addSeries(LC.HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vol.setData(T.map((t, i) => ({ time: t, value: d.volume[i] || 0, color: alpha(d.close[i] >= d.open[i] ? UP : DOWN, th.vol) })));

    const line = (data, o) => {
      const s = chart.addSeries(LC.LineSeries, Object.assign({ lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false }, o), o.pane || 0);
      s.setData(data);
      return s;
    };
    // 200일선 (RSI-2 전략의 추세 필터)
    const sma = g.TA.sma(d.close, 200);
    line(T.map((t, i) => ({ time: t, value: fix(sma[i]) })).filter(p => p.value !== undefined), { color: '#9598a1', lineWidth: 1, title: '200일선' });
    // PWMA: 오르면 초록, 내리면 빨강 (원본 스크립트와 같음)
    const pw = g.IND.pwma(d.close);
    line(T.map((t, i) => ({ time: t, value: fix(pw[i]), color: pw[i] > pw[i - 1] ? PWMA_UP : PWMA_DOWN })).filter(p => p.value !== undefined), { lineWidth: 2 });

    // SMC 구조: 피벗에서 돌파 봉까지 선 + BOS/CHoCH 글자 (스윙 실선, 내부 점선)
    const smc = g.SMC.structure(d);
    const since = Math.max(0, n - (opts.smcBars || 260));
    [['swing', 0], ['internal', 2]].forEach(([k, style]) => {
      smc[k].events.filter(e => e.i >= since && e.from < e.i).forEach(e => {
        const c = e.bull ? UP : DOWN;
        const s = line([{ time: T[e.from], value: e.level }, { time: T[e.i], value: e.level }], { color: c, lineWidth: 1, lineStyle: style });
        const mid = T[Math.round((e.from + e.i) / 2)];
        LC.createSeriesMarkers(s, [{ time: mid, position: e.bull ? 'aboveBar' : 'belowBar', shape: 'circle', size: 0, color: c, text: e.tag }]);
      });
    });

    // RSI-2 매수·매도 표시 (원본 스크립트 label과 같은 자리: 매수는 저가 아래, 매도는 고가 위)
    const marks = sim.marks.map(m => ({
      time: T[m.i],
      position: m.kind === 'buy' ? 'belowBar' : 'aboveBar',
      shape: m.kind === 'buy' ? 'arrowUp' : 'arrowDown',
      color: m.kind === 'buy' ? UP : DOWN,
      text: (m.kind === 'buy' ? '매수 ' : '매도 ') + d.close[m.i].toFixed(2),
    }));
    LC.createSeriesMarkers(candles, marks);

    // 아래 칸: 스토캐스틱
    const st = g.IND.stoch(d, g.TA);
    const range = () => ({ priceRange: { minValue: 0, maxValue: 100 } });
    const k = line(T.map((t, i) => ({ time: t, value: fix(st.k[i]) })).filter(p => p.value !== undefined), { color: '#2962FF', lineWidth: 1.5, pane: 1, lastValueVisible: true, autoscaleInfoProvider: range });
    line(T.map((t, i) => ({ time: t, value: fix(st.d[i]) })).filter(p => p.value !== undefined), { color: '#FF6D00', lineWidth: 1.5, pane: 1, lastValueVisible: true, autoscaleInfoProvider: range });
    [80, 50, 20].forEach(p => k.createPriceLine({ price: p, color: '#787B86', lineWidth: 1, lineStyle: 2, axisLabelVisible: false }));
    const panes = chart.panes();
    if (panes[1]) panes[1].setHeight(Math.round(el.clientHeight * 0.24));

    chart.timeScale().setVisibleLogicalRange({ from: n - (opts.bars || 130), to: n + 3 });

    // 왼쪽 위 범례
    const lg = document.createElement('div');
    lg.className = 'chart-legend';
    lg.innerHTML = `<span><i style="background:${UP}"></i>RSI-2 매수 · <i style="background:${DOWN}"></i>매도</span><span><i style="background:${PWMA_UP}"></i>PWMA 14 2</span><span><i style="background:#9598a1"></i>200일선</span><span>SMC 구조 (실선 스윙, 점선 내부)</span><span>아래: 스토캐스틱 ${g.IND.stochK} ${g.IND.stochSmooth} ${g.IND.stochD}</span>`;
    el.appendChild(lg);
    return chart;
  }

  g.SigChart = { draw };
})(window);
