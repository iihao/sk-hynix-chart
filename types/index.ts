// types/index.ts

// ══════════════════════════════════════════════
//  Candle & Chart Types
// ══════════════════════════════════════════════

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface LinePoint {
  time: number;
  value: number;
}

export interface ChartMeta {
  currency: string;
  price: number;
  previousClose: number;
  exchangeName: string;
  marketOpen: boolean;
  nextOpen: string;
  marketTime: string;
  tickCount?: number;
  afterHours?: AfterHoursInfo;
}

export interface AfterHoursInfo {
  price: number;
  prevClose: number;
  changePct: number;
  session: string;
  status: string;
  tradedAt: string;
}

export interface ChartData {
  source: string;
  candles: Candle[];
  meta: ChartMeta;
}

// ══════════════════════════════════════════════
//  Binance Types
// ══════════════════════════════════════════════

export interface BinanceMeta {
  price: number;
  markPrice: number;
  indexPrice: number;
  fundingRate: number;
  nextFundingTime: number;
  high24h: number;
  low24h: number;
  volume24h: number;
}

export interface BinanceLineData {
  line: LinePoint[];
  meta: BinanceMeta | null;
  candles: Candle[];
  local?: boolean;
  tickCount?: number;
  fallback?: boolean;
}

export interface BinancePriceResponse {
  price: number;
  markPrice: number;
  indexPrice: number;
  fundingRate: number;
  nextFundingTime: number;
}

// ══════════════════════════════════════════════
//  Calculator Types
// ══════════════════════════════════════════════

export interface CalculatorParams {
  entryPrice: number;
  exitPrice: number;
  leverage: number;
  positionSize: number;
  direction: 'long' | 'short';
  feeType: 'maker' | 'taker';
  fundingRate: number;
  fundingCount: number;
}

export interface CalculatorResult {
  entryPrice: number;
  exitPrice: number;
  leverage: number;
  positionSize: number;
  margin: number;
  quantity: number;
  direction: string;
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
//  Data Source Types
// ══════════════════════════════════════════════

export interface NaverBasic {
  price: number;
  prevClose: number;
  marketOpen: boolean;
  afterHours: AfterHoursInfo | null;
}

export interface TickData {
  ts: number;
  price: number;
  prev_close: number;
  market_open: number;
  after_hours_price: number | null;
  after_hours_session: string | null;
}

export interface BinanceTickData {
  ts: number;
  price: number;
  mark_price: number;
  index_price: number;
  funding_rate: number;
  high_24h: number;
  low_24h: number;
  volume_24h: number;
}

// ══════════════════════════════════════════════
//  API Response Types
// ══════════════════════════════════════════════

export interface ApiResponse {
  m1: ChartData;
  m5: ChartData;
  m15: ChartData;
  h1: ChartData;
  source: string;
  krwUsd: number;
  serverTime: number;
  binance: {
    m1: BinanceLineData;
    m5: BinanceLineData;
    m15: BinanceLineData;
    h1: BinanceLineData;
  } | null;
  fallbackFrom?: string;
}

export interface TickStats {
  naver: {
    count: number;
    latest: TickData | null;
  };
  binance: {
    count: number;
    latest: BinanceTickData | null;
  };
}

// ══════════════════════════════════════════════
//  Factor & Signal Types
// ══════════════════════════════════════════════

export interface Factor {
  name: string;
  score: number;
  weight: number;
  detail: string;
}

export interface Signal {
  type: 'long' | 'short' | 'risk' | 'opportunity';
  label: string;
  time: string;
  description: string;
}

export interface DirectionResult {
  direction: 'long' | 'short' | 'neutral';
  score: number;
  confidence: number;
  reason: string;
}

// ══════════════════════════════════════════════
//  Database Types
// ══════════════════════════════════════════════

export interface DatabaseTick {
  ts: number;
  price: number;
  prev_close: number | null;
  market_open: number;
  after_hours_price: number | null;
  after_hours_session: string | null;
}

export interface DatabaseBinanceTick {
  ts: number;
  price: number;
  mark_price: number | null;
  index_price: number | null;
  funding_rate: number | null;
  high_24h: number | null;
  low_24h: number | null;
  volume_24h: number | null;
}
