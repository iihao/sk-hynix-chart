// ═══ Constants & Utils ═══
/* ── Constants ── */
const KRW_USD_DEFAULT = 1544;

const BN = {
  bg: '#0b0e11',
  grid: '#161a1e',
  border: '#2b3139',
  text: '#848e9c',
  textBright: '#eaecef',
  up: '#0ecb81',
  down: '#f6465d',
  upVol: 'rgba(14,203,129,0.18)',
  downVol: 'rgba(246,70,93,0.18)',
  crosshair: '#474d57',
};

const LABELS = {
  normal: {
    ticker: 'SK HYNIX',
    sub: '000660.KS',
    stat1: '前收',
    stat2: '最高',
    stat3: '最低',
    tf: ['1分', '5分', '15分', '1时'],
    watermark: '000660',
    ohlc: ['O', 'H', 'L', 'C'],
    title: (p, pct, up) => `${up ? '▲' : '▼'} ${p} (${pct}) SK Hynix`,
  },
  stealth: {
    ticker: 'prod-cluster-east',
    sub: 'Grafana v10.2.3',
    stat1: 'baseline',
    stat2: 'peak',
    stat3: 'trough',
    tf: ['1m', '5m', '15m', '1h'],
    watermark: 'PROD-EAST-01',
    ohlc: ['min', 'p50', 'p95', 'max'],
    title: (p, pct, up) => `p99 ${p}ms (${pct}%) — prod-east`,
  },
};

/* ── State ── */
const state = {
  krwUsdRate: KRW_USD_DEFAULT,
  currency: 'USD',
  activeTF: 'm5',
  rawData: {},
  charts: {},
  stealthMode: false,
  currentBinancePrice: 0,
  currentSource: 'yahoo',
  lastServerTime: 0,
};

/* ── Helper Functions ── */
function convertP(v) {
  return state.currency === 'USD'
    ? +(v / state.krwUsdRate).toFixed(2)
    : Math.round(v);
}

function fmtPrice(v) {
  if (state.currency === 'USD') return '$' + v.toFixed(2);
  return '₩' + Math.round(v).toLocaleString();
}

function getThemeColors() {
  return state.stealthMode
    ? {
        bg: '#111217',
        grid: '#1c1f24',
        border: '#25292e',
        text: '#6b7280',
        textBright: '#c9d1d9',
        up: '#3b82f6',
        down: '#6b7280',
        upVol: 'rgba(59,130,246,0.15)',
        downVol: 'rgba(107,114,128,0.12)',
        crosshair: '#374151',
      }
    : BN;
}

function getLabels() {
  return state.stealthMode ? LABELS.stealth : LABELS.normal;
}

/* ── DOM Helpers ── */
function $(id) {
  return document.getElementById(id);
}

function showError(msg) {
  const t = $('errorToast');
  if (t) {
    t.textContent = '数据获取失败: ' + msg;
    t.style.display = 'block';
    setTimeout(() => (t.style.display = 'none'), 8000);
  }
}

// ═══ Chart ═══
/* ── Chart Factory ── */
function makeChart(containerId, tf) {
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
        const d = new Date(time * 1000 + 9 * 3600000);
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

    if (d && state.currentSource !== 'naver') {
      const c = state.stealthMode
        ? BN.textBright
        : d.close >= d.open
        ? BN.up
        : BN.down;
      const f = (v) => fmtPrice(v);
      html =
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

  return { chart, series, volSeries, naverLine, bnSeries };
}

/* ── Data Pipeline ── */
function pushData(tf, data, bnData) {
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

  c.chart.timeScale().fitContent();
  const ld = $('load-' + tf);
  if (ld) ld.classList.add('hide');
}

/* ── Tab Switching ── */
function switchTF(tf, btn) {
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
      setTimeout(() => {
        const c = state.charts[tf];
        if (c) c.chart.timeScale().fitContent();
      }, 320);
    });
  }
}

// ═══ Calculator ═══
/* ── Floating Calculator State ── */
let fpCalcDirection = 'long';

/* ── Floating Calculator Toggle ── */
function toggleCalculator() {
  $('calcPanel').classList.toggle('show');
}

/* ── Floating Calculator Direction ── */
function fpSetDirection(dir) {
  fpCalcDirection = dir;
  $('fpBtnLong').classList.toggle('active', dir === 'long');
  $('fpBtnShort').classList.toggle('active', dir === 'short');
}

/* ── Floating Calculator Use Current Price ── */
function fpUseCurrentPrice() {
  if (state.currentBinancePrice) {
    $('fpCalcExit').value = state.currentBinancePrice.toFixed(2);
    fpCalculatePnl();
  }
}

