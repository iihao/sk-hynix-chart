import {
  state,
  BN,
  KRW_USD_DEFAULT,
  LABELS,
  convertP,
  fmtPrice,
  getLabels,
  $,
  showError,
} from './utils.js';
import { makeChart, pushData, resetChartFraming, switchTF } from './chart.js';
import {
  toggleCalculator,
  fpSetDirection,
  fpUseCurrentPrice,
  fpCalculatePnl,
  fetchBinancePrice,
} from './calculator.js';
import { createDashboardController } from './dashboard-controller.mjs';
import {
  renderConnectionState as renderConnectionLabel,
  renderFactors,
  renderMarketContext,
  renderPanelMessage,
  renderSignals,
  renderSourceHealth,
} from './dashboard-renderers.mjs';
import {
  buildBacktestQuery,
  normalizeBacktest,
  normalizeFactors,
  normalizeIndicators,
} from './dashboard-data.mjs';

const panelRequests = new Map();
let secondaryTimers = [];

const dashboardController = createDashboardController({
  fetch: window.fetch.bind(window),
  createEventSource: (url) => new EventSource(url),
  setTimeout: window.setTimeout.bind(window),
  clearTimeout: window.clearTimeout.bind(window),
  setInterval: window.setInterval.bind(window),
  clearInterval: window.clearInterval.bind(window),
  now: () => Date.now(),
  onSnapshot: applySnapshot,
  onConnection: (connection) => renderConnectionLabel($('refreshLabel'), connection),
  onError: (message) => showError(message),
});

/* ── Signal Panel Toggle ── */
function toggleSignalPanel() {
  $('signalPanel').classList.toggle('open');
  document.body.classList.toggle('signal-panel-open', $('signalPanel').classList.contains('open'));
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
  resetChartFraming();
  await dashboardController.setSource(src);
}

function applySnapshot(data) {
  if (!data || data.error) {
    if (data?.error) showError(data.error);
    return;
  }
  state.krwUsdRate = data.krwUsd || KRW_USD_DEFAULT;
  state.rawData = data;
  state.lastServerTime = data.serverTime || 0;
  updateAll(data);
  updateLatency(data.serverTime);
}

function nextPanelSignal(panel) {
  panelRequests.get(panel)?.abort();
  const controller = new AbortController();
  panelRequests.set(panel, controller);
  return controller.signal;
}

