// 신호 차트: 트레이딩뷰가 만든 무료 차트 라이브러리(Lightweight Charts)로 야후 일봉을 그리고,
// 그 위에 고른 매매 신호(▲매수 ▼매도)와 켜 둔 차트 지표(js/strategy.js 의 CHART_INDICATORS)를 입힌다.
(function (g) {
  'use strict';
  const UP = '#089981', DOWN = '#F23645'; // 트레이딩뷰 기본 캔들 색
  const fix = v => (Number.isFinite(v) ? v : undefined);

  function theme() {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    return dark
      ? { bg: '#131722', text: '#d1d4dc', grid: '#232632', border: '#2a2e39', vol: 0.35 }
      : { bg: '#ffffff', text: '#191f28', grid: '#f0f3fa', border: '#e0e3eb', vol: 0.3 };
  }
  const alpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, '0');

  // sets = [{ strat, sim }] : 고른 매매 신호, inds = [{ ind, out }] : 켜 둔 지표와 그 plot() 결과
  function draw(el, d, sets, inds, opts = {}) {
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

    const line = (data, o, pane) => {
      const s = chart.addSeries(LC.LineSeries, Object.assign({ lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false }, o), pane || 0);
      s.setData(data);
      return s;
    };
    const candleMarks = [];
    let nextPane = 1;

    // 지표
    inds.forEach(({ ind, out }) => {
      if (!out) return;
      const subLines = (out.lines || []).filter(l => l.pane === 'sub');
      const pane = subLines.length || (out.hlines || []).length ? nextPane++ : 0;
      let first = null;
      (out.lines || []).forEach(l => {
        const vals = l.values || [];
        const data = T.map((t, i) => {
          const v = fix(vals[i]);
          if (v === undefined) return null;
          const p = { time: t, value: v };
          if (l.colors && l.colors[i]) p.color = l.colors[i];
          return p;
        }).filter(Boolean);
        const o = { color: l.color || ind.color || '#787B86', lineWidth: l.width || 1.5, lineStyle: l.dashed ? 2 : 0, title: l.pane === 'sub' ? '' : (l.title || '') };
        if (l.pane === 'sub') o.lastValueVisible = true;
        if (l.range) o.autoscaleInfoProvider = () => ({ priceRange: { minValue: l.range[0], maxValue: l.range[1] } });
        const s = line(data, o, l.pane === 'sub' ? pane : 0);
        if (l.pane === 'sub' && !first) first = s;
      });
      if (first) (out.hlines || []).forEach(h => first.createPriceLine({ price: h.price, color: h.color || '#787B86', lineWidth: 1, lineStyle: 2, axisLabelVisible: false }));
      (out.segments || []).forEach(sg => {
        if (!(sg.from >= 0 && sg.to < n && sg.from < sg.to)) return;
        const s = line([{ time: T[sg.from], value: sg.price }, { time: T[sg.to], value: sg.price }], { color: sg.color || ind.color, lineWidth: 1, lineStyle: sg.dashed ? 2 : 0 });
        if (sg.text) LC.createSeriesMarkers(s, [{ time: T[Math.round((sg.from + sg.to) / 2)], position: sg.textPos === 'below' ? 'belowBar' : 'aboveBar', shape: 'circle', size: 0, color: sg.color || ind.color, text: sg.text }]);
      });
      (out.marks || []).forEach(m => {
        if (!(m.i >= 0 && m.i < n)) return;
        candleMarks.push({ i: m.i, time: T[m.i], position: m.position === 'above' ? 'aboveBar' : 'belowBar', shape: m.shape || 'circle', color: m.color || ind.color, text: m.text || '' });
      });
    });

    // 매매 신호 표시 (원본 스크립트 label과 같은 자리: 매수는 저가 아래 ▲, 매도는 고가 위 ▼). 신호마다 색이 다르다.
    sets.forEach(({ strat, sim }) => sim.marks.forEach(m => candleMarks.push({
      i: m.i,
      time: T[m.i],
      position: m.kind === 'buy' ? 'belowBar' : 'aboveBar',
      shape: m.kind === 'buy' ? 'arrowUp' : 'arrowDown',
      color: strat.color,
      text: (m.kind === 'buy' ? '매수 ' : '매도 ') + d.close[m.i].toFixed(2),
    })));
    candleMarks.sort((a, b) => a.i - b.i);
    LC.createSeriesMarkers(candles, candleMarks.map(({ i, ...m }) => m));

    const panes = chart.panes();
    const subH = Math.round(el.clientHeight * (panes.length > 2 ? 0.18 : 0.24));
    panes.slice(1).forEach(p => p.setHeight(subH));
    chart.timeScale().setVisibleLogicalRange({ from: n - (opts.bars || 130), to: n + 3 });

    // 왼쪽 위 범례
    const lg = document.createElement('div');
    lg.className = 'chart-legend';
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    lg.innerHTML = sets.map(({ strat }) => `<span><i style="background:${strat.color}"></i><b>${esc(strat.name)}</b> ▲매수 ▼매도</span>`).join('') +
      inds.map(({ ind }) => `<span><i style="background:${ind.color || '#787B86'}"></i>${esc(ind.name)}</span>`).join('');
    el.appendChild(lg);
    return chart;
  }

  g.SigChart = { draw };
})(window);
