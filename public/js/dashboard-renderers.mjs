const BULLISH_TYPES = new Set([
  'buy', 'golden_cross', 'rsi_oversold', 'macd_golden', 'boll_breakdown',
  'ma_golden', 'uptrend',
]);
const BEARISH_TYPES = new Set([
  'sell', 'death_cross', 'rsi_overbought', 'macd_death', 'boll_breakup',
  'ma_death', 'downtrend',
]);

function clear(element) {
  while (element?.firstChild) element.removeChild(element.firstChild);
}

function appendText(document, parent, tag, className, value) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = String(value ?? '');
  parent.appendChild(element);
  return element;
}

export function renderPanelMessage(document, element, message, tone = 'muted') {
  if (!element) return;
  clear(element);
  appendText(document, element, 'div', `panel-message ${tone}`, message);
}

export function renderSignals(document, element, signals) {
  if (!element) return;
  clear(element);
  if (!Array.isArray(signals) || signals.length === 0) {
    renderPanelMessage(document, element, '暂无信号');
    return;
  }
  for (const signal of signals) {
    const row = document.createElement('div');
    const tone = BULLISH_TYPES.has(signal.type)
      ? 'bull'
      : BEARISH_TYPES.has(signal.type) ? 'bear' : 'neut';
    row.className = `sig-row ${tone}`;
    appendText(document, row, 'span', 'sig-dot', '');
    appendText(document, row, 'span', 'sig-label', signal.label || '未命名信号');
    
    // Show trigger time if available
    if (signal.time) {
      const time = new Date(signal.time * 1000 + 8 * 3600000); // Beijing time
      const hh = String(time.getUTCHours()).padStart(2, '0');
      const mm = String(time.getUTCMinutes()).padStart(2, '0');
      const MM = String(time.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(time.getUTCDate()).padStart(2, '0');
      appendText(document, row, 'span', 'sig-time', `${MM}/${dd} ${hh}:${mm}`);
    }
    
    appendText(document, row, 'span', 'sig-strength', '*'.repeat(Math.max(1, Number(signal.strength) || 1)));
    element.appendChild(row);
  }
}

export function renderFactors(document, element, factors, omittedFactors = []) {
  if (!element) return;
  clear(element);
  if (!Array.isArray(factors) || factors.length === 0) {
    renderPanelMessage(document, element, '暂无因子数据');
    return;
  }
  for (const factor of factors) {
    const score = Number(factor.score) || 0;
    const weight = Number(factor.weight) || 0;
    const row = document.createElement('div');
    row.className = `factor-row ${score > 0 ? 'bull' : score < 0 ? 'bear' : 'neut'}`;
    
    // Factor name with weight indicator
    const nameSpan = document.createElement('span');
    nameSpan.className = 'factor-name';
    nameSpan.textContent = factor.label || '未命名因子';
    row.appendChild(nameSpan);
    
    // Score bar visualization
    const barContainer = document.createElement('span');
    barContainer.className = 'factor-bar-container';
    const bar = document.createElement('span');
    bar.className = 'factor-bar';
    const barWidth = Math.min(100, Math.abs(score) * 10);
    if (bar.style) {
      bar.style.width = `${barWidth}%`;
      bar.style.left = score >= 0 ? '50%' : `${50 - barWidth}%`;
    }
    barContainer.appendChild(bar);
    row.appendChild(barContainer);
    
    // Score value
    appendText(document, row, 'span', 'factor-score', `${score > 0 ? '+' : ''}${score.toFixed(1)}`);
    
    // Detail tooltip
    const detailSpan = document.createElement('span');
    detailSpan.className = 'factor-detail';
    detailSpan.textContent = factor.detail || '';
    detailSpan.title = `权重: ${weight.toFixed(2)}`;
    row.appendChild(detailSpan);
    
    element.appendChild(row);
  }
  
  // Add composite summary
  const summary = document.createElement('div');
  summary.className = 'factor-summary';
  summary.textContent = omittedFactors.length > 0
    ? `已省略 ${omittedFactors.map((item) => item.category).join(', ')}`
    : '数据覆盖完整';
  element.appendChild(summary);
}

function contextRow(document, label, value, tone = '') {
  const row = document.createElement('div');
  row.className = 'ctx-row';
  appendText(document, row, 'span', 'ctx-label', label);
  appendText(document, row, 'span', `ctx-val${tone ? ` ${tone}` : ''}`, value);
  return row;
}

export function renderMarketContext(document, element, context) {
  if (!element) return;
  clear(element);
  if (!context) {
    renderPanelMessage(document, element, '暂无市场环境数据');
    return;
  }
  if (context.koreaSession) {
    const tone = context.koreaSession.isRegular ? 'green' : context.koreaSession.isPreMarket ? 'yellow' : '';
    element.appendChild(contextRow(document, '韩股时段', context.koreaSession.label, tone));
  }
  if (context.regime) {
    const tone = context.regime.mode === 'trend' ? 'green' : context.regime.mode === 'event' ? 'red' : 'yellow';
    element.appendChild(contextRow(document, '市场模式', context.regime.label, tone));
    appendText(document, element, 'div', 'ctx-reason', context.regime.reason || '');
  }
  if (context.fundingCountdown) {
    element.appendChild(contextRow(document, '资金费率', context.fundingCountdown.label, context.fundingCountdown.isSoon ? 'yellow' : ''));
  }
  if (context.eventWindow) {
    const tone = context.eventWindow.status === 'freeze' ? 'red' : context.eventWindow.status === 'watch' ? 'yellow' : '';
    element.appendChild(contextRow(document, '事件窗口', context.eventWindow.message, tone));
  }
  if (context.basis?.ready) {
    const tone = context.basis.state === 'extreme' ? 'red' : context.basis.state === 'stretched' ? 'yellow' : '';
    element.appendChild(contextRow(document, '基差', `${context.basis.currentBasisPct}% (${context.basis.label})`, tone));
  }
  if (context.atrPct !== undefined) {
    const tone = context.atrPct >= 3 ? 'red' : context.atrPct >= 2 ? 'yellow' : '';
    element.appendChild(contextRow(document, '波动率', `${context.atrPct}%`, tone));
  }
  if (context.risk) {
    const tone = context.risk.blocked ? 'red' : context.risk.action === 'reduce' ? 'yellow' : 'green';
    element.appendChild(contextRow(document, '仓位建议', `${context.risk.positionPct}%`, tone));
    element.appendChild(contextRow(document, '杠杆上限', context.risk.leverageCap, tone));
    const messages = [...(context.risk.reasons || []), ...(context.risk.warnings || [])].slice(0, 3);
    for (const message of messages) appendText(document, element, 'div', 'ctx-warn', `! ${message}`);
  }
}

export function renderSourceHealth(document, element, health, now = Date.now()) {
  if (!element) return;
  clear(element);
  const sources = [
    ['Naver', health?.naver],
    ['Binance', health?.binance],
  ];
  for (const [label, source] of sources) {
    const latestSeconds = Number(source?.latest?.ts) || 0;
    const age = latestSeconds ? Math.max(0, Math.round(now / 1000 - latestSeconds)) : null;
    const row = document.createElement('div');
    row.className = `health-row ${age === null || age > 120 ? 'stale' : 'fresh'}`;
    appendText(document, row, 'span', 'health-source', label);
    appendText(document, row, 'span', 'health-count', `${Number(source?.count) || 0} ticks`);
    appendText(document, row, 'span', 'health-age', age === null ? '无数据' : `${age}s`);
    element.appendChild(row);
  }
}

export function renderConnectionState(element, connection) {
  if (!element) return;
  const labels = {
    connecting: '连接中', live: 'LIVE', fallback: '备用轮询', offline: '离线',
  };
  element.textContent = labels[connection] || labels.offline;
  element.className = `refresh-label connection-${connection || 'offline'}`;
}
