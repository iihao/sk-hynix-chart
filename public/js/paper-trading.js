import { $ } from './utils.js';

const paperState = {
  direction: 'long',
  lastSummary: null,
  activeTab: 'positions',
};

function usd(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '--';
  return (num < 0 ? '-' : '') + '$' + Math.abs(num).toFixed(digits);
}

function pct(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '--';
  return (num >= 0 ? '+' : '') + num.toFixed(2) + '%';
}

function tone(value) {
  const num = Number(value);
  if (num > 0) return 'profit';
  if (num < 0) return 'loss';
  return 'neutral';
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function setTone(id, value) {
  const el = $(id);
  if (el) el.className = tone(value);
}

async function paperRequest(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
  }
  return data;
}

function renderPositions(positions = []) {
  const box = $('paperPositions');
  if (!box) return;
  box.innerHTML = '';
  if (!positions.length) {
    const empty = document.createElement('div');
    empty.className = 'paper-empty';
    empty.textContent = '暂无模拟持仓';
    box.appendChild(empty);
    return;
  }
  for (const p of positions) {
    const row = document.createElement('div');
    row.className = `paper-position ${p.direction}`;
    const side = p.direction === 'long' ? 'LONG' : 'SHORT';
    const tp = p.takeProfitPrice ? p.takeProfitPrice.toFixed(2) : '--';
    const sl = p.stopLossPrice ? p.stopLossPrice.toFixed(2) : '--';
    row.innerHTML = `
      <div class="paper-pos-main">
        <span class="paper-badge ${p.direction}">${side}</span>
        <span>${p.leverage}x</span>
        <span>Qty ${Number(p.quantity).toFixed(4)}</span>
      </div>
      <div class="paper-pos-grid">
        <span>入场 <b>${Number(p.entryPrice).toFixed(2)}</b></span>
        <span>标记 <b>${Number(p.markPrice).toFixed(2)}</b></span>
        <span>保证金 <b>${usd(p.margin)}</b></span>
        <span>TP/SL <b>${tp} / ${sl}</b></span>
      </div>
      <div class="paper-pos-pnl ${tone(p.unrealizedPnl)}">
        <b>${usd(p.unrealizedPnl)}</b><span>${pct(p.roe)}</span>
      </div>
    `;
    const close = document.createElement('button');
    close.className = 'paper-close-btn';
    close.textContent = '平仓';
    close.onclick = () => paperClosePosition(p.id);
    row.appendChild(close);
    box.appendChild(row);
  }
}

function renderFills(fills = []) {
  const box = $('paperFills');
  if (!box) return;
  box.innerHTML = '';
  if (!fills.length) {
    const empty = document.createElement('div');
    empty.className = 'paper-empty';
    empty.textContent = '暂无成交记录';
    box.appendChild(empty);
    return;
  }
  for (const fill of fills.slice(0, 20)) {
    const row = document.createElement('div');
    row.className = `paper-fill ${tone(fill.realizedPnl)}`;
    const time = new Date(Number(fill.createdAt) * 1000).toLocaleTimeString('zh-CN', { hour12: false });
    row.innerHTML = `
      <span>${time}</span>
      <b>${fill.type}</b>
      <span>${fill.direction.toUpperCase()}</span>
      <span>@${Number(fill.price).toFixed(2)}</span>
      <span>${usd(fill.realizedPnl)}</span>
    `;
    box.appendChild(row);
  }
}

function renderLedger(fills = []) {
  const box = $('paperLedger');
  if (!box) return;
  box.innerHTML = '';
  if (!fills.length) {
    const empty = document.createElement('div');
    empty.className = 'paper-empty';
    empty.textContent = '暂无资金流水';
    box.appendChild(empty);
    return;
  }
  for (const fill of fills.slice(0, 20)) {
    const row = document.createElement('div');
    row.className = `paper-fill ${tone(fill.realizedPnl)}`;
    const time = new Date(Number(fill.createdAt) * 1000).toLocaleTimeString('zh-CN', { hour12: false });
    row.innerHTML = `
      <span>${time}</span>
      <b>${fill.reason}</b>
      <span>手续费 ${usd(fill.fee)}</span>
      <span>余额 ${usd(fill.balanceAfter)}</span>
      <span>${usd(fill.realizedPnl)}</span>
    `;
    box.appendChild(row);
  }
}

