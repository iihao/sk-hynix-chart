// src/domain/backtest.ts
// Backtest engine module with signal detection and closed-loop optimization

import {
  calculateWeightedComposite,
  Factor,
  factorFundingRate,
  factorLongShortRatio,
  factorMomentum,
  factorOpenInterest,
  factorPremium,
  factorTakerVolume,
  factorVolatility,
  factorVolume,
  factorLongShortTrend,
  factorWhaleActivity,
  factorIndicatorMomentum,
  factorSupportResistance,
  factorExchangeRate,
  factorNewsSentiment,
} from './factors';
import { findFxAtOrBefore, FxTick } from './fx';
import { calculateAllIndicators, findSupportResistance, SupportResistance } from './indicators';

export interface BacktestParams {
  threshold?: number;
  holdBars?: number;
  leverage?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  weights?: Record<string, number>;
  observationToleranceSec?: number;
  fxRate?: number;
  prevFxRate?: number;
  fxTicks?: FxTick[];
  timeframe?: 'm1' | 'm5' | 'm15' | 'h1';
  feeRate?: number;
  slippageBps?: number;
  hasRealVolume?: boolean;
  sentimentHistory?: BacktestSentimentRow[];
  newsScore?: number;
  newsPositive?: number;
  newsNegative?: number;
  newsTopHeadline?: string;
}

export interface BacktestBinanceTick {
  ts: number;
  price: number;
  funding_rate?: number;
  isFundingEvent?: boolean;
  mark_price?: number;
  index_price?: number;
  high_24h?: number;
  low_24h?: number;
  volume_24h?: number;
}

export interface BacktestSentimentRow {
  ts: number;
  ls_ratio?: number;
  taker_buy_vol?: number;
  taker_sell_vol?: number;
  open_interest?: number;
  oi_value?: number;
  top_ls_ratio?: number;
  [key: string]: unknown;
}

export interface BacktestTrade {
  entryTime: number;
  exitTime: number;
  direction: 'long' | 'short';
  entry: number;
  exit: number;
  pnl: number;
  pnlPct: number;
  exitReason: 'signal' | 'stopLoss' | 'takeProfit' | 'timeout';
  entryFactors: Factor[];
  exitFactors: Factor[];
  composite: number;
}

export interface BacktestMetrics {
  totalTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  totalReturn: number;
  maxDrawdown: number;
  sharpe: number;
  profitFactor: number;
  avgHoldBars: number;
  expectancy: number;
}

export interface FactorAnalysis {
  category: string;
  label: string;
  avgScoreOnWin: number;
  avgScoreOnLoss: number;
  correlation: number;
  suggestedWeight: number;
  currentWeight: number;
}

export interface SignalAnalysis {
  type: string;
  label: string;
  totalTriggers: number;
  winRate: number;
  avgReturn: number;
  suggestedAction: 'keep' | 'increase_threshold' | 'decrease_threshold' | 'disable';
}

export interface OptimizationResult {
  currentMetrics: BacktestMetrics;
  optimizedWeights: Record<string, number>;
  optimizedMetrics: BacktestMetrics;
  factorAnalysis: FactorAnalysis[];
  signalAnalysis: SignalAnalysis[];
  improvements: string[];
}

export interface BacktestResult {
  trades: BacktestTrade[];
  metrics: BacktestMetrics;
  equityCurve: number[];
  weights: Record<string, number>;
  costs: { fees: number; slippage: number; funding: number };
  factorAnalysis?: FactorAnalysis[];
  signalAnalysis?: SignalAnalysis[];
  optimization?: OptimizationResult;
}

export function annualizationBars(timeframe: string = 'm5'): number {
  const bars = { m1: 252 * 390, m5: 252 * 78, m15: 252 * 26, h1: 252 * 7 };
  return bars[timeframe as keyof typeof bars] || bars.m5;
}

