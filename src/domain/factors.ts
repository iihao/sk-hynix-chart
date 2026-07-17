// src/domain/factors.ts
// Factor calculation module for multi-factor analysis

export interface Factor {
  category: string;
  label: string;
  score: number;
  weight: number;
  detail: string;
}

export interface FactorResult {
  factors: Factor[];
  omittedFactors: Array<{ category: string; reason: 'missing' | 'stale' | 'unsupported' }>;
  composite: number;
  direction: 'long' | 'short' | 'neutral';
  confidence: number;
}

export function calculateWeightedComposite(
  factors: Factor[],
  overrides: Record<string, number> = {},
): Omit<FactorResult, 'factors' | 'omittedFactors'> {
  let weightedScore = 0;
  let totalWeight = 0;
  let positiveCount = 0;
  let negativeCount = 0;
  
  for (const factor of factors) {
    const weight = overrides[factor.category] ?? factor.weight;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    weightedScore += factor.score * weight;
    totalWeight += weight;
    if (factor.score > 0) positiveCount++;
    else if (factor.score < 0) negativeCount++;
  }

  const composite = totalWeight > 0 ? weightedScore / totalWeight : 0;
  const direction = composite > 1.5 ? 'long' : composite < -1.5 ? 'short' : 'neutral';
  
  // Confidence based on composite strength and factor consensus
  const factorConsensus = factors.length > 0 
    ? Math.max(positiveCount, negativeCount) / factors.length 
    : 0;
  const confidence = Math.min(100, Math.round(
    Math.abs(composite) * 12 + factorConsensus * 30
  ));
  
  return {
    composite,
    direction,
    confidence,
  };
}

function clampScore(v: number): number {
  return Math.max(-10, Math.min(10, v));
}

export function factorMomentum(candles: Array<{ close: number }>): Factor {
  const len = candles.length;
  if (len < 20) {
    return { category: 'momentum', label: '价格动量', score: 0, weight: 1, detail: '数据不足' };
  }
  
  const current = candles[len - 1].close;
  const prev5 = candles[len - 6]?.close || current;
  const prev20 = candles[len - 21]?.close || current;
  
  const change5d = (current - prev5) / prev5 * 100;
  const change20d = (current - prev20) / prev20 * 100;
  
  // If no price change, return neutral
  if (Math.abs(change5d) < 0.01 && Math.abs(change20d) < 0.01) {
    return { category: 'momentum', label: '价格动量', score: 0, weight: 1, detail: '价格平稳' };
  }
  
  let score = 0;
  // Short-term momentum (more responsive)
  if (change5d > 5) score += 4;
  else if (change5d > 3) score += 3;
  else if (change5d > 1) score += 2;
  else if (change5d > 0.5) score += 1;
  else if (change5d < -5) score -= 4;
  else if (change5d < -3) score -= 3;
  else if (change5d < -1) score -= 2;
  else if (change5d < -0.5) score -= 1;
  
  // Medium-term momentum
  if (change20d > 15) score += 3;
  else if (change20d > 10) score += 2;
  else if (change20d > 5) score += 1;
  else if (change20d < -15) score -= 3;
  else if (change20d < -10) score -= 2;
  else if (change20d < -5) score -= 1;
  
  return {
    category: 'momentum',
    label: '价格动量',
    score: clampScore(score),
    weight: 1,
    detail: `5日${change5d >= 0 ? '+' : ''}${change5d.toFixed(1)}%, 20日${change20d >= 0 ? '+' : ''}${change20d.toFixed(1)}%`,
  };
}

export function factorFundingRate(fundingRate: number): Factor {
  let score = 0;
  let detail = '';
  
  if (fundingRate > 0.001) {
    score = -3;
    detail = `费率偏高 ${(fundingRate * 100).toFixed(4)}%，做多成本高`;
  } else if (fundingRate > 0.0005) {
    score = -1;
    detail = `费率略高 ${(fundingRate * 100).toFixed(4)}%`;
  } else if (fundingRate < -0.001) {
    score = 3;
    detail = `费率偏低 ${(fundingRate * 100).toFixed(4)}%，做空成本高`;
  } else if (fundingRate < -0.0005) {
    score = 1;
    detail = `费率略低 ${(fundingRate * 100).toFixed(4)}%`;
  } else {
    score = 0;
    detail = `费率中性 ${(fundingRate * 100).toFixed(4)}%`;
  }
  
  return {
    category: 'funding',
    label: '资金费率',
    score: clampScore(score),
    weight: 0.8,
    detail,
  };
}

