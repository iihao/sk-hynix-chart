import {
  state,
  BN,
  KRW_USD_DEFAULT,
  LABELS,
  fmtPrice,
  getLabels,
  $,
  showError,
} from './utils.js';
import { convertQuotePrice, resolveQuoteCurrency } from './header-quote.mjs';
import { makeChart, pushData, resetChartFraming, switchTF as switchChartTimeframe, updateSupportResistance, applyIndicators } from './chart.js';
import {
  toggleCalculator,
  fpSetDirection,
  fpUseCurrentPrice,
  fpCalculatePnl,
  syncBinanceQuote,
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
  buildPanelUrl,
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
  const panel = $('signalPanel');
  panel.classList.toggle('collapsed');
  // Keep 'open' class for backward compatibility
  panel.classList.toggle('open', !panel.classList.contains('collapsed'));
  document.body.classList.toggle('signal-panel-open', !panel.classList.contains('collapsed'));
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
  const frame = data.m1 || data.m5 || data.m15 || {};
  const meta = frame.meta || {};
  const quoteCurrency = resolveQuoteCurrency(frame, meta);
  const displayPrice = (value) => convertQuotePrice(value, {
    fromCurrency: quoteCurrency,
    toCurrency: state.currency,
    krwUsdRate: state.krwUsdRate,
  });
  const price = meta.price || 0;
  const prev = meta.previousClose || 0;
  const pct = prev ? ((price - prev) / prev) * 100 : 0;
  const up = pct >= 0;

  const priceEl = $('hdrPrice');
  priceEl.textContent = fmtPrice(displayPrice(price));
  priceEl.className = 'price ' + (up ? 'up' : 'down');

  const chgEl = $('hdrChange');
  chgEl.textContent = (up ? '+' : '') + pct.toFixed(2) + '%';
  chgEl.className = 'change-badge ' + (up ? 'up' : 'down');

  const L = getLabels();
  document.title = L.title(
    fmtPrice(displayPrice(price)),
    (up ? '+' : '') + pct.toFixed(2),
    up
  );

  $('statPrev').textContent = fmtPrice(displayPrice(prev));
  const closePrice = !meta.marketOpen
    ? price
    : data.m1?.candles?.length
    ? data.m1.candles[data.m1.candles.length - 1].close
    : price;
  $('statClose').textContent = fmtPrice(displayPrice(closePrice));

  if (data.m1?.candles?.length) {
    const allH = data.m1.candles.map((c) => c.high);
    const allL = data.m1.candles.map((c) => c.low);
    $('statHigh').textContent = fmtPrice(displayPrice(Math.max(...allH)));
    $('statLow').textContent = fmtPrice(displayPrice(Math.min(...allL)));
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
    if (data[tf]) pushData(tf, data[tf], bn[tf], state.overlayData);
  });
  updateHeader(data);
  renderSourceToggles();
}

/* ── Latency ── */
function updateLatency(serverTime) {
  const badge = $('latencyBadge');
  if (!serverTime) {
    badge.textContent = '--';
    return;
  }
  const lag = Math.round((Date.now() - serverTime) / 1000);
  let cls;
  if (lag < 5) cls = 'good';
  else if (lag < 15) cls = 'ok';
  else cls = 'bad';
  badge.textContent = (state.stealthMode ? 'lag ' : '延迟 ') + lag + 's';
  badge.className = 'latency ' + cls;

  // Binance latency from latest tick
  const bnBadge = $('latencyBn');
  if (bnBadge && state.rawData?.binance?.m5?.meta) {
    const bnMeta = state.rawData.binance.m5.meta;
    if (bnMeta.price) {
      bnBadge.style.display = 'inline';
      bnBadge.textContent = 'BN $' + bnMeta.price.toFixed(0);
    }
  }
}

/* ── Currency Switch ── */
function switchCurrency(cur) {
  state.currency = cur;
  const bn = state.rawData.binance || {};
  ['m1', 'm5', 'm15', 'h1'].forEach((tf) => {
    if (state.rawData[tf]) pushData(tf, state.rawData[tf], bn[tf], state.overlayData);
  });
  updateHeader(state.rawData);
}

function switchTF(tf, btn) {
  switchChartTimeframe(tf, btn);
  void updateIndicators();
  void updateFactors();
}

/* ── Source Switch ── */
async function switchSource(src) {
  state.currentSource = src;
  resetChartFraming();
  await dashboardController.setSource(src);
}