export function computeMetrics(
  trades: BacktestTrade[], equityCurve: number[], initialEquity: number, timeframe = 'm5',
): BacktestMetrics {
  if (trades.length === 0) {
    return {
      totalTrades: 0, winRate: 0, avgWin: 0, avgLoss: 0,
      totalReturn: 0, maxDrawdown: 0, sharpe: 0, profitFactor: 0,
      avgHoldBars: 0, expectancy: 0,
    };
  }
  
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  
  const winRate = wins.length / trades.length;
  const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((sum, t) => sum + t.pnlPct, 0) / losses.length : 0;
  
  const finalEquity = equityCurve[equityCurve.length - 1] || initialEquity;
  const totalReturn = ((finalEquity - initialEquity) / initialEquity) * 100;
  
  // Max drawdown
  let maxDrawdown = 0;
  let peak = equityCurve[0] || initialEquity;
  for (const equity of equityCurve) {
    if (equity > peak) peak = equity;
    const drawdown = (peak - equity) / peak * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  
  // Sharpe ratio
  const returns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    returns.push((equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1]);
  }
  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdReturn = returns.length > 0 
    ? Math.sqrt(returns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / returns.length)
    : 1;
  const sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(annualizationBars(timeframe)) : 0;
  
  // Profit factor
  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;
  
  // Expectancy (average P&L per trade)
  const expectancy = trades.reduce((sum, t) => sum + t.pnl, 0) / trades.length;
  
  // Average hold bars
  const avgHoldBars = trades.reduce((sum, t) => {
    const holdTime = (t.exitTime - t.entryTime) / 300; // Assuming 5m bars
    return sum + holdTime;
  }, 0) / trades.length;
  
  return {
    totalTrades: trades.length,
    winRate: Math.round(winRate * 1000) / 10,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    totalReturn: Math.round(totalReturn * 100) / 100,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    avgHoldBars: Math.round(avgHoldBars * 10) / 10,
    expectancy: Math.round(expectancy * 100) / 100,
  };
}

// Calculate all factors for a given candle position
function calculateFactorsAtPosition(
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>,
  index: number,
  binanceTick: BacktestBinanceTick | undefined,
  sentimentRow: BacktestSentimentRow | undefined,
  params: BacktestParams,
  srLevels: SupportResistance[],
): Factor[] {
  const factors: Factor[] = [];
  const window = candles.slice(Math.max(0, index - 20), index + 1);
  const hasRealVolume = params.hasRealVolume || false;
  
  // Core factors
  factors.push(factorMomentum(window));
  factors.push(factorVolatility(window));
  if (hasRealVolume) factors.push(factorVolume(window));
  
  // Binance-based factors
  if (binanceTick) {
    const candle = candles[index];
    const obsAge = params.observationToleranceSec || 3600;
    if (candle.time - binanceTick.ts <= obsAge) {
      factors.push(factorFundingRate(binanceTick.funding_rate || 0));
      const alignedFx = params.fxRate || 0;
      if (alignedFx > 0 && binanceTick.price > 0) {
        factors.push(factorPremium(candle.close, binanceTick.price, alignedFx));
      }
    }
  }
  
  // Sentiment-based factors
  if (sentimentRow) {
    const obsAge = params.observationToleranceSec || 3600;
    if (candles[index].time - sentimentRow.ts <= obsAge) {
      if (typeof sentimentRow.ls_ratio === 'number' && sentimentRow.ls_ratio > 0) {
        factors.push(factorLongShortRatio(sentimentRow.ls_ratio));
      }
      if (typeof sentimentRow.taker_buy_vol === 'number' && typeof sentimentRow.taker_sell_vol === 'number'
        && sentimentRow.taker_buy_vol > 0 && sentimentRow.taker_sell_vol > 0) {
        factors.push(factorTakerVolume(sentimentRow.taker_buy_vol, sentimentRow.taker_sell_vol));
      }
      const prevSentiment = index > 0 ? undefined : undefined; // Will be handled separately
      const oiChange = sentimentRow.oi_value || sentimentRow.open_interest;
      if (typeof oiChange === 'number') {
        const prevPrice = index > 0 ? candles[index - 1].close : candles[index].close;
        const priceChange = prevPrice > 0 ? (candles[index].close - prevPrice) / prevPrice * 100 : 0;
        factors.push(factorOpenInterest(oiChange, priceChange));
      }
    }
  }
  
  // Indicator-based factors
  if (index >= 50) {
    const indicatorWindow = candles.slice(Math.max(0, index - 50), index + 1);
    const indicators = calculateAllIndicators(indicatorWindow);
    if (indicators.latest) {
      factors.push(factorIndicatorMomentum(indicators.latest.rsi, indicators.latest.macd.histogram));
      const support = srLevels.filter(l => l.type === 'support');
      const resistance = srLevels.filter(l => l.type === 'resistance');
      if (support.length > 0 || resistance.length > 0) {
        factors.push(factorSupportResistance(candles[index].close, support, resistance));
      }
    }
  }

  // FX factor
  if (params.fxRate && params.fxRate > 0) {
    factors.push(factorExchangeRate(params.fxRate, params.prevFxRate || params.fxRate));
  }

  // LS Trend factor (requires sentiment history with valid ls_ratio)
  if (sentimentRow && index > 0) {
    const rawHistory = params.sentimentHistory || [];
    const sentimentHistory = rawHistory
      .filter((r: any) => typeof r.ls_ratio === 'number' && r.ls_ratio > 0)
      .map((r: any) => ({ ts: r.ts, ls_ratio: r.ls_ratio! }));
    if (sentimentHistory.length >= 3) {
      factors.push(factorLongShortTrend(sentimentHistory));
    }
  }

  // Whale activity factor (requires sentiment history with valid top_ls_ratio)
  if (sentimentRow && typeof sentimentRow.top_ls_ratio === 'number') {
    const rawHistory = params.sentimentHistory || [];
    const sentimentHistory = rawHistory
      .filter((r: any) => typeof r.top_ls_ratio === 'number' && r.top_ls_ratio > 0)
      .map((r: any) => ({ ts: r.ts, top_ls_ratio: r.top_ls_ratio! }));
    if (sentimentHistory.length >= 3) {
      factors.push(factorWhaleActivity(sentimentHistory));
    }
  }

  // News sentiment factor
  if (params.newsScore !== undefined) {
    factors.push(factorNewsSentiment(params.newsScore, params.newsPositive || 0, params.newsNegative || 0, params.newsTopHeadline || ''));
  }

  return factors;
}

