// src/domain/strategy.ts
// Strategy generation module

import { directionFromComposite, Factor } from './factors';
import { IndicatorResult, SupportResistance } from './indicators';
import { generateOperationAdvice, OperationAdvice, AdviceContext } from './advice';

export interface Strategy {
  direction: 'long' | 'short' | 'neutral';
  entry: string;
  stopLoss: string;
  takeProfit: string;
  riskLevel: 'low' | 'medium' | 'high';
  reasoning: string[];
  warnings: string[];
  confidence: number;
  evidence: {
    for: string[];
    against: string[];
    neutral: string[];
  };
  riskReward: string;
  leverage: string;
  regime?: string;
  regimeLabel?: string;
  regimeReason?: string;
  entryThresholdUsed?: number;
  entryNote?: string;
  /** 新手友好的操作建议 (因子驱动) */
  advice: OperationAdvice;
}

export interface RiskOverlay {
  blocked: boolean;
  action: 'block' | 'flat' | 'reduce' | 'normal';
  positionPct: number;
  maxSingleLossPct: number;
  maxDailyLossPct: number;
  leverageCap: string;
  reasons: string[];
  warnings: string[];
}

export interface Regime {
  mode: 'trend' | 'range' | 'event';
  label: string;
  entryThresholdMultiplier: number;
  reason: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function deriveRegime(params: {
  composite: number;
  consensus: number;
  eventStatus: string;
  basisZScore: number;
  atrPct: number;
}): Regime {
  const { composite, consensus, eventStatus, basisZScore, atrPct } = params;
  
  if (eventStatus === 'freeze' || eventStatus === 'watch' || eventStatus === 'cooldown') {
    return {
      mode: 'event',
      label: '事件模式',
      entryThresholdMultiplier: 1.4,
      reason: '事件窗口优先，避免方向误判',
    };
  }
  
  if (Math.abs(composite) >= 1.2 && consensus >= 0.55 && Math.abs(basisZScore) < 2.3 && atrPct < 3.5) {
    return {
      mode: 'trend',
      label: '趋势模式',
      entryThresholdMultiplier: 0.9,
      reason: '方向一致性较高，适合顺势跟随',
    };
  }
  
  return {
    mode: 'range',
    label: '震荡模式',
    entryThresholdMultiplier: 1.15,
    reason: '多空分歧较大，优先等待确认',
  };
}

export function buildRiskOverlay(params: {
  direction: string;
  atrPct: number;
  volatilityScore: number;
  fundingRate: number;
  eventStatus: string;
  basisZScore: number;
  regimeMode: string;
}): RiskOverlay {
  const { direction, atrPct, volatilityScore, fundingRate, eventStatus, basisZScore, regimeMode } = params;
  
  const directionSign = direction.includes('做多') ? 1 : direction.includes('做空') ? -1 : 0;
  const noTrade = directionSign === 0;
  const reasons: string[] = [];
  const warnings: string[] = [];
  let positionPct = regimeMode === 'trend' ? 70 : regimeMode === 'event' ? 25 : 45;
  
  if (noTrade) positionPct = 0;
  
  // ATR adjustment
  if (atrPct >= 3) positionPct *= 0.35;
  else if (atrPct >= 2) positionPct *= 0.5;
  else if (atrPct >= 1) positionPct *= 0.7;
  
  // Volatility adjustment
  if (volatilityScore <= -6) positionPct *= 0.6;
  else if (volatilityScore <= -3) positionPct *= 0.75;
  
  // Basis adjustment
  if (Math.abs(basisZScore) >= 3) {
    positionPct *= 0.25;
    warnings.push('基差极端偏离，避免追价');
  } else if (Math.abs(basisZScore) >= 2) {
    positionPct *= 0.5;
    warnings.push('基差偏离扩大，建议缩仓');
  }
  
  // Event adjustment
  if (eventStatus === 'watch') {
    positionPct *= 0.5;
    warnings.push('财报临近，提前减仓');
  } else if (eventStatus === 'cooldown') {
    positionPct *= 0.6;
    warnings.push('事件后波动未稳，降低仓位');
  } else if (eventStatus === 'freeze') {
    reasons.push('财报冻结区，禁止新开仓');
    positionPct = 0;
  }
  
  // Funding rate adjustment
  const fundingCost = directionSign === 1 ? fundingRate : directionSign === -1 ? -fundingRate : 0;
  if (directionSign !== 0 && fundingCost >= 0.0035) {
    reasons.push('当前 funding 成本过高，禁止顺势开仓');
    positionPct = 0;
  } else if (directionSign !== 0 && fundingCost >= 0.0015) {
    positionPct *= 0.6;
    warnings.push('funding 成本偏高，降低仓位');
  }
  
  positionPct = clamp(Math.round(positionPct), 0, 100);
  const blocked = reasons.length > 0 && positionPct === 0;
  const maxSingleLossPct = atrPct >= 2 ? 0.35 : atrPct >= 1 ? 0.5 : 0.75;
  const maxDailyLossPct = blocked ? 0.75 : atrPct >= 2 ? 1 : 1.5;
  const leverageCap = blocked ? '0x' : regimeMode === 'trend' && atrPct < 2 ? '5x' : atrPct < 2.5 ? '3x' : '2x';
  
  return {
    blocked,
    action: blocked ? 'block' : noTrade ? 'flat' : positionPct <= 30 ? 'reduce' : 'normal',
    positionPct,
    maxSingleLossPct,
    maxDailyLossPct,
    leverageCap,
    reasons,
    warnings,
  };
}

export function generateStrategy(params: {
  factors: Factor[];
  composite: number;
  indicators: IndicatorResult;
  candles: Array<{ close: number; high: number; low: number }>;
  support: SupportResistance[];
  resistance: SupportResistance[];
  naverPrice: number;
  binancePrice: number;
  fundingRate: number;
  eventStatus?: string;
  basisZScore?: number;
  atrPct?: number;
  entryThreshold?: number;
  calibratedConfidence?: number;
}): Strategy {
  const {
    factors,
    composite,
    indicators,
    candles,
    support,
    resistance,
    naverPrice,
    binancePrice,
    fundingRate,
    eventStatus = 'clear',
    basisZScore = 0,
    atrPct = 0,
    entryThreshold: requestedEntryThreshold = 0.5,
    calibratedConfidence,
  } = params;

  const len = candles.length;
  const currentPrice = candles[len - 1]?.close || 0;

  // Calculate consensus
  const positiveFactors = factors.filter(f => f.score > 0).length;
  const negativeFactors = factors.filter(f => f.score < 0).length;
  const consensus = factors.length > 0 ? Math.max(positiveFactors, negativeFactors) / factors.length : 0;

  // Determine regime
  const regime = deriveRegime({
    composite,
    consensus,
    eventStatus,
    basisZScore,
    atrPct,
  });

  // Build reasoning
  const reasoning: string[] = [];
  const evidence = { for: [] as string[], against: [] as string[], neutral: [] as string[] };

  for (const f of factors) {
    if (f.score > 1) {
      evidence.for.push(`${f.label}: ${f.detail}`);
    } else if (f.score < -1) {
      evidence.against.push(`${f.label}: ${f.detail}`);
    } else {
      evidence.neutral.push(`${f.label}: ${f.detail}`);
    }
  }

  // Entry calculation
  const baseEntryThreshold = Number.isFinite(requestedEntryThreshold) && requestedEntryThreshold > 0
    ? requestedEntryThreshold
    : 0.5;
  const entryThreshold = baseEntryThreshold * regime.entryThresholdMultiplier;
  const direction = directionFromComposite(composite, entryThreshold);
  let entry = '';
  let entryNote = '';

  if (direction === 'long') {
    if (currentPrice > indicators.ma20) {
      entry = `当前价上方回踩 ${indicators.ma20.toFixed(0)}`;
      entryNote = '等待回踩均线入场';
    } else {
      entry = `突破 ${resistance[0]?.price.toFixed(0) || 'N/A'}`;
      entryNote = '等待突破阻力位';
    }
  } else if (direction === 'short') {
    if (currentPrice < indicators.ma20) {
      entry = `当前价下方反弹 ${indicators.ma20.toFixed(0)}`;
      entryNote = '等待反弹均线入场';
    } else {
      entry = `跌破 ${support[0]?.price.toFixed(0) || 'N/A'}`;
      entryNote = '等待跌破支撑位';
    }
  } else {
    entry = '观望';
    entryNote = '方向不明确，等待信号';
  }

  // Stop loss
  const atrValue = currentPrice * atrPct / 100;
  let stopLoss = '';
  if (direction === 'long') {
    stopLoss = `${(currentPrice - atrValue * 2).toFixed(0)} (2x ATR)`;
  } else if (direction === 'short') {
    stopLoss = `${(currentPrice + atrValue * 2).toFixed(0)} (2x ATR)`;
  } else {
    stopLoss = `${(currentPrice - atrValue * 2).toFixed(0)} / ${(currentPrice + atrValue * 2).toFixed(0)}`;
  }

  // Take profit
  let takeProfit = '';
  if (direction === 'long') {
    takeProfit = `${(currentPrice + atrValue * 3).toFixed(0)} (3x ATR)`;
  } else if (direction === 'short') {
    takeProfit = `${(currentPrice - atrValue * 3).toFixed(0)} (3x ATR)`;
  } else {
    takeProfit = `${(currentPrice + atrValue * 3).toFixed(0)} / ${(currentPrice - atrValue * 3).toFixed(0)}`;
  }

  // Risk level
  let riskLevel: 'low' | 'medium' | 'high' = 'medium';
  if (atrPct > 3 || Math.abs(basisZScore) > 2) riskLevel = 'high';
  else if (atrPct < 1.5 && Math.abs(basisZScore) < 1) riskLevel = 'low';

  // Warnings
  const warnings: string[] = [];
  if (atrPct > 3) warnings.push('波动率偏高，注意风险');
  if (Math.abs(basisZScore) > 2) warnings.push('基差偏离较大');
  if (eventStatus !== 'clear') warnings.push('事件窗口期间谨慎操作');

  // Confidence: prefer the backtest-calibrated value when supplied by the API layer.
  const rawConfidence = Math.min(100, Math.round(Math.abs(composite) * 12 + consensus * 30));
  const confidence = Number.isFinite(calibratedConfidence)
    ? Math.max(0, Math.min(100, Math.round(calibratedConfidence as number)))
    : rawConfidence;

  // Risk/Reward
  const riskReward = direction === 'long'
    ? `1:${(3/2).toFixed(1)}`
    : direction === 'short'
    ? `1:${(3/2).toFixed(1)}`
    : 'N/A';

  // Leverage
  const leverage = riskLevel === 'high' ? '2x' : riskLevel === 'medium' ? '3x' : '5x';

  // ── 生成新手友好的操作建议 (因子驱动) ──
  const adviceCtx: AdviceContext = {
    factors,
    composite,
    direction,
    confidence,
    currentPrice,
    atrPct,
    atrValue,
    consensus,
    regime: regime.mode as 'trend' | 'range' | 'event',
    supportPrices: support.map(s => s.price),
    resistancePrices: resistance.map(r => r.price),
    ma20: indicators.ma20,
    rsi: indicators.rsi,
    fundingRate,
    eventStatus,
    basisZScore,
  };
  const advice = generateOperationAdvice(adviceCtx);

  return {
    direction,
    entry,
    stopLoss,
    takeProfit,
    riskLevel,
    reasoning,
    warnings,
    confidence,
    evidence,
    riskReward,
    leverage,
    regime: regime.mode,
    regimeLabel: regime.label,
    regimeReason: regime.reason,
    entryThresholdUsed: entryThreshold,
    entryNote,
    advice,
  };
}
