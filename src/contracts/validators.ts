import { BacktestResponse, FactorsResponse, IndicatorsResponse } from './api';

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
  expectNumber(metrics.sharpeRatio, 'metrics.sharpeRatio');
  return data as unknown as BacktestResponse;
}
