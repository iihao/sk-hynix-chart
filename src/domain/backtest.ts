// src/domain/backtest.ts
// Backtest engine module

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
} from './factors';
import { findFxAtOrBefore, FxTick } from './fx';

export interface BacktestParams {
  threshold?: number;
  holdBars?: number;
  leverage?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  weights?: Record<string, number>;
  observationToleranceSec?: number;
  fxRate?: number;
  fxTicks?: FxTick[];
  timeframe?: 'm1' | 'm5' | 'm15' | 'h1';
  feeRate?: number;
  slippageBps?: number;
  hasRealVolume?: boolean;
}

export interface BacktestBinanceTick {
  ts: number;
  price: number;
  funding_rate?: number;
  isFundingEvent?: boolean;
}

export interface BacktestSentimentRow {
  ts: number;
  ls_ratio?: number;
  taker_buy_vol?: number;
  taker_sell_vol?: number;
  open_interest?: number;
  oi_value?: number;
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
}

export interface BacktestResult {
  trades: BacktestTrade[];
  metrics: BacktestMetrics;
  equityCurve: number[];
  weights: Record<string, number>;
  costs: { fees: number; slippage: number; funding: number };
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
      totalTrades: 0,
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      totalReturn: 0,
      maxDrawdown: 0,
      sharpe: 0,
      profitFactor: 0,
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
  
  // Sharpe ratio (simplified)
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
  
  return {
    totalTrades: trades.length,
    winRate: Math.round(winRate * 1000) / 10,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    totalReturn: Math.round(totalReturn * 100) / 100,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
  };
}

export function backtestEngine(
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>,
  binanceTicks: BacktestBinanceTick[],
  sentimentData: BacktestSentimentRow[],
  params: BacktestParams = {},
): BacktestResult {
  const {
    threshold = 2,
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
  let position: {
    direction: 'long' | 'short'; entry: number; entryTime: number; entryIdx: number;
    quantity: number; entryEquity: number; entryFee: number; fundingCost: number; lastFundingTs: number;
  } | null = null;

  const slippageRate = slippageBps / 10000;

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
        lastFundingTs: candle.time,
      };
      pendingDirection = null;
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
      if (hitStop) { exitReason = 'stopLoss'; rawExit = stop; }
      else if (hitTarget) { exitReason = 'takeProfit'; rawExit = target; }
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
        });
        position = null;
      }
    }

    if (!position && !pendingDirection) {
      const factorWindow = candles.slice(Math.max(0, i - 20), i + 1);
      const factors: Factor[] = [factorMomentum(factorWindow), factorVolatility(factorWindow)];
      if (hasRealVolume) factors.push(factorVolume(factorWindow));
      const binance = binanceIndex >= 0 ? orderedBinance[binanceIndex] : undefined;
      if (binance && candle.time - binance.ts <= observationToleranceSec) {
        factors.push(factorFundingRate(binance.funding_rate || 0));
        const alignedFx = orderedFx.length
          ? findFxAtOrBefore(orderedFx, candle.time, observationToleranceSec)?.mid
          : fxRate;
        if (alignedFx && binance.price > 0) factors.push(factorPremium(candle.close, binance.price, alignedFx));
      }
      const sentiment = sentimentIndex >= 0 ? orderedSentiment[sentimentIndex] : undefined;
      if (sentiment && candle.time - sentiment.ts <= observationToleranceSec) {
        if (typeof sentiment.ls_ratio === 'number' && sentiment.ls_ratio > 0) factors.push(factorLongShortRatio(sentiment.ls_ratio));
        if (typeof sentiment.taker_buy_vol === 'number' && typeof sentiment.taker_sell_vol === 'number'
          && sentiment.taker_buy_vol > 0 && sentiment.taker_sell_vol > 0) {
          factors.push(factorTakerVolume(sentiment.taker_buy_vol, sentiment.taker_sell_vol));
        }
      }
      const composite = calculateWeightedComposite(factors, weights).composite;
      if (composite > threshold) pendingDirection = 'long';
      else if (composite < -threshold) pendingDirection = 'short';
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
    });
    equityCurve.push(equity);
  }

  return {
    trades,
    metrics: computeMetrics(trades, equityCurve, initialEquity, timeframe),
    equityCurve,
    weights,
    costs: {
      fees: Math.round(costs.fees * 100) / 100,
      slippage: Math.round(costs.slippage * 100) / 100,
      funding: Math.round(costs.funding * 100) / 100,
    },
  };
}

export function optimizeWeights(
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>,
  binanceTicks: BacktestBinanceTick[],
  sentimentData: BacktestSentimentRow[]
): BacktestResult {
  // Grid search for optimal parameters
  const thresholds = [1.5, 2, 2.5, 3];
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