export function factorVolume(candles: Array<{ volume: number }>): Factor {
  const len = candles.length;
  if (len < 10) {
    return { category: 'volume', label: '成交量', score: 0, weight: 0.8, detail: '数据不足' };
  }
  
  const recentVol = candles.slice(-5).reduce((sum, c) => sum + c.volume, 0) / 5;
  const prevVol = candles.slice(-10, -5).reduce((sum, c) => sum + c.volume, 0) / 5;
  
  const volRatio = prevVol > 0 ? recentVol / prevVol : 1;
  
  let score = 0;
  if (volRatio > 2) score = 3;
  else if (volRatio > 1.5) score = 2;
  else if (volRatio > 1.2) score = 1;
  else if (volRatio < 0.5) score = -2;
  else if (volRatio < 0.8) score = -1;
  
  return {
    category: 'volume',
    label: '成交量',
    score: clampScore(score),
    weight: 0.8,
    detail: `量比 ${volRatio.toFixed(2)}`,
  };
}

export function factorVolatility(candles: Array<{ high: number; low: number }>): Factor {
  const len = candles.length;
  if (len < 14) {
    return { category: 'volatility', label: '波动率', score: 0, weight: 0.6, detail: '数据不足' };
  }
  
  // Calculate ATR
  const atrPeriod = 14;
  let atr = 0;
  for (let i = len - atrPeriod; i < len; i++) {
    const tr = candles[i].high - candles[i].low;
    atr += tr;
  }
  atr /= atrPeriod;
  
  const currentPrice = candles[len - 1].high;
  const atrPct = (atr / currentPrice) * 100;
  
  let score = 0;
  if (atrPct > 5) score = -3;
  else if (atrPct > 3) score = -2;
  else if (atrPct > 2) score = -1;
  else if (atrPct < 1) score = 1;
  
  return {
    category: 'volatility',
    label: '波动率',
    score: clampScore(score),
    weight: 0.6,
    detail: `ATR ${atrPct.toFixed(2)}%`,
  };
}

export function factorExchangeRate(krwUsd: number, prevKrwUsd: number): Factor {
  const change = ((krwUsd - prevKrwUsd) / prevKrwUsd) * 100;
  
  let score = 0;
  if (change > 1) score = -2;
  else if (change > 0.5) score = -1;
  else if (change < -1) score = 2;
  else if (change < -0.5) score = 1;
  
  return {
    category: 'fx',
    label: '汇率影响',
    score: clampScore(score),
    weight: 0.5,
    detail: `USD/KRW ${krwUsd.toFixed(2)} (${change >= 0 ? '+' : ''}${change.toFixed(2)}%)`,
  };
}

export function factorPremium(naverPrice: number, binancePrice: number, fxRate: number): Factor {
  if (!naverPrice || !binancePrice || !fxRate) {
    return { category: 'premium', label: '合约溢价', score: 0, weight: 0.7, detail: '数据不足' };
  }
  
  const naverUsd = naverPrice / fxRate;
  const premium = ((binancePrice - naverUsd) / naverUsd) * 100;
  
  let score = 0;
  // More granular scoring for large premiums
  if (premium > 5) score = 5;
  else if (premium > 3) score = 4;
  else if (premium > 2) score = 3;
  else if (premium > 1) score = 2;
  else if (premium > 0.5) score = 1;
  else if (premium < -5) score = -5;
  else if (premium < -3) score = -4;
  else if (premium < -2) score = -3;
  else if (premium < -1) score = -2;
  else if (premium < -0.5) score = -1;
  
  return {
    category: 'premium',
    label: '合约溢价',
    score: clampScore(score),
    weight: 0.7,
    detail: `${premium >= 0 ? '+' : ''}${premium.toFixed(2)}%`,
  };
}

