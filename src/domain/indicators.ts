// src/domain/indicators.ts
// Technical indicators calculation module

export interface IndicatorResult {
  rsi: number;
  macd: { dif: number; dea: number; histogram: number };
  bollinger: { upper: number; mid: number; lower: number };
  ma5: number;
  ma20: number;
  volRatio: number;
}

export interface IndicatorsData {
  rsi: number[];
  macd: { dif: number[]; dea: number[]; histogram: number[] };
  bollinger: { upper: number[]; mid: number[]; lower: number[] };
  ma5: number[];
  ma20: number[];
  volRatio: number[];
  latest: IndicatorResult;
  signals: Signal[];
  support: SupportResistance[];
  resistance: SupportResistance[];
}

export interface Signal {
  type: 'buy' | 'sell' | 'neutral';
  label: string;
  strength: number;
  time: number;
}

export interface SupportResistance {
  price: number;
  type: 'support' | 'resistance';
  strength: number;
}

export function calcSMA(closes: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
    } else {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) {
        sum += closes[j];
      }
      result.push(sum / period);
    }
  }
  return result;
}

export function calcEMA(closes: number[], period: number): number[] {
  const result: number[] = [];
  const multiplier = 2 / (period + 1);
  
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) {
      result.push(closes[i]);
    } else {
      result.push((closes[i] - result[i - 1]) * multiplier + result[i - 1]);
    }
  }
  return result;
}

export function calcRSI(closes: number[], period: number = 14): number[] {
  const result: number[] = [];
  const gains: number[] = [];
  const losses: number[] = [];
  
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }
  
  for (let i = 0; i < closes.length; i++) {
    if (i < period) {
      result.push(NaN);
    } else {
      const avgGain = gains.slice(i - period, i).reduce((a, b) => a + b, 0) / period;
      const avgLoss = losses.slice(i - period, i).reduce((a, b) => a + b, 0) / period;
      if (avgLoss === 0) {
        result.push(100);
      } else {
        const rs = avgGain / avgLoss;
        result.push(100 - (100 / (1 + rs)));
      }
    }
  }
  return result;
}

export function calcMACD(closes: number[], fast: number = 12, slow: number = 26, signal: number = 9) {
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  
  const dif: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    dif.push(emaFast[i] - emaSlow[i]);
  }
  
  const dea = calcEMA(dif, signal);
  const histogram: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    histogram.push((dif[i] - dea[i]) * 2);
  }
  
  return { dif, dea, histogram };
}

export function calcBollinger(closes: number[], period: number = 20, mult: number = 2) {
  const ma = calcSMA(closes, period);
  const upper: number[] = [];
  const lower: number[] = [];
  
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      upper.push(NaN);
      lower.push(NaN);
    } else {
      const slice = closes.slice(i - period + 1, i + 1);
      const mean = slice.reduce((a, b) => a + b, 0) / period;
      const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
      const stdDev = Math.sqrt(variance);
      upper.push(ma[i] + stdDev * mult);
      lower.push(ma[i] - stdDev * mult);
    }
  }
  
  return { upper, mid: ma, lower };
}

export function calcVolRatio(volumes: number[], period: number = 5): number[] {
  const result: number[] = [];
  for (let i = 0; i < volumes.length; i++) {
    if (i < period) {
      result.push(NaN);
    } else {
      const avg = volumes.slice(i - period, i).reduce((a, b) => a + b, 0) / period;
      result.push(avg > 0 ? volumes[i] / avg : 1);
    }
  }
  return result;
}

