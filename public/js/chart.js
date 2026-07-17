import { state, BN, convertP, fmtPrice, getLabels, $ } from './utils.js';

/* ── Chart Factory ── */
export function makeChart(containerId, tf) {
  const el = document.getElementById(containerId);
  const chart = LightweightCharts.createChart(el, {
    layout: {
      background: { type: 'solid', color: BN.bg },
      textColor: BN.text,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
    },
    grid: {
      vertLines: { color: BN.grid, style: 3 },
      horzLines: { color: BN.grid, style: 3 },
    },
    crosshair: {
      mode: 0,
      vertLine: {
        color: BN.crosshair,
        width: 1,
        style: 2,
        labelBackgroundColor: BN.border,
      },
      horzLine: {
        color: BN.crosshair,
        width: 1,
        style: 2,
        labelBackgroundColor: BN.border,
      },
    },
    rightPriceScale: {
      borderColor: BN.border,
      scaleMargins: { top: 0.05, bottom: 0.2 },
    },
    timeScale: {
      borderColor: BN.border,
      timeVisible: true,
      secondsVisible: false,
      tickMarkFormatter: (time) => {
        const d = new Date(time * 1000 + 8 * 3600000); // Beijing time (UTC+8)
        return (
          String(d.getUTCHours()).padStart(2, '0') +
          ':' +
          String(d.getUTCMinutes()).padStart(2, '0')
        );
      },
    },
    handleScroll: { vertTouchDrag: false },
  });

  const series = chart.addCandlestickSeries({
    upColor: BN.up,
    downColor: BN.down,
    wickUpColor: BN.up,
    wickDownColor: BN.down,
    borderVisible: false,
    priceLineColor: BN.border,
  });

  const volSeries = chart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: 'vol',
  });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

  const naverLine = chart.addLineSeries({
    color: '#00bcd4',
    lineWidth: 2,
    lineStyle: 0,
    priceLineVisible: false,
    lastValueVisible: true,
    title: 'Naver',
  });

  const bnSeries = chart.addLineSeries({
    color: '#f0b90b',
    lineWidth: 2,
    lineStyle: 0,
    priceLineVisible: false,
    lastValueVisible: true,
    title: 'BN',
  });

  // ── Indicator Overlay Series ──
  const ma5Series = chart.addLineSeries({ color: '#e8a838', lineWidth: 1, lineStyle: 0, priceLineVisible: false, lastValueVisible: false, title: 'MA5' });
  const ma20Series = chart.addLineSeries({ color: '#e058a0', lineWidth: 1, lineStyle: 0, priceLineVisible: false, lastValueVisible: false, title: 'MA20' });
  const bollUpper = chart.addLineSeries({ color: 'rgba(156,163,175,0.4)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, title: 'BOLL' });
  const bollLower = chart.addLineSeries({ color: 'rgba(156,163,175,0.4)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });

  // OHLC crosshair handler
  chart.subscribeCrosshairMove((param) => {
    const ohlcEl = $('ohlc-' + tf);
    if (!param?.time) {
      ohlcEl.innerHTML = '';
      return;
    }
    const d = param.seriesData.get(series);
    const nv = param.seriesData.get(naverLine);
    const bnD = param.seriesData.get(bnSeries);
    if (!d && !nv && !bnD) return;

    const L = getLabels();
    let html = '';

    // Show time (UTC+8)
    const time = new Date(param.time * 1000 + 8 * 3600000);
    const hh = String(time.getUTCHours()).padStart(2, '0');
    const mm = String(time.getUTCMinutes()).padStart(2, '0');
    const dateStr = `${time.getUTCMonth()+1}/${time.getUTCDate()}`;
    html += `<span style="color:#848e9c"><span class="lbl">时间</span><b>${dateStr} ${hh}:${mm}</b></span>`;

    if (d && state.currentSource !== 'naver') {
      const c = state.stealthMode
        ? BN.textBright
        : d.close >= d.open
        ? BN.up
        : BN.down;
      const f = (v) => fmtPrice(v);
      html +=
        `<span><span class="lbl">${L.ohlc[0]}</span><b style="color:${c}">${f(d.open)}</b></span>` +
        `<span><span class="lbl">${L.ohlc[1]}</span><b style="color:${c}">${f(d.high)}</b></span>` +
        `<span><span class="lbl">${L.ohlc[2]}</span><b style="color:${c}">${f(d.low)}</b></span>` +
        `<span><span class="lbl">${L.ohlc[3]}</span><b style="color:${c}">${f(d.close)}</b></span>`;
    }
    if (nv && state.currentSource === 'naver') {
      html += `<span style="color:#00bcd4"><span class="lbl">NV</span><b>${fmtPrice(
        nv.value
      )}</b></span>`;
    }
    if (bnD) {
      html += `<span style="margin-left:8px;color:#f0b90b"><span class="lbl">BN</span><b>$${
        bnD.value?.toFixed(2) || '--'
      }</b></span>`;
    }
    ohlcEl.innerHTML = html;
  });

  // Resize observer
  const ro = new ResizeObserver(() => {
    chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
  });
  ro.observe(el);

  return { chart, series, volSeries, naverLine, bnSeries, ma5Series, ma20Series, bollUpper, bollLower, initialFramed: false, priceLines: [] };
}

/* ── Apply Indicator Overlays ── */
export function applyIndicators(tf, indicators, times) {
  const c = state.charts[tf];
  if (!c || !indicators) return;

  const toLine = (arr) => {
    if (!arr || !arr.length || !times || !times.length) return [];
    return arr.map((v, i) => {
      if (v == null || i >= times.length) return null;
      return { time: times[i], value: state.currency === 'KRW' ? v : v / state.krwUsdRate };
    }).filter(Boolean);
  };

  if (indicators.ma5 && c.ma5Series) c.ma5Series.setData(toLine(indicators.ma5));
  if (indicators.ma20 && c.ma20Series) c.ma20Series.setData(toLine(indicators.ma20));
  if (indicators.bollinger?.upper && c.bollUpper) c.bollUpper.setData(toLine(indicators.bollinger.upper));
  if (indicators.bollinger?.lower && c.bollLower) c.bollLower.setData(toLine(indicators.bollinger.lower));
}

/* ── Support/Resistance Lines ── */
export function updateSupportResistance(tf, levelGroup) {
  const c = state.charts[tf];
  if (!c) return;

  // Remove old price lines
  for (const line of c.priceLines || []) {
    try { c.series.removePriceLine(line); } catch (e) {}
  }
  c.priceLines = [];

  const support = levelGroup?.support || [];
  const resistance = levelGroup?.resistance || [];
  const toDisplayPrice = (price) => {
    if (levelGroup?.currency === 'KRW') {
      return state.currency === 'KRW' ? price : +(price / state.krwUsdRate).toFixed(2);
    }
    return state.currency === 'KRW' ? Math.round(price * state.krwUsdRate) : price;
  };

  // Draw support lines (green)
  for (const s of (support || []).slice(0, 3)) {
    const price = toDisplayPrice(s.price);
    const line = c.series.createPriceLine({
      price,
      color: 'rgba(14, 203, 129, 0.4)',
      lineWidth: 1,
      lineStyle: 2, // Dashed
      axisLabelVisible: true,
      title: `S${s.strength || ''}`,
    });
    c.priceLines.push(line);
  }

  // Draw resistance lines (red)
  for (const r of (resistance || []).slice(0, 3)) {
    const price = toDisplayPrice(r.price);
    const line = c.series.createPriceLine({
      price,
      color: 'rgba(246, 70, 93, 0.4)',
      lineWidth: 1,
      lineStyle: 2, // Dashed
      axisLabelVisible: true,
      title: `R${r.strength || ''}`,
    });
    c.priceLines.push(line);
  }
}

/* ── Data Pipeline ── */
export function pushData(tf, data, bnData) {
  const c = state.charts[tf];
  if (!c) return;
  const isNaver = state.currentSource === 'naver';

  if (isNaver && data?.candles?.length && c.naverLine) {
    c.series.applyOptions({ visible: false });
    c.volSeries.applyOptions({ visible: false });
    c.naverLine.applyOptions({ visible: true });
    const lineData = data.candles.map((i) => ({
      time: i.time,
      value: convertP(i.close),
    }));
    c.naverLine.setData(lineData);
  } else if (!isNaver && data?.candles?.length) {
    c.series.applyOptions({ visible: true });
    c.volSeries.applyOptions({ visible: true });
    if (c.naverLine) c.naverLine.applyOptions({ visible: false });
    const candles = data.candles.map((i) => ({
      time: i.time,
      open: convertP(i.open),
      high: convertP(i.high),
      low: convertP(i.low),
      close: convertP(i.close),
    }));
    c.series.setData(candles);
    c.volSeries.setData(
      data.candles.map((cc) => ({
        time: cc.time,
        value: cc.volume,
        color: cc.close >= cc.open ? BN.upVol : BN.downVol,
      }))
    );
  }

  if (bnData?.line?.length && c.bnSeries) {
    const bnLine = bnData.line.map((p) => ({
      time: p.time,
      value:
        state.currency === 'KRW'
          ? Math.round(p.value * state.krwUsdRate)
          : p.value,
    }));
    c.bnSeries.setData(bnLine);
    c.bnSeries.applyOptions({ visible: true });
  } else if (c.bnSeries) {
    c.bnSeries.setData([]);
    c.bnSeries.applyOptions({ visible: false });
  }

  const ld = $('load-' + tf);
  if (ld) ld.classList.add('hide');

  // Set visible range after data is loaded
  const shouldFrame = !c.initialFramed || c.pendingFrame;
  if (shouldFrame) {
    const visibleBars = TF_VISIBLE[tf] || 120;
    const allData = data?.candles || [];
    if (allData.length > visibleBars) {
      const from = allData[allData.length - visibleBars].time;
      const to = allData[allData.length - 1].time;
      c.chart.timeScale().setVisibleRange({ from, to });
    } else {
      c.chart.timeScale().fitContent();
    }
    c.initialFramed = true;
    c.pendingFrame = false;
  }
}

export function resetChartFraming() {
  for (const chart of Object.values(state.charts)) {
    if (chart) chart.initialFramed = false;
  }
}

/* ── Tab Switching ── */
// Timeframe display ranges (in candles)
const TF_VISIBLE = { m1: 120, m5: 120, m15: 120, h1: 120 };

export function switchTF(tf, btn) {
  if (tf === state.activeTF) return;
  state.activeTF = tf;
  document.querySelectorAll('.tf-btn').forEach((b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document
    .querySelectorAll('.chart-container')
    .forEach((cc) => cc.classList.remove('active'));
  const target = $('cc-' + tf);
  if (target) {
    requestAnimationFrame(() => {
      target.classList.add('active');
      // Defer range setting to after data is loaded
      setTimeout(() => {
        const c = state.charts[tf];
        if (c) {
          c.pendingFrame = true; // Signal pushData to set range
        }
      }, 320);
    });
  }
}