function preferredSpotSource() {
  if (state.selectedSources.includes('naver')) return 'naver';
  if (state.selectedSources.includes('yahoo')) return 'yahoo';
  return state.currentSource === 'yahoo' ? 'yahoo' : 'naver';
}

function renderSourceToggles() {
  document.querySelectorAll('.source-toggle').forEach((button) => {
    const source = button.dataset.source;
    const active = state.selectedSources.includes(source);
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

async function refreshOverlaySource(source) {
  if (!['naver', 'yahoo'].includes(source)) return;
  if (state.rawData?.source === source) {
    state.overlayData[source] = state.rawData;
    return;
  }
  try {
    const res = await fetch(`/api/data?source=${encodeURIComponent(source)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || data.error) throw new Error(data?.error || 'empty overlay data');
    state.overlayData[data.source || source] = data;
    if (state.rawData?.m1 || state.rawData?.m5) updateAll(state.rawData);
  } catch (e) {
    console.error(`Failed to fetch ${source} overlay:`, e);
  }
}

async function refreshSelectedOverlays() {
  const spotSources = state.selectedSources.filter((source) => ['naver', 'yahoo'].includes(source));
  await Promise.all(spotSources.map((source) => refreshOverlaySource(source)));
}

async function toggleSource(source) {
  if (!['naver', 'yahoo', 'binance'].includes(source)) return;
  const selected = new Set(state.selectedSources);
  if (selected.has(source)) selected.delete(source);
  else selected.add(source);
  if (selected.size === 0) selected.add('naver');
  state.selectedSources = [...selected];
  renderSourceToggles();
  resetChartFraming();

  const nextSpot = preferredSpotSource();
  if (nextSpot !== state.currentSource) {
    state.currentSource = nextSpot;
    await dashboardController.setSource(nextSpot);
  } else {
    await refreshOverlaySource(nextSpot);
  }
  await refreshSelectedOverlays();
  if (state.rawData?.m1 || state.rawData?.m5) updateAll(state.rawData);
}

function applySnapshot(data) {
  if (!data || data.error) {
    if (data?.error) showError(data.error);
    return;
  }
  state.krwUsdRate = data.krwUsd || KRW_USD_DEFAULT;
  state.rawData = data;
  if (['naver', 'yahoo'].includes(data.source)) state.overlayData[data.source] = data;
  state.lastServerTime = data.serverTime || 0;
  const binanceMeta = data.binance?.m5?.meta || data.binance?.m1?.meta || {};
  syncBinanceQuote(binanceMeta.price, binanceMeta.fundingRate);
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
    const requestedTf = state.activeTF;
    const res = await fetch(buildPanelUrl('/api/indicators', requestedTf), { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = normalizeIndicators(await res.json());
    if (data.tf && data.tf !== state.activeTF) return;

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

    // Update support/resistance lines on chart
    const levelGroup = state.selectedSources.includes('binance') && data.levels?.futures
      ? data.levels.futures
      : data.levels?.spot;
    if (levelGroup || data.support || data.resistance) {
      updateSupportResistance(state.activeTF, levelGroup || {
        currency: 'KRW', support: data.support, resistance: data.resistance,
      });
    }

    // Apply indicator overlays (MA, Bollinger)
    applyIndicators(state.activeTF, data, data.times);

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
    const requestedTf = state.activeTF;
    const res = await fetch(buildPanelUrl('/api/factors', requestedTf), { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = normalizeFactors(await res.json());
    if (data.tf && data.tf !== state.activeTF) return;
    
    renderFactors(document, $('factorTags'), data.factors, data.omittedFactors);
    
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
    // Show strategy section when data is available
    const stratEl = $('stratSection');
    const stratCard = $('stratCard');
    if (stratEl && data.direction && data.strategy) {
      stratEl.style.display = 'block';
      // Render strategy details
      if (stratCard) {
        const s = data.strategy;
        const priceText = (value) => {
          const numeric = Number(value);
          return Number.isFinite(numeric) ? '$' + numeric.toFixed(2) : String(value || '--');
        };
        const rows = [
          ['模式', s.regimeLabel || s.regime || '--'],
          ['建议', s.direction || data.direction.label || '--'],
          ['入场', priceText(s.entry)],
          ['止损', priceText(s.stopLoss)],
          ['止盈', priceText(s.takeProfit)],
          ['风险', s.riskLevel || '--'],
          ['杠杆', s.leverage || '--'],
          ['风险收益比', s.riskReward || '--'],
        ].filter(([, v]) => v && v !== '--');
        stratCard.replaceChildren();
        for (const [key, value] of rows) {
          const row = document.createElement('div');
          row.className = 'strat-row';
          const keyEl = document.createElement('span');
          keyEl.className = 'strat-kw';
          keyEl.textContent = key;
          const valueEl = document.createElement('span');
          valueEl.className = 'strat-val';
          valueEl.textContent = String(value);
          row.append(keyEl, valueEl);
          stratCard.appendChild(row);
        }
        // Add evidence
        if (s.evidence) {
          const evFor = s.evidence.for || [];
          const evAgainst = s.evidence.against || [];
          if (evFor.length || evAgainst.length) {
            const evidence = document.createElement('div');
            evidence.className = 'strat-evidence';
            const evForEl = document.createElement('div');
            evForEl.className = 'strat-ev-for';
            evForEl.textContent = `看多 (${evFor.length}): ${evFor.map(e => e.label || e).join(', ') || '无'}`;
            const evAgainstEl = document.createElement('div');
            evAgainstEl.className = 'strat-ev-against';
            evAgainstEl.textContent = `看空 (${evAgainst.length}): ${evAgainst.map(e => e.label || e).join(', ') || '无'}`;
            evidence.append(evForEl, evAgainstEl);
            stratCard.appendChild(evidence);
          }
        }
      }
    } else if (stratEl) {
      stratEl.style.display = 'none';
    }
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
    const res = await fetch('/api/quality', { signal });
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
      timeframe: state.activeTF,
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

    const contextEl = $('btContextArea');
    if (contextEl) {
      const testTrades = Number(data.test?.trades) || 0;
      contextEl.className = testTrades < 3 ? 'bt-context warn' : 'bt-context';
      contextEl.textContent = testTrades < 3
        ? `测试集仅 ${testTrades} 笔交易，结果样本不足`
        : `测试集 ${testTrades} 笔交易`;
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
    
    // Display optimization results (factor analysis, signal analysis, improvements)
    if (optimize && data.optimization) {
      const opt = data.optimization;
      
      // Factor Analysis
      if (opt.factorAnalysis && opt.factorAnalysis.length > 0) {
        const factorEl = document.createElement('div');
        factorEl.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid var(--border)';
        
        const factorTitle = document.createElement('div');
        factorTitle.style.cssText = 'font-size:10px;color:var(--text);margin-bottom:6px;font-weight:600';
        factorTitle.textContent = '因子分析:';
        factorEl.appendChild(factorTitle);
        
        for (const fa of opt.factorAnalysis.slice(0, 6)) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;justify-content:space-between;font-size:9px;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.03)';
          
          const nameSpan = document.createElement('span');
          nameSpan.textContent = fa.label;
          nameSpan.style.cssText = 'color:var(--text-bright)';
          
          const corrSpan = document.createElement('span');
          const corrColor = fa.correlation > 0.1 ? 'var(--green)' : fa.correlation < -0.1 ? 'var(--red)' : 'var(--text)';
          corrSpan.textContent = `相关:${fa.correlation.toFixed(2)}`;
          corrSpan.style.cssText = `color:${corrColor};font-family:monospace`;
          
          const sugSpan = document.createElement('span');
          sugSpan.textContent = `建议:${(fa.suggestedWeight * 100).toFixed(0)}%`;
          sugSpan.style.cssText = 'color:var(--yellow);font-family:monospace';
          
          row.append(nameSpan, corrSpan, sugSpan);
          factorEl.appendChild(row);
        }
        
        weightsEl.appendChild(factorEl);
      }
      
      // Signal Analysis
      if (opt.signalAnalysis && opt.signalAnalysis.length > 0) {
        const signalEl = document.createElement('div');
        signalEl.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid var(--border)';
        
        const signalTitle = document.createElement('div');
        signalTitle.style.cssText = 'font-size:10px;color:var(--text);margin-bottom:6px;font-weight:600';
        signalTitle.textContent = '信号效果:';
        signalEl.appendChild(signalTitle);
        
        for (const sa of opt.signalAnalysis.slice(0, 5)) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;justify-content:space-between;font-size:9px;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.03)';
          
          const nameSpan = document.createElement('span');
          nameSpan.textContent = sa.label;
          nameSpan.style.cssText = 'color:var(--text-bright)';
          
          const winSpan = document.createElement('span');
          const winColor = sa.winRate > 55 ? 'var(--green)' : sa.winRate < 40 ? 'var(--red)' : 'var(--text)';
          winSpan.textContent = `胜率:${sa.winRate.toFixed(1)}%`;
          winSpan.style.cssText = `color:${winColor};font-family:monospace`;
          
          const actionSpan = document.createElement('span');
          const actionLabels = { keep: '保持', increase_threshold: '↑阈值', decrease_threshold: '↓阈值', disable: '禁用' };
          actionSpan.textContent = actionLabels[sa.suggestedAction] || sa.suggestedAction;
          actionSpan.style.cssText = sa.suggestedAction === 'disable' ? 'color:var(--red)' : 'color:var(--text)';
          
          row.append(nameSpan, winSpan, actionSpan);
          signalEl.appendChild(row);
        }
        
        weightsEl.appendChild(signalEl);
      }
      
      // Improvements
      if (opt.improvements && opt.improvements.length > 0) {
        const impEl = document.createElement('div');
        impEl.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid var(--border)';
        
        const impTitle = document.createElement('div');
        impTitle.style.cssText = 'font-size:10px;color:var(--text);margin-bottom:6px;font-weight:600';
        impTitle.textContent = '优化建议:';
        impEl.appendChild(impTitle);
        
        for (const imp of opt.improvements.slice(0, 5)) {
          const row = document.createElement('div');
          row.style.cssText = 'font-size:9px;padding:2px 0;color:var(--yellow)';
          row.textContent = '• ' + imp;
          impEl.appendChild(row);
        }
        
        weightsEl.appendChild(impEl);
      }
      
      // Comparison metrics
      if (opt.currentMetrics && opt.optimizedMetrics) {
        const compEl = document.createElement('div');
        compEl.style.cssText = 'margin-top:10px;padding:6px;background:rgba(255,255,255,0.02);border-radius:4px';
        
        const compTitle = document.createElement('div');
        compTitle.style.cssText = 'font-size:9px;color:var(--text);margin-bottom:4px';
        compTitle.textContent = '优化对比:';
        compEl.appendChild(compTitle);
        
        const createCompRow = (label, before, after, format = v => v.toFixed(2)) => {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;justify-content:space-between;font-size:9px;padding:1px 0';
          const diff = after - before;
          const color = diff > 0 ? 'var(--green)' : diff < 0 ? 'var(--red)' : 'var(--text)';
          row.innerHTML = `<span>${label}</span><span style="color:${color}">${format(before)} → ${format(after)}</span>`;
          return row;
        };
        
        compEl.appendChild(createCompRow('收益%', opt.currentMetrics.totalReturn, opt.optimizedMetrics.totalReturn));
        compEl.appendChild(createCompRow('夏普', opt.currentMetrics.sharpe, opt.optimizedMetrics.sharpe));
        compEl.appendChild(createCompRow('胜率%', opt.currentMetrics.winRate, opt.optimizedMetrics.winRate));
        
        weightsEl.appendChild(compEl);
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
  void refreshSelectedOverlays();
  secondaryTimers = [
    setInterval(updateIndicators, 30000),
    setInterval(updateFactors, 60000),
    setInterval(updateHealth, 60000),
    setInterval(refreshSelectedOverlays, 60000),
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

  renderSourceToggles();
  void dashboardController.start();
  void fetchBinancePrice();
  startSecondarySchedules();
});

window.addEventListener('beforeunload', () => {
  dashboardController.stop();
  stopSecondarySchedules();
});

/* ── Wide Mode Toggle ── */
let wideMode = false;
function toggleWideMode() {
  wideMode = !wideMode;
  document.body.classList.toggle('wide-mode', wideMode);
  // Resize charts after transition
  setTimeout(() => {
    Object.values(state.charts).forEach(c => {
      if (c && c.chart) {
        const w = c.chart.options().width;
        const h = c.chart.options().height;
        c.chart.applyOptions({ width: w - 1, height: h });
        c.chart.applyOptions({ width: w, height: h });
      }
    });
  }, 350);
}

/* ── Expose to global scope for onclick handlers ── */
window.toggleSignalPanel = toggleSignalPanel;
window.toggleCollapsible = toggleCollapsible;
window.toggleCalculator = toggleCalculator;
window.toggleWideMode = toggleWideMode;
window.fpSetDirection = fpSetDirection;
window.fpUseCurrentPrice = fpUseCurrentPrice;
window.fpCalculatePnl = fpCalculatePnl;
window.switchTF = switchTF;
window.switchCurrency = switchCurrency;
window.switchSource = switchSource;
window.toggleSource = toggleSource;
window.runBacktest = runBacktest;
window.updateIndicators = updateIndicators;
window.updateFactors = updateFactors;