// Analyze factor performance
function analyzeFactorPerformance(trades: BacktestTrade[]): FactorAnalysis[] {
  if (trades.length === 0) return [];
  
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const categoryMap = new Map<string, { winScores: number[]; lossScores: number[] }>();
  
  // Collect scores by category
  for (const trade of trades) {
    const factors = trade.entryFactors || [];
    for (const factor of factors) {
      if (!categoryMap.has(factor.category)) {
        categoryMap.set(factor.category, { winScores: [], lossScores: [] });
      }
      const entry = categoryMap.get(factor.category)!;
      if (trade.pnl > 0) {
        entry.winScores.push(factor.score);
      } else {
        entry.lossScores.push(factor.score);
      }
    }
  }
  
  const analysis: FactorAnalysis[] = [];
  
  for (const [category, scores] of categoryMap) {
    const avgWin = scores.winScores.length > 0
      ? scores.winScores.reduce((a, b) => a + b, 0) / scores.winScores.length
      : 0;
    const avgLoss = scores.lossScores.length > 0
      ? scores.lossScores.reduce((a, b) => a + b, 0) / scores.lossScores.length
      : 0;
    
    // Correlation: positive means factor score correlates with winning
    const allScores = [...scores.winScores, ...scores.lossScores];
    const allOutcomes = scores.winScores.map(() => 1).concat(scores.lossScores.map(() => -1));
    const n = allScores.length;
    let correlation = 0;
    if (n > 1) {
      const meanScore = allScores.reduce((a, b) => a + b, 0) / n;
      const meanOutcome = allOutcomes.reduce((a, b) => a + b, 0) / n;
      let numerator = 0, denomScore = 0, denomOutcome = 0;
      for (let i = 0; i < n; i++) {
        const ds = allScores[i] - meanScore;
        const do_ = allOutcomes[i] - meanOutcome;
        numerator += ds * do_;
        denomScore += ds * ds;
        denomOutcome += do_ * do_;
      }
      const denom = Math.sqrt(denomScore * denomOutcome);
      correlation = denom > 0 ? numerator / denom : 0;
    }
    
    // Suggested weight based on correlation
    const label = category; // Will be mapped later
    const suggestedWeight = Math.max(0, Math.min(1, 0.5 + correlation * 0.5));
    
    analysis.push({
      category,
      label,
      avgScoreOnWin: Math.round(avgWin * 100) / 100,
      avgScoreOnLoss: Math.round(avgLoss * 100) / 100,
      correlation: Math.round(correlation * 100) / 100,
      suggestedWeight: Math.round(suggestedWeight * 100) / 100,
      currentWeight: 0, // Will be filled from params
    });
  }
  
  return analysis.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
}