function renderPositionHistory(fills = []) {
  const box = $('paperPositionHistory');
  if (!box) return;
  const closed = fills.filter((fill) => fill.type !== 'OPEN');
  box.innerHTML = '';
  if (!closed.length) {
    const empty = document.createElement('div');
    empty.className = 'paper-empty';
    empty.textContent = '暂无仓位历史记录';
    box.appendChild(empty);
    return;
  }
  for (const fill of closed.slice(0, 20)) {
    const row = document.createElement('div');
    row.className = `paper-fill ${tone(fill.realizedPnl)}`;
    const time = new Date(Number(fill.createdAt) * 1000).toLocaleString('zh-CN', { hour12: false });
    row.innerHTML = `
      <span>${time}</span>
      <b>${fill.type}</b>
      <span>${fill.direction.toUpperCase()}</span>
      <span>${Number(fill.quantity).toFixed(4)} @${Number(fill.price).toFixed(2)}</span>
      <span>${usd(fill.realizedPnl)}</span>
    `;
    box.appendChild(row);
  }
}

function renderPaper(summary) {
  paperState.lastSummary = summary;
  const account = summary.account || {};
  setText('paperMarkPrice', summary.markPrice ? '$' + Number(summary.markPrice).toFixed(2) : '--');
  setText('paperEquity', usd(account.equity));
  setText('paperAvailable', usd(account.availableBalance));
  setText('paperUnrealized', usd(account.unrealizedPnl));
  setText('paperRealized', usd(account.realizedPnl));
  setText('paperReturnPct', pct(account.totalReturnPct));
  setTone('paperUnrealized', account.unrealizedPnl);
  setTone('paperRealized', account.realizedPnl);
  setTone('paperReturnPct', account.totalReturnPct);
  setText('paperPositionCount', String((summary.positions || []).length));

  const initial = $('paperInitialBalance');
  const available = $('paperAvailableBalance');
  if (initial && !initial.value) initial.value = Number(account.initialBalance || 10000).toFixed(0);
  if (available && !available.value) available.value = Number(account.availableBalance || 0).toFixed(0);
  renderPositions(summary.positions || []);
  renderFills(summary.fills || []);
  renderLedger(summary.fills || []);
  renderPositionHistory(summary.fills || []);
}

export function paperSwitchTab(tab) {
  paperState.activeTab = tab || 'positions';
  document.querySelectorAll('.paper-terminal-tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.paperTab === paperState.activeTab);
  });
  document.querySelectorAll('.paper-terminal-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.dataset.paperPane === paperState.activeTab);
  });
}

export async function updatePaperTrading() {
  try {
    renderPaper(await paperRequest('/api/paper/account'));
  } catch (err) {
    const box = $('paperPositions');
    if (box) {
      box.innerHTML = '';
      const msg = document.createElement('div');
      msg.className = 'paper-empty loss';
      msg.textContent = '模拟账户不可用: ' + err.message;
      box.appendChild(msg);
    }
  }
}

export function paperSetDirection(direction) {
  paperState.direction = direction === 'short' ? 'short' : 'long';
  $('paperLongBtn')?.classList.toggle('active', paperState.direction === 'long');
  $('paperShortBtn')?.classList.toggle('active', paperState.direction === 'short');
  const submit = $('paperSubmitBtn');
  if (submit) {
    submit.className = `paper-submit ${paperState.direction}`;
    submit.textContent = paperState.direction === 'long' ? '模拟买入/做多' : '模拟卖出/做空';
  }
}

export async function paperSaveAccount() {
  const initialBalance = Number($('paperInitialBalance')?.value);
  const availableBalance = Number($('paperAvailableBalance')?.value);
  renderPaper(await paperRequest('/api/paper/account', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initialBalance, availableBalance }),
  }));
}

export async function paperSubmitOrder() {
  const payload = {
    direction: paperState.direction,
    notional: Number($('paperNotional')?.value),
    leverage: Number($('paperLeverage')?.value),
    entryPrice: Number($('paperEntryPrice')?.value) || undefined,
    takeProfitPrice: Number($('paperTakeProfit')?.value) || undefined,
    stopLossPrice: Number($('paperStopLoss')?.value) || undefined,
  };
  renderPaper(await paperRequest('/api/paper/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }));
}

export async function paperClosePosition(id) {
  renderPaper(await paperRequest(`/api/paper/positions/${encodeURIComponent(id)}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }));
}

export async function paperCloseAll() {
  renderPaper(await paperRequest('/api/paper/positions/close-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }));
}