export function factorIndicatorMomentum(rsi: number, macdHist: number): Factor {
  let score = 0;
  const details: string[] = [];
  
  // RSI
  if (rsi < 30) {
    score += 3;
    details.push('RSI超卖');
  } else if (rsi < 40) {
    score += 1;
    details.push('RSI偏低');
  } else if (rsi > 70) {
    score -= 3;
    details.push('RSI超买');
  } else if (rsi > 60) {
    score -= 1;
    details.push('RSI偏高');
  }
  
  // MACD
  if (macdHist > 0) {
    score += 2;
    details.push('MACD多头');
  } else if (macdHist < 0) {
    score -= 2;
    details.push('MACD空头');
  }
  
  return {
    category: 'indicator',
    label: '指标动量',
    score: clampScore(score),
    weight: 0.9,
    detail: details.join(', ') || '中性',
  };
}

export function factorSupportResistance(
  price: number,
  support: Array<{ price: number }>,
  resistance: Array<{ price: number }>
): Factor {
  let score = 0;
  const details: string[] = [];
  
  // Check proximity to support
  for (const s of support) {
    const distance = ((price - s.price) / price) * 100;
    if (distance < 2 && distance > 0) {
      score += 2;
      details.push(`接近支撑 ${s.price.toFixed(0)}`);
      break;
    }
  }
  
  // Check proximity to resistance
  for (const r of resistance) {
    const distance = ((r.price - price) / price) * 100;
    if (distance < 2 && distance > 0) {
      score -= 2;
      details.push(`接近阻力 ${r.price.toFixed(0)}`);
      break;
    }
  }
  
  return {
    category: 'structure',
    label: '结构位',
    score: clampScore(score),
    weight: 0.8,
    detail: details.join(', ') || '无明显结构位',
  };
}

export function factorLongShortRatio(longRatio: number): Factor {
  if (!longRatio) {
    return { category: 'lsRatio', label: '多空比', score: 0, weight: 0.7, detail: '数据不足' };
  }
  
  let score = 0;
  // Extreme long ratios are contrarian bearish signals
  if (longRatio > 5) score = -4;
  else if (longRatio > 3) score = -3;
  else if (longRatio > 2) score = -2;
  else if (longRatio > 1.5) score = -1;
  else if (longRatio < 0.3) score = 4;
  else if (longRatio < 0.5) score = 3;
  else if (longRatio < 0.67) score = 2;
  else if (longRatio < 0.8) score = 1;
  
  return {
    category: 'lsRatio',
    label: '多空比',
    score: clampScore(score),
    weight: 0.7,
    detail: `多空比 ${longRatio.toFixed(2)}`,
  };
}

export function factorTakerVolume(buyVol: number, sellVol: number): Factor {
  if (!buyVol || !sellVol) {
    return { category: 'takerVol', label: '主动买卖', score: 0, weight: 0.7, detail: '数据不足' };
  }
  
  const ratio = buyVol / sellVol;
  let score = 0;
  
  if (ratio > 1.5) score = 3;
  else if (ratio > 1.2) score = 2;
  else if (ratio > 1) score = 1;
  else if (ratio < 0.67) score = -3;
  else if (ratio < 0.83) score = -2;
  else if (ratio < 1) score = -1;
  
  return {
    category: 'takerVol',
    label: '主动买卖',
    score: clampScore(score),
    weight: 0.7,
    detail: `买卖比 ${ratio.toFixed(2)}`,
  };
}

export function factorOpenInterest(oiChange: number, priceChange: number): Factor {
  if (!oiChange && !priceChange) {
    return { category: 'openInterest', label: '持仓量', score: 0, weight: 0.6, detail: '数据不足' };
  }
  
  let score = 0;
  let direction = '';
  
  if (oiChange > 0 && priceChange > 0) {
    score = 2;
    direction = '增仓上涨';
  } else if (oiChange > 0 && priceChange < 0) {
    score = -2;
    direction = '增仓下跌';
  } else if (oiChange < 0 && priceChange > 0) {
    score = 1;
    direction = '减仓上涨(空头平仓)';
  } else if (oiChange < 0 && priceChange < 0) {
    score = -1;
    direction = '减仓下跌(多头平仓)';
  }
  
  return {
    category: 'openInterest',
    label: '持仓量',
    score: clampScore(score),
    weight: 0.6,
    detail: direction || '中性',
  };
}

