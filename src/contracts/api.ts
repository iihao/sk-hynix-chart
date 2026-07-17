// src/contracts/api.ts
// API 响应类型契约 - 所有 API 端点的唯一响应类型

// ══════════════════════════════════════════════
//  Indicators Response
// ══════════════════════════════════════════════

export interface IndicatorsResponse {
  rsi: number[];
  macd: {
    dif: number[];
    dea: number[];
    histogram: number[];
  };
  bollinger: {
    upper: number[];
    mid: number[];
    lower: number[];
  };
  ma5: number[];
  ma20: number[];
  volRatio: number[];
  latest: {
    rsi: number;
    macdDif: number;
    macdDea: number;
    macdHist: number;
    volRatio: number;
    ma5: number;
    ma20: number;
    bollUpper: number;
    bollLower: number;
    macdState: 'bullish' | 'bearish' | 'neutral';
  };
  signals: Signal[];
  support: SupportResistance[];
  resistance: SupportResistance[];
  times: number[];
}

export interface Signal {
  type: 'buy' | 'sell' | 'golden_cross' | 'death_cross' | 'rsi_oversold' | 'rsi_overbought' | 'macd_golden' | 'macd_death' | 'boll_breakup' | 'boll_breakdown';
  label: string;
  direction: 'long' | 'short';
  time: number;
  strength?: number;
}

export interface SupportResistance {
  price: number;
  type: 'support' | 'resistance';
  strength: number;
}

// ══════════════════════════════════════════════
//  Factors Response
// ══════════════════════════════════════════════

export interface FactorsResponse {
  factors: Factor[];
  composite: number;
  direction: 'long' | 'short' | 'neutral';
  confidence: number;
}

export interface Factor {
  category: string;
  label: string;
  score: number;
  weight: number;
  detail: string;
}

// ══════════════════════════════════════════════
//  Strategy Response
// ══════════════════════════════════════════════

export interface StrategyResponse {
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
  regime: 'trend' | 'range' | 'event';
  regimeLabel: string;
  regimeReason: string;
  entryThresholdUsed: number;
  entryNote: string;
  riskOverlay: RiskOverlay;
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

// ══════════════════════════════════════════════
//  Backtest Response
// ══════════════════════════════════════════════

export interface BacktestResponse {
  trades: BacktestTrade[];
  metrics: BacktestMetrics;
  equityCurve: number[];
  weights: Record<string, number>;
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

// ══════════════════════════════════════════════
//  Calculator Response
// ══════════════════════════════════════════════

export interface CalculatorResponse {
  entryPrice: number;
  exitPrice: number;
  leverage: number;
  positionSize: number;
  margin: number;
  quantity: number;
  direction: 'long' | 'short';
  pnl: number;
  openFee: number;
  closeFee: number;
  totalFee: number;
  fundingCost: number;
  netPnl: number;
  roi: number;
  liquidationPrice: number;
  feeType: string;
  feeRate: number;
}

// ══════════════════════════════════════════════
//  Market Data Response
// ══════════════════════════════════════════════

export interface MarketDataResponse {
  m1: TimeframeData;
  m5: TimeframeData;
  m15: TimeframeData;
  h1: TimeframeData;
  source: string;
  krwUsd: number;
  serverTime: number;
  binance: {
    m1: BinanceTimeframeData;
    m5: BinanceTimeframeData;
    m15: BinanceTimeframeData;
    h1: BinanceTimeframeData;
  } | null;
}

export interface TimeframeData {
  source: string;
  candles: Candle[];
  meta: {
    currency: string;
    price: number;
    previousClose: number;
    exchangeName: string;
    marketOpen: boolean;
    nextOpen: string;
    marketTime: string;
    tickCount?: number;
    afterHours?: {
      price: number;
      prevClose: number;
      changePct: number;
      session: string;
      status: string;
      tradedAt: string;
    };
  };
}

export interface BinanceTimeframeData {
  line: Array<{ time: number; value: number }>;
  meta: {
    price: number;
    markPrice: number;
    indexPrice: number;
    fundingRate: number;
    nextFundingTime: number;
    high24h: number;
    low24h: number;
    volume24h: number;
  } | null;
  candles: Candle[];
  local?: boolean;
  tickCount?: number;
  fallback?: boolean;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ══════════════════════════════════════════════
//  Error Response
// ══════════════════════════════════════════════

export interface ErrorResponse {
  error: string;
  code?: string;
  details?: unknown;
}