/* ── Indicators ── */
async function updateIndicators() {
  const signal = nextPanelSignal('indicators');
  try {
    const res = await fetch('/api/indicators', { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = normalizeIndicators(await res.json());

    const rsiEl = $('indRsi');
    const macdEl = $('indMacd');
    const volEl = $('indVol');

    if (rsiEl) {
      const rsi = data.rsi;
      rsiEl.textContent = rsi.toFixed(1);
      rsiEl.className = 'ind-stat-val ' + (rsi > 70 ? 'bearish' : rsi < 30 ? 'bullish' : 'neutral');
    }
    if (macdEl) {
      const macdVal = data.macdHist;
      macdEl.textContent = macdVal > 0 ? '+' + macdVal.toFixed(2) : macdVal.toFixed(2);
      macdEl.className = 'ind-stat-val ' + (macdVal > 0 ? 'bullish' : 'bearish');
    }
    if (volEl) {
      const volRatio = data.volRatio;
      volEl.textContent = volRatio.toFixed(2);
      volEl.className = 'ind-stat-val ' + (volRatio > 1.5 ? 'bullish' : volRatio < 0.5 ? 'bearish' : 'neutral');
    }

    renderSignals(document, $('signalsContainer'), data.signals);
    dashboardController.markPanel('indicators', 'ready');
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error('Failed to fetch indicators:', e);
    dashboardController.markPanel('indicators', 'error');
    renderPanelMessage(document, $('signalsContainer'), '信号数据暂不可用', 'error');
  }
}

/* ── Factors ── */
async function updateFactors() {
  const signal = nextPanelSignal('factors');
  try {
    const res = await fetch('/api/factors', { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = normalizeFactors(await res.json());
    
    renderFactors(document, $('factorTags'), data.factors);
    
    if (data.direction) {
      const dirText = $('dirText');
      const dirScore = $('dirScore');
      const dirConf = $('dirConf');

      if (dirText) {
        dirText.textContent = data.direction.label;
        dirText.className = 'dir-text ' + data.direction.code;
      }
      if (dirScore) {
        dirScore.textContent = data.direction.score.toFixed(1);
        dirScore.className = 'dir-score ' + data.direction.code;
      }
      if (dirConf) dirConf.textContent = data.direction.confidence + '%';
    }
    
    // Update direction reason
    const dirReason = $('dirReason');
    if (dirReason && data.factors && data.factors.length > 0) {
      const topFactor = data.factors.reduce((a, b) => Math.abs(a.score) > Math.abs(b.score) ? a : b);
      dirReason.textContent = topFactor.label + ': ' + topFactor.detail;
    }
    
    renderMarketContext(document, $('marketContextArea'), data.marketContext);
    $('riskArea').hidden = !data.risk;
    $('basisArea').hidden = !data.basis;
    dashboardController.markPanel('factors', 'ready');
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error('Failed to fetch factors:', e);
    dashboardController.markPanel('factors', 'error');
    renderPanelMessage(document, $('factorTags'), '因子数据暂不可用', 'error');
  }
}

async function updateHealth() {
  const signal = nextPanelSignal('health');
  try {
    const res = await fetch('/api/ticks', { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderSourceHealth(document, $('factorCoverage'), await res.json());
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error('Failed to fetch source health:', e);
    renderPanelMessage(document, $('factorCoverage'), '数据源健康状态不可用', 'error');
  }
}

/* ── Backtest ── */
async function runBacktest(optimize = false) {
  const threshold = $('btThreshold')?.value || 2.0;
  const hold = $('btHold')?.value || 12;
  const sl = $('btSL')?.value || 3.0;
  const tp = $('btTP')?.value || 5.0;
  
  const btn = optimize ? $('btOptBtn') : $('btRunBtn');
  if (btn) {
    btn.textContent = '运行中...';
    btn.disabled = true;
  }
  
  try {
    const params = buildBacktestQuery({
      threshold,
      hold,
      stopLoss: sl,
      takeProfit: tp,
      optimize,
    });
    const res = await fetch('/api/backtest?' + params);
    if (!res.ok) throw new Error('Backtest failed');
    const data = normalizeBacktest(await res.json());

    if (data.error) {
      showError(data.error);
      return;
    }
    
    // Update metrics with safe DOM manipulation
    const metricsEl = $('btMetricsArea');
    if (metricsEl && data.metrics) {
      metricsEl.innerHTML = '';
      const metricsDiv = document.createElement('div');
      metricsDiv.className = 'bt-metrics';
      
      const createMetric = (label, value) => {
        const div = document.createElement('div');
        div.className = 'bt-metric';
        const labelDiv = document.createElement('div');
        labelDiv.className = 'bt-metric-label';
        labelDiv.textContent = label;
        const valDiv = document.createElement('div');
        valDiv.className = 'bt-metric-val';
        valDiv.textContent = value;
        div.appendChild(labelDiv);
        div.appendChild(valDiv);
        return div;
      };
      
      metricsDiv.appendChild(createMetric('胜率', data.metrics.winRate.toFixed(1) + '%'));
      metricsDiv.appendChild(createMetric('收益', data.metrics.totalReturn.toFixed(2) + '%'));
      metricsDiv.appendChild(createMetric('夏普', data.metrics.sharpe.toFixed(2)));
      metricsEl.appendChild(metricsDiv);
    }
    
    // Update weights if optimized
    if (optimize && data.weights) {
      const weightsEl = $('btWeightsArea');
      if (weightsEl) {
        weightsEl.innerHTML = '';
        const title = document.createElement('div');
        title.style.cssText = 'margin-top:8px;font-size:10px;color:var(--text)';
        title.textContent = '优化权重:';
        weightsEl.appendChild(title);
        
        for (const [k, v] of Object.entries(data.weights)) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;justify-content:space-between;font-size:10px;padding:2px 0';
          const keySpan = document.createElement('span');
          keySpan.textContent = k;
          const valSpan = document.createElement('span');
          valSpan.textContent = (v * 100).toFixed(1) + '%';
          row.appendChild(keySpan);
          row.appendChild(valSpan);
          weightsEl.appendChild(row);
        }
      }
    }
    
    // Update trades with safe DOM manipulation
    const tradesEl = $('btTradesArea');
    if (tradesEl && data.trades) {
      tradesEl.innerHTML = '';
      const title = document.createElement('div');
      title.style.cssText = 'margin-top:8px;font-size:10px;color:var(--text)';
      title.textContent = '最近交易:';
      tradesEl.appendChild(title);
      
      for (const t of data.trades.slice(0, 5)) {
        const div = document.createElement('div');
        div.style.cssText = 'font-size:10px;padding:2px 0;color:' + (t.pnlPct >= 0 ? 'var(--green)' : 'var(--red)');
        div.textContent = `${t.direction} ${t.entry.toFixed(2)} → ${t.exit.toFixed(2)} (${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}%)`;
        tradesEl.appendChild(div);
      }
    }
  } catch (e) {
    console.error('Backtest error:', e);
    showError('回测失败: ' + e.message);
  } finally {
    if (btn) {
      btn.textContent = optimize ? '优化' : '回测';
      btn.disabled = false;
    }
  }
}

/* ── Keyboard Shortcuts ── */
document.addEventListener('keydown', (e) => {
  if (e.key === '`' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    e.preventDefault();
    toggleStealth();
  }
});

function stopSecondarySchedules() {
  for (const timer of secondaryTimers) clearInterval(timer);
  secondaryTimers = [];
  for (const controller of panelRequests.values()) controller.abort();
}

function startSecondarySchedules() {
  stopSecondarySchedules();
  void updateIndicators();
  void updateFactors();
  void updateHealth();
  secondaryTimers = [
    setInterval(updateIndicators, 30000),
    setInterval(updateFactors, 60000),
    setInterval(updateHealth, 60000),
  ];
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopSecondarySchedules();
  else startSecondarySchedules();
});

/* ── Init ── */
window.addEventListener('DOMContentLoaded', () => {
  if (window.LightweightCharts) {
    state.charts.m1 = makeChart('chart-m1', 'm1');
    state.charts.m5 = makeChart('chart-m5', 'm5');
    state.charts.m15 = makeChart('chart-m15', 'm15');
    state.charts.h1 = makeChart('chart-h1', 'h1');
  } else {
    document.querySelectorAll('.loading-mask').forEach((element) => {
      element.classList.add('chart-error');
      element.textContent = '图表组件不可用';
    });
  }

  void dashboardController.start();
  void fetchBinancePrice();
  startSecondarySchedules();
});

window.addEventListener('beforeunload', () => {
  dashboardController.stop();
  stopSecondarySchedules();
});

/* ── Expose to global scope for onclick handlers ── */
window.toggleSignalPanel = toggleSignalPanel;
window.toggleCollapsible = toggleCollapsible;
window.toggleCalculator = toggleCalculator;
window.fpSetDirection = fpSetDirection;
window.fpUseCurrentPrice = fpUseCurrentPrice;
window.fpCalculatePnl = fpCalculatePnl;
window.switchTF = switchTF;
window.switchCurrency = switchCurrency;
window.switchSource = switchSource;
window.runBacktest = runBacktest;
window.updateIndicators = updateIndicators;
window.updateFactors = updateFactors;