// Analyze signal effectiveness
function analyzeSignalPerformance(trades: BacktestTrade[]): SignalAnalysis[] {
  // This will analyze what types of signals led to trades
  const signalMap = new Map<string, { wins: number; losses: number; returns: number[] }>();
  
  for (const trade of trades) {
    // Determine signal type based on factors
    const factors = trade.entryFactors || [];
    const dominantFactor = factors.reduce((a, b) => Math.abs(a.score) > Math.abs(b.score) ? a : b, factors[0]);
    
    if (dominantFactor) {
      const key = dominantFactor.category;
      if (!signalMap.has(key)) {
        signalMap.set(key, { wins: 0, losses: 0, returns: [] });
      }
      const entry = signalMap.get(key)!;
      if (trade.pnl > 0) entry.wins++;
      else entry.losses++;
      entry.returns.push(trade.pnlPct);
    }
  }
  
  const analysis: SignalAnalysis[] = [];
  
  for (const [type, data] of signalMap) {
    const total = data.wins + data.losses;
    const winRate = total > 0 ? data.wins / total : 0;
    const avgReturn = data.returns.length > 0
      ? data.returns.reduce((a, b) => a + b, 0) / data.returns.length
      : 0;
    
    let suggestedAction: SignalAnalysis['suggestedAction'] = 'keep';
    if (total >= 5) {
      if (winRate > 0.6 && avgReturn > 0.5) suggestedAction = 'increase_threshold';
      else if (winRate < 0.35 && avgReturn < 0) suggestedAction = 'decrease_threshold';
      else if (winRate < 0.25 && avgReturn < -1) suggestedAction = 'disable';
    }
    
    analysis.push({
      type,
      label: type,
      totalTriggers: total,
      winRate: Math.round(winRate * 1000) / 10,
      avgReturn: Math.round(avgReturn * 100) / 100,
      suggestedAction,
    });
  }
  
  return analysis.sort((a, b) => b.totalTriggers - a.totalTriggers);
}

// Closed-loop optimization
function runOptimization(
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>,
  binanceTicks: BacktestBinanceTick[],
  sentimentData: BacktestSentimentRow[],
  params: BacktestParams,
): OptimizationResult {
  // Run with current weights
  const currentResult = backtestEngine(candles, binanceTicks, sentimentData, params);
  
  // Analyze factors
  const factorAnalysis = analyzeFactorPerformance(currentResult.trades);
  const signalAnalysis = analyzeSignalPerformance(currentResult.trades);
  
  // Map labels to Chinese
  const labelMap: Record<string, string> = {
    momentum: '价格动量', funding: '资金费率', volume: '成交量', volatility: '波动率',
    fx: '汇率影响', premium: '合约溢价', indicator: '指标动量', structure: '结构位',
    lsRatio: '多空比', takerVol: '主动买卖', openInterest: '持仓量',
    lsTrend: '多空趋势', whale: '庄家动向', news: '新闻情绪',
  };
  for (const fa of factorAnalysis) {
    fa.label = labelMap[fa.category] || fa.category;
    fa.currentWeight = params.weights?.[fa.category] || 0.5;
  }
  for (const sa of signalAnalysis) {
    sa.label = labelMap[sa.type] || sa.type;
  }
  
  // Generate optimized weights based on analysis
  const optimizedWeights: Record<string, number> = { ...params.weights };
  const improvements: string[] = [];
  
  for (const fa of factorAnalysis) {
    if (fa.correlation > 0.1) {
      // Factor correlates with wins - increase weight
      const increase = Math.min(0.3, fa.correlation * 0.5);
      optimizedWeights[fa.category] = Math.min(1, (fa.currentWeight || 0.5) + increase);
      improvements.push(`${fa.label}: 增加权重 (相关性 ${fa.correlation.toFixed(2)})`);
    } else if (fa.correlation < -0.1) {
      // Factor correlates with losses - decrease weight
      const decrease = Math.min(0.3, Math.abs(fa.correlation) * 0.5);
      optimizedWeights[fa.category] = Math.max(0, (fa.currentWeight || 0.5) - decrease);
      improvements.push(`${fa.label}: 降低权重 (负相关 ${fa.correlation.toFixed(2)})`);
    }
  }
  
  // Signal-based improvements
  for (const sa of signalAnalysis) {
    if (sa.suggestedAction === 'disable') {
      improvements.push(`${sa.label}: 建议禁用 (胜率 ${sa.winRate.toFixed(1)}%)`);
    } else if (sa.suggestedAction === 'increase_threshold') {
      improvements.push(`${sa.label}: 建议提高阈值 (表现良好)`);
    }
  }
  
  // Run with optimized weights
  const optimizedResult = backtestEngine(candles, binanceTicks, sentimentData, {
    ...params,
    weights: optimizedWeights,
  });
  
  // Calculate improvement
  const returnDiff = optimizedResult.metrics.totalReturn - currentResult.metrics.totalReturn;
  const sharpeDiff = optimizedResult.metrics.sharpe - currentResult.metrics.sharpe;
  if (returnDiff > 0.5) improvements.unshift(`预期收益提升: +${returnDiff.toFixed(2)}%`);
  if (sharpeDiff > 0.1) improvements.unshift(`夏普比率提升: +${sharpeDiff.toFixed(2)}`);
  
  return {
    currentMetrics: currentResult.metrics,
    optimizedWeights,
    optimizedMetrics: optimizedResult.metrics,
    factorAnalysis,
    signalAnalysis,
    improvements,
  };
}