export function detectSignals(closes: number[], times: number[], indicators: IndicatorsData): Signal[] {
  const signals: Signal[] = [];
  const len = closes.length;
  
  if (len < 2) return signals;
  
  const rsi = indicators.rsi[len - 1];
  const macdHist = indicators.macd.histogram[len - 1];
  const prevMacdHist = indicators.macd.histogram[len - 2];
  const price = closes[len - 1];
  const bbUpper = indicators.bollinger.upper[len - 1];
  const bbLower = indicators.bollinger.lower[len - 1];
  const ma5 = indicators.ma5[len - 1];
  const ma20 = indicators.ma20[len - 1];
  const prevMa5 = indicators.ma5[len - 2];
  const prevMa20 = indicators.ma20[len - 2];
  
  // RSI signals
  if (!isNaN(rsi)) {
    if (rsi < 30) {
      signals.push({ type: 'buy', label: 'RSI超卖', strength: 2, time: times[len - 1] });
    } else if (rsi > 70) {
      signals.push({ type: 'sell', label: 'RSI超买', strength: 2, time: times[len - 1] });
    }
  }
  
  // MACD crossover
  if (!isNaN(macdHist) && !isNaN(prevMacdHist)) {
    if (macdHist > 0 && prevMacdHist <= 0) {
      signals.push({ type: 'buy', label: 'MACD金叉', strength: 3, time: times[len - 1] });
    } else if (macdHist < 0 && prevMacdHist >= 0) {
      signals.push({ type: 'sell', label: 'MACD死叉', strength: 3, time: times[len - 1] });
    }
  }
  
  // Bollinger Band signals
  if (!isNaN(bbUpper) && !isNaN(bbLower)) {
    if (price <= bbLower) {
      signals.push({ type: 'buy', label: '触及布林下轨', strength: 2, time: times[len - 1] });
    } else if (price >= bbUpper) {
      signals.push({ type: 'sell', label: '触及布林上轨', strength: 2, time: times[len - 1] });
    }
  }
  
  // MA crossover (golden/death cross)
  if (!isNaN(ma5) && !isNaN(ma20) && !isNaN(prevMa5) && !isNaN(prevMa20)) {
    if (prevMa5 <= prevMa20 && ma5 > ma20) {
      signals.push({ type: 'buy', label: 'MA金叉', strength: 3, time: times[len - 1] });
    } else if (prevMa5 >= prevMa20 && ma5 < ma20) {
      signals.push({ type: 'sell', label: 'MA死叉', strength: 3, time: times[len - 1] });
    }
  }
  
  // Trend signals (3 consecutive higher/lower closes)
  if (len >= 4) {
    if (closes[len-1] > closes[len-2] && closes[len-2] > closes[len-3] && closes[len-3] > closes[len-4]) {
      signals.push({ type: 'buy', label: '连续上涨', strength: 2, time: times[len - 1] });
    } else if (closes[len-1] < closes[len-2] && closes[len-2] < closes[len-3] && closes[len-3] < closes[len-4]) {
      signals.push({ type: 'sell', label: '连续下跌', strength: 2, time: times[len - 1] });
    }
  }
  
  return signals;
}

export function findSupportResistance(candles: Array<{ high: number; low: number; close: number }>): SupportResistance[] {
  const result: SupportResistance[] = [];
  const len = candles.length;
  
  if (len < 10) return result;
  
  // Simple pivot point method
  for (let i = 2; i < len - 2; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    
    // Resistance: local high
    if (high > candles[i - 1].high && high > candles[i - 2].high &&
        high > candles[i + 1].high && high > candles[i + 2].high) {
      result.push({ price: high, type: 'resistance', strength: 1 });
    }
    
    // Support: local low
    if (low < candles[i - 1].low && low < candles[i - 2].low &&
        low < candles[i + 1].low && low < candles[i + 2].low) {
      result.push({ price: low, type: 'support', strength: 1 });
    }
  }
  
  // Deduplicate nearby levels
  const filtered: SupportResistance[] = [];
  const threshold = candles[len - 1].close * 0.01; // 1%
  
  for (const level of result) {
    const nearby = filtered.find(f => Math.abs(f.price - level.price) < threshold);
    if (nearby) {
      nearby.strength++;
    } else {
      filtered.push(level);
    }
  }
  
  return filtered.slice(-10); // Keep last 10 levels
}

export function calculateAllIndicators(
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>
): IndicatorsData {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const times = candles.map(c => c.time);
  
  const rsi = calcRSI(closes);
  const macd = calcMACD(closes);
  const bollinger = calcBollinger(closes);
  const ma5 = calcSMA(closes, 5);
  const ma20 = calcSMA(closes, 20);
  const volRatio = calcVolRatio(volumes);
  
  const len = closes.length;
  const latest: IndicatorResult = {
    rsi: rsi[len - 1] || 0,
    macd: {
      dif: macd.dif[len - 1] || 0,
      dea: macd.dea[len - 1] || 0,
      histogram: macd.histogram[len - 1] || 0,
    },
    bollinger: {
      upper: bollinger.upper[len - 1] || 0,
      mid: bollinger.mid[len - 1] || 0,
      lower: bollinger.lower[len - 1] || 0,
    },
    ma5: ma5[len - 1] || 0,
    ma20: ma20[len - 1] || 0,
    volRatio: volRatio[len - 1] || 1,
  };
  
  const indicators: IndicatorsData = {
    rsi,
    macd,
    bollinger,
    ma5,
    ma20,
    volRatio,
    latest,
    signals: [],
    support: [],
    resistance: [],
  };
  
  indicators.signals = detectSignals(closes, times, indicators);
  const sr = findSupportResistance(candles);
  indicators.support = sr.filter(s => s.type === 'support');
  indicators.resistance = sr.filter(s => s.type === 'resistance');
  
  return indicators;
}