export function factorLongShortTrend(sentimentRows: Array<{ ts: number; ls_ratio: number }>): Factor {
  if (!sentimentRows || sentimentRows.length < 2) {
    return { category: 'lsTrend', label: '多空趋势', score: 0, weight: 0.6, detail: '数据不足' };
  }
  
  const unique: typeof sentimentRows = [];
  const seen = new Set<number>();
  for (const r of sentimentRows) {
    const key = Math.floor(r.ts / 3600);
    if (!seen.has(key)) { seen.add(key); unique.push(r); }
  }
  if (unique.length < 2) {
    return { category: 'lsTrend', label: '多空趋势', score: 0, weight: 0.6, detail: '数据不足' };
  }
  
  const latest = unique[unique.length - 1].ls_ratio;
  const earliest = unique[0].ls_ratio;
  const trend = latest - earliest;
  const prevHour = unique.length >= 2 ? unique[unique.length - 2].ls_ratio : latest;
  const shortTrend = latest - prevHour;
  
  let score = 0;
  if (latest > 2.5 && shortTrend > 0.1) score = -3;
  else if (latest > 2 && shortTrend > 0.05) score = -2;
  else if (latest < 0.7 && shortTrend < -0.1) score = 3;
  else if (latest < 0.8 && shortTrend < -0.05) score = 2;
  else if (trend > 0.3) score = 1;
  else if (trend < -0.3) score = -1;
  else if (latest > 1.8) score = 1;
  else if (latest < 0.9) score = -1;
  
  const arrow = shortTrend > 0.05 ? '↑多' : shortTrend < -0.05 ? '↑空' : '→平';
  return {
    category: 'lsTrend',
    label: '多空趋势',
    score: clampScore(score),
    weight: 0.6,
    detail: `${unique.length}h趋势 ${arrow} | 比值 ${earliest.toFixed(2)} → ${latest.toFixed(2)}`,
  };
}

export function factorWhaleActivity(sentimentRows: Array<{ ts: number; top_ls_ratio: number }>): Factor {
  if (!sentimentRows || sentimentRows.length < 2) {
    return { category: 'whale', label: '庄家动向', score: 0, weight: 0.75, detail: '数据不足' };
  }
  
  const unique: typeof sentimentRows = [];
  const seen = new Set<number>();
  for (const r of sentimentRows) {
    const key = Math.floor(r.ts / 3600);
    if (!seen.has(key) && r.top_ls_ratio > 0) { seen.add(key); unique.push(r); }
  }
  if (unique.length < 2) {
    return { category: 'whale', label: '庄家动向', score: 0, weight: 0.75, detail: '数据不足' };
  }
  
  const latest = unique[unique.length - 1].top_ls_ratio;
  const earliest = unique[0].top_ls_ratio;
  const trend = latest - earliest;
  const prevHour = unique.length >= 2 ? unique[unique.length - 2].top_ls_ratio : latest;
  const shortTrend = latest - prevHour;
  
  // Whale long percentage for display
  const whaleLongPct = latest / (1 + latest) * 100;
  
  let score = 0;
  // Extreme whale positions with momentum
  if (whaleLongPct > 85 && shortTrend > 0.1) score = 3;
  else if (whaleLongPct > 80 && shortTrend > 0.05) score = 2;
  else if (whaleLongPct > 75) score = 1;
  else if (whaleLongPct < 25 && shortTrend < -0.1) score = -3;
  else if (whaleLongPct < 30 && shortTrend < -0.05) score = -2;
  else if (whaleLongPct < 35) score = -1;
  // Trend-based
  if (trend > 0.3 && whaleLongPct > 70) score += 1;
  else if (trend < -0.3 && whaleLongPct < 40) score -= 1;
  
  return {
    category: 'whale',
    label: '庄家动向',
    score: clampScore(score),
    weight: 0.75,
    detail: `大户 ${whaleLongPct.toFixed(0)}%多 | 短期${shortTrend > 0.05 ? '↑' : shortTrend < -0.05 ? '↓' : '→'} 24h${trend > 0.2 ? '↑' : trend < -0.2 ? '↓' : '→'}`,
  };
}

