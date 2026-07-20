import type { BacktestMetrics } from './backtest';
import type { Factor } from './factors';
import type { IndicatorResult } from './indicators';

export interface BacktestCalibration {
  winRate: number;
  profitProbability: number;
  sampleTrades: number;
  source: 'active-backtest' | 'insufficient';
  totalReturn: number;
  maxDrawdown: number;
  sharpe: number;
  updatedAt: string | null;
  note: string;
}

export interface SignalConfidenceCalibration {
  rawConfidence: number;
  confidence: number;
  backtestProbability: number;
  sampleTrades: number;
  factorAgreement: number;
  indicatorAgreement: number;
  penalties: Array<'sample' | 'performance' | 'drawdown' | 'indicator_divergence'>;
  note: string;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function buildBacktestCalibration(
  metrics: BacktestMetrics | null | undefined,
  updatedAt: string | null = null,
): BacktestCalibration {
  const sampleTrades = metrics?.totalTrades ?? 0;
  if (!metrics || sampleTrades <= 0) {
    return {
      winRate: 0,
      profitProbability: 50,
      sampleTrades: 0,
      source: 'insufficient',
      totalReturn: 0,
      maxDrawdown: 0,
      sharpe: 0,
      updatedAt,
      note: '回测样本不足，暂按中性概率处理',
    };
  }

  // Bayesian-style shrinkage: avoid showing overconfident probabilities from tiny samples.
  // 20 virtual neutral trades keeps the display conservative until the system has enough history.
  const virtualNeutralTrades = 20;
  const profitProbability = (
    metrics.winRate * sampleTrades + 50 * virtualNeutralTrades
  ) / (sampleTrades + virtualNeutralTrades);

  return {
    winRate: round1(metrics.winRate),
    profitProbability: round1(profitProbability),
    sampleTrades,
    source: sampleTrades >= 5 ? 'active-backtest' : 'insufficient',
    totalReturn: round1(metrics.totalReturn),
    maxDrawdown: round1(metrics.maxDrawdown),
    sharpe: round1(metrics.sharpe || 0),
    updatedAt,
    note: sampleTrades >= 5
      ? '基于最近回测样本校准，非确定盈利概率'
      : '回测样本偏少，概率已向 50% 保守收缩',
  };
}

function signForDirection(direction: 'long' | 'short' | 'neutral'): number {
  if (direction === 'long') return 1;
  if (direction === 'short') return -1;
  return 0;
}

export function calculateFactorAgreement(
  factors: Factor[],
  direction: 'long' | 'short' | 'neutral',
): number {
  const sign = signForDirection(direction);
  if (sign === 0 || factors.length === 0) return 0;

  let alignedWeight = 0;
  let totalWeight = 0;
  for (const factor of factors) {
    const weight = Number.isFinite(factor.weight) && factor.weight > 0 ? factor.weight : 1;
    const strength = Math.min(1, Math.abs(factor.score) / 3);
    totalWeight += weight;
    if (factor.score * sign > 0) alignedWeight += weight * strength;
    else if (factor.score === 0) alignedWeight += weight * 0.35;
  }
  return totalWeight > 0 ? round1((alignedWeight / totalWeight) * 10) / 10 : 0;
}

export function calculateIndicatorAgreement(params: {
  indicators: IndicatorResult;
  currentPrice: number;
  direction: 'long' | 'short' | 'neutral';
}): number {
  const { indicators, currentPrice, direction } = params;
  const sign = signForDirection(direction);
  if (sign === 0 || !currentPrice) return 0;

  const votes: number[] = [];
  const priceVsMa20 = indicators.ma20 > 0 ? (currentPrice - indicators.ma20) * sign : 0;
  const maTrend = indicators.ma20 > 0 ? (indicators.ma5 - indicators.ma20) * sign : 0;
  const macdTrend = indicators.macd.histogram * sign;

  votes.push(priceVsMa20 > 0 ? 1 : priceVsMa20 < 0 ? 0 : 0.5);
  votes.push(maTrend > 0 ? 1 : maTrend < 0 ? 0 : 0.5);
  votes.push(macdTrend > 0 ? 1 : macdTrend < 0 ? 0 : 0.5);

  if (direction === 'long') {
    if (indicators.rsi >= 45 && indicators.rsi <= 68) votes.push(1);
    else if (indicators.rsi >= 35 && indicators.rsi < 45) votes.push(0.65);
    else if (indicators.rsi > 68) votes.push(0.15);
    else votes.push(0.35);
  } else {
    if (indicators.rsi >= 32 && indicators.rsi <= 55) votes.push(1);
    else if (indicators.rsi > 55 && indicators.rsi <= 65) votes.push(0.45);
    else if (indicators.rsi < 32) votes.push(0.15);
    else votes.push(0.25);
  }

  if (indicators.volRatio > 1.1) votes.push(0.75);
  else if (indicators.volRatio < 0.7) votes.push(0.25);
  else votes.push(0.5);

  const agreement = votes.reduce((sum, vote) => sum + vote, 0) / votes.length;
  return round1(agreement * 10) / 10;
}

export function calibrateSignalConfidence(params: {
  rawConfidence: number;
  composite: number;
  direction: 'long' | 'short' | 'neutral';
  factors: Factor[];
  indicators: IndicatorResult;
  currentPrice: number;
  backtestCalibration: BacktestCalibration;
}): SignalConfidenceCalibration {
  const {
    rawConfidence,
    composite,
    direction,
    factors,
    indicators,
    currentPrice,
    backtestCalibration,
  } = params;

  if (direction === 'neutral') {
    // Even in neutral, show a reduced confidence based on signal strength
    const neutralConfidence = Math.round(clamp(rawConfidence * 0.4, 0, 30));
    return {
      rawConfidence: Math.round(clamp(rawConfidence, 0, 100)),
      confidence: neutralConfidence,
      backtestProbability: backtestCalibration.profitProbability,
      sampleTrades: backtestCalibration.sampleTrades,
      factorAgreement: 0,
      indicatorAgreement: 0,
      penalties: [],
      note: '方向中性，置信度已大幅下调',
    };
  }

  const factorAgreement = calculateFactorAgreement(factors, direction);
  const indicatorAgreement = calculateIndicatorAgreement({ indicators, currentPrice, direction });
  const sampleQuality = clamp(backtestCalibration.sampleTrades / 30, 0, 1);
  const backtestQuality = clamp((backtestCalibration.profitProbability - 45) / 25, 0, 1);
  const performanceQuality = clamp((backtestCalibration.totalReturn + 5) / 20, 0, 1);
  const drawdownQuality = clamp(1 - backtestCalibration.maxDrawdown / 20, 0, 1);
  const sharpeQuality = clamp((backtestCalibration.sharpe + 0.5) / 2.5, 0, 1);
  const signalStrength = clamp(Math.abs(composite) / 2, 0, 1);

  const qualityScore = (
    clamp(rawConfidence, 0, 100) * 0.25
    + backtestQuality * 100 * 0.2
    + sampleQuality * 100 * 0.12
    + performanceQuality * 100 * 0.12
    + drawdownQuality * 100 * 0.08
    + sharpeQuality * 100 * 0.08
    + factorAgreement * 100 * 0.08
    + indicatorAgreement * 100 * 0.07
  );

  const penalties: SignalConfidenceCalibration['penalties'] = [];
  let confidence = qualityScore;
  if (backtestCalibration.sampleTrades < 5) {
    penalties.push('sample');
    confidence = Math.min(confidence, 58);
  } else if (backtestCalibration.sampleTrades < 15) {
    penalties.push('sample');
    confidence = Math.min(confidence, 72);
  }
  if (backtestCalibration.totalReturn < 0 || backtestCalibration.sharpe < 0) {
    penalties.push('performance');
    confidence -= 18;
  }
  if (backtestCalibration.maxDrawdown >= 12) {
    penalties.push('drawdown');
    confidence -= Math.min(18, (backtestCalibration.maxDrawdown - 10) * 1.4);
  }
  if (indicatorAgreement < 0.4) {
    penalties.push('indicator_divergence');
    confidence -= 14;
  }

  confidence += signalStrength * 4;
  confidence = clamp(Math.round(confidence), 0, 95);

  return {
    rawConfidence: Math.round(clamp(rawConfidence, 0, 100)),
    confidence,
    backtestProbability: backtestCalibration.profitProbability,
    sampleTrades: backtestCalibration.sampleTrades,
    factorAgreement,
    indicatorAgreement,
    penalties,
    note: penalties.length > 0
      ? `置信度已因 ${penalties.join(', ')} 保守下调`
      : '因子、技术指标与回测表现一致，置信度有效',
  };
}