/* ── Floating Calculator Calculate ── */
async function fpCalculatePnl() {
  const entryPrice = parseFloat($('fpCalcEntry').value);
  const exitPrice = parseFloat($('fpCalcExit').value);
  const leverage = parseInt($('fpCalcLeverage').value);
  const positionSize = parseFloat($('fpCalcSize').value);
  const feeType = $('fpCalcFeeType').value;
  const fundingInput = $('fpCalcFunding');
  const fundingRate = parseFloat(fundingInput.dataset.rate) || 0;
  const fundingCount = parseInt($('fpCalcFundingCount').value) || 0;

  if (!entryPrice || !exitPrice || !positionSize) {
    alert('请填写完整参数');
    return;
  }

  try {
    const res = await fetch('/api/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entryPrice,
        exitPrice,
        leverage,
        positionSize,
        direction: fpCalcDirection,
        feeType,
        fundingRate,
        fundingCount,
      }),
    });
    if (!res.ok) throw new Error('计算失败');
    const data = await res.json();

    $('fpCalcResult').style.display = 'block';
    $('fpResMargin').textContent = '$' + data.margin.toFixed(2);
    $('fpResQty').textContent = data.quantity.toFixed(6);
    $('fpResOpenFee').textContent = '$' + data.openFee.toFixed(2);
    $('fpResCloseFee').textContent = '$' + data.closeFee.toFixed(2);
    $('fpResFunding').textContent = '$' + data.fundingCost.toFixed(2);
    $('fpResTotalFee').textContent = '$' + data.totalFee.toFixed(2);

    const pnlEl = $('fpResPnl');
    pnlEl.textContent =
      (data.pnl >= 0 ? '+' : '') + '$' + data.pnl.toFixed(2);
    pnlEl.className =
      'fp-result-val ' + (data.pnl >= 0 ? 'profit' : 'loss');

    const netPnlEl = $('fpResNetPnl');
    netPnlEl.textContent =
      (data.netPnl >= 0 ? '+' : '') +
      '$' +
      data.netPnl.toFixed(2) +
      ' (' +
      data.roi.toFixed(1) +
      '%)';
    netPnlEl.className = 'fp-result-total-val';
    netPnlEl.style.color =
      data.netPnl >= 0 ? 'var(--green)' : 'var(--red)';

    $('fpResLiq').textContent = '$' + data.liquidationPrice.toFixed(2);
  } catch (e) {
    alert('计算错误: ' + e.message);
  }
}

/* ── Signal Panel Calculator State ── */
let calcDirection = 'long';

/* ── Signal Panel Calculator Direction ── */
function setDirection(dir) {
  calcDirection = dir;
  $('btnLong').classList.toggle('active', dir === 'long');
  $('btnShort').classList.toggle('active', dir === 'short');
}

/* ── Signal Panel Calculator Use Current Price ── */
function useCurrentPrice() {
  if (state.currentBinancePrice) {
    $('calcExit').value = state.currentBinancePrice.toFixed(2);
    calculatePnl();
  }
}

/* ── Signal Panel Calculator Calculate ── */
async function calculatePnl() {
  const entryPrice = parseFloat($('calcEntry').value);
  const exitPrice = parseFloat($('calcExit').value);
  const leverage = parseInt($('calcLeverage').value);
  const positionSize = parseFloat($('calcSize').value);
  const feeType = $('calcFeeType').value;
  const fundingInput = $('calcFunding');
  const fundingRate = parseFloat(fundingInput.dataset.rate) || 0;
  const fundingCount = parseInt($('calcFundingCount').value) || 0;

  if (!entryPrice || !exitPrice || !positionSize) {
    alert('请填写完整参数');
    return;
  }

  try {
    const res = await fetch('/api/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entryPrice,
        exitPrice,
        leverage,
        positionSize,
        direction: calcDirection,
        feeType,
        fundingRate,
        fundingCount,
      }),
    });
    if (!res.ok) throw new Error('计算失败');
    const data = await res.json();

    $('calcResult').style.display = 'block';
    $('resMargin').textContent = '$' + data.margin.toFixed(2);
    $('resQty').textContent = data.quantity.toFixed(6);
    $('resOpenFee').textContent = '$' + data.openFee.toFixed(2);
    $('resCloseFee').textContent = '$' + data.closeFee.toFixed(2);
    $('resFunding').textContent = '$' + data.fundingCost.toFixed(2);
    $('resTotalFee').textContent = '$' + data.totalFee.toFixed(2);

    const pnlEl = $('resPnl');
    pnlEl.textContent =
      (data.pnl >= 0 ? '+' : '') + '$' + data.pnl.toFixed(2);
    pnlEl.className =
      'result-val ' + (data.pnl >= 0 ? 'profit' : 'loss');

    const netPnlEl = $('resNetPnl');
    netPnlEl.textContent =
      (data.netPnl >= 0 ? '+' : '') +
      '$' +
      data.netPnl.toFixed(2) +
      ' (' +
      data.roi.toFixed(1) +
      '%)';
    netPnlEl.className = 'result-total-val';
    netPnlEl.style.color =
      data.netPnl >= 0 ? 'var(--green)' : 'var(--red)';

    $('resLiq').textContent = '$' + data.liquidationPrice.toFixed(2);
  } catch (e) {
    alert('计算错误: ' + e.message);
  }
}

