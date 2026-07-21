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
  } | null;
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
  rawConfidence?: number;
  strategy?: StrategyResponse;
  backtestCalibration?: BacktestCalibration;
  confidenceCalibration?: SignalConfidenceCalibration;
  timeframeProfile?: TimeframeProfileState;
}

export interface TimeframeProfileState {
  tf: 'm1' | 'm5' | 'm15' | 'h1' | string;
  label: string;
  role: 'scalp' | 'trade' | 'confirm' | string;
  decisionWeight: number;
  minSampleTrades: number;
  params: Record<string, number>;
  calibration: BacktestCalibration;
  optimizeTime: string | null;
}

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
  penalties: string[];
  note: string;
  debug?: {
    rawScore: number;
    backtestScore: number;
    sampleScore: number;
    performanceScore: number;
    drawdownScore: number;
    sharpeScore: number;
    factorScore: number;
    indicatorScore: number;
    signalBonus: number;
    penaltyDetails: Array<{ type: string; reason: string; impact: number }>;
    formula: string;
  };
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
  /** 新手友好的操作建议 (因子驱动) */
  advice: OperationAdvice;
}

export interface OperationAdvice {
  action: string;
  signalStrength: string;
  confidence: number;
  reason: string;
  entry: {
    text: string;
    price: number;
    condition?: string;
  };
  exit: {
    takeProfit: string;
    takeProfitPrice: number;
    stopLoss: string;
    stopLossPrice: number;
    riskReward: string;
  };
  position: {
    pct: number;
    leverage: string;
    text: string;
  };
  warnings: string[];
  drivers?: Array<{
    category: string;
    label: string;
    score: number;
    contribution: string;
  }>;
  decisionTrace?: DecisionTrace;
}

export interface DecisionTrace {
  raw: {
    direction: 'long' | 'short' | 'neutral';
    composite: number;
    confidence: number;
    consensusPct: number;
    summary: string;
    topDrivers: OperationAdvice['drivers'];
  };
  technical: {
    verdict: 'confirm' | 'diverge' | 'neutral' | 'unknown';
    agreementPct: number;
    summary: string;
    checks: string[];
  };
  impact: {
    verdict: 'supportive' | 'conflicting' | 'neutral';
    summary: string;
    drivers: OperationAdvice['drivers'];
  };
  backtest: {
    verdict: 'tradable' | 'weak' | 'insufficient';
    probability: number;
    sampleTrades: number;
    winRate: number;
    totalReturn: number;
    maxDrawdown: number;
    sharpe: number;
    summary: string;
  };
  final: {
    action: string;
    originalDirection: 'long' | 'short' | 'neutral';
    finalDirection: 'long' | 'short' | 'neutral';
    directionOverridden: boolean;
    overrideReason: string;
    confidence: number;
    summary: string;
    blockers: string[];
  };
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
  params?: {
    tf: string;
    entryThreshold: number;
    holdBars: number;
    stopLossPct: number;
    takeProfitPct: number;
    leverage: number;
    optimize?: boolean;
  };
  trades: BacktestTrade[];
  metrics: BacktestMetrics | null;
  equityCurve: number[] | Array<{ time: number; equity: number }>;
  factorHistory?: unknown[];
  activeWeights?: Record<string, number>;
  activeParams?: Record<string, number>;
  timeframeProfile?: TimeframeProfileState;
  activeProfiles?: Record<string, TimeframeProfileState>;
  optimizedWeights?: Record<string, number>;
  weights?: Record<string, number>;
  error?: string;
}

export interface BacktestTrade {
  entryTime: number;
  exitTime: number;
  direction: 'long' | 'short';
  entry?: number;
  exit?: number;
  entryPrice?: number;
  exitPrice?: number;
  pnl: number;
  pnlPct: number;
  exitReason: string;
  bars?: number;
  positionSizePct?: number;
  sl?: number;
  tp?: number;
}

export interface BacktestMetrics {
  totalReturn: number;
  winRate: number;
  profitFactor: number;
  sharpe?: number;
  sharpeRatio?: number;
  maxDrawdown: number;
  totalTrades: number;
  avgHoldBars?: number;
  avgWin: number;
  avgLoss: number;
  expectancy?: number;
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
  fundingPnl?: number;
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

// ══════════════════════════════════════════════
//  Data Quality Response
// ══════════════════════════════════════════════

export interface CollectorQuality {
  key: string;
  state: 'starting' | 'healthy' | 'degraded' | 'open' | 'half-open' | 'stopped';
  transport: 'direct' | 'proxy' | 'local' | 'none';
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  nextRetryAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface SourceQuality {
  key: string;
  label?: string;
  status: 'ok' | 'idle' | 'stale' | 'missing';
  updatedAt?: string | null;
  ageSec: number | null;
  ageLabel?: string;
  staleAfterSec?: number;
  expectedActive: boolean;
  detail: string;
}

export interface QualityResponse {
  serverTime: number;
  overall: 'healthy' | 'degraded' | 'unavailable';
  collectors: CollectorQuality[];
  sources: SourceQuality[];
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