export function backtestEngine(
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>,
  binanceTicks: BacktestBinanceTick[],
  sentimentData: BacktestSentimentRow[],
  params: BacktestParams = {},
): BacktestResult {
  const {
    threshold = 0.3,
    holdBars = 12,
    leverage = 1,
    stopLossPct = 3,
    takeProfitPct = 5,
    weights = {},
    observationToleranceSec = 3600,
    fxRate = 0,
    fxTicks = [],
    timeframe = 'm5',
    feeRate = 0.0005,
    slippageBps = 5,
    hasRealVolume = false,
  } = params;
  const initialEquity = 10000;
  let equity = initialEquity;
  const equityCurve = [equity];
  const trades: BacktestTrade[] = [];
  const costs = { fees: 0, slippage: 0, funding: 0 };
  const orderedBinance = [...binanceTicks].sort((a, b) => a.ts - b.ts);
  const orderedSentiment = [...sentimentData].sort((a, b) => a.ts - b.ts);
  const orderedFx = [...fxTicks].sort((a, b) => a.ts - b.ts);
  let binanceIndex = -1;
  let sentimentIndex = -1;
  let pendingDirection: 'long' | 'short' | null = null;
  let pendingFactors: Factor[] = [];
  let position: {
    direction: 'long' | 'short'; entry: number; entryTime: number; entryIdx: number;
    quantity: number; entryEquity: number; entryFee: number; fundingCost: number; lastFundingTs: number;
    entryFactors: Factor[];
  } | null = null;

  const slippageRate = slippageBps / 10000;
  
  // Pre-compute support/resistance levels
  const srLevels = findSupportResistance(candles);

  for (let i = 50; i < candles.length; i++) {
    const candle = candles[i];
    while (binanceIndex + 1 < orderedBinance.length && orderedBinance[binanceIndex + 1].ts <= candle.time) binanceIndex++;
    while (sentimentIndex + 1 < orderedSentiment.length && orderedSentiment[sentimentIndex + 1].ts <= candle.time) sentimentIndex++;

    if (!position && pendingDirection) {
      const rawEntry = candle.open;
      const entry = pendingDirection === 'long'
        ? rawEntry * (1 + slippageRate)
        : rawEntry * (1 - slippageRate);
      const entryEquity = equity;
      const notional = entryEquity * leverage;
      const quantity = notional / entry;
      const entryFee = notional * feeRate;
      costs.fees += entryFee;
      costs.slippage += Math.abs(entry - rawEntry) * quantity;
      equity -= entryFee;
      position = {
        direction: pendingDirection, entry, entryTime: candle.time, entryIdx: i,
        quantity, entryEquity, entryFee, fundingCost: 0,
        lastFundingTs: candle.time, entryFactors: pendingFactors,
      };
      pendingDirection = null;
      pendingFactors = [];
    }

    if (position) {
      for (const tick of orderedBinance) {
        if (!tick.isFundingEvent || tick.ts <= position.lastFundingTs || tick.ts > candle.time) continue;
        const fundingCash = position.quantity * position.entry * (tick.funding_rate || 0)
          * (position.direction === 'long' ? 1 : -1);
        equity -= fundingCash;
        position.fundingCost += fundingCash;
        costs.funding += fundingCash;
        position.lastFundingTs = tick.ts;
      }
      const stop = position.direction === 'long'
        ? position.entry * (1 - stopLossPct / 100)
        : position.entry * (1 + stopLossPct / 100);
      const target = position.direction === 'long'
        ? position.entry * (1 + takeProfitPct / 100)
        : position.entry * (1 - takeProfitPct / 100);
      const hitStop = position.direction === 'long' ? candle.low <= stop : candle.high >= stop;
      const hitTarget = position.direction === 'long' ? candle.high >= target : candle.low <= target;
      const timedOut = i - position.entryIdx >= holdBars;
      let exitReason: BacktestTrade['exitReason'] | null = null;
      let rawExit = candle.close;
      
      // Check for exit signal (direction reversal)
      const exitSentimentHistory = orderedSentiment.slice(0, sentimentIndex + 1);
      const exitFactors = calculateFactorsAtPosition(candles, i,
        binanceIndex >= 0 ? orderedBinance[binanceIndex] : undefined,
        sentimentIndex >= 0 ? orderedSentiment[sentimentIndex] : undefined,
        { ...params, sentimentHistory: exitSentimentHistory }, srLevels);
      const exitComposite = calculateWeightedComposite(exitFactors, weights).composite;
      const exitSignal = (position.direction === 'long' && exitComposite < -threshold) ||
                         (position.direction === 'short' && exitComposite > threshold);
      
      if (hitStop) { exitReason = 'stopLoss'; rawExit = stop; }
      else if (hitTarget) { exitReason = 'takeProfit'; rawExit = target; }
      else if (exitSignal) { exitReason = 'signal'; }
      else if (timedOut) exitReason = 'timeout';

      if (exitReason) {
        const exit = position.direction === 'long'
          ? rawExit * (1 - slippageRate)
          : rawExit * (1 + slippageRate);
        const gross = position.direction === 'long'
          ? position.quantity * (exit - position.entry)
          : position.quantity * (position.entry - exit);
        const exitFee = position.quantity * exit * feeRate;
        const exitSlippage = Math.abs(exit - rawExit) * position.quantity;
        equity += gross - exitFee;
        costs.fees += exitFee;
        costs.slippage += exitSlippage;
        const net = gross - position.entryFee - exitFee - position.fundingCost;
        trades.push({
          entryTime: position.entryTime,
          exitTime: candle.time,
          direction: position.direction,
          entry: Math.round(position.entry * 10000) / 10000,
          exit: Math.round(exit * 10000) / 10000,
          pnl: Math.round(net * 100) / 100,
          pnlPct: Math.round((net / position.entryEquity) * 10000) / 100,
          exitReason,
          entryFactors: position.entryFactors,
          exitFactors,
          composite: exitComposite,
        });
        position = null;
      }
    }

    if (!position && !pendingDirection) {
      const binance = binanceIndex >= 0 ? orderedBinance[binanceIndex] : undefined;
      const sentiment = sentimentIndex >= 0 ? orderedSentiment[sentimentIndex] : undefined;
      // Build sentiment history window for trend factors
      const sentimentHistory = orderedSentiment.slice(0, sentimentIndex + 1);
      const enrichedParams = { ...params, sentimentHistory };
      const factors = calculateFactorsAtPosition(candles, i, binance, sentiment, enrichedParams, srLevels);
      const composite = calculateWeightedComposite(factors, weights).composite;
      
      if (composite > threshold) {
        pendingDirection = 'long';
        pendingFactors = factors;
      } else if (composite < -threshold) {
        pendingDirection = 'short';
        pendingFactors = factors;
      }
    }
    equityCurve.push(equity);
  }

  if (position) {
    const candle = candles[candles.length - 1];
    const rawExit = candle.close;
    const exit = position.direction === 'long' ? rawExit * (1 - slippageRate) : rawExit * (1 + slippageRate);
    const gross = position.direction === 'long'
      ? position.quantity * (exit - position.entry)
      : position.quantity * (position.entry - exit);
    const exitFee = position.quantity * exit * feeRate;
    equity += gross - exitFee;
    costs.fees += exitFee;
    costs.slippage += Math.abs(exit - rawExit) * position.quantity;
    const net = gross - position.entryFee - exitFee - position.fundingCost;
    trades.push({
      entryTime: position.entryTime, exitTime: candle.time, direction: position.direction,
      entry: Math.round(position.entry * 10000) / 10000,
      exit: Math.round(exit * 10000) / 10000,
      pnl: Math.round(net * 100) / 100,
      pnlPct: Math.round((net / position.entryEquity) * 10000) / 100,
      exitReason: 'timeout',
      entryFactors: position.entryFactors,
      exitFactors: [],
      composite: 0,
    });
    equityCurve.push(equity);
  }

  const metrics = computeMetrics(trades, equityCurve, initialEquity, timeframe);
  const factorAnalysis = analyzeFactorPerformance(trades);
  const signalAnalysis = analyzeSignalPerformance(trades);
  
  // Fill in current weights
  for (const fa of factorAnalysis) {
    fa.currentWeight = weights[fa.category] || 0.5;
  }
  
  // Map labels
  const labelMap: Record<string, string> = {
    momentum: '价格动量', funding: '资金费率', volume: '成交量', volatility: '波动率',
    fx: '汇率影响', premium: '合约溢价', indicator: '指标动量', structure: '结构位',
    lsRatio: '多空比', takerVol: '主动买卖', openInterest: '持仓量',
    lsTrend: '多空趋势', whale: '庄家动向', news: '新闻情绪',
  };
  for (const fa of factorAnalysis) {
    fa.label = labelMap[fa.category] || fa.category;
  }
  for (const sa of signalAnalysis) {
    sa.label = labelMap[sa.type] || sa.type;
  }

  return {
    trades,
    metrics,
    equityCurve,
    weights,
    costs: {
      fees: Math.round(costs.fees * 100) / 100,
      slippage: Math.round(costs.slippage * 100) / 100,
      funding: Math.round(costs.funding * 100) / 100,
    },
    factorAnalysis,
    signalAnalysis,
  };
}

