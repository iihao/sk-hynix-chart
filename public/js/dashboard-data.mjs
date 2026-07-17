function asObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('无效数据: ' + field);
  }
  return value;
}

function asNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error('无效数据: ' + field);
  }
  return number;
}

export function normalizeIndicators(payload) {
  const data = asObject(payload, 'indicators');
  const latest = asObject(data.latest, 'indicators.latest');
  return {
    rsi: asNumber(latest.rsi, 'latest.rsi'),
    macdHist: asNumber(latest.macdHist, 'latest.macdHist'),
    volRatio: asNumber(latest.volRatio, 'latest.volRatio'),
    signals: Array.isArray(data.signals) ? data.signals : [],
    support: Array.isArray(data.support) ? data.support : [],
    resistance: Array.isArray(data.resistance) ? data.resistance : [],
    levels: data.levels && typeof data.levels === 'object' ? data.levels : null,
  };
}

export function normalizeFactors(payload) {
  const data = asObject(payload, 'factors');
  if (!Array.isArray(data.factors)) {
    throw new Error('无效数据: factors');
  }
  if (!['long', 'short', 'neutral'].includes(data.direction)) {
    throw new Error('无效数据: direction');
  }
  const composite = asNumber(data.composite, 'composite');
  const confidence = asNumber(data.confidence, 'confidence');
  const labels = { long: '做多', short: '做空', neutral: '中性' };
  return {
    factors: data.factors,
    marketContext: data.marketContext && typeof data.marketContext === 'object'
      ? data.marketContext
      : null,
    risk: data.risk && typeof data.risk === 'object' ? data.risk : null,
    basis: data.basis && typeof data.basis === 'object' ? data.basis : null,
    direction: {
      code: data.direction,
      label: labels[data.direction],
      score: composite,
      confidence,
    },
  };
}

export function buildBacktestQuery(input) {
  return new URLSearchParams({
    entryThreshold: String(asNumber(input.threshold, 'entryThreshold')),
    holdBars: String(asNumber(input.hold, 'holdBars')),
    stopLossPct: String(asNumber(input.stopLoss, 'stopLossPct')),
    takeProfitPct: String(asNumber(input.takeProfit, 'takeProfitPct')),
    optimize: input.optimize ? 'true' : 'false',
  });
}

export function normalizeBacktest(payload) {
  const data = asObject(payload, 'backtest');
  if (typeof data.error === 'string') {
    return { error: data.error, metrics: null, trades: [], weights: null };
  }
  const metrics = asObject(data.metrics, 'backtest.metrics');
  if (!Array.isArray(data.trades)) {
    throw new Error('无效数据: backtest.trades');
  }
  return {
    error: null,
    metrics: {
      winRate: asNumber(metrics.winRate, 'metrics.winRate'),
      totalReturn: asNumber(metrics.totalReturn, 'metrics.totalReturn'),
      sharpe: asNumber(metrics.sharpe ?? metrics.sharpeRatio, 'metrics.sharpe'),
    },
    trades: data.trades.map((trade, index) => {
      const item = asObject(trade, `trades[${index}]`);
      return {
        ...item,
        entry: asNumber(item.entry ?? item.entryPrice, `trades[${index}].entry`),
        exit: asNumber(item.exit ?? item.exitPrice, `trades[${index}].exit`),
        pnl: asNumber(item.pnl, `trades[${index}].pnl`),
        pnlPct: asNumber(item.pnlPct, `trades[${index}].pnlPct`),
      };
    }),
    weights: data.weights || data.optimizedWeights || data.activeWeights || null,
  };
}

export function resolveResponseSource(currentSource, payload) {
  const responseSource = payload && payload.source;
  return ['yahoo', 'naver'].includes(responseSource) ? responseSource : currentSource;
}