export function factorNewsSentiment(newsScore: number, positiveCount: number, negativeCount: number, topHeadline: string): Factor {
  if (!newsScore && !positiveCount && !negativeCount) {
    return { category: 'news', label: '新闻情绪', score: 0, weight: 0.5, detail: '暂无新闻数据' };
  }
  
  let score = 0;
  if (newsScore > 3) score = 3;
  else if (newsScore > 1) score = 2;
  else if (newsScore < -3) score = -3;
  else if (newsScore < -1) score = -2;
  else score = Math.round(newsScore);
  
  return {
    category: 'news',
    label: '新闻情绪',
    score: clampScore(score),
    weight: 0.5,
    detail: `正面${positiveCount}条 负面${negativeCount}条 | ${(topHeadline || '').slice(0, 30)}`,
  };
}

export function calculateAllFactors(params: {
  candles: Array<{ close: number; high: number; low: number; volume: number }>;
  fundingRate?: number;
  krwUsd: number;
  prevKrwUsd?: number;
  naverPrice: number;
  binancePrice?: number;
  fxRate: number;
  rsi: number;
  macdHist: number;
  support: Array<{ price: number }>;
  resistance: Array<{ price: number }>;
  longRatio?: number;
  buyVol?: number;
  sellVol?: number;
  oiChange?: number;
  priceChange?: number;
  sentimentRows?: Array<{ ts: number; ls_ratio: number; top_ls_ratio: number }>;
  newsScore?: number;
  newsPositive?: number;
  newsNegative?: number;
  newsTopHeadline?: string;
  weights?: Record<string, number>;
  hasRealVolume?: boolean;
}): FactorResult {
  const omittedFactors: FactorResult['omittedFactors'] = [];
  const factors: Factor[] = [
    factorMomentum(params.candles),
    factorVolatility(params.candles),
    factorIndicatorMomentum(params.rsi, params.macdHist),
    factorSupportResistance(params.candles[params.candles.length - 1]?.close || 0, params.support, params.resistance),
  ];

  if (params.prevKrwUsd !== undefined) {
    factors.push(factorExchangeRate(params.krwUsd, params.prevKrwUsd));
  } else {
    omittedFactors.push({ category: 'fx', reason: 'missing' });
  }

  if (params.fundingRate !== undefined) factors.push(factorFundingRate(params.fundingRate));
  else omittedFactors.push({ category: 'funding', reason: 'stale' });

  if (params.hasRealVolume) factors.push(factorVolume(params.candles));
  else omittedFactors.push({ category: 'volume', reason: 'unsupported' });

  if (params.binancePrice !== undefined) {
    factors.push(factorPremium(params.naverPrice, params.binancePrice, params.fxRate));
  } else {
    omittedFactors.push({ category: 'premium', reason: 'stale' });
  }
  
  if (params.longRatio) {
    factors.push(factorLongShortRatio(params.longRatio));
  }
  if (params.buyVol && params.sellVol) {
    factors.push(factorTakerVolume(params.buyVol, params.sellVol));
  }
  if (params.oiChange !== undefined && params.priceChange !== undefined) {
    factors.push(factorOpenInterest(params.oiChange, params.priceChange));
  }
  if (params.sentimentRows && params.sentimentRows.length > 0) {
    factors.push(factorLongShortTrend(params.sentimentRows));
    factors.push(factorWhaleActivity(params.sentimentRows));
  }
  if (params.newsScore !== undefined || params.newsPositive !== undefined) {
    factors.push(factorNewsSentiment(
      params.newsScore || 0,
      params.newsPositive || 0,
      params.newsNegative || 0,
      params.newsTopHeadline || '',
    ));
  }
  
  const { composite, direction, confidence } = calculateWeightedComposite(factors, params.weights);
  
  return {
    factors,
    omittedFactors,
    composite: Math.round(composite * 10) / 10,
    direction,
    confidence: Math.round(confidence),
  };
}
