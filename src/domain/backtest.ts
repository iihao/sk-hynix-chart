// src/domain/backtest.ts
// Backtest engine module

export interface BacktestParams {
  threshold?: number;
  holdBars?: number;
  leverage?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  weights?: Record<string, number>;
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
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  
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
  binanceTicks: Array<{ ts: number; price: number }>,
  sentimentData: Array<{ ts: number; [key: string]: any }>,
  params: BacktestParams = {}
): BacktestResult {
  const {
    threshold = 2,
    holdBars = 12,
    leverage = 1,
    stopLossPct = 3,
    takeProfitPct = 5,
    weights = {},
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
  
  for (let i = lookback; i < len; i++) {
    const candle = candles[i];
    const price = candle.close;
    
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
      // Simple momentum-based entry
      const recentCandles = candles.slice(i - 10, i);
      const avgClose = recentCandles.reduce((sum, c) => sum + c.close, 0) / recentCandles.length;
      const momentum = (price - avgClose) / avgClose * 100;
      
      // Volume check
      const avgVol = recentCandles.reduce((sum, c) => sum + c.volume, 0) / recentCandles.length;
      const volRatio = candle.volume / avgVol;
      
      if (momentum > threshold && volRatio > 1.2) {
        position = {
          direction: 'long',
          entry: price,
          entryTime: candle.time,
          entryIdx: i,
        };
      } else if (momentum < -threshold && volRatio > 1.2) {
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
  binanceTicks: Array<{ ts: number; price: number }>,
  sentimentData: Array<{ ts: number; [key: string]: any }>
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