// Full optimization with closed-loop feedback
export function backtestWithOptimization(
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>,
  binanceTicks: BacktestBinanceTick[],
  sentimentData: BacktestSentimentRow[],
  params: BacktestParams = {},
): BacktestResult {
  const result = backtestEngine(candles, binanceTicks, sentimentData, params);
  
  // Run optimization
  const optimization = runOptimization(candles, binanceTicks, sentimentData, params);
  
  return {
    ...result,
    optimization,
  };
}

// Legacy optimization function (kept for backward compatibility)
export function optimizeWeights(
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>,
  binanceTicks: BacktestBinanceTick[],
  sentimentData: BacktestSentimentRow[]
): BacktestResult {
  const thresholds = [0.3, 0.5, 0.8, 1.2];
  const holdBars = [8, 12, 16, 20];
  const stopLosses = [2, 3, 4];
  const takeProfits = [4, 6, 8];
  
  let bestResult: BacktestResult | null = null;
  let bestSharpe = -Infinity;
  
  for (const threshold of thresholds) {
    for (const hold of holdBars) {
      for (const sl of stopLosses) {
        for (const tp of takeProfits) {
          const result = backtestEngine(candles, binanceTicks, sentimentData, {
            threshold,
            holdBars: hold,
            stopLossPct: sl,
            takeProfitPct: tp,
          });
          
          if (result.metrics.sharpe > bestSharpe && result.metrics.totalTrades >= 5) {
            bestSharpe = result.metrics.sharpe;
            bestResult = result;
            bestResult.weights = {
              threshold,
              holdBars: hold,
              stopLossPct: sl,
              takeProfitPct: tp,
            };
          }
        }
      }
    }
  }
  
  return bestResult || backtestEngine(candles, binanceTicks, sentimentData);
}