/* ── Fetch Binance Price ── */
async function fetchBinancePrice() {
  try {
    const res = await fetch('/api/binance/price');
    if (res.ok) {
      const data = await res.json();
      state.currentBinancePrice = data.price || 0;

      // Fill floating calculator
      const fpEntryInput = $('fpCalcEntry');
      if (!fpEntryInput.value && state.currentBinancePrice) {
        fpEntryInput.value = state.currentBinancePrice.toFixed(2);
      }
      const fpFundingInput = $('fpCalcFunding');
      if (data.fundingRate) {
        fpFundingInput.value = (data.fundingRate * 100).toFixed(4) + '%';
        fpFundingInput.dataset.rate = data.fundingRate;
      }

      // Fill signal panel calculator
      const entryInput = $('calcEntry');
      if (!entryInput.value && state.currentBinancePrice) {
        entryInput.value = state.currentBinancePrice.toFixed(2);
      }
      const fundingInput = $('calcFunding');
      if (data.fundingRate) {
        fundingInput.value = (data.fundingRate * 100).toFixed(4) + '%';
        fundingInput.dataset.rate = data.fundingRate;
      }
    }
  } catch (e) {
    console.error('Failed to fetch Binance price:', e);
  }
}

// ═══ App ═══
/* ── Signal Panel Toggle ── */
function toggleSignalPanel() {
  $('signalPanel').classList.toggle('open');
}

function toggleCollapsible(id) {
  $(id).classList.toggle('open');
}

/* ── Stealth Toggle ── */
function toggleStealth() {
  state.stealthMode = !state.stealthMode;
  document.body.classList.toggle('stealth', state.stealthMode);
  const L = getLabels();

  $('tickerName').textContent = L.ticker;
  $('tickerSub').textContent = L.sub;
  $('statLabel1').textContent = L.stat1;
  $('statLabel2').textContent = L.stat2;
  $('statLabel3').textContent = L.stat3;
  $('watermark').textContent = L.watermark;

  document.querySelectorAll('.tf-btn').forEach((btn, i) => {
    const span = btn.querySelector('.tf-text');
    if (span) span.textContent = L.tf[i];
  });

  if (state.rawData.m1 || state.rawData.m5) updateHeader(state.rawData);
}

/* ── Update Header ── */
function updateHeader(data) {
  const meta = data.m1?.meta || data.m5?.meta || data.m15?.meta || {};
  const price = meta.price || 0;
  const prev = meta.previousClose || 0;
  const pct = prev ? ((price - prev) / prev) * 100 : 0;
  const up = pct >= 0;

  const priceEl = $('hdrPrice');
  priceEl.textContent = fmtPrice(convertP(price));
  priceEl.className = 'price ' + (up ? 'up' : 'down');

  const chgEl = $('hdrChange');
  chgEl.textContent = (up ? '+' : '') + pct.toFixed(2) + '%';
  chgEl.className = 'change-badge ' + (up ? 'up' : 'down');

  const L = getLabels();
  document.title = L.title(
    fmtPrice(convertP(price)),
    (up ? '+' : '') + pct.toFixed(2),
    up
  );

  $('statPrev').textContent = fmtPrice(convertP(prev));
  const closePrice = !meta.marketOpen
    ? price
    : data.m1?.candles?.length
    ? data.m1.candles[data.m1.candles.length - 1].close
    : price;
  $('statClose').textContent = fmtPrice(convertP(closePrice));

  if (data.m1?.candles?.length) {
    const allH = data.m1.candles.map((c) => c.high);
    const allL = data.m1.candles.map((c) => c.low);
    $('statHigh').textContent = fmtPrice(convertP(Math.max(...allH)));
    $('statLow').textContent = fmtPrice(convertP(Math.min(...allL)));
  }

  // Binance stats
  const bnData = data.binance;
  const bnMeta = bnData?.m5?.meta || bnData?.m1?.meta || {};
  if (bnMeta.price) {
    $('statBnPrice').textContent =
      state.currency === 'KRW'
        ? '₩' + Math.round(bnMeta.price * state.krwUsdRate).toLocaleString()
        : '$' + bnMeta.price.toFixed(2);
    const fr = bnMeta.fundingRate;
    if (fr != null) {
      $('statBnFR').textContent =
        (fr >= 0 ? '+' : '') + (fr * 100).toFixed(4) + '%';
    }
  }

  // Market status
  const dot = $('statusDot');
  const label = $('statusLabel');
  const nextTxt = $('nextOpenText');
  if (meta.marketOpen) {
    dot.className = 'status-dot open';
    dot.style.background = '';
    dot.style.boxShadow = '';
    label.textContent = state.stealthMode ? 'healthy' : '交易中';
    label.style.color = state.stealthMode ? '#22c55e' : BN.green;
    nextTxt.textContent = '';
  } else {
    dot.className = 'status-dot closed';
    dot.style.background = '';
    dot.style.boxShadow = '';
    label.textContent = state.stealthMode ? 'offline' : '已收盘';
    label.style.color = state.stealthMode ? '#6b7280' : BN.red;
    nextTxt.textContent = meta.nextOpen
      ? (state.stealthMode ? 'next: ' : '开盘 ') + meta.nextOpen
      : '';
  }
}

