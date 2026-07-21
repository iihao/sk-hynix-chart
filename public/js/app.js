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
import {
  paperCloseAll,
  paperClosePosition,
  paperSaveAccount,
  paperSetDirection,
  paperSubmitOrder,
  paperSwitchTab,
  updatePaperTrading,
} from './paper-trading.js';

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

/* ── Paper Terminal Collapse ── */
function toggleTerminalCollapse(event) {
  // Don't collapse when clicking a tab button
  if (event.target.closest('.paper-terminal-tab')) return;
  $('paperTradingTerminal').classList.toggle('collapsed');
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
function renderDecisionTrace(root, trace) {
  if (!root || !trace) return;

  const toneMap = {
    long: 'long',
    short: 'short',
    neutral: 'neutral',
    confirm: 'good',
    supportive: 'good',
    tradable: 'good',
    diverge: 'bad',
    conflicting: 'bad',
    weak: 'bad',
    unknown: 'warn',
    insufficient: 'warn',
  };
  const verdictText = {
    confirm: '确认',
    diverge: '背离',
    neutral: '中性',
    unknown: '未知',
    supportive: '支持',
    conflicting: '冲突',
    tradable: '可交易',
    weak: '偏弱',
    insufficient: '样本不足',
    long: '偏多',
    short: '偏空',
  };
  const section = document.createElement('div');
  section.className = 'decision-trace';

  const title = document.createElement('div');
  title.className = 'decision-trace-title';
  title.textContent = '决策链路';
  section.appendChild(title);

  const addStep = (name, verdict, summary, details = []) => {
    const step = document.createElement('div');
    step.className = 'decision-step';
    const head = document.createElement('div');
    head.className = 'decision-step-head';
    const nameEl = document.createElement('span');
    nameEl.className = 'decision-step-name';
    nameEl.textContent = name;
    const badge = document.createElement('span');
    badge.className = 'decision-step-badge tone-' + (toneMap[verdict] || 'neutral');
    badge.textContent = verdictText[verdict] || verdict || '--';
    head.append(nameEl, badge);
    const summaryEl = document.createElement('div');
    summaryEl.className = 'decision-step-summary';
    summaryEl.textContent = summary || '--';
    step.append(head, summaryEl);
    if (details.length) {
      const list = document.createElement('div');
      list.className = 'decision-step-details';
      for (const detail of details.slice(0, 4)) {
        const item = document.createElement('span');
        item.textContent = detail;
        list.appendChild(item);
      }
      step.appendChild(list);
    }
    section.appendChild(step);
  };

  addStep('原始因子', trace.raw?.direction, trace.raw?.summary, (trace.raw?.topDrivers || []).map(d => `${d.label}:${d.score}`));
  addStep('技术确认', trace.technical?.verdict, trace.technical?.summary, trace.technical?.checks || []);
  addStep('影响因子', trace.impact?.verdict, trace.impact?.summary, (trace.impact?.drivers || []).map(d => d.contribution || d.label));
  addStep('回测校准', trace.backtest?.verdict, trace.backtest?.summary, [
    `概率 ${Number(trace.backtest?.probability || 50).toFixed(1)}%`,
    `样本 ${trace.backtest?.sampleTrades || 0} 笔`,
    `夏普 ${Number(trace.backtest?.sharpe || 0).toFixed(2)}`,
  ]);
  addStep('最终建议', trace.final?.finalDirection, trace.final?.summary, [
    trace.final?.directionOverridden ? `方向覆盖：${trace.final.overrideReason}` : '未覆盖原始方向',
    ...(trace.final?.blockers || []).map(b => `限制：${b}`),
  ]);

  root.appendChild(section);
}

async function updateFactors() {
  const signal = nextPanelSignal('factors');
  try {
    const requestedTf = state.activeTF;
    const res = await fetch(buildPanelUrl('/api/factors', requestedTf), { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = normalizeFactors(await res.json());
    if (data.tf && data.tf !== state.activeTF) return;

    renderFactors(document, $('factorTags'), data.factors, data.omittedFactors);

    // Render TF Profile Header
    const tfProfile = data.timeframeProfile;
    if (tfProfile) {
      const tfIcon = $('tfIcon');
      const tfLabel = $('tfLabel');
      const tfRole = $('tfRole');
      const tfWeight = $('tfWeight');

      if (tfIcon) {
        tfIcon.textContent = tfProfile.tf || '5m';
        tfIcon.className = 'tf-icon role-' + (tfProfile.role || 'trade');
      }
      if (tfLabel) tfLabel.textContent = tfProfile.label || (tfProfile.tf + ' 分析');
      if (tfRole) {
        const roleLabels = { trade: '主决策', scalp: '入场节奏', confirm: '趋势确认' };
        const cal = tfProfile.calibration;
        const calText = cal && cal.sampleTrades > 0
          ? ' · 回测' + cal.sampleTrades + '笔 · 胜率' + cal.winRate + '%'
          : '';
        tfRole.textContent = (roleLabels[tfProfile.role] || tfProfile.role) + calText;
      }
      if (tfWeight) tfWeight.textContent = Math.round((tfProfile.decisionWeight || 0) * 100) + '%';
    }

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
      if (dirConf) {
        dirConf.textContent = data.direction.confidence + '%';
        const calibration = data.confidenceCalibration;
        dirConf.title = calibration
          ? `回测校准置信度 ${calibration.confidence}%｜原始强度 ${calibration.rawConfidence}%｜技术确认 ${(calibration.indicatorAgreement * 100).toFixed(0)}%｜因子共振 ${(calibration.factorAgreement * 100).toFixed(0)}%`
          : '原始因子置信度';
      }
    }

    // Update direction reason
    const dirReason = $('dirReason');
    if (dirReason && data.factors && data.factors.length > 0) {
      const topFactor = data.factors.reduce((a, b) => Math.abs(a.score) > Math.abs(b.score) ? a : b);
      dirReason.textContent = topFactor.label + ': ' + topFactor.detail;
    }

    // Update calibration bar
    const calibration = data.confidenceCalibration;
    if (calibration) {
      const calRaw = $('calRaw');
      const calIndicator = $('calIndicator');
      const calFactor = $('calFactor');
      const calBacktest = $('calBacktest');

      function toneForValue(val) {
        if (val >= 60) return 'tone-green';
        if (val >= 35) return 'tone-yellow';
        return 'tone-red';
      }

      // DOM order inside .calibration-item is: dot -> label -> value.
      // Target the real .calibration-dot (NOT previousElementSibling, which is the label).
      function setCal(valueEl, val) {
        if (!valueEl) return;
        valueEl.textContent = val + '%';
        const dot = valueEl.parentElement && valueEl.parentElement.querySelector('.calibration-dot');
        if (dot) dot.className = 'calibration-dot ' + toneForValue(val);
      }

      setCal(calRaw, calibration.rawConfidence || 0);
      setCal(calIndicator, Math.round((calibration.indicatorAgreement || 0) * 100));
      setCal(calFactor, Math.round((calibration.factorAgreement || 0) * 100));
      setCal(calBacktest, Math.round(calibration.backtestProbability || 50));

      // Render debug breakdown
      const debugEl = $('calibrationDebug');
      if (debugEl && calibration.debug) {
        const d = calibration.debug;
        const parts = [
          { label: '原始', value: d.rawScore, color: d.rawScore > 15 ? 'green' : d.rawScore > 8 ? 'yellow' : 'red' },
          { label: '回测', value: d.backtestScore, color: d.backtestScore > 15 ? 'green' : d.backtestScore > 8 ? 'yellow' : 'red' },
          { label: '样本', value: d.sampleScore, color: d.sampleScore > 10 ? 'green' : d.sampleScore > 5 ? 'yellow' : 'red' },
          { label: '收益', value: d.performanceScore, color: d.performanceScore > 10 ? 'green' : d.performanceScore > 5 ? 'yellow' : 'red' },
          { label: '回撤', value: d.drawdownScore, color: d.drawdownScore > 6 ? 'green' : d.drawdownScore > 3 ? 'yellow' : 'red' },
          { label: '夏普', value: d.sharpeScore, color: d.sharpeScore > 6 ? 'green' : d.sharpeScore > 3 ? 'yellow' : 'red' },
          { label: '因子', value: d.factorScore, color: d.factorScore > 6 ? 'green' : d.factorScore > 3 ? 'yellow' : 'red' },
          { label: '技术', value: d.indicatorScore, color: d.indicatorScore > 5 ? 'green' : d.indicatorScore > 2 ? 'yellow' : 'red' },
          { label: '强度', value: d.signalBonus, color: d.signalBonus > 2 ? 'green' : 'yellow' },
        ];

        debugEl.innerHTML = '';
        debugEl.style.display = 'block';

        const title = document.createElement('div');
        title.className = 'debug-title';
        title.textContent = '置信度分解';
        debugEl.appendChild(title);

        const grid = document.createElement('div');
        grid.className = 'debug-grid';
        for (const p of parts) {
          const item = document.createElement('div');
          item.className = 'debug-item';
          item.innerHTML = `<span class="debug-label">${p.label}</span><span class="debug-val ${p.color}">${p.value.toFixed(1)}</span>`;
          grid.appendChild(item);
        }
        debugEl.appendChild(grid);

        // Show penalties if any
        if (d.penaltyDetails && d.penaltyDetails.length > 0) {
          const penaltyDiv = document.createElement('div');
          penaltyDiv.className = 'debug-penalties';
          for (const p of d.penaltyDetails) {
            const row = document.createElement('div');
            row.className = 'debug-penalty';
            row.innerHTML = `<span class="debug-penalty-type">${p.type}</span><span class="debug-penalty-reason">${p.reason}</span><span class="debug-penalty-impact">-${p.impact}</span>`;
            penaltyDiv.appendChild(row);
          }
          debugEl.appendChild(penaltyDiv);
        }

        // Show formula
        const formulaDiv = document.createElement('div');
        formulaDiv.className = 'debug-formula';
        formulaDiv.textContent = d.formula;
        debugEl.appendChild(formulaDiv);
      }
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
        const toneFor = (key, value) => {
          const v = String(value).toLowerCase();
          if (key === '建议') {
            if (/long|多/.test(v)) return 'tone-long';
            if (/short|空/.test(v)) return 'tone-short';
            return 'tone-neutral';
          }
          if (key === '风险') {
            if (v === 'low') return 'tone-good';
            if (v === 'medium') return 'tone-warn';
            if (v === 'high') return 'tone-bad';
          }
          if (key === '入场' || key === '止损' || key === '止盈') return 'tone-price';
          return '';
        };
        for (const [key, value] of rows) {
          const row = document.createElement('div');
          row.className = 'strat-row';
          const keyEl = document.createElement('span');
          keyEl.className = 'strat-kw';
          keyEl.textContent = key;
          const valueEl = document.createElement('span');
          const tone = toneFor(key, value);
          valueEl.className = 'strat-val' + (tone ? ' ' + tone : '');
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
            const buildGroup = (items, cls, title) => {
              const group = document.createElement('div');
              group.className = 'strat-ev-group ' + cls;
              const head = document.createElement('div');
              head.className = 'strat-ev-head';
              const label = document.createElement('span');
              label.className = 'strat-ev-title';
              label.textContent = title;
              const count = document.createElement('span');
              count.className = 'strat-ev-count';
              count.textContent = items.length;
              head.append(label, count);
              group.appendChild(head);
              const chips = document.createElement('div');
              chips.className = 'strat-ev-chips';
              if (items.length) {
                for (const item of items) {
                  const chip = document.createElement('span');
                  chip.className = 'strat-ev-chip';
                  chip.textContent = item.label || item;
                  chips.appendChild(chip);
                }
              } else {
                const none = document.createElement('span');
                none.className = 'strat-ev-none';
                none.textContent = '无';
                chips.appendChild(none);
              }
              group.appendChild(chips);
              return group;
            };
            evidence.append(
              buildGroup(evFor, 'for', '看多'),
              buildGroup(evAgainst, 'against', '看空')
            );
            stratCard.appendChild(evidence);
          }
        }
        renderDecisionTrace(stratCard, s.advice?.decisionTrace);
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
const WEIGHT_LABELS = {
  momentum: '价格动量', funding: '资金费率', volume: '成交量', volatility: '波动率',
  fx: '汇率影响', premium: '合约溢价', indicator: '指标动量', structure: '结构位',
  lsRatio: '多空比', takerVol: '主动买卖', openInterest: '持仓量',
  lsTrend: '多空趋势', whale: '庄家动向', news: '新闻情绪',
};

const fmtBtPrice = (v) => {
  // Backtest prices from Binance are already in USD
  if (state.currency === 'KRW') return '₩' + Math.round(v * state.krwUsdRate).toLocaleString();
  return '$' + v.toFixed(2);
};

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

    const metrics = data.metrics || {};
    const costs = data.costs || {};

    // Update metrics
    const metricsEl = $('btMetricsArea');
    if (metricsEl) {
      metricsEl.innerHTML = '';
      const metricsDiv = document.createElement('div');
      metricsDiv.className = 'bt-metrics';

      const createMetric = (label, value, color = '') => {
        const div = document.createElement('div');
        div.className = 'bt-metric';
        const labelDiv = document.createElement('div');
        labelDiv.className = 'bt-metric-label';
        labelDiv.textContent = label;
        const valDiv = document.createElement('div');
        valDiv.className = 'bt-metric-val' + (color ? ` ${color}` : '');
        valDiv.textContent = value;
        div.appendChild(labelDiv);
        div.appendChild(valDiv);
        return div;
      };

      const returnColor = metrics.totalReturn > 0 ? 'profit' : metrics.totalReturn < 0 ? 'loss' : '';

      metricsDiv.appendChild(createMetric('交易数', String(metrics.totalTrades || 0)));
      metricsDiv.appendChild(createMetric('胜率', (metrics.winRate || 0).toFixed(1) + '%', metrics.winRate > 50 ? 'profit' : metrics.winRate < 40 ? 'loss' : ''));
      metricsDiv.appendChild(createMetric('收益', (metrics.totalReturn || 0).toFixed(2) + '%', returnColor));
      metricsDiv.appendChild(createMetric('夏普', (metrics.sharpe || 0).toFixed(2), metrics.sharpe > 1 ? 'profit' : metrics.sharpe < 0 ? 'loss' : ''));
      metricsDiv.appendChild(createMetric('回撤', (metrics.maxDrawdown || 0).toFixed(2) + '%', metrics.maxDrawdown > 10 ? 'loss' : ''));
      metricsDiv.appendChild(createMetric('盈亏比', (metrics.profitFactor || 0).toFixed(2), metrics.profitFactor > 1.5 ? 'profit' : ''));
      metricsEl.appendChild(metricsDiv);
    }

    // Context info
    const contextEl = $('btContextArea');
    if (contextEl) {
      const testTrades = Number(data.test?.trades) || 0;
      contextEl.className = testTrades < 3 ? 'bt-context warn' : 'bt-context';
      contextEl.textContent = testTrades < 3
        ? `测试集仅 ${testTrades} 笔交易，样本不足`
        : `测试集 ${testTrades} 笔 | 手续费 $${(costs.fees || 0).toFixed(2)} | 滑点 $${(costs.slippage || 0).toFixed(2)}`;
    }

    // Update weights and optimization results
    const weightsEl = $('btWeightsArea');
    if (weightsEl) {
      weightsEl.innerHTML = '';

      if (optimize && data.weights) {
        const title = document.createElement('div');
        title.className = 'bt-section-title';
        title.textContent = '优化权重';
        weightsEl.appendChild(title);

        const weightsGrid = document.createElement('div');
        weightsGrid.className = 'bt-weights-grid';
        for (const [k, v] of Object.entries(data.weights)) {
          const chip = document.createElement('div');
          chip.className = 'bt-weight-chip';
          const label = WEIGHT_LABELS[k] || k;
          chip.innerHTML = `<span>${label}</span><span>${(v * 100).toFixed(0)}%</span>`;
          weightsGrid.appendChild(chip);
        }
        weightsEl.appendChild(weightsGrid);
      }

      // Display optimization results
      if (optimize && data.optimization) {
        const opt = data.optimization;

        // Factor Analysis
        if (opt.factorAnalysis?.length > 0) {
          const section = document.createElement('div');
          section.className = 'bt-section';

          const title = document.createElement('div');
          title.className = 'bt-section-title';
          title.textContent = '因子分析';
          section.appendChild(title);

          for (const fa of opt.factorAnalysis.slice(0, 6)) {
            const row = document.createElement('div');
            row.className = 'bt-analysis-row';

            const name = document.createElement('span');
            name.className = 'bt-analysis-name';
            name.textContent = fa.label;

            const corr = document.createElement('span');
            corr.className = 'bt-analysis-corr ' + (fa.correlation > 0.1 ? 'bull' : fa.correlation < -0.1 ? 'bear' : '');
            corr.textContent = `r=${fa.correlation.toFixed(2)}`;

            const sug = document.createElement('span');
            sug.className = 'bt-analysis-sug';
            sug.textContent = `→${(fa.suggestedWeight * 100).toFixed(0)}%`;

            row.append(name, corr, sug);
            section.appendChild(row);
          }
          weightsEl.appendChild(section);
        }

        // Signal Analysis
        if (opt.signalAnalysis?.length > 0) {
          const section = document.createElement('div');
          section.className = 'bt-section';

          const title = document.createElement('div');
          title.className = 'bt-section-title';
          title.textContent = '信号效果';
          section.appendChild(title);

          for (const sa of opt.signalAnalysis.slice(0, 5)) {
            const row = document.createElement('div');
            row.className = 'bt-analysis-row';

            const name = document.createElement('span');
            name.className = 'bt-analysis-name';
            name.textContent = sa.label;

            const win = document.createElement('span');
            win.className = 'bt-analysis-win ' + (sa.winRate > 55 ? 'bull' : sa.winRate < 40 ? 'bear' : '');
            win.textContent = `${sa.winRate.toFixed(0)}%`;

            const action = document.createElement('span');
            const actionLabels = { keep: '保持', increase_threshold: '提高', decrease_threshold: '降低', disable: '禁用' };
            action.className = 'bt-analysis-action ' + (sa.suggestedAction === 'disable' ? 'bear' : '');
            action.textContent = actionLabels[sa.suggestedAction] || '';

            row.append(name, win, action);
            section.appendChild(row);
          }
          weightsEl.appendChild(section);
        }

        // Improvements
        if (opt.improvements?.length > 0) {
          const section = document.createElement('div');
          section.className = 'bt-section';

          const title = document.createElement('div');
          title.className = 'bt-section-title';
          title.textContent = '优化建议';
          section.appendChild(title);

          for (const imp of opt.improvements.slice(0, 5)) {
            const row = document.createElement('div');
            row.className = 'bt-improvement';
            row.textContent = imp;
            section.appendChild(row);
          }
          weightsEl.appendChild(section);
        }

        // Comparison
        if (opt.currentMetrics && opt.optimizedMetrics) {
          const section = document.createElement('div');
          section.className = 'bt-section bt-comparison';

          const title = document.createElement('div');
          title.className = 'bt-section-title';
          title.textContent = '优化对比';
          section.appendChild(title);

          const rows = [
            ['收益', opt.currentMetrics.totalReturn, opt.optimizedMetrics.totalReturn, '%'],
            ['夏普', opt.currentMetrics.sharpe, opt.optimizedMetrics.sharpe, ''],
            ['胜率', opt.currentMetrics.winRate, opt.optimizedMetrics.winRate, '%'],
          ];

          for (const [label, before, after, unit] of rows) {
            const row = document.createElement('div');
            row.className = 'bt-comp-row';
            const diff = after - before;
            const color = diff > 0 ? 'profit' : diff < 0 ? 'loss' : '';
            row.innerHTML = `<span>${label}</span><span class="${color}">${before.toFixed(1)}${unit} → ${after.toFixed(1)}${unit}</span>`;
            section.appendChild(row);
          }
          weightsEl.appendChild(section);
        }
      }
    }

    // Update trades
    const tradesEl = $('btTradesArea');
    if (tradesEl && data.trades) {
      tradesEl.innerHTML = '';

      const title = document.createElement('div');
      title.className = 'bt-section-title';
      title.textContent = `交易记录 (${data.trades.length}笔)`;
      tradesEl.appendChild(title);

      for (const t of data.trades.slice(0, 10)) {
        const row = document.createElement('div');
        row.className = 'bt-trade ' + (t.pnlPct >= 0 ? 'profit' : 'loss');

        const dir = document.createElement('span');
        dir.className = 'bt-trade-dir';
        dir.textContent = t.direction === 'long' ? '多' : '空';

        const entry = document.createElement('span');
        entry.className = 'bt-trade-price';
        entry.textContent = fmtBtPrice(t.entry);

        const arrow = document.createElement('span');
        arrow.className = 'bt-trade-arrow';
        arrow.textContent = '→';

        const exit = document.createElement('span');
        exit.className = 'bt-trade-price';
        exit.textContent = fmtBtPrice(t.exit);

        const pnl = document.createElement('span');
        pnl.className = 'bt-trade-pnl';
        pnl.textContent = `${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}%`;

        const reason = document.createElement('span');
        reason.className = 'bt-trade-reason';
        const reasonLabels = { stopLoss: '止损', takeProfit: '止盈', timeout: '超时', signal: '信号' };
        reason.textContent = reasonLabels[t.exitReason] || '';

        row.append(dir, entry, arrow, exit, pnl, reason);
        tradesEl.appendChild(row);
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
  void updatePaperTrading();
  secondaryTimers = [
    setInterval(updateIndicators, 30000),
    setInterval(updateFactors, 60000),
    setInterval(updateHealth, 60000),
    setInterval(refreshSelectedOverlays, 60000),
    setInterval(updatePaperTrading, 5000),
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
window.toggleTerminalCollapse = toggleTerminalCollapse;
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
window.paperSetDirection = paperSetDirection;
window.paperSaveAccount = paperSaveAccount;
window.paperSubmitOrder = paperSubmitOrder;
window.paperClosePosition = paperClosePosition;
window.paperCloseAll = paperCloseAll;
window.paperSwitchTab = paperSwitchTab;
