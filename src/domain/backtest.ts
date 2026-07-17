// src/domain/backtest.ts
// Backtest engine module

import {
  calculateWeightedComposite,
  Factor,
  factorFundingRate,
  factorLongShortRatio,
  factorMomentum,
  factorOpenInterest,
  factorTakerVolume,
  factorVolatility,
  factorVolume,
} from './factors';

export interface BacktestParams {
  threshold?: number;
  holdBars?: number;
  leverage?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  weights?: Record<string, number>;
  observationToleranceSec?: number;
}

export interface BacktestBinanceTick {
  ts: number;
  price: number;
  funding_rate?: number;
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
}

export function computeMetrics(trades: BacktestTrade[], equityCurve: number[], initialEquity: number): BacktestMetrics {
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
  const sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;
  
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
  params: BacktestParams = {}
): BacktestResult {
  const {
    threshold = 2,
    holdBars = 12,
    leverage = 1,
    stopLossPct = 3,
    takeProfitPct = 5,
    weights = {},
    observationToleranceSec = 3600,
  } = params;
  
  const initialEquity = 10000;
  let equity = initialEquity;
  const equityCurve: number[] = [equity];
  const trades: BacktestTrade[] = [];
  
  let position: {
    direction: 'long' | 'short';
    entry: number;
    entryTime: number;
    entryIdx: number;
  } | null = null;
  
  const len = candles.length;
  const lookback = 50; // Need enough data for indicators
  const orderedBinance = [...binanceTicks].sort((a, b) => a.ts - b.ts);
  const orderedSentiment = [...sentimentData].sort((a, b) => a.ts - b.ts);
  let binanceIndex = -1;
  let sentimentIndex = -1;
  
  for (let i = lookback; i < len; i++) {
    const candle = candles[i];
    const price = candle.close;
    while (binanceIndex + 1 < orderedBinance.length && orderedBinance[binanceIndex + 1].ts <= candle.time) {
      binanceIndex++;
    }
    while (sentimentIndex + 1 < orderedSentiment.length && orderedSentiment[sentimentIndex + 1].ts <= candle.time) {
      sentimentIndex++;
    }
    
    // Check exit conditions if in position
    if (position) {
      const barsHeld = i - position.entryIdx;
      const pnlPct = position.direction === 'long'
        ? (price - position.entry) / position.entry * 100
        : (position.entry - price) / position.entry * 100;
      
      let exitReason: BacktestTrade['exitReason'] | null = null;
      
      // Stop loss
      if (pnlPct <= -stopLossPct) {
        exitReason = 'stopLoss';
      }
      // Take profit
      else if (pnlPct >= takeProfitPct) {
        exitReason = 'takeProfit';
      }
      // Timeout
      else if (barsHeld >= holdBars) {
        exitReason = 'timeout';
      }
      
      if (exitReason) {
        const pnl = equity * (pnlPct / 100) * leverage;
        equity += pnl;
        
        trades.push({
          entryTime: position.entryTime,
          exitTime: candle.time,
          direction: position.direction,
          entry: position.entry,
          exit: price,
          pnl: Math.round(pnl * 100) / 100,
          pnlPct: Math.round(pnlPct * 100) / 100,
          exitReason,
        });
        
        position = null;
      }
    }
    
    // Check entry conditions if no position
    if (!position) {
      const factorWindow = candles.slice(Math.max(0, i - 20), i + 1);
      const factors: Factor[] = [
        factorMomentum(factorWindow),
        factorVolume(factorWindow),
        factorVolatility(factorWindow),
      ];
      const binance = binanceIndex >= 0 ? orderedBinance[binanceIndex] : undefined;
      if (binance && candle.time - binance.ts <= observationToleranceSec) {
        factors.push(factorFundingRate(binance.funding_rate || 0));
      }

      const sentiment = sentimentIndex >= 0 ? orderedSentiment[sentimentIndex] : undefined;
      if (sentiment && candle.time - sentiment.ts <= observationToleranceSec) {
        if (typeof sentiment.ls_ratio === 'number' && sentiment.ls_ratio > 0) {
          factors.push(factorLongShortRatio(sentiment.ls_ratio));
        }
        if (
          typeof sentiment.taker_buy_vol === 'number' && sentiment.taker_buy_vol > 0
          && typeof sentiment.taker_sell_vol === 'number' && sentiment.taker_sell_vol > 0
        ) {
          factors.push(factorTakerVolume(sentiment.taker_buy_vol, sentiment.taker_sell_vol));
        }
        const previousSentiment = sentimentIndex > 0 ? orderedSentiment[sentimentIndex - 1] : undefined;
        const currentOi = sentiment.oi_value ?? sentiment.open_interest;
        const previousOi = previousSentiment?.oi_value ?? previousSentiment?.open_interest;
        if (typeof currentOi === 'number' && typeof previousOi === 'number' && previousOi > 0 && i > 0) {
          const oiChange = (currentOi - previousOi) / previousOi * 100;
          const previousPrice = candles[i - 1].close;
          const priceChange = previousPrice > 0 ? (price - previousPrice) / previousPrice * 100 : 0;
          factors.push(factorOpenInterest(oiChange, priceChange));
        }
      }

      const composite = calculateWeightedComposite(factors, weights).composite;
      if (composite > threshold) {
        position = {
          direction: 'long',
          entry: price,
          entryTime: candle.time,
          entryIdx: i,
        };
      } else if (composite < -threshold) {
        position = {
          direction: 'short',
          entry: price,
          entryTime: candle.time,
          entryIdx: i,
        };
      }
    }
    
    equityCurve.push(equity);
  }
  
  // Close any remaining position
  if (position) {
    const price = candles[len - 1].close;
    const pnlPct = position.direction === 'long'
      ? (price - position.entry) / position.entry * 100
      : (position.entry - price) / position.entry * 100;
    const pnl = equity * (pnlPct / 100) * leverage;
    equity += pnl;
    
    trades.push({
      entryTime: position.entryTime,
      exitTime: candles[len - 1].time,
      direction: position.direction,
      entry: position.entry,
      exit: price,
      pnl: Math.round(pnl * 100) / 100,
      pnlPct: Math.round(pnlPct * 100) / 100,
      exitReason: 'timeout',
    });
    equityCurve.push(equity);
  }
  
  const metrics = computeMetrics(trades, equityCurve, initialEquity);
  
  return {
    trades,
    metrics,
    equityCurve,
    weights,
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