/* ── Update All ── */
function updateAll(data) {
  const bn = data.binance || {};
  ['m1', 'm5', 'm15', 'h1'].forEach((tf) => {
    if (data[tf]) pushData(tf, data[tf], bn[tf]);
  });
  updateHeader(data);
}

/* ── Latency ── */
function updateLatency(serverTime) {
  const badge = $('latencyBadge');
  if (!serverTime) {
    badge.textContent = '--';
    return;
  }
  const lag = Math.round((Date.now() - serverTime) / 1000);
  let text, cls;
  if (lag < 5) {
    text = lag + 's';
    cls = 'good';
  } else if (lag < 15) {
    text = lag + 's';
    cls = 'ok';
  } else {
    text = lag + 's';
    cls = 'bad';
  }
  badge.textContent = (state.stealthMode ? 'lag ' : '延迟 ') + text;
  badge.className = 'latency ' + cls;
}

/* ── Currency Switch ── */
function switchCurrency(cur) {
  state.currency = cur;
  const bn = state.rawData.binance || {};
  ['m1', 'm5', 'm15', 'h1'].forEach((tf) => {
    if (state.rawData[tf]) pushData(tf, state.rawData[tf], bn[tf]);
  });
  updateHeader(state.rawData);
}

/* ── Source Switch ── */
async function switchSource(src) {
  state.currentSource = src;
  try {
    await fetch('/api/source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: src }),
    });
    fetchData();
  } catch (e) {
    console.error(e);
  }
}

/* ── Fetch Data ── */
async function fetchData() {
  try {
    const res = await fetch('/api/data?source=' + state.currentSource);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.krwUsdRate = data.krwUsd || KRW_USD_DEFAULT;
    state.rawData = data;

    if (data.source && data.source !== state.currentSource) {
      state.currentSource = data.source;
      $('srcSel').value = state.currentSource;
    }

    updateAll(data);
    updateLatency(data.serverTime);
    $('refreshLabel').textContent = new Date().toLocaleTimeString('zh-CN', {
      hour12: false,
    });
  } catch (e) {
    console.error(e);
    showError(e.message);
  }
}

/* ── SSE ── */
function connectSSE() {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      state.krwUsdRate = data.krwUsd || KRW_USD_DEFAULT;
      state.rawData = data;
      state.lastServerTime = data.serverTime || 0;
      updateAll(data);
      updateLatency(data.serverTime);
      $('refreshLabel').textContent =
        'LIVE ' +
        new Date().toLocaleTimeString('zh-CN', { hour12: false });
    } catch (err) {
      console.error(err);
    }
  };
  es.onerror = () => {
    es.close();
    setTimeout(connectSSE, 5000);
  };
}

/* ── Keyboard Shortcuts ── */
document.addEventListener('keydown', (e) => {
  if (e.key === '`' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    e.preventDefault();
    toggleStealth();
  }
});

/* ── Init ── */
window.addEventListener('DOMContentLoaded', () => {
  // Create charts
  state.charts.m1 = makeChart('chart-m1', 'm1');
  state.charts.m5 = makeChart('chart-m5', 'm5');
  state.charts.m15 = makeChart('chart-m15', 'm15');
  state.charts.h1 = makeChart('chart-h1', 'h1');

  // Fetch data
  fetchData();
  connectSSE();
  setInterval(fetchData, 10000);
  fetchBinancePrice();
});

/* ── Expose to global scope for onclick handlers ── */
window.toggleSignalPanel = toggleSignalPanel;
window.toggleCollapsible = toggleCollapsible;
window.toggleCalculator = toggleCalculator;
window.fpSetDirection = fpSetDirection;
window.fpUseCurrentPrice = fpUseCurrentPrice;
window.fpCalculatePnl = fpCalculatePnl;
window.setDirection = setDirection;
window.useCurrentPrice = useCurrentPrice;
window.calculatePnl = calculatePnl;
window.switchTF = switchTF;
window.switchCurrency = switchCurrency;
window.switchSource = switchSource;