import { BacktestResponse, FactorsResponse, IndicatorsResponse, QualityResponse } from './api';

function expectObject(value: unknown, field: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid API response: ${field}`);
  }
  return value as Record<string, any>;
}

function expectArray(value: unknown, field: string): any[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid API response: ${field}`);
  }
  return value;
}

function expectNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid API response: ${field}`);
  }
  return value;
}

export function parseIndicatorsResponse(value: unknown): IndicatorsResponse {
  const data = expectObject(value, 'indicators');
  expectArray(data.rsi, 'rsi');
  expectArray(data.signals, 'signals');
  expectArray(data.support, 'support');
  expectArray(data.resistance, 'resistance');
  expectArray(data.times, 'times');
  if (data.latest != null) {
    const latest = expectObject(data.latest, 'latest');
    expectNumber(latest.rsi, 'latest.rsi');
    expectNumber(latest.macdHist, 'latest.macdHist');
    expectNumber(latest.volRatio, 'latest.volRatio');
  }
  return data as unknown as IndicatorsResponse;
}

export function parseFactorsResponse(value: unknown): FactorsResponse {
  const data = expectObject(value, 'factors response');
  const factors = expectArray(data.factors, 'factors');
  for (const [index, factorValue] of factors.entries()) {
    const factor = expectObject(factorValue, `factors[${index}]`);
    expectNumber(factor.score, `factors[${index}].score`);
    expectNumber(factor.weight, `factors[${index}].weight`);
    if (typeof factor.label !== 'string') {
      throw new Error(`Invalid API response: factors[${index}].label`);
    }
  }
  expectNumber(data.composite, 'composite');
  expectNumber(data.confidence, 'confidence');
  if (!['long', 'short', 'neutral'].includes(data.direction)) {
    throw new Error('Invalid API response: direction');
  }
  return data as unknown as FactorsResponse;
}

export function parseBacktestResponse(value: unknown): BacktestResponse {
  const data = expectObject(value, 'backtest');
  if (typeof data.error === 'string') {
    expectArray(data.trades, 'trades');
    return data as unknown as BacktestResponse;
  }
  expectArray(data.trades, 'trades');
  expectArray(data.equityCurve, 'equityCurve');
  const metrics = expectObject(data.metrics, 'metrics');
  expectNumber(metrics.winRate, 'metrics.winRate');
  expectNumber(metrics.totalReturn, 'metrics.totalReturn');
  expectNumber(metrics.sharpe ?? metrics.sharpeRatio, 'metrics.sharpe');
  expectNumber(metrics.profitFactor, 'metrics.profitFactor');
  expectNumber(metrics.maxDrawdown, 'metrics.maxDrawdown');
  expectNumber(metrics.totalTrades, 'metrics.totalTrades');
  expectNumber(metrics.avgWin, 'metrics.avgWin');
  expectNumber(metrics.avgLoss, 'metrics.avgLoss');
  return data as unknown as BacktestResponse;
}

export function parseQualityResponse(value: unknown): QualityResponse {
  const data = expectObject(value, 'quality');
  expectNumber(data.serverTime, 'serverTime');
  if (!['healthy', 'degraded', 'unavailable'].includes(data.overall)) {
    throw new Error('Invalid API response: overall');
  }
  const collectors = expectArray(data.collectors, 'collectors');
  for (const [index, collectorValue] of collectors.entries()) {
    const collector = expectObject(collectorValue, `collectors[${index}]`);
    if (typeof collector.key !== 'string') throw new Error(`Invalid API response: collectors[${index}].key`);
    if (!['starting', 'healthy', 'degraded', 'open', 'half-open', 'stopped'].includes(collector.state)) {
      throw new Error(`Invalid API response: collectors[${index}].state`);
    }
    if (!['direct', 'proxy', 'local', 'none'].includes(collector.transport)) {
      throw new Error(`Invalid API response: collectors[${index}].transport`);
    }
  }
  const sources = expectArray(data.sources, 'sources');
  for (const [index, sourceValue] of sources.entries()) {
    const source = expectObject(sourceValue, `sources[${index}]`);
    if (typeof source.key !== 'string') throw new Error(`Invalid API response: sources[${index}].key`);
    if (!['ok', 'idle', 'stale', 'missing'].includes(source.status)) {
      throw new Error(`Invalid API response: sources[${index}].status`);
    }
    if (source.ageSec !== null) expectNumber(source.ageSec, `sources[${index}].ageSec`);
    if (typeof source.expectedActive !== 'boolean') {
      throw new Error(`Invalid API response: sources[${index}].expectedActive`);
    }
    if (typeof source.detail !== 'string') throw new Error(`Invalid API response: sources[${index}].detail`);
  }
  return data as unknown as QualityResponse;
}
