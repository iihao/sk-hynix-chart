import express, { Request, Response } from 'express';
import https from 'https';
import http from 'http';
import tls from 'tls';
import path from 'path';
import Database from 'better-sqlite3';
import {
  buildFactorCoverage,
  getTimeframeConfig,
  mergeSentimentHistory,
  normalizeTimeframe,
  parseGoogleNewsRss,
  scoreOpenInterestSignal,
} from './lib/factor-support';
import {
  alignBasisSeries,
  buildRiskOverlay,
  computeBasisSnapshot,
  deriveRegime,
  getEventWindow,
  getFundingCountdown,
  getKoreaSessionState,
} from './lib/trading-context';
import {
  Candle,
  ChartData,
  BinanceMeta,
  BinanceLineData,
  CalculatorParams,
  CalculatorResult,
  NaverBasic,
  TickData,
  BinanceTickData,
  ApiResponse,
  TickStats,
} from './types';

// Domain modules
import {
  calculateAllIndicators,
  IndicatorsData,
  IndicatorResult,
  Signal,
  SupportResistance,
} from './src/domain/indicators';
import {
  calculateAllFactors,
  Factor,
  FactorResult,
} from './src/domain/factors';
import {
  generateStrategy,
  Strategy,
  RiskOverlay,
  Regime,
} from './src/domain/strategy';
import {
  backtestEngine,
  backtestWithOptimization,
  optimizeWeights,
  BacktestParams,
  BacktestResult,
  BacktestBinanceTick,
  BacktestSentimentRow,
  BacktestMetrics,
} from './src/domain/backtest';
import {
  buildBacktestCalibration,
  calibrateSignalConfidence,
  BacktestCalibration,
} from './src/domain/calibration';
import {
  createInitialTimeframeStates,
  getTimeframeProfile,
  normalizeProfileTimeframe,
  summarizeTimeframeState,
  TimeframeKey,
  TimeframeState,
} from './src/domain/timeframe-profile';
import {
  DashboardSnapshot,
  isCompleteDashboardSnapshot,
  mergeBinanceIntoSnapshot,
} from './src/contracts/stream';
import { parseBacktestParams } from './src/contracts/params';
import { calculateContract, ContractValidationError } from './src/domain/contract';
import {
  closePaperPosition,
  findTriggeredExit,
  openPaperPosition,
  PaperTradeValidationError,
  summarizePaperAccount,
  PaperAccountState,
  PaperPosition,
  PaperFill,
  PaperDirection,
} from './src/domain/paper-trading';
import { buildContinuousSpotCandles, buildSpotCandles } from './src/domain/candles';
import { canRecordSpotTick, classifyObservationAge } from './src/domain/market-quality';
import { buildLevelGroups } from './src/domain/levels';
import { createCircuitBreaker } from './src/infrastructure/circuit-breaker';
import { createCollectorRuntime } from './src/infrastructure/collector-runtime';
import { createBinanceTransport } from './src/infrastructure/binance-transport';
import { createScheduler } from './src/infrastructure/scheduler';
import { createShutdownCoordinator } from './src/infrastructure/shutdown';
// ══════════════════════════════════════════
//  Project Root & Data Directory
// ══════════════════════════════════════════
const PROJECT_ROOT = process.cwd();
const DATA_DIR = process.env.DATA_DIR || PROJECT_ROOT;

console.log(`[config] PROJECT_ROOT: ${PROJECT_ROOT}`);
console.log(`[config] DATA_DIR: ${DATA_DIR}`);

const app = express();
const PORT: number = Number(process.env.PORT || 3456);
const SYMBOL: string = '000660.KS';
const scheduler = createScheduler();
const NAVER_CODE: string = '000660';
const KRW_USD_DEFAULT: number = 1544;
let krwUsdRate: number = KRW_USD_DEFAULT;
let insertFxTick: any = null;

function storeFxObservation(rate: number, source: string): void {
  if (!insertFxTick || !Number.isFinite(rate) || rate <= 0) return;
  insertFxTick.run(Math.floor(Date.now() / 1000), null, null, rate, source);
}
const FACTOR_DEFS = [
  { category: 'momentum', label: '价格动量' },
  { category: 'funding', label: '资金费率' },
  { category: 'volume', label: '成交量' },
  { category: 'volatility', label: '波动率' },
  { category: 'fx', label: '汇率影响' },
  { category: 'premium', label: '合约溢价' },
  { category: 'indicator', label: '指标动量' },
  { category: 'structure', label: '结构位' },
  { category: 'lsRatio', label: '多空比' },
  { category: 'takerVol', label: '主动买卖' },
  { category: 'openInterest', label: '持仓量' },
  { category: 'lsTrend', label: '多空趋势' },
  { category: 'whale', label: '庄家动向' },
  { category: 'news', label: '新闻情绪' },
];

interface SourceMeta {
  label: string;
  staleAfterSec: number;
  expectedActive: () => boolean;
}

interface SourceRuntime extends SourceMeta {
  updatedAt: number;
  detail: string;
}

const SOURCE_META: Record<string, SourceMeta> = {
  naver: { label: '现货', staleAfterSec: 180, expectedActive: () => isMarketOpen() || isPreMarket() || isAfterHours() },
  binance: { label: '合约', staleAfterSec: 120, expectedActive: () => true },
  sentiment: { label: '情绪', staleAfterSec: 7200, expectedActive: () => true },
  fx: { label: '汇率', staleAfterSec: 10800, expectedActive: () => true },
  news: { label: '新闻', staleAfterSec: 86400, expectedActive: () => true },
};

const sourceRuntime: Record<string, SourceRuntime> = Object.fromEntries(
  Object.entries(SOURCE_META).map(([key, meta]) => [key, { ...meta, updatedAt: 0, detail: '' }]),
);

function markSourceHealthy(key: string, updates: Partial<SourceRuntime> = {}): void {
  if (!sourceRuntime[key]) return;
  Object.assign(sourceRuntime[key], updates);
}

function formatAgeShort(ageSec: number | null | undefined): string {
  if (ageSec == null || !Number.isFinite(ageSec)) return '--';
  if (ageSec < 60) return `${ageSec}s`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m`;
  if (ageSec < 86400) return `${Math.round(ageSec / 3600)}h`;
  return `${Math.round(ageSec / 86400)}d`;
}

// Fetch real-time KRW/USD exchange rate (updates hourly)
// Primary: Naver Finance (Highly reliable for KRW)
// Fallbacks: frankfurter.app, open.er-api.com
async function fetchExchangeRate() {
  // Try Naver Finance first
  try {
    const data = await fetchJSON('https://m.stock.naver.com/front-api/marketIndex/prices?category=exchange&reutersCode=FX_USDKRW');
    if (data && data.isSuccess && data.result && data.result.length > 0) {
      const priceStr = data.result[0].closePrice.replace(/,/g, '');
      const rate = parseFloat(priceStr);
      if (!isNaN(rate)) {
        krwUsdRate = Math.round(rate * 100) / 100;
        markSourceHealthy('fx', { updatedAt: Date.now(), detail: `USD/KRW ${krwUsdRate}` });
        storeFxObservation(krwUsdRate, 'naver');
        console.log(`[FX] USD/KRW = ${krwUsdRate} (Naver)`);
        return;
      }
    }
  } catch (e) {
    console.error(`[FX] Naver failed: ${e.message}`);
  }
  // Fallback 1: frankfurter.app (ECB data)
  try {
    const data = await fetchJSON('https://api.frankfurter.dev/v1/latest?from=USD&to=KRW');
    if (data && data.rates && data.rates.KRW) {
      krwUsdRate = Math.round(data.rates.KRW * 100) / 100; // Keep 2 decimals
      markSourceHealthy('fx', { updatedAt: Date.now(), detail: `USD/KRW ${krwUsdRate}` });
      storeFxObservation(krwUsdRate, 'frankfurter');
      console.log(`[FX] USD/KRW = ${krwUsdRate} (frankfurter/ECB)`);
      return;
    }
  } catch (e) {
    console.error(`[FX] frankfurter failed: ${e.message}`);
  }
  // Fallback 2: open.er-api.com
  try {
    const data = await fetchJSON('https://open.er-api.com/v6/latest/USD');
    if (data && data.result === 'success' && data.rates && data.rates.KRW) {
      krwUsdRate = Math.round(data.rates.KRW * 100) / 100;
      markSourceHealthy('fx', { updatedAt: Date.now(), detail: `USD/KRW ${krwUsdRate}` });
      storeFxObservation(krwUsdRate, 'open-er-api');
      console.log(`[FX] USD/KRW = ${krwUsdRate} (open.er-api fallback)`);
    }
  } catch (e) {
    console.error(`[FX] open.er-api failed: ${e.message}, using cached ${krwUsdRate}`);
  }
}
app.use(express.static(path.join(PROJECT_ROOT, 'public')));

// ══════════════════════════════════════════
//  SQLite: tick storage
// ══════════════════════════════════════════
const DB_PATH = path.join(DATA_DIR, 'ticks.db');
console.log(`[config] Database path: ${DB_PATH}`);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS ticks (
    ts      INTEGER PRIMARY KEY,  -- unix seconds
    price   INTEGER NOT NULL,
    prev_close INTEGER,
    market_open INTEGER DEFAULT 0,
    after_hours_price INTEGER,
    after_hours_session TEXT
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS fx_ticks (
    ts INTEGER PRIMARY KEY,
    bid REAL,
    ask REAL,
    mid REAL NOT NULL,
    source TEXT NOT NULL
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS paper_account (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    initial_balance REAL NOT NULL,
    available_balance REAL NOT NULL,
    realized_pnl REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS paper_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL,
    entry_price REAL NOT NULL,
    quantity REAL NOT NULL,
    leverage REAL NOT NULL,
    margin REAL NOT NULL,
    notional REAL NOT NULL,
    take_profit_price REAL,
    stop_loss_price REAL,
    opened_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    closed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS paper_fills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id INTEGER,
    type TEXT NOT NULL,
    direction TEXT NOT NULL,
    price REAL NOT NULL,
    quantity REAL NOT NULL,
    notional REAL NOT NULL,
    fee REAL NOT NULL,
    realized_pnl REAL NOT NULL,
    balance_after REAL NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS signals_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_type TEXT NOT NULL,
    label TEXT NOT NULL,
    direction TEXT NOT NULL,
    time INTEGER NOT NULL,
    strength INTEGER DEFAULT 1,
    tf TEXT NOT NULL DEFAULT '5m',
    created_at INTEGER NOT NULL,
    UNIQUE(signal_type, time, tf)
  );
  CREATE INDEX IF NOT EXISTS idx_signals_tf_time ON signals_history(tf, time DESC);
`);
db.prepare(`
  INSERT OR IGNORE INTO paper_account (id, initial_balance, available_balance, realized_pnl, updated_at)
  VALUES (1, 10000, 10000, 0, ?)
`).run(Math.floor(Date.now() / 1000));
insertFxTick = db.prepare('INSERT OR REPLACE INTO fx_ticks (ts, bid, ask, mid, source) VALUES (?, ?, ?, ?, ?)');
const selectFxRange = db.prepare('SELECT ts, bid, ask, mid, source FROM fx_ticks WHERE ts >= ? AND ts <= ? ORDER BY ts');
const selectFxAtOrBefore = db.prepare('SELECT ts, bid, ask, mid, source FROM fx_ticks WHERE ts <= ? ORDER BY ts DESC LIMIT 1');
fetchExchangeRate();
scheduler.setInterval(fetchExchangeRate, 3600000);
// Migration: add columns if they don't exist (for existing DBs)
try { db.exec('ALTER TABLE ticks ADD COLUMN after_hours_price INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE ticks ADD COLUMN after_hours_session TEXT'); } catch(e) {}

// WAL checkpoint: prevent WAL file from growing unbounded
function walCheckpoint() {
  try {
    const result = db.pragma('wal_checkpoint(RESTART)');
    if (result[0].busy || result[0].log) {
      console.log(`[wal] checkpoint: busy=${result[0].busy} log=${result[0].log} pages=${result[0].checkpointed}`);
    }
  } catch (e) {
    console.error('[wal] checkpoint error:', e.message);
  }
}
// Checkpoint on startup, then every 5 minutes
walCheckpoint();
scheduler.setInterval(walCheckpoint, 300000);

// Prepared statements
const insertTick = db.prepare('INSERT OR REPLACE INTO ticks (ts, price, prev_close, market_open, after_hours_price, after_hours_session) VALUES (?, ?, ?, ?, ?, ?)');
const selectRange = db.prepare('SELECT ts, price, prev_close, market_open, after_hours_price, after_hours_session FROM ticks WHERE ts >= ? AND ts <= ? ORDER BY ts');
const selectLatest = db.prepare('SELECT ts, price, prev_close, market_open, after_hours_price, after_hours_session FROM ticks ORDER BY ts DESC LIMIT 1');
const countTicks = db.prepare('SELECT COUNT(*) as cnt FROM ticks');
const countAfterHours = db.prepare('SELECT COUNT(*) as cnt FROM ticks WHERE after_hours_price IS NOT NULL');
const selectPaperAccount = db.prepare('SELECT * FROM paper_account WHERE id = 1');
const updatePaperAccount = db.prepare('UPDATE paper_account SET initial_balance = ?, available_balance = ?, realized_pnl = ?, updated_at = ? WHERE id = 1');
const selectOpenPaperPositions = db.prepare('SELECT * FROM paper_positions WHERE status = ? ORDER BY opened_at DESC, id DESC');
const selectPaperPositionById = db.prepare('SELECT * FROM paper_positions WHERE id = ? AND status = ?');
const insertPaperPosition = db.prepare(`INSERT INTO paper_positions
  (direction, entry_price, quantity, leverage, margin, notional, take_profit_price, stop_loss_price, opened_at, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`);
const closePaperPositionStmt = db.prepare('UPDATE paper_positions SET status = ?, closed_at = ? WHERE id = ?');
const insertPaperFill = db.prepare(`INSERT INTO paper_fills
  (position_id, type, direction, price, quantity, notional, fee, realized_pnl, balance_after, reason, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const selectPaperFills = db.prepare('SELECT * FROM paper_fills ORDER BY created_at DESC, id DESC LIMIT ?');

// Signals history prepared statements
const insertSignal = db.prepare('INSERT OR IGNORE INTO signals_history (signal_type, label, direction, time, strength, tf, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
const selectSignalsByTf = db.prepare('SELECT signal_type, label, direction, time, strength FROM signals_history WHERE tf = ? ORDER BY time DESC LIMIT ?');
const selectRecentSignals = db.prepare('SELECT signal_type, label, direction, time, strength FROM signals_history WHERE tf = ? AND time >= ? ORDER BY time DESC');

function roundNumber(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function getPaperAccount(): PaperAccountState {
  const row = selectPaperAccount.get() as any;
  return {
    initialBalance: Number(row.initial_balance),
    availableBalance: Number(row.available_balance),
    realizedPnl: Number(row.realized_pnl),
  };
}

function savePaperAccount(account: PaperAccountState): void {
  updatePaperAccount.run(
    account.initialBalance,
    account.availableBalance,
    account.realizedPnl,
    Math.floor(Date.now() / 1000),
  );
}

function mapPaperPosition(row: any): PaperPosition {
  return {
    id: Number(row.id),
    direction: row.direction as PaperDirection,
    entryPrice: Number(row.entry_price),
    quantity: Number(row.quantity),
    leverage: Number(row.leverage),
    margin: Number(row.margin),
    notional: Number(row.notional),
    takeProfitPrice: row.take_profit_price == null ? null : Number(row.take_profit_price),
    stopLossPrice: row.stop_loss_price == null ? null : Number(row.stop_loss_price),
    openedAt: Number(row.opened_at),
  };
}

function mapPaperFill(row: any) {
  return {
    id: Number(row.id),
    positionId: row.position_id == null ? null : Number(row.position_id),
    type: row.type,
    direction: row.direction,
    price: Number(row.price),
    quantity: Number(row.quantity),
    notional: Number(row.notional),
    fee: Number(row.fee),
    realizedPnl: Number(row.realized_pnl),
    balanceAfter: Number(row.balance_after),
    reason: row.reason,
    createdAt: Number(row.created_at),
  };
}

function savePaperFill(fill: PaperFill, positionId: number | null): void {
  insertPaperFill.run(
    positionId,
    fill.type,
    fill.direction,
    fill.price,
    fill.quantity,
    fill.notional,
    fill.fee,
    fill.realizedPnl,
    fill.balanceAfter,
    fill.reason,
    fill.createdAt,
  );
}

function readOpenPaperPositions(): PaperPosition[] {
  return (selectOpenPaperPositions.all('OPEN') as any[]).map(mapPaperPosition);
}

function latestPaperMarkPrice(): number {
  const latest = selectBinanceLatest.get() as any;
  return Number(latest?.mark_price || latest?.price || 0);
}

async function getPaperMarkPrice(): Promise<number> {
  const local = latestPaperMarkPrice();
  if (Number.isFinite(local) && local > 0) return local;
  const meta = await binanceMetaWithFallback();
  return Number((meta as any).markPrice || (meta as any).price || 0);
}

async function buildPaperSummary(markPriceInput?: number) {
  const markPrice = Number(markPriceInput) > 0 ? Number(markPriceInput) : await getPaperMarkPrice();
  const account = getPaperAccount();
  const positions = readOpenPaperPositions();
  const summary = summarizePaperAccount(account, positions, markPrice);
  return {
    ...summary,
    fills: (selectPaperFills.all(20) as any[]).map(mapPaperFill),
    serverTime: Date.now(),
  };
}

function parseOptionalPositive(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

function paperError(res: Response, err: any): void {
  const message = err instanceof Error ? err.message : String(err);
  const status = err instanceof PaperTradeValidationError ? 400 : 500;
  res.status(status).json({ error: { code: status === 400 ? 'PAPER_VALIDATION_ERROR' : 'PAPER_ERROR', message } });
}

function fetchJSON<T = any>(url: string, useEnvironmentProxy = true): Promise<T> {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

  if (useEnvironmentProxy && proxyUrl && url.startsWith('https://')) {
    return fetchJSONViaProxy<T>(url, proxyUrl);
  }

  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${data.slice(0, 100)}`)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function fetchJSONViaProxy<T = any>(url: string, proxyUrl: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const proxyParsed = new URL(proxyUrl);
    const proxyPort = parseInt(proxyParsed.port) || (proxyParsed.protocol === 'https:' ? 443 : 80);

    const connectReq = http.request({
      host: proxyParsed.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${parsed.hostname}:443`,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
        return;
      }
      const tlsSocket = tls.connect({
        socket,
        servername: parsed.hostname,
      }, () => {
        const reqPath = parsed.pathname + parsed.search;
        const reqStr = `GET ${reqPath} HTTP/1.1\r\nHost: ${parsed.hostname}\r\nUser-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36\r\nConnection: close\r\n\r\n`;
        tlsSocket.write(reqStr);

        let responseData = '';
        tlsSocket.on('data', chunk => { responseData += chunk.toString(); });
        tlsSocket.on('end', () => {
          const headerEnd = responseData.indexOf('\r\n\r\n');
          if (headerEnd === -1) { reject(new Error('Invalid proxy response')); return; }
          const headers = responseData.slice(0, headerEnd);
          const body = responseData.slice(headerEnd + 4);
          const statusMatch = headers.match(/HTTP\/\d\.\d (\d+)/);
          if (!statusMatch) { reject(new Error('No status code')); return; }
          const statusCode = parseInt(statusMatch[1]);
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`HTTP ${statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`JSON parse: ${body.slice(0, 100)}`)); }
        });
        tlsSocket.on('error', reject);
      });
      tlsSocket.on('error', reject);
    });

    connectReq.on('error', reject);
    connectReq.setTimeout(10000, () => { connectReq.destroy(); reject(new Error('proxy timeout')); });
    connectReq.end();
  });
}

async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 2000): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw new Error('unreachable');
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        resolve(data);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Market hours (Beijing time UTC+8) ──
function isMarketOpen() {
  const bj = new Date(Date.now() + 8 * 3600000);
  const day = bj.getUTCDay();
  if (day === 0 || day === 6) return false;
  const t = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  // Korean market: 09:00-15:30 KST = 08:00-14:30 Beijing
  return t >= 480 && t <= 870;
}

function isPreMarket() {
  const bj = new Date(Date.now() + 8 * 3600000);
  const day = bj.getUTCDay();
  if (day === 0 || day === 6) return false;
  const t = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  // Pre-market: 08:00-09:00 KST = 07:00-08:00 Beijing
  return t >= 420 && t < 480;
}

function isAfterHours() {
  const bj = new Date(Date.now() + 8 * 3600000);
  const day = bj.getUTCDay();
  if (day === 0 || day === 6) return false;
  const t = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  // After-hours: 15:30-18:00 KST = 14:30-17:00 Beijing
  return t > 870 && t <= 1020;
}

function getNextOpenTime() {
  const bj = new Date(Date.now() + 8 * 3600000); // Beijing time (UTC+8)
  let daysToAdd = 0;
  const day = bj.getUTCDay();
  const t = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  // Beijing 9:00-15:30 = KRX 9:00-15:30 (same as KST-1)
  // Beijing 9:00 = KST 10:00, Beijing 15:30 = KST 16:30
  // Korean market: 09:00-15:30 KST = 08:00-14:30 Beijing
  if (day === 0) daysToAdd = 1;
  else if (day === 6) daysToAdd = 2;
  else if (t >= 840) daysToAdd = day === 5 ? 3 : 1; // After 14:00 Beijing
  const next = new Date(bj);
  next.setUTCDate(next.getUTCDate() + daysToAdd);
  next.setUTCHours(8, 0, 0, 0); // 08:00 Beijing = 09:00 KST
  return next.toISOString().replace('T', ' ').slice(0, 16) + ' 北京时间';
}

function metaCommon() {
  return { marketOpen: isMarketOpen(), nextOpen: getNextOpenTime(), marketTime: new Date().toISOString() };
}

function getSourceHealthSnapshot() {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const sentimentStats = sentimentCoverageStats.get(nowSec - 86400, nowSec);
  return Object.entries(sourceRuntime).map(([key, meta]) => {
    const expectedActive = typeof meta.expectedActive === 'function' ? meta.expectedActive() : true;
    const ageSec = meta.updatedAt ? Math.max(0, Math.round((nowMs - meta.updatedAt) / 1000)) : null;
    let status = expectedActive ? 'missing' : 'idle';
    if (meta.updatedAt) {
      status = expectedActive ? (ageSec <= meta.staleAfterSec ? 'ok' : 'stale') : 'idle';
    }

    let detail = meta.detail || '';
    if (key === 'sentiment' && sentimentStats) {
      detail = `${Math.min((sentimentStats as any).hours || 0, 24)}/24h`;
    }

    return {
      key,
      label: meta.label,
      status,
      updatedAt: meta.updatedAt ? new Date(meta.updatedAt).toISOString() : null,
      ageSec,
      ageLabel: ageSec == null ? '--' : formatAgeShort(ageSec),
      detail,
      staleAfterSec: meta.staleAfterSec,
      expectedActive,
    };
  });
}

// ══════════════════════════════════════════
//  Data Source: Yahoo Finance (query2)
// ══════════════════════════════════════════
async function yahooChart(interval, range) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${SYMBOL}?interval=${interval}&range=${range}&includePrePost=false`;
  const data = await fetchJSON(url);
  if (!data.chart?.result?.[0]) throw new Error('Yahoo: no data');
  const r = data.chart.result[0];
  const ts = r.timestamp || [];
  const q = r.indicators.quote[0];
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.open[i] != null && q.close[i] != null && q.high[i] != null && q.low[i] != null) {
      candles.push({ time: ts[i], open: Math.round(q.open[i]), high: Math.round(q.high[i]), low: Math.round(q.low[i]), close: Math.round(q.close[i]), volume: q.volume[i] || 0 });
    }
  }
  return {
    source: 'yahoo',
    candles,
    meta: { currency: r.meta.currency || 'KRW', price: r.meta.regularMarketPrice || 0, previousClose: r.meta.chartPreviousClose || r.meta.previousClose || 0, exchangeName: 'KOSPI', ...metaCommon() }
  };
}

// ══════════════════════════════════════════
//  Data Source: Naver Finance (real-time + SQLite)
// ══════════════════════════════════════════
async function naverBasic() {
  const data = await fetchJSON(`https://m.stock.naver.com/api/stock/${NAVER_CODE}/basic`);
  const price = parseInt((data.closePrice || '0').replace(/,/g, ''));
  const changeRaw = parseInt((data.compareToPreviousClosePrice || '0').replace(/,/g, '').replace(/^-/, ''));
  const isFall = data.compareToPreviousPrice?.name === 'FALLING';
  const prevClose = isFall ? price + changeRaw : price - changeRaw;
  const marketOpen = data.marketStatus === 'OPEN';

  // After-hours / OTC data — capture even after session closes (price persists)
  const omi = data.overMarketPriceInfo;
  let afterHours = null;
  if (omi && omi.overPrice && omi.overPrice !== '0') {
    const ohPrice = parseInt((omi.overPrice || '0').replace(/,/g, ''));
    // Use regular session prevClose as base — compareToPreviousClosePrice is daily change,
    // not after-hours change, so we calculate change from prevClose directly
    const ohChangePct = prevClose ? ((ohPrice - prevClose) / prevClose * 100) : 0;
    afterHours = {
      price: ohPrice,
      prevClose: prevClose,
      changePct: Math.round(ohChangePct * 100) / 100,
      session: omi.tradingSessionType || 'AFTER_MARKET',
      status: omi.overMarketStatus || 'CLOSE',
      tradedAt: omi.localTradedAt || '',
    };
  }

  return { price, prevClose, marketOpen, afterHours };
}

// Cache last known after-hours data — Naver API only returns overMarketPriceInfo
// during the after-hours trading window (~17:00-18:00 KST). After the window closes,
// the field disappears. We preserve the last known price until the next market open.
let lastAfterHours = null;

// Record a spot tick only when Naver provides market or after-hours data.
async function recordTick() {
  if (!isSpotExternalSession()) {
    const fallback = getBinanceKrwFallbackPrice();
    const latest = selectLatest.get() as TickData | undefined;
    const price = observedTickPrice(latest) || fallback;
    markSourceHealthy('naver', {
      updatedAt: Date.now(),
      detail: price ? `休市延续 ₩${price.toLocaleString()}` : '休市等待本地/BN兜底',
    });
    return null;
  }

  try {
    const basic = await naverBasic();
    const nowMs = Date.now();
    const freshAfterHours = basic.afterHours;

    // Clear cached after-hours when market opens (new trading day)
    if (basic.marketOpen) {
      lastAfterHours = null;
    }

    // Only update cache when after-hours market is actually active
    if (freshAfterHours && freshAfterHours.status !== 'CLOSE') {
      lastAfterHours = freshAfterHours;
    }

    if (!canRecordSpotTick({
      nowMs,
      marketOpen: basic.marketOpen,
      hasFreshAfterHours: Boolean(freshAfterHours && freshAfterHours.status !== 'CLOSE'),
    })) {
      return null;
    }
    
    const ts = Math.floor(nowMs / 1000);
    let price = (basic as any).price;
    let ahPrice = freshAfterHours?.price || null;
    let ahSession = freshAfterHours?.session || null;
    let label = basic.marketOpen ? 'regular' : (ahPrice ? 'after-hours' : 'closed');

    insertTick.run(ts, price, basic.prevClose, basic.marketOpen ? 1 : 0, ahPrice, ahSession);
    markSourceHealthy('naver', {
      updatedAt: ts * 1000,
      detail: `₩${(ahPrice || price).toLocaleString()}`,
    });
    const cnt = (countTicks.get() as { cnt: number }).cnt;
    const displayPrice = ahPrice || price;
    console.log(`[tick] ${new Date().toLocaleTimeString()} ${label} price=${displayPrice} (total: ${cnt})`);
    return basic;
  } catch (err) {
    console.error('[tick] error:', err.message);
    return null;
  }
}

// Build candles from SQLite ticks (uses after_hours_price when available)
function buildCandlesFromTicks(ticks: TickData[], intervalSec: number) {
  return buildSpotCandles(ticks, intervalSec);
}

function isSpotExternalSession(): boolean {
  return isMarketOpen() || isPreMarket() || isAfterHours();
}

function observedTickPrice(tick: TickData | null | undefined): number | null {
  if (!tick) return null;
  const price = typeof tick.after_hours_price === 'number' ? tick.after_hours_price : tick.price;
  return Number.isFinite(price) && price > 0 ? price : null;
}

function getBinanceKrwFallbackPrice(): number | null {
  const latest = selectBinanceLatest.get() as BinanceTickData | undefined;
  const price = latest?.mark_price || latest?.index_price || latest?.price;
  if (!price || !Number.isFinite(price) || !Number.isFinite(krwUsdRate) || krwUsdRate <= 0) return null;
  return Math.round(price * krwUsdRate);
}

async function resolveNaverBasicForSnapshot(): Promise<{ basic: NaverBasic | null; externalSkipped: boolean }> {
  if (!isSpotExternalSession()) {
    return { basic: null, externalSkipped: true };
  }

  const basic = await naverBasic();
  if (!basic.afterHours && lastAfterHours && !basic.marketOpen) {
    basic.afterHours = lastAfterHours;
  }
  return { basic, externalSkipped: false };
}

function buildNaverTimeframeResult(input: {
  basic: NaverBasic | null;
  rangeSec: number;
  intervalSec: number;
  now: number;
}) {
  const ticks = selectRange.all(input.now - input.rangeSec, input.now) as TickData[];
  const latest = selectLatest.get() as TickData | undefined;
  const rawCandles = buildCandlesFromTicks(ticks, input.intervalSec);
  const marketOpen = Boolean(input.basic?.marketOpen);
  const afterHours = input.basic?.afterHours || null;
  const afterHoursActive = afterHours && afterHours.status !== 'CLOSE';
  const apiPrice = input.basic
    ? (!input.basic.marketOpen && afterHoursActive ? afterHours!.price : input.basic.price)
    : null;
  const localSpotPrice = rawCandles[rawCandles.length - 1]?.close || observedTickPrice(latest) || apiPrice;
  const fallbackPrice = getBinanceKrwFallbackPrice();
  // Use continuous candles when market is closed and no active after-hours session
  const useContinuous = !marketOpen && !afterHoursActive;
  const continuous = useContinuous
    ? buildContinuousSpotCandles({
        candles: rawCandles,
        nowSec: input.now,
        intervalSec: input.intervalSec,
        spotPrice: localSpotPrice,
        fallbackPrice,
      })
    : { candles: rawCandles, source: 'spot-flat', price: localSpotPrice };
  const displayPrice = afterHours?.price || continuous.price || apiPrice || fallbackPrice || 0;
  const nowBucket = Math.floor(input.now / input.intervalSec) * input.intervalSec;
  const candles = continuous.candles.length
    ? continuous.candles
    : [{ time: nowBucket, open: displayPrice, high: displayPrice, low: displayPrice, close: displayPrice, volume: 0, sampleCount: 0 }];

  return {
    source: 'naver',
    candles,
    meta: {
      currency: 'KRW',
      price: displayPrice,
      previousClose: input.basic?.prevClose || latest?.prev_close || displayPrice,
      exchangeName: 'KOSPI',
      ...metaCommon(),
      marketOpen,
      tickCount: ticks.length,
      afterHours,
      synthetic: useContinuous,
      syntheticSource: continuous.source,
    },
  };
}

async function naverChart(interval, range) {
  // Determine time range and bucket size
  const now = Math.floor(Date.now() / 1000);
  let rangeSec, intervalSec;
  switch (interval) {
    case '1m':  rangeSec = 3*86400;   intervalSec = 60; break;    // 3天
    case '5m':  rangeSec = 7*86400;   intervalSec = 300; break;   // 7天
    case '15m': rangeSec = 30*86400;  intervalSec = 900; break;   // 30天
    case '1h':  rangeSec = 90*86400;  intervalSec = 3600; break;  // 90天
    default:    rangeSec = 3*86400;   intervalSec = 60;
  }

  const { basic } = await resolveNaverBasicForSnapshot();
  return buildNaverTimeframeResult({ basic, rangeSec, intervalSec, now });
}

// ══════════════════════════════════════════
//  Data Source: Binance Futures (SKHYNIXUSDT)
// ══════════════════════════════════════════
const BINANCE_SYMBOL = 'SKHYNIXUSDT';
const BINANCE_ENDPOINTS = [
  'https://fapi.binance.com',
  'https://fapi1.binance.com',
  'https://fapi2.binance.com',
];
const BINANCE_PROXY = process.env.BINANCE_PROXY || 'http://127.0.0.1:7890';
let latestBinanceFundingTimeMs = 0;

const binanceBreaker = createCircuitBreaker<any>({
  failureThreshold: 3,
  initialCooldownMs: 30000,
  maxCooldownMs: 300000,
});
const binanceRuntime = createCollectorRuntime({key: 'binance'});
const binanceTransport = createBinanceTransport<any>({
  proxyUrl: BINANCE_PROXY || undefined,
  directRequest: (url) => fetchJSON(url, false),
  proxyRequest: (url, proxyUrl) => fetchJSONViaProxy(url, proxyUrl),
});

function isBinanceCircuitOpen(): boolean {
  return binanceBreaker.snapshot().state === 'open';
}

// Binance local storage table
db.exec(`
  CREATE TABLE IF NOT EXISTS binance_ticks (
    ts      INTEGER PRIMARY KEY,
    price   REAL NOT NULL,
    mark_price REAL,
    index_price REAL,
    funding_rate REAL,
    high_24h REAL,
    low_24h REAL,
    volume_24h REAL
  );
`);

const insertBinanceTick = db.prepare('INSERT OR REPLACE INTO binance_ticks (ts, price, mark_price, index_price, funding_rate, high_24h, low_24h, volume_24h) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const selectBinanceRange = db.prepare('SELECT ts, price, mark_price, index_price, funding_rate FROM binance_ticks WHERE ts >= ? AND ts <= ? ORDER BY ts');
const selectBinanceLatest = db.prepare('SELECT * FROM binance_ticks ORDER BY ts DESC LIMIT 1');
const countBinanceTicks = db.prepare('SELECT COUNT(*) as cnt FROM binance_ticks');

async function recordBinanceTick() {
  if (isBinanceCircuitOpen()) return null;
  try {
    const meta = await binanceMeta();
    const ts = Math.floor(Date.now() / 1000);
    insertBinanceTick.run(ts, (meta as any).price, meta.markPrice, meta.indexPrice, meta.fundingRate, meta.high24h, meta.low24h, meta.volume24h);
    latestBinanceFundingTimeMs = meta.nextFundingTime || 0;
    markSourceHealthy('binance', {
      updatedAt: ts * 1000,
      detail: `$${Math.round((meta as any).price * 100) / 100}`,
    });
    const cnt = (countBinanceTicks.get() as { cnt: number }).cnt;
    console.log(`[binance-tick] ${new Date().toLocaleTimeString()} price=$${(meta as any).price} (total: ${cnt})`);
    return meta;
  } catch (err) {
    console.error('[binance-tick] error:', err.message);
    return null;
  }
}

// Backfill missing Binance ticks using klines API
async function backfillBinanceTicks() {
  if (isBinanceCircuitOpen()) return;
  try {
    const latest = selectBinanceLatest.get() as any;
    if (!latest?.ts) return;
    const lastTs = latest.ts;
    const now = Math.floor(Date.now() / 1000);
    const gap = now - lastTs;
    // Only backfill if gap > 60 seconds
    if (gap < 60) return;

    console.log(`[binance-backfill] gap=${gap}s (~${Math.round(gap/60)}min), fetching klines...`);

    let currentStart = (lastTs + 1) * 1000;
    let totalInserted = 0;

    // Paginate through klines (max 1500 per request)
    let pages = 0;
    while (currentStart < now * 1000 && pages < 4) {
      pages++;
      const data = await binanceFetch(`/fapi/v1/klines?symbol=${BINANCE_SYMBOL}&interval=1m&startTime=${currentStart}&limit=1500`);

      if (!Array.isArray(data) || data.length === 0) break;

      for (const k of data) {
        const ts = Math.floor(k[0] / 1000);
        const close = parseFloat(k[4]);
        const high = parseFloat(k[2]);
        const low = parseFloat(k[3]);
        const vol = parseFloat(k[5]);
        if (ts <= lastTs) continue;
        insertBinanceTick.run(ts, close, close, close, 0, high, low, vol);
        totalInserted++;
      }

      // Move to next page
      const lastKlineTime = data[data.length - 1][0];
      currentStart = lastKlineTime + 60000; // +1 minute

      // Break if we got less than limit (no more data)
      if (data.length < 1500) break;
    }

    if (totalInserted > 0) {
      console.log(`[binance-backfill] inserted ${totalInserted} ticks from klines`);
    } else {
      console.log('[binance-backfill] no new ticks to insert');
    }
  } catch (err) {
    console.error('[binance-backfill] error:', err.message);
  }
}

function buildBinanceCandlesFromTicks(ticks: BinanceTickData[], intervalSec: number) {
  if (!ticks.length) return [];
  const candles = [];
  let bucket = Math.floor(ticks[0].ts / intervalSec) * intervalSec;
  let o = ticks[0].price, h = o, l = o, c = o;

  for (let i = 1; i < ticks.length; i++) {
    const t = ticks[i];
    const b = Math.floor((t as any).ts / intervalSec) * intervalSec;
    const p = (t as any).price;
    if (b !== bucket) {
      if (h === l) { h = o + 0.01; l = o - 0.01; }
      candles.push({ time: bucket, open: o, high: h, low: l, close: c, volume: 0 });
      bucket = b;
      o = p; h = p; l = p; c = p;
    } else {
      c = p;
      if (p > h) h = p;
      if (p < l) l = p;
    }
  }
  if (h === l) { h = o + 0.01; l = o - 0.01; }
  candles.push({ time: bucket, open: o, high: h, low: l, close: c, volume: 0 });
  return candles;
}

function getBinanceLocal(interval: string) {
  const now = Math.floor(Date.now() / 1000);
  let rangeSec, intervalSec;
  switch (interval) {
    case '1m':  rangeSec = 3*86400;    intervalSec = 60; break;    // 3天
    case '5m':  rangeSec = 7*86400;    intervalSec = 300; break;   // 7天
    case '15m': rangeSec = 30*86400;   intervalSec = 900; break;   // 30天
    case '1h':  rangeSec = 90*86400;   intervalSec = 3600; break;  // 90天
    default:    rangeSec = 7*86400;    intervalSec = 300;
  }
  const ticks = selectBinanceRange.all(now - rangeSec, now) as BinanceTickData[];
  const latest = selectBinanceLatest.get() as any;
  const lastPrice = latest?.price || 0;

  const candles = buildBinanceCandlesFromTicks(ticks, intervalSec);
  const line = candles.map(k => ({ time: k.time, value: k.close }));
  const freshness = latest?.ts
    ? classifyObservationAge({ nowSec: now, exchangeTs: latest.ts, maxAgeSec: 120 })
    : { eligible: false, ageSec: null, quality: 'stale' as const };
  return {
    line,
    candles,
    meta: latest ? {
      price: lastPrice,
      markPrice: latest.mark_price,
      indexPrice: latest.index_price,
      fundingRate: latest.funding_rate,
      high24h: latest.high_24h,
      low24h: latest.low_24h,
      volume24h: latest.volume_24h,
    } : null,
    local: true,
    tickCount: ticks.length,
    lastExchangeTs: latest?.ts || null,
    ageSec: freshness.ageSec,
    quality: freshness.quality,
  };
}

async function binanceFetch(path: string) {
  try {
    return await binanceBreaker.execute(async () => {
      let lastErr;
      for (const base of BINANCE_ENDPOINTS) {
        try {
          const result = await binanceTransport.request(`${base}${path}`);
          const data = result.data;
          if (data && typeof data === 'object' && data.code !== undefined && data.code !== 0) {
            throw new Error(`Binance API error: ${data.msg || JSON.stringify(data)}`);
          }
          binanceRuntime.update({
            state: 'healthy', transport: result.transport, lastAttemptAt: Date.now(),
            lastSuccessAt: Date.now(), consecutiveFailures: 0, nextRetryAt: null,
            errorCode: null, errorMessage: null,
          });
          return data;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr || new Error('All Binance endpoints failed');
    });
  } catch (error) {
    const breaker = binanceBreaker.snapshot();
    binanceRuntime.update({
      state: breaker.state === 'open' ? 'open' : 'degraded',
      transport: 'local', lastAttemptAt: Date.now(),
      consecutiveFailures: breaker.consecutiveFailures, nextRetryAt: breaker.nextRetryAt,
      errorCode: error instanceof Error ? error.name : 'ERROR',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function binanceKlines(interval: string, limit: number) {
  const data = await binanceFetch(`/fapi/v1/klines?symbol=${BINANCE_SYMBOL}&interval=${interval}&limit=${limit}`);
  if (!Array.isArray(data)) throw new Error('Binance klines: expected array');
  return data.map(k => ({
    time: Math.floor(k[0] / 1000),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

async function binanceMeta() {
  const [ticker, premium] = await Promise.all([
    binanceFetch(`/fapi/v1/ticker/24hr?symbol=${BINANCE_SYMBOL}`),
    binanceFetch(`/fapi/v1/premiumIndex?symbol=${BINANCE_SYMBOL}`),
  ]);
  return {
    price: parseFloat(ticker.lastPrice),
    markPrice: parseFloat(premium.markPrice),
    indexPrice: parseFloat(premium.indexPrice),
    fundingRate: parseFloat(premium.lastFundingRate),
    nextFundingTime: parseInt(premium.nextFundingTime),
    high24h: parseFloat(ticker.highPrice),
    low24h: parseFloat(ticker.lowPrice),
    volume24h: parseFloat(ticker.quoteVolume),
  };
}

function binanceMetaLocal() {
  const latest = selectBinanceLatest.get();
  if (!latest) return null;
  return {
    price: (latest as any).price,
    markPrice: (latest as any).mark_price || (latest as any).price,
    indexPrice: (latest as any).index_price || (latest as any).price,
    fundingRate: (latest as any).funding_rate || 0,
    nextFundingTime: 0,
    high24h: (latest as any).high_24h || (latest as any).price,
    low24h: (latest as any).low_24h || (latest as any).price,
    volume24h: (latest as any).volume_24h || 0,
    local: true,
  };
}

async function binanceMetaWithFallback() {
  try {
    const meta = await binanceMeta();
    return meta;
  } catch (err) {
    console.error(`[binance] meta API failed: ${err.message}, using local fallback`);
    const local = binanceMetaLocal();
    if (local) return local;
    throw err;
  }
}

// ═══ Binance Sentiment Data ═══
// Long/Short ratio, Taker volume, Open Interest, Top trader ratio
db.exec(`
  CREATE TABLE IF NOT EXISTS binance_sentiment (
    ts INTEGER PRIMARY KEY,
    ls_ratio REAL,
    ls_long_pct REAL,
    ls_short_pct REAL,
    taker_ratio REAL,
    taker_buy_vol REAL,
    taker_sell_vol REAL,
    open_interest REAL,
    oi_value REAL,
    top_ls_ratio REAL,
    top_long_pct REAL,
    top_short_pct REAL
  );
`);

const insertSentiment = db.prepare(`INSERT OR REPLACE INTO binance_sentiment
  (ts, ls_ratio, ls_long_pct, ls_short_pct, taker_ratio, taker_buy_vol, taker_sell_vol,
   open_interest, oi_value, top_ls_ratio, top_long_pct, top_short_pct)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const selectSentimentRange = db.prepare('SELECT * FROM binance_sentiment WHERE ts >= ? AND ts <= ? ORDER BY ts');
const selectSentimentLatest = db.prepare('SELECT * FROM binance_sentiment ORDER BY ts DESC LIMIT 1');
const countSentimentRows = db.prepare('SELECT COUNT(*) as cnt FROM binance_sentiment');
const sentimentCoverageStats = db.prepare(`
  SELECT
    COUNT(*) as rows,
    COUNT(DISTINCT CAST(ts / 3600 AS INTEGER)) as hours
  FROM binance_sentiment
  WHERE ts >= ? AND ts <= ?
`);

async function fetchBinanceSentiment() {
  try {
    const [lsData, takerData, oiData, topData] = await Promise.all([
      binanceFetch(`/futures/data/globalLongShortAccountRatio?symbol=${BINANCE_SYMBOL}&period=1h&limit=24`),
      binanceFetch(`/futures/data/takerlongshortRatio?symbol=${BINANCE_SYMBOL}&period=1h&limit=24`),
      binanceFetch(`/futures/data/openInterestHist?symbol=${BINANCE_SYMBOL}&period=1h&limit=24`),
      binanceFetch(`/futures/data/topLongShortAccountRatio?symbol=${BINANCE_SYMBOL}&period=1h&limit=24`),
    ]);

    const merged = mergeSentimentHistory({ lsData, takerData, oiData, topData });
    if (!merged.length) {
      console.log('[sentiment] no aligned hourly rows returned');
      return;
    }

    for (const row of merged) {
      insertSentiment.run(
        (row as any).ts,
        row.ls_ratio,
        row.ls_long_pct,
        row.ls_short_pct,
        row.taker_ratio,
        row.taker_buy_vol,
        row.taker_sell_vol,
        row.open_interest,
        row.oi_value,
        (row as any).top_ls_ratio,
        row.top_long_pct,
        row.top_short_pct,
      );
    }

    const latest = merged[merged.length - 1];
    markSourceHealthy('sentiment', {
      updatedAt: (latest as any).ts * 1000,
      detail: `${merged.length}h`,
    });
    const cnt = (countSentimentRows.get() as { cnt: number }).cnt;
    console.log(`[sentiment] rows=${merged.length} latest LS=${latest.ls_ratio} Taker=${latest.taker_ratio} OI=${latest.open_interest} Top=${(latest as any).top_ls_ratio} (total: ${cnt})`);
  } catch (err) {
    console.error('[sentiment] fetch error:', err.message);
  }
}

// Map our timeframe to Binance interval + limit
function binanceParams(interval: string) {
  switch (interval) {
    case '1m':  return { interval: '1m',  limit: 1440 };   // ~3d
    case '5m':  return { interval: '5m',  limit: 2016 };   // ~7d
    case '15m': return { interval: '15m', limit: 2880 };   // ~30d
    case '1h':  return { interval: '1h',  limit: 2160 };   // ~90d
    default:    return { interval: '5m',  limit: 2016 };
  }
}

async function binanceLine(interval: string, sharedMeta: BinanceMeta | null) {
  try {
    const { interval: bnInterval, limit } = binanceParams(interval);
    const klines = await binanceKlines(bnInterval, limit);
    // Return as line points (close prices)
    const line = klines.map(k => ({ time: k.time, value: k.close }));
    return { line, meta: sharedMeta, candles: klines };
  } catch (err) {
    if (!isBinanceCircuitOpen()) {
      console.error(`[binance] API failed for ${interval}: ${err.message}, using local fallback`);
    }
    const local = getBinanceLocal(interval);
    if (local.tickCount > 0) {
      return { ...local, fallback: true };
    }
    throw err;
  }
}

// ══════════════════════════════════════════
//  Unified fetcher
// ══════════════════════════════════════════
const SOURCES = { yahoo: yahooChart, naver: naverChart };

async function getNaverTimeframesOnly() {
  const { basic, externalSkipped } = await resolveNaverBasicForSnapshot();
  const now = Math.floor(Date.now() / 1000);
  const makeResult = (rangeSec: number, intervalSec: number) => {
    const result = buildNaverTimeframeResult({ basic, rangeSec, intervalSec, now });
    if (externalSkipped) {
      (result.meta as any).externalSkipped = true;
    }
    return result;
  };
  return {
    m1: makeResult(3*86400, 60),      // 3天
    m5: makeResult(7*86400, 300),      // 7天
    m15: makeResult(30*86400, 900),    // 30天
    h1: makeResult(90*86400, 3600),    // 90天
  };
}

async function getAllTimeframes(source = 'yahoo') {
  let m1, m5, m15, h1;

  if (source === 'naver') {
    ({ m1, m5, m15, h1 } = await getNaverTimeframesOnly());
  } else {
    // Yahoo source
    [m1, m5, m15, h1] = await Promise.all([
      yahooChart('1m', '3d'), yahooChart('5m', '7d'), yahooChart('15m', '30d'), yahooChart('1h', '3mo'),
    ]);
  }

  // Binance in parallel (separate try/catch so it doesn't break main data)
  let binance = null;
  try {
    // Fetch meta once, share across all timeframes (saves 3 redundant API calls)
    const sharedMeta = await binanceMetaWithFallback();
    const [b1, b5, b15, bh] = await Promise.all([
      binanceLine('1m', sharedMeta), binanceLine('5m', sharedMeta),
      binanceLine('15m', sharedMeta), binanceLine('1h', sharedMeta),
    ]);
    binance = { m1: b1, m5: b5, m15: b15, h1: bh };
  } catch (err) {
    console.error('[binance] fetch error:', err.message);
  }

  return { m1, m5, m15, h1, source, krwUsd: krwUsdRate, serverTime: Date.now(), binance };
}

// ── API: data ──
app.get('/api/data', async (req, res) => {
  const source = (req.query as any).source || 'yahoo';
  try {
    const data = await getAllTimeframes(source);
    cacheDashboardSnapshot(data);
    res.json(data);
  } catch (err) {
    console.error(`[${source}] Fetch error:`, err.message);
    if (source !== 'naver') {
      try {
        console.log('Trying naver fallback...');
        const data = await getAllTimeframes('naver');
        (data as any).fallbackFrom = source;
        cacheDashboardSnapshot(data);
        res.json(data);
        return;
      } catch (e2) { console.error('[naver] Fallback also failed:', e2.message); }
    }
    res.status(500).json({ error: err.message });
  }
});

// ── API: sources ──
app.get('/api/sources', (req, res) => {
  const cnt = (countTicks.get() as { cnt: number }).cnt;
  res.json([
    { id: 'yahoo', name: 'Yahoo Finance', desc: 'K线完整，延迟~20min', status: 'ok' },
    { id: 'naver', name: 'Naver Finance', desc: `实时报价，本地${cnt}条tick`, status: 'ok' },
  ]);
});

// ── API: tick stats ──
app.get('/api/ticks', (req, res) => {
  const cnt = (countTicks.get() as { cnt: number }).cnt;
  const latest = selectLatest.get();
  const bnCnt = (countBinanceTicks.get() as { cnt: number }).cnt;
  const bnLatest = selectBinanceLatest.get();
  res.json({
    naver: { count: cnt, latest: latest || null },
    binance: { count: bnCnt, latest: bnLatest || null },
  });
});

app.get('/api/quality', (req, res) => {
  try {
    const sources = getSourceHealthSnapshot();
    const collector = binanceRuntime.snapshot();
    const breaker = binanceBreaker.snapshot();
    const binanceCollector = {
      ...collector,
      state: breaker.state === 'open' || breaker.state === 'half-open' ? breaker.state : collector.state,
      nextRetryAt: breaker.nextRetryAt,
    };
    const spot = sources.find((source) => source.key === 'naver');
    const overall =
      !spot || (spot.status === 'missing' && spot.expectedActive)
        ? 'unavailable'
        : binanceCollector.state === 'healthy'
          ? 'healthy'
        : 'degraded';

  res.json({
    serverTime: Date.now(),
    overall,
    collectors: [binanceCollector],
    sources,
  });
  } catch (err) {
    console.error('[quality] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SSE ──
interface SSEClient {
  res: Response;
  source: string;
}
let clients: SSEClient[] = [];
const lastSnapshotsBySource = new Map<string, DashboardSnapshot>();

function cacheDashboardSnapshot(value: unknown): void {
  if (isCompleteDashboardSnapshot(value)) {
    lastSnapshotsBySource.set(value.source, value);
  }
}

app.get('/api/stream', (req, res) => {
  const source = (req.query.source as string) || 'naver';
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*'
  });
  res.write(':\n\n');
  const client: SSEClient = { res, source };
  clients.push(client);
  req.on('close', () => { clients = clients.filter(c => c.res !== res); });
});

function closeSseClients() {
  for (const client of clients) {
    try {
      client.res.write('event: close\ndata: {}\n\n');
      client.res.end();
    } catch (error) {
      console.error('[sse] close error:', error.message);
    }
  }
  clients = [];
}

async function broadcast() {
  if (clients.length === 0) return;
  
  // Group clients by source
  const clientsBySource = new Map<string, SSEClient[]>();
  for (const client of clients) {
    const list = clientsBySource.get(client.source) || [];
    list.push(client);
    clientsBySource.set(client.source, list);
  }
  
  // Broadcast to each group
  for (const [source, group] of clientsBySource) {
    try {
      const data = await getAllTimeframes(source);
      cacheDashboardSnapshot(data);
      const payload = `data: ${JSON.stringify(data)}\n\n`;
      group.forEach(c => c.res.write(payload));
      console.log(`[${new Date().toLocaleTimeString()}] ${source} → ${group.length} clients`);
    } catch (err) {
      console.error(`Broadcast error (${source}):`, err.message);
      // Fallback to naver for this group
      if (source !== 'naver') {
        try {
          const data = await getAllTimeframes('naver');
          (data as any).fallbackFrom = source;
          cacheDashboardSnapshot(data);
          const payload = `data: ${JSON.stringify(data)}\n\n`;
          group.forEach(c => c.res.write(payload));
        } catch (e2) { /* ignore */ }
      }
    }
  }
}

// Keep /api/source for backward compatibility but it's now per-session
app.post('/api/source', express.json(), (req, res) => {
  const source = req.body.source;
  if (source && SOURCES[source]) {
    res.json({ source, note: 'Use /api/stream?source= for per-client binding' });
  } else {
    res.status(400).json({ error: 'invalid source' });
  }
});

// ══════════════════════════════════════════
//  Quantitative Indicators Engine
// ══════════════════════════════════════════
function calcSMA(closes: number[], period: number) {
  const result = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    result.push(Math.round((sum / period) * 100) / 100);
  }
  return result;
}

function calcEMA(closes: number[], period: number) {
  const k = 2 / (period + 1);
  const result = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] == null) { result.push(result[i - 1]); continue; }
    result.push(Math.round((closes[i] * k + result[i - 1] * (1 - k)) * 100) / 100);
  }
  return result;
}

function calcRSI(closes, period = 14) {
  const result = [];
  if (closes.length <= period) {
    for (let i = 0; i < closes.length; i++) result.push(null);
    return result;
  }
  let avgGain = 0, avgLoss = 0;
  // Seed with first period
  for (let i = 1; i <= period && i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period; avgLoss /= period;
  for (let i = 0; i < period; i++) result.push(null);
  result.push(avgLoss === 0 ? 100 : Math.round((100 - 100 / (1 + avgGain / avgLoss)) * 100) / 100);
  // Subsequent values use smoothed averages
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result.push(avgLoss === 0 ? 100 : Math.round((100 - 100 / (1 + avgGain / avgLoss)) * 100) / 100);
  }
  return result;
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const dif = emaFast.map((v, i) => Math.round((v - emaSlow[i]) * 100) / 100);
  const dea = calcEMA(dif, signal);
  const hist = dif.map((v, i) => Math.round((v - dea[i]) * 100) / 100);
  return { dif, dea, hist };
}

function calcBollinger(closes, period = 20, mult = 2) {
  const upper = [], mid = [], lower = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { upper.push(null); mid.push(null); lower.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j] - mean) ** 2;
    const std = Math.sqrt(variance / period);
    mid.push(Math.round(mean * 100) / 100);
    upper.push(Math.round((mean + mult * std) * 100) / 100);
    lower.push(Math.round((mean - mult * std) * 100) / 100);
  }
  return { upper, mid, lower };
}

function detectSignals(closes: number[], times: number[], indicators: IndicatorsData) {
  const signals = [];
  const { ma5, ma20, rsi, macd, bollinger } = indicators;
  const len = closes.length;
  if (len < 3) return signals;

  // MA Golden/Death Cross (MA5 vs MA20)
  for (let i = Math.max(26, len - 50); i < len; i++) {
    if (ma5[i] == null || ma20[i] == null || ma5[i-1] == null || ma20[i-1] == null) continue;
    if (ma5[i-1] <= ma20[i-1] && ma5[i] > ma20[i]) {
      signals.push({ type: 'golden_cross', label: 'MA5/20 金叉', direction: 'long', time: times[i] });
    }
    if (ma5[i-1] >= ma20[i-1] && ma5[i] < ma20[i]) {
      signals.push({ type: 'death_cross', label: 'MA5/20 死叉', direction: 'short', time: times[i] });
    }
  }

  // RSI Overbought/Oversold
  for (let i = Math.max(14, len - 50); i < len; i++) {
    if (rsi[i] == null || rsi[i-1] == null) continue;
    if (rsi[i-1] <= 30 && rsi[i] > 30) {
      signals.push({ type: 'rsi_oversold', label: 'RSI 超卖回升', direction: 'long', time: times[i] });
    }
    if (rsi[i-1] >= 70 && rsi[i] < 70) {
      signals.push({ type: 'rsi_overbought', label: 'RSI 超买回落', direction: 'short', time: times[i] });
    }
  }

  // MACD Crossover
  for (let i = Math.max(26, len - 50); i < len; i++) {
    if (macd.dif[i] == null || macd.dea[i] == null || macd.dif[i-1] == null || macd.dea[i-1] == null) continue;
    if (macd.dif[i-1] <= macd.dea[i-1] && macd.dif[i] > macd.dea[i]) {
      signals.push({ type: 'macd_golden', label: 'MACD 金叉', direction: 'long', time: times[i] });
    }
    if (macd.dif[i-1] >= macd.dea[i-1] && macd.dif[i] < macd.dea[i]) {
      signals.push({ type: 'macd_death', label: 'MACD 死叉', direction: 'short', time: times[i] });
    }
  }

  // Bollinger Breakout
  for (let i = Math.max(20, len - 50); i < len; i++) {
    if (bollinger.upper[i] == null || bollinger.lower[i] == null) continue;
    if (closes[i] > bollinger.upper[i] && closes[i-1] <= bollinger.upper[i-1]) {
      signals.push({ type: 'boll_breakup', label: '突破布林上轨', direction: 'short', time: times[i] });
    }
    if (closes[i] < bollinger.lower[i] && closes[i-1] >= bollinger.lower[i-1]) {
      signals.push({ type: 'boll_breakdown', label: '跌破布林下轨', direction: 'long', time: times[i] });
    }
  }

  // Price trend signals (3 consecutive higher/lower closes)
  for (let i = Math.max(3, len - 50); i < len; i++) {
    if (closes[i] > closes[i-1] && closes[i-1] > closes[i-2] && closes[i-2] > closes[i-3]) {
      signals.push({ type: 'uptrend', label: '连续上涨', direction: 'long', time: times[i] });
    }
    if (closes[i] < closes[i-1] && closes[i-1] < closes[i-2] && closes[i-2] < closes[i-3]) {
      signals.push({ type: 'downtrend', label: '连续下跌', direction: 'short', time: times[i] });
    }
  }

  return signals;
}

function findSupportResistance(candles: Array<{ high: number; low: number; close: number }>) {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);

  // Simple pivot-based S/R
  const levels = [];
  const window = Math.max(5, Math.floor(candles.length / 20));

  for (let i = window; i < candles.length - window; i++) {
    // Swing high
    let isHigh = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j !== i && highs[j] >= highs[i]) { isHigh = false; break; }
    }
    if (isHigh) levels.push({ price: highs[i], type: 'resistance' });

    // Swing low
    let isLow = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j !== i && lows[j] <= lows[i]) { isLow = false; break; }
    }
    if (isLow) levels.push({ price: lows[i], type: 'support' });
  }

  // Cluster nearby levels (within 1%)
  const clustered = [];
  const used = new Set();
  for (const l of levels) {
    if (used.has((l as any).price)) continue;
    const cluster = levels.filter(x => Math.abs((x as any).price - (l as any).price) / (l as any).price < 0.01);
    const avgPrice = Math.round(cluster.reduce((s, x) => s + (x as any).price, 0) / cluster.length);
    const count = cluster.length;
    clustered.push({ price: avgPrice, type: l.type, strength: count });
    cluster.forEach(x => used.add((x as any).price));
  }

  // Return top support and resistance levels
  const currentPrice = closes[closes.length - 1];
  const support = clustered.filter(l => l.type === 'support' && (l as any).price < currentPrice)
    .sort((a, b) => (b as any).price - (a as any).price).slice(0, 3);
  const resistance = clustered.filter(l => l.type === 'resistance' && (l as any).price > currentPrice)
    .sort((a, b) => (a as any).price - (b as any).price).slice(0, 3);

  return { support, resistance };
}

// Use new domain module for /api/indicators
app.get('/api/indicators', (req, res) => {
  try {
    const { tf, rangeSec, intervalSec } = getTimeframeConfig((req.query as any).tf || 'm5');
    const now = Math.floor(Date.now() / 1000);
    
    // Get Binance data as primary source
    const binanceTicks = selectBinanceRange.all(now - rangeSec, now) as BinanceTickData[];
    const binanceCandles = binanceTicks.length >= 10 
      ? buildBinanceCandlesFromTicks(binanceTicks, intervalSec) 
      : [];
    
    // Get Naver data as fallback
    const naverTicks = selectRange.all(now - rangeSec, now) as TickData[];
    const naverCandles = naverTicks.length >= 10 
      ? buildCandlesFromTicks(naverTicks, intervalSec) 
      : [];
    
    // Primary: Binance, Fallback: Naver
    const candles = binanceCandles.length >= 10 ? binanceCandles : naverCandles;
    const dataSource = binanceCandles.length >= 10 ? 'binance' : 'naver';
    
    if (candles.length < 2) {
      return res.json({ 
        rsi: [], macd: { dif: [], dea: [], histogram: [] }, 
        bollinger: { upper: [], mid: [], lower: [] }, 
        ma5: [], ma20: [], volRatio: [], 
        latest: null, signals: [], support: [], resistance: [], 
        times: [], dataSource 
      });
    }
    
    const result = calculateAllIndicators(candles);
    
    // Store newly detected signals to database
    const currentSignals = result.signals || [];
    const nowTs = Math.floor(Date.now() / 1000);
    for (const signal of currentSignals) {
      try {
        insertSignal.run(
          signal.type,
          signal.label,
          (signal as any).direction || 'neutral',
          signal.time,
          signal.strength || 1,
          tf,
          nowTs
        );
      } catch (e) {
        // Ignore duplicate key errors
      }
    }
    
    // Retrieve historical signals from database (last 100 signals for this timeframe)
    const historicalSignals = selectSignalsByTf.all(tf, 100) as any[];
    
    // Merge: deduplicate by (type, time), prefer current signals
    const signalMap = new Map<string, any>();
    
    // Add historical signals first
    for (const sig of historicalSignals) {
      const key = `${sig.signal_type}_${sig.time}`;
      signalMap.set(key, {
        type: sig.signal_type,
        label: sig.label,
        direction: sig.direction,
        time: sig.time,
        strength: sig.strength,
        historical: true,
      });
    }
    
    // Override with current signals (they have fresh data)
    for (const sig of currentSignals) {
      const key = `${sig.type}_${sig.time}`;
      signalMap.set(key, {
        type: sig.type,
        label: sig.label,
        direction: (sig as any).direction || 'neutral',
        time: sig.time,
        strength: sig.strength,
        historical: false,
      });
    }
    
    // Sort by time descending (most recent first)
    const mergedSignals = Array.from(signalMap.values())
      .sort((a, b) => b.time - a.time);
    
    // Get support/resistance from both sources
    const binanceSR = binanceCandles.length >= 20 ? findSupportResistance(binanceCandles) : { support: [], resistance: [] };
    const naverSR = naverCandles.length >= 20 ? findSupportResistance(naverCandles) : { support: [], resistance: [] };
    
    const levels = buildLevelGroups({
      spot: { support: result.support, resistance: result.resistance },
      futures: { support: binanceSR.support, resistance: binanceSR.resistance },
    });
    
    // Transform to match expected format
    const latest = result.latest;
    let macdState = 'neutral';
    if (latest.macd.dif > latest.macd.dea && latest.macd.histogram > 0) macdState = 'bullish';
    else if (latest.macd.dif < latest.macd.dea && latest.macd.histogram < 0) macdState = 'bearish';
    
    res.json({
      tf,
      dataSource,
      rsi: result.rsi,
      macd: result.macd,
      bollinger: result.bollinger,
      ma5: result.ma5,
      ma20: result.ma20,
      volRatio: result.volRatio,
      latest: {
        rsi: latest.rsi,
        macdDif: latest.macd.dif,
        macdDea: latest.macd.dea,
        macdHist: latest.macd.histogram,
        volRatio: latest.volRatio,
        ma5: latest.ma5,
        ma20: latest.ma20,
        bollUpper: latest.bollinger.upper,
        bollLower: latest.bollinger.lower,
        macdState,
      },
      signals: mergedSignals,
      support: levels.spot.support,
      resistance: levels.spot.resistance,
      levels,
      times: candles.map(c => c.time),
    });
  } catch (err) {
    console.error('[indicators] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
//  Impact Factor Analysis Engine
// ══════════════════════════════════════════
function clampScore(v: number) { return Math.max(-10, Math.min(10, v)); }

function factorMomentum(candles: Candle[]) {
  if (candles.length < 2) return { score: 0, weight: 0, detail: '数据不足' };
  const last = candles[candles.length - 1].close;
  // Short-term: last 12 candles (~1h for 5m tf)
  const shortLen = Math.min(12, candles.length);
  const shortPrev = candles[candles.length - shortLen].close;
  const shortChg = (last - shortPrev) / shortPrev * 100;
  // Medium-term: last ~1 day
  const medLen = Math.min(Math.floor(candles.length * 0.15), candles.length - 1);
  const medPrev = candles[candles.length - Math.max(medLen, 2)].close;
  const medChg = (last - medPrev) / medPrev * 100;
  // Long-term: full range
  const longPrev = candles[0].close;
  const longChg = (last - longPrev) / longPrev * 100;
  // Score: weighted blend
  const score = clampScore(shortChg * 2 + medChg * 1.2 + longChg * 0.5);
  return {
    category: 'momentum', label: '价格动量',
    score: Math.round(score * 10) / 10, weight: 0.9,
    detail: `1h ${shortChg >= 0 ? '+' : ''}${shortChg.toFixed(1)}%  1d ${medChg >= 0 ? '+' : ''}${medChg.toFixed(1)}%  7d ${longChg >= 0 ? '+' : ''}${longChg.toFixed(1)}%`
  };
}

function factorFundingRate(binanceTicks: BinanceTickData[]) {
  if (binanceTicks.length < 2) return { score: 0, weight: 0, detail: '数据不足' };
  const recent = binanceTicks.slice(-20);
  const latest = recent[recent.length - 1];
  const rate = (latest as any).funding_rate || 0;
  const ratePct = rate * 100;
  // Trend: compare recent avg vs earlier avg
  const half = Math.floor(recent.length / 2);
  const recentAvg = recent.slice(half).reduce((s, t) => s + ((t as any).funding_rate || 0), 0) / (recent.length - half);
  const earlyAvg = recent.slice(0, half).reduce((s, t) => s + ((t as any).funding_rate || 0), 0) / half;
  const trend = (recentAvg - earlyAvg) * 100;
  // Positive funding = longs pay shorts = bullish sentiment
  // But very high = overheated
  let score = ratePct * 30; // 0.1% → 3 score
  if (Math.abs(ratePct) > 0.3) score = Math.sign(score) * 9; // cap at extreme
  score = clampScore(score + trend * 50); // trend adds/subtracts
  const trendLabel = trend > 0.005 ? '↑上升' : trend < -0.005 ? '↓下降' : '→平稳';
  return {
    category: 'funding', label: '资金费率',
    score: Math.round(score * 10) / 10, weight: 0.75,
    detail: `${ratePct.toFixed(4)}% (${rate >= 0 ? '多头' : '空头'}付) 趋势${trendLabel}`
  };
}

function factorVolume(candles: Candle[]) {
  if (candles.length < 5) return { score: 0, weight: 0, detail: '数据不足' };
  const vols = candles.map(c => c.volume);
  const closes = candles.map(c => c.close);
  const lastVol = vols[vols.length - 1];
  const avg20 = vols.slice(-20).reduce((s, v) => s + v, 0) / Math.min(20, vols.length);
  const ratio = avg20 > 0 ? lastVol / avg20 : 1;
  // Volume spike + direction
  const lastChg = closes.length >= 2 ? closes[closes.length - 1] - closes[closes.length - 2] : 0;
  const volDirection = lastChg > 0 ? 1 : lastChg < 0 ? -1 : 0;
  let score = 0;
  if (ratio > 2) score = volDirection * Math.min(ratio, 5); // big volume spike
  else if (ratio > 1.5) score = volDirection * 2;
  else if (ratio < 0.5) score = -1; // low volume = weak conviction
  score = clampScore(score);
  return {
    category: 'volume', label: '成交量',
    score: Math.round(score * 10) / 10, weight: 0.65,
    detail: `量比 ${ratio.toFixed(1)}x ${ratio > 2 ? '(放量)' : ratio < 0.5 ? '(缩量)' : ''} ${volDirection > 0 ? '↑涨' : volDirection < 0 ? '↓跌' : ''}`
  };
}

function factorVolatility(candles: Candle[]) {
  if (candles.length < 15) return { score: 0, weight: 0, detail: '数据不足' };
  // ATR(14) as % of price
  let atrSum = 0;
  const period = Math.min(14, candles.length - 1);
  for (let i = candles.length - period; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low;
    const prevC = candles[i - 1].close;
    const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
    atrSum += tr;
  }
  const atr = atrSum / period;
  const price = candles[candles.length - 1].close;
  const atrPct = (atr / price) * 100;
  // High volatility = risk (negative score), low = stable (positive)
  // ATR 0-1% = good, 1-3% = normal, >3% = risky
  let score;
  if (atrPct < 0.5) score = 3;
  else if (atrPct < 1) score = 2;
  else if (atrPct < 2) score = 0;
  else if (atrPct < 3) score = -3;
  else score = -6;
  score = clampScore(score);
  return {
    category: 'volatility', label: '波动率',
    score: Math.round(score * 10) / 10, weight: 0.55,
    detail: `ATR(14) ${atrPct.toFixed(2)}% ${atrPct > 3 ? '(高波动)' : atrPct > 2 ? '(偏高)' : atrPct < 0.5 ? '(极低)' : '(正常)'}`
  };
}

function factorExchangeRate() {
  // krwUsdRate: higher = weaker KRW = good for export stocks like SK Hynix
  // Use deviation from default as signal
  const deviation = (krwUsdRate - KRW_USD_DEFAULT) / KRW_USD_DEFAULT * 100;
  let score = clampScore(deviation * 3);
  return {
    category: 'fx', label: '汇率影响',
    score: Math.round(score * 10) / 10, weight: 0.4,
    detail: `USD/KRW ${krwUsdRate} (偏离 ${deviation >= 0 ? '+' : ''}${deviation.toFixed(1)}%) ${deviation > 0 ? '韩元贬值利好' : deviation < -1 ? '韩元升值利空' : '中性'}`
  };
}

function factorPremium(naverLatest: NaverBasic, binanceLatest: BinanceTickData) {
  if (!naverLatest || !binanceLatest) return { score: 0, weight: 0, detail: '数据不足' };
  const naverKRW = naverLatest.afterHours?.price || naverLatest.price;
  const naverUSD = naverKRW / krwUsdRate;
  const bnPrice = binanceLatest.price;
  const premium = (bnPrice - naverUSD) / naverUSD * 100;
  // Positive premium = market expects upside = bullish
  let score = clampScore(premium * 2);
  return {
    category: 'premium', label: '合约溢价',
    score: Math.round(score * 10) / 10, weight: 0.7,
    detail: `Binance vs 现货 ${premium >= 0 ? '+' : ''}${premium.toFixed(2)}% ${premium > 3 ? '(高溢价)' : premium > 1 ? '(正溢价)' : premium < -2 ? '(折价)' : '(正常)'}`
  };
}

function factorIndicatorMomentum(indicators: IndicatorResult) {
  if (!indicators) return { score: 0, weight: 0, detail: '数据不足' };
  const rsi = indicators.rsi;
  const macdHist = indicators.macd?.histogram;
  const macdDif = indicators.macd?.dif;
  const macdDea = indicators.macd?.dea;
  // RSI: 50 = neutral, >70 = overbought, <30 = oversold
  const rsiScore = rsi != null ? (rsi - 50) / 5 : 0; // -10 to +10
  // MACD: positive histogram = bullish
  const macdScore = macdHist != null ? Math.sign(macdHist) * Math.min(Math.abs(macdHist) / 500, 5) : 0;
  const score = clampScore(rsiScore * 0.6 + macdScore * 0.4);
  const rsiLabel = rsi != null ? `RSI ${rsi.toFixed(0)}` : 'RSI --';
  const macdLabel = macdDif > macdDea ? '多头' : macdDif < macdDea ? '空头' : '中性';
  return {
    category: 'indicator', label: '指标动量',
    score: Math.round(score * 10) / 10, weight: 0.6,
    detail: `${rsiLabel} ${rsi > 70 ? '(超买)' : rsi < 30 ? '(超卖)' : ''} MACD ${macdLabel}`
  };
}

function factorSupportResistance(candles: Candle[], sr: { support: SupportResistance[]; resistance: SupportResistance[] }) {
  if (!sr || (!sr.support?.length && !sr.resistance?.length) || !candles.length) {
    return { score: 0, weight: 0, detail: '数据不足' };
  }
  const price = candles[candles.length - 1].close;
  // Distance to nearest support/resistance
  const allLevels = [...(sr.support || []), ...(sr.resistance || [])];
  if (!allLevels.length) return { score: 0, weight: 0, detail: '无关键位' };

  let nearestSupport = 0, nearestResistance = Infinity;
  for (const l of allLevels) {
    if (l.type === 'support' && (l as any).price < price && (l as any).price > nearestSupport) nearestSupport = (l as any).price;
    if (l.type === 'resistance' && (l as any).price > price && (l as any).price < nearestResistance) nearestResistance = (l as any).price;
  }

  const distToSupport = nearestSupport > 0 ? (price - nearestSupport) / price * 100 : 10;
  const distToResist = nearestResistance < Infinity ? (nearestResistance - price) / price * 100 : 10;
  // Close to support = potential bounce (positive), close to resistance = potential reversal (negative)
  let score = 0;
  if (distToSupport < 1) score = 4; // very close to support
  else if (distToSupport < 2) score = 2;
  if (distToResist < 1) score -= 4; // very close to resistance
  else if (distToResist < 2) score -= 2;
  score = clampScore(score);
  const parts = [];
  if (nearestSupport > 0) parts.push(`支撑 ₩${nearestSupport.toLocaleString()} (${distToSupport.toFixed(1)}%)`);
  if (nearestResistance < Infinity) parts.push(`阻力 ₩${nearestResistance.toLocaleString()} (${distToResist.toFixed(1)}%)`);
  return {
    category: 'structure', label: '结构位',
    score: Math.round(score * 10) / 10, weight: 0.5,
    detail: parts.join(' / ')
  };
}

// ═══ New Sentiment Factors ═══
function factorLongShortRatio(sentiment: { ls_ratio: number; ls_long_pct?: number; top_ls_ratio?: number; top_long_pct?: number }) {
  if (!sentiment) return { score: 0, weight: 0, detail: '数据不足' };
  const ratio = sentiment.ls_ratio || 1;
  const longPct = sentiment.ls_long_pct || 0.5;
  const topRatio = (sentiment as any).top_ls_ratio || 1;
  const topLongPct = sentiment.top_long_pct || 0.5;

  // Long/Short ratio: >1.5 = lots of longs (potential squeeze risk), <0.7 = lots of shorts (potential squeeze up)
  // Extreme readings are contrarian signals
  let score = 0;
  if (ratio > 3) score = -4;       // too many longs = contrarian bearish
  else if (ratio > 2) score = -2;  // crowded long
  else if (ratio > 1.3) score = 2; // healthy bullish
  else if (ratio > 0.8) score = 0; // balanced
  else if (ratio > 0.5) score = 2; // healthy bearish (shorts building)
  else score = 4;                  // too many shorts = contrarian bullish

  // Top traders add confirmation
  const topConfirm = topRatio > 2 ? -1 : topRatio > 1.3 ? 1 : topRatio < 0.7 ? 1 : 0;
  score = clampScore(score + topConfirm);

  return {
    category: 'lsRatio', label: '多空比',
    score: Math.round(score * 10) / 10, weight: 0.7,
    detail: `散户 ${(longPct*100).toFixed(0)}%多 ${(100-longPct*100).toFixed(0)}空 | 大户 ${(topLongPct*100).toFixed(0)}%多`
  };
}

function factorTakerVolume(sentiment: { taker_buy_vol: number; taker_sell_vol: number; taker_ratio?: number }) {
  if (!sentiment) return { score: 0, weight: 0, detail: '数据不足' };
  const ratio = sentiment.taker_ratio || 1;
  const buyVol = sentiment.taker_buy_vol || 0;
  const sellVol = sentiment.taker_sell_vol || 0;

  // Taker buy/sell ratio: >1 = more buying (bullish), <1 = more selling (bearish)
  // Lowered thresholds to be more responsive
  let score = 0;
  if (ratio > 1.3) score = 4;      // strong buying pressure
  else if (ratio > 1.05) score = 2; // moderate buying
  else if (ratio > 0.95) score = 0; // balanced
  else if (ratio > 0.8) score = -2; // moderate selling
  else score = -4;                  // strong selling pressure

  score = clampScore(score);
  const totalVol = buyVol + sellVol;
  return {
    category: 'takerVol', label: '主动买卖',
    score: Math.round(score * 10) / 10, weight: 0.65,
    detail: `买 ${(buyVol/1000).toFixed(0)}K 卖 ${(sellVol/1000).toFixed(0)}K 比值 ${ratio.toFixed(2)}`
  };
}

function factorOpenInterest(sentimentRows: BacktestSentimentRow[], candles: Candle[]) {
  const rows = Array.isArray(sentimentRows) ? sentimentRows : (sentimentRows ? [sentimentRows] : []);
  const latest = rows[rows.length - 1];
  if (!latest || !candles || candles.length < 5) return { score: 0, weight: 0, detail: '数据不足' };

  const priceNow = candles[candles.length - 1].close;
  const pricePrev = candles[Math.max(0, candles.length - 5)].close;
  const signal = scoreOpenInterestSignal({ sentimentRows: rows, priceNow, pricePrev });
  if (!signal.weight) return { score: 0, weight: 0, detail: '数据不足' };

  const oiArrow = signal.oiChangePct > 0 ? '↑' : signal.oiChangePct < 0 ? '↓' : '→';
  const priceArrow = signal.priceChangePct > 0 ? '↑' : signal.priceChangePct < 0 ? '↓' : '→';
  const latestOiText = signal.metric === 'oi_value'
    ? `$${(signal.latestValue / 1000000).toFixed(1)}M`
    : `${(signal.latestValue / 1000).toFixed(1)}K`;

  return {
    category: 'openInterest', label: '持仓量',
    score: Math.round(signal.score * 10) / 10, weight: signal.weight,
    detail: `OI ${latestOiText} ${oiArrow}${Math.abs(signal.oiChangePct*100).toFixed(1)}% | 价格${priceArrow}${Math.abs(signal.priceChangePct*100).toFixed(1)}%`
  };
}

// ═══ Trend Factors (using historical data) ═══
function factorLongShortTrend() {
  // Get last 24 hours of LS ratio data (hourly resolution)
  const now = Math.floor(Date.now() / 1000);
  const rows = selectSentimentRange.all(now - 86400, now);
  if (rows.length < 2) return { score: 0, weight: 0, detail: '数据不足' };

  // Get unique values (deduplicate same-hour entries)
  const unique = [];
  const seen = new Set();
  for (const r of rows) {
    const key = Math.floor((r as any).ts / 3600); // group by hour
    if (!seen.has(key)) { seen.add(key); unique.push(r); }
  }
  if (unique.length < 2) return { score: 0, weight: 0, detail: '数据不足' };

  const latest = unique[unique.length - 1].ls_ratio;
  const earliest = unique[0].ls_ratio;
  const trend = latest - earliest;
  const prevHour = unique.length >= 2 ? unique[unique.length - 2].ls_ratio : latest;
  const shortTrend = latest - prevHour;

  let score = 0;
  // Use actual ratio level + trend direction
  if (latest > 2.5 && shortTrend > 0.1) score = -3;       // crowding longs fast
  else if (latest > 2 && shortTrend > 0.05) score = -2;
  else if (latest < 0.7 && shortTrend < -0.1) score = 3;  // crowding shorts fast
  else if (latest < 0.8 && shortTrend < -0.05) score = 2;
  // Even without extreme levels, trend matters
  else if (trend > 0.3) score = 1;    // longs increasing = mildly bullish
  else if (trend < -0.3) score = -1;  // shorts increasing = mildly bearish
  // Use absolute level as tiebreaker
  else if (latest > 1.8) score = 1;   // moderate long bias = mildly bullish
  else if (latest < 0.9) score = -1;  // moderate short bias = mildly bearish

  score = clampScore(score);
  const arrow = shortTrend > 0.05 ? '↑多' : shortTrend < -0.05 ? '↑空' : '→平';
  return {
    category: 'lsTrend', label: '多空趋势',
    score: Math.round(score * 10) / 10, weight: 0.6,
    detail: `${unique.length}h趋势 ${arrow} | 比值 ${earliest.toFixed(2)} → ${latest.toFixed(2)}`
  };
}

function factorWhaleActivity() {
  const now = Math.floor(Date.now() / 1000);
  const rows = selectSentimentRange.all(now - 86400, now);
  if (rows.length < 2) return { score: 0, weight: 0, detail: '数据不足' };

  // Deduplicate
  const unique = [];
  const seen = new Set();
  for (const r of rows) {
    const key = Math.floor((r as any).ts / 3600);
    if (!seen.has(key) && (r as any).top_ls_ratio > 0) { seen.add(key); unique.push(r); }
  }
  if (unique.length < 2) return { score: 0, weight: 0, detail: '数据不足' };

  const latest = unique[unique.length - 1].top_ls_ratio;
  const earliest = unique[0].top_ls_ratio;
  const trend = latest - earliest;
  const prevHour = unique.length >= 2 ? unique[unique.length - 2].top_ls_ratio : latest;
  const shortTrend = latest - prevHour;
  const avg = unique.reduce((s, r) => s + (r as any).top_ls_ratio, 0) / unique.length;

  let score = 0;
  // Whale activity: level + momentum
  if (latest > 2 && shortTrend > 0.1) score = 4;        // whales aggressively adding longs
  else if (latest > 1.5 && shortTrend > 0.05) score = 2; // whales leaning long
  else if (latest < 0.7 && shortTrend < -0.1) score = -4; // whales aggressively adding shorts
  else if (latest < 0.8 && shortTrend < -0.05) score = -2; // whales leaning short
  // Trend over 24h
  else if (latest > 1.8 && trend > 0.2) score = 2;
  else if (latest < 0.9 && trend < -0.2) score = -2;
  // Level alone
  else if (latest > 1.8) score = 1;
  else if (latest < 0.9) score = -1;

  score = clampScore(score);
  return {
    category: 'whale', label: '庄家动向',
    score: Math.round(score * 10) / 10, weight: 0.75,
    detail: `大户 ${(latest/(1+latest)*100).toFixed(0)}%多 | 短期${shortTrend > 0.05 ? '↑' : shortTrend < -0.05 ? '↓' : '→'} 24h${trend > 0.2 ? '↑' : trend < -0.2 ? '↓' : '→'}`
  };
}

// ═══ News Sentiment ═══
// Keyword-based news sentiment (Bing News RSS, English + Korean keywords)
const NEWS_POSITIVE = ['HBM', 'hbm', 'AI', 'growth', 'profit', 'surge', 'soar', 'rally', 'demand', 'upgrade', 'buy', 'overweight', 'double', 'leader', 'market share', 'triple-digit', 'strong', 'record', 'boom', 'nvidia'];
const NEWS_NEGATIVE = ['crash', 'tumble', 'plunge', 'drop', 'fall', 'sink', 'sell-off', 'profit-taking', 'weak', 'downgrade', 'sell', 'underweight', 'risk', 'peak', 'unravel', 'decline', 'loss', 'cut', 'slump', 'tumbles'];

interface NewsSentiment {
  score: number;
  headlines: string[];
  updatedAt: number;
  positive?: number;
  negative?: number;
  fetchedAt?: number;
  recentCount?: number;
  source?: string;
}

let newsSentiment: NewsSentiment = { score: 0, headlines: [], updatedAt: 0 };

async function fetchNewsSentiment() {
  // Try Bing News RSS first (reliable, English headlines)
  try {
    const url = 'https://www.bing.com/news/search?q=SK+hynix+HBM&format=rss';
    const xml = await withRetry(() => fetchText(url));
    const parsed = parseGoogleNewsRss(xml, NEWS_POSITIVE, NEWS_NEGATIVE, { limit: 15, maxAgeHours: 168 });
    if (parsed.headlines.length > 0) {
      newsSentiment = {
        score: parsed.score,
        headlines: parsed.headlines.slice(0, 5),
        positive: (parsed as any).positive,
        negative: (parsed as any).negative,
        updatedAt: parsed.latestPublishedAt || 0,
        fetchedAt: Date.now(),
        recentCount: (parsed as any).recentCount || 0,
        source: 'bing',
      };
      markSourceHealthy('news', {
        updatedAt: parsed.latestPublishedAt || Date.now(),
        detail: `${(newsSentiment as any).recentCount || newsSentiment.headlines.length}条(Bing)`,
      });
      return;
    }
  } catch (e) {
    console.error('[news] Bing RSS failed:', e.message);
  }

  // Fallback: try Yahoo Finance RSS
  try {
    const url = 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=000660.KS&region=KR&lang=ko-KR';
    const xml = await withRetry(() => fetchText(url));
    const parsed = parseGoogleNewsRss(xml, NEWS_POSITIVE, NEWS_NEGATIVE, { limit: 15, maxAgeHours: 168 });
    if (parsed.headlines.length > 0) {
      newsSentiment = {
        score: parsed.score,
        headlines: parsed.headlines.slice(0, 5),
        positive: (parsed as any).positive,
        negative: (parsed as any).negative,
        updatedAt: parsed.latestPublishedAt || 0,
        fetchedAt: Date.now(),
        recentCount: (parsed as any).recentCount || 0,
        source: 'yahoo',
      };
      markSourceHealthy('news', {
        updatedAt: parsed.latestPublishedAt || Date.now(),
        detail: `${(newsSentiment as any).recentCount || newsSentiment.headlines.length}条(Yahoo)`,
      });
    }
  } catch (e) {
    console.error('[news] Yahoo RSS failed:', e.message);
  }
}

function factorNewsSentiment() {
  if (!newsSentiment.updatedAt) return { score: 0, weight: 0, detail: '暂无新闻数据' };
  // Weight by article freshness instead of fetch time.
  const age = (Date.now() - newsSentiment.updatedAt) / 3600000;
  const weight = age < 24 ? 0.6 : age < 72 ? 0.3 : 0.1;

  const score = clampScore(newsSentiment.score);
  const topHeadline = newsSentiment.headlines[0] || '';
  return {
    category: 'news', label: '新闻情绪',
    score: Math.round(score * 10) / 10, weight,
    detail: `近7天 正面${(newsSentiment as any).positive}条 负面${(newsSentiment as any).negative}条 | ${topHeadline.slice(0, 30)}...`
  };
}

// Fetch news on startup and every 30 minutes
fetchNewsSentiment();
scheduler.setInterval(() => { fetchNewsSentiment(); }, 1800000);

function generateFactorSummary(factors: Factor[], composite: number) {
  const parts = [];
  const bullish = factors.filter(f => f.score > 2);
  const bearish = factors.filter(f => f.score < -2);
  const extreme = factors.filter(f => Math.abs(f.score) > 6);

  if (composite > 5) parts.push('综合偏多');
  else if (composite > 2) parts.push('综合略偏多');
  else if (composite < -5) parts.push('综合偏空');
  else if (composite < -2) parts.push('综合略偏空');
  else parts.push('综合中性');

  if (bullish.length) parts.push(`${bullish.map(f => f.label).join('、')}利多`);
  if (bearish.length) parts.push(`${bearish.map(f => f.label).join('、')}利空`);
  if (extreme.length) parts.push(`注意${extreme.map(f => f.label).join('、')}极端值`);

  return parts.join('，');
}

function calcAtrPctFromCandles(candles: Candle[], period: number = 14) {
  if (!candles || candles.length <= period) return 0;
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const candle = candles[i];
    const prev = candles[i - 1];
    if (!candle || !prev) continue;
    atrSum += Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - prev.close),
      Math.abs(candle.low - prev.close),
    );
  }
  const lastClose = candles[candles.length - 1].close || 0;
  return lastClose ? atrSum / period / lastClose * 100 : 0;
}

function calcFactorConsensus(factors: Factor[]) {
  if (!factors || !factors.length) return 0;
  const bullish = factors.filter(f => f.score > 2).length;
  const bearish = factors.filter(f => f.score < -2).length;
  return Math.abs(bullish - bearish) / factors.length;
}

function calcScoreConsensus(scores: number[]) {
  const values = Object.values(scores || {}).filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  if (!values.length) return 0;
  const bullish = values.filter(value => value > 2).length;
  const bearish = values.filter(value => value < -2).length;
  return Math.abs(bullish - bearish) / values.length;
}

function applyRiskToStrategy(strategy: Strategy, risk: RiskOverlay, context: Record<string, unknown> = {}) {
  const next = {
    ...strategy,
    risk,
    regime: (context as any).regime,
    marketContext: (context as any).marketContext,
    basis: (context as any).basis,
    positionSize: `${risk.positionPct}%`,
    maxSingleLoss: `${risk.maxSingleLossPct}%`,
    maxDailyLoss: `${risk.maxDailyLossPct}%`,
    openingStatus: risk.blocked ? '禁止新开仓' : risk.action === 'flat' ? '等待信号' : risk.action === 'reduce' ? '只允许缩量开仓' : '正常',
  } as any;

  if (risk.blocked && next.direction !== '观望') {
    next.blockedDirection = next.direction;
    next.direction = '观望';
    next.confidence = Math.min(next.confidence, 35);
    next.warnings = [...risk.reasons, ...next.warnings];
    next.reasoning = [`风控阻断 — ${risk.reasons.join('；')}`, ...next.reasoning];
  } else if (risk.action === 'reduce') {
    if (next.direction === '做多') next.direction = '轻仓做多';
    if (next.direction === '做空') next.direction = '轻仓做空';
    next.warnings = [...risk.warnings, ...next.warnings];
  } else if (risk.warnings.length) {
    next.warnings = [...risk.warnings, ...next.warnings];
  }

  if (next.direction !== '观望') next.leverage = risk.leverageCap;
  return next;
}

// News sentiment endpoint
app.get('/api/news', (req, res) => {
  res.json(newsSentiment);
});

app.post('/api/news/refresh', async (req, res) => {
  await fetchNewsSentiment();
  res.json(newsSentiment);
});

// Use new domain module for /api/factors
app.get('/api/factors', (req, res) => {
  try {
    const { tf, rangeSec, intervalSec } = getTimeframeConfig((req.query as any).tf || 'm5');
    const profileKey = normalizeProfileTimeframe(tf);
    const profileState = getActiveTimeframeState(profileKey);
    const now = Math.floor(Date.now() / 1000);
    
    // Get Binance data as primary source
    const binanceTicks = selectBinanceRange.all(now - rangeSec, now) as BinanceTickData[];
    const binanceLatest = selectBinanceLatest.get();
    const binanceFreshness = binanceLatest
      ? classifyObservationAge({ nowSec: now, exchangeTs: (binanceLatest as any).ts, maxAgeSec: 120 })
      : { eligible: false, ageSec: null, quality: 'stale' as const };
    
    // Get Naver data as fallback
    const naverTicks = selectRange.all(now - rangeSec, now) as TickData[];
    
    // Use Binance candles if available, otherwise fall back to Naver
    const binanceCandles = binanceTicks.length >= 10 
      ? buildBinanceCandlesFromTicks(binanceTicks, intervalSec) 
      : [];
    const naverCandles = naverTicks.length >= 10 
      ? buildCandlesFromTicks(naverTicks, intervalSec) 
      : [];
    
    // Primary: Binance, Fallback: Naver
    const candles = binanceCandles.length >= 10 ? binanceCandles : naverCandles;
    const dataSource = binanceCandles.length >= 10 ? 'binance' : 'naver';
    
    if (candles.length < 2) {
      return res.json({
        factors: [],
        composite: 0,
        direction: 'neutral',
        rawConfidence: 0,
        confidence: 0,
        dataSource,
        timeframeProfile: summarizeTimeframeState(profileState),
        backtestCalibration: currentBacktestCalibration(profileKey),
      });
    }
    
    const indicators = calculateAllIndicators(candles);
    
    // Get sentiment data
    const sentimentRows = selectSentimentRange.all(now - rangeSec, now) as any[];
    const latestSentimentCandidate = sentimentRows[sentimentRows.length - 1];
    const sentimentFreshness = latestSentimentCandidate
      ? classifyObservationAge({ nowSec: now, exchangeTs: latestSentimentCandidate.ts, maxAgeSec: 7200 })
      : { eligible: false };
    const latestSentiment = sentimentFreshness.eligible ? latestSentimentCandidate : undefined;
    const previousSentiment = sentimentFreshness.eligible ? sentimentRows[sentimentRows.length - 2] : undefined;
    
    // Get price data
    const naverLatest = selectLatest.get();
    const naverPrice = naverLatest ? (naverLatest as any).price : 0;
    const binancePrice = binanceFreshness.eligible ? (binanceLatest as any).price : undefined;
    const latestClose = candles[candles.length - 1]?.close || 0;
    const previousClose = candles[candles.length - 2]?.close || 0;
    const latestOi = latestSentiment?.oi_value || latestSentiment?.open_interest;
    const previousOi = previousSentiment?.oi_value || previousSentiment?.open_interest;
    
    const result = calculateAllFactors({
      candles,
      fundingRate: binanceFreshness.eligible ? (binanceLatest as any).funding_rate || 0 : undefined,
      krwUsd: krwUsdRate,
      prevKrwUsd: (selectFxAtOrBefore.get(now - Math.max(intervalSec * 12, 3600)) as any)?.mid,
      naverPrice,
      binancePrice,
      fxRate: krwUsdRate,
      rsi: indicators.latest.rsi,
      macdHist: indicators.latest.macd.histogram,
      support: indicators.support,
      resistance: indicators.resistance,
      longRatio: latestSentiment?.ls_ratio > 0 ? latestSentiment.ls_ratio : undefined,
      buyVol: latestSentiment?.taker_buy_vol > 0 ? latestSentiment.taker_buy_vol : undefined,
      sellVol: latestSentiment?.taker_sell_vol > 0 ? latestSentiment.taker_sell_vol : undefined,
      oiChange: latestOi > 0 && previousOi > 0
        ? (latestOi - previousOi) / previousOi * 100
        : undefined,
      priceChange: latestOi > 0 && previousOi > 0 && previousClose > 0
        ? (latestClose - previousClose) / previousClose * 100
        : undefined,
      sentimentRows: sentimentRows.length > 0 ? sentimentRows : undefined,
      newsScore: newsSentiment.score || 0,
      newsPositive: (newsSentiment as any).positive || 0,
      newsNegative: (newsSentiment as any).negative || 0,
      newsTopHeadline: newsSentiment.headlines?.[0] || '',
      weights: profileState.weights,
      hasRealVolume: dataSource === 'binance',
      directionThreshold: profileState.params.entryThreshold * profileState.profile.entryThresholdMultiplier,
    });
    const rawConfidence = result.confidence;
    
    // Calculate market context
    const nowMs = Date.now();
    const koreaSession = getKoreaSessionState(nowMs);
    const fundingCountdown = getFundingCountdown({
      nowMs,
      nextFundingTimeMs: (binanceLatest as any)?.next_funding_time ? (binanceLatest as any).next_funding_time * 1000 : undefined,
    });
    const eventWindow = getEventWindow(nowMs);
    
    // Calculate ATR for regime
    const atrPct = candles.length >= 14
      ? (() => {
          const atrs = [];
          for (let i = 1; i < candles.length; i++) {
            const tr = Math.max(
              candles[i].high - candles[i].low,
              Math.abs(candles[i].high - candles[i - 1].close),
              Math.abs(candles[i].low - candles[i - 1].close)
            );
            atrs.push(tr);
          }
          const atr14 = atrs.slice(-14).reduce((a, b) => a + b, 0) / 14;
          return (atr14 / latestClose) * 100;
        })()
      : 0;
    
    // Calculate consensus
    const positiveFactors = result.factors.filter((f: any) => f.score > 0).length;
    const negativeFactors = result.factors.filter((f: any) => f.score < 0).length;
    const consensus = result.factors.length > 0
      ? Math.max(positiveFactors, negativeFactors) / result.factors.length
      : 0;
    
    // Derive regime
    const regime = deriveRegime({
      composite: result.composite,
      consensus,
      eventStatus: eventWindow.status,
      basisZScore: 0,
      atrPct,
    });
    
    // Build basis snapshot
    const spotTicks = selectRange.all(now - 86400, now) as TickData[];
    const basisSeries = alignBasisSeries({ spotTicks: spotTicks as any, binanceTicks: binanceTicks as any, fxRate: krwUsdRate });
    const basis = computeBasisSnapshot(basisSeries);
    
    // Build risk overlay
    const risk = buildRiskOverlay({
      direction: result.direction,
      atrPct,
      volatilityScore: result.factors.find((f: any) => f.category === 'volatility')?.score || 0,
      fundingRate: binanceFreshness.eligible ? (binanceLatest as any).funding_rate || 0 : 0,
      eventStatus: eventWindow.status,
      basisZScore: basis.zScore,
      regimeMode: regime.mode,
    });

    const confidenceCalibration = calibrateSignalConfidence({
      rawConfidence,
      composite: result.composite,
      direction: result.direction,
      factors: result.factors,
      indicators: indicators.latest,
      currentPrice: latestClose,
      backtestCalibration: currentBacktestCalibration(profileKey),
    });
    const calibratedResult = {
      ...result,
      rawConfidence,
      confidence: confidenceCalibration.confidence,
    };

    // Generate strategy recommendation
    const strategy = generateStrategy({
      factors: calibratedResult.factors,
      composite: calibratedResult.composite,
      indicators: indicators.latest,
      candles,
      support: indicators.support,
      resistance: indicators.resistance,
      naverPrice,
      binancePrice,
      fundingRate: binanceFreshness.eligible ? (binanceLatest as any).funding_rate || 0 : 0,
      eventStatus: eventWindow.status,
      basisZScore: basis.zScore,
      atrPct,
      entryThreshold: profileState.params.entryThreshold * profileState.profile.entryThresholdMultiplier,
      calibratedConfidence: confidenceCalibration.confidence,
    });

    res.json({
      tf,
      dataSource,
      ...calibratedResult,
      timeframeProfile: summarizeTimeframeState(profileState),
      backtestCalibration: currentBacktestCalibration(profileKey),
      confidenceCalibration,
      strategy,
      marketContext: {
        koreaSession,
        fundingCountdown,
        eventWindow,
        regime,
        basis: {
          ready: basis.ready,
          currentBasisPct: basis.currentBasisPct,
          zScore: basis.zScore,
          state: basis.state,
          label: basis.label,
        },
        risk,
        atrPct: Math.round(atrPct * 100) / 100,
      },
    });
  } catch (err) {
    console.error('[factors] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
//  Backtesting Engine
// ══════════════════════════════════════════
const DEFAULT_WEIGHTS = {
  momentum: 0.9, funding: 0.75, volume: 0.65, volatility: 0.55,
  fx: 0.4, premium: 0.7, indicator: 0.6, structure: 0.5,
  lsRatio: 0.7, takerVol: 0.65, openInterest: 0.55,
  lsTrend: 0.6, whale: 0.75, news: 0.5
};

// Active optimized weights and params — used by strategy & factors API
let activeTimeframeStates = createInitialTimeframeStates(DEFAULT_WEIGHTS);
let optimizeRunning = false;

function getActiveTimeframeState(tf: string | undefined | null): TimeframeState {
  return activeTimeframeStates[normalizeProfileTimeframe(tf)];
}

function currentBacktestCalibration(tf: string | undefined | null): BacktestCalibration {
  return getActiveTimeframeState(tf).calibration;
}

function updateBacktestCalibration(tf: string | undefined | null, metrics: BacktestMetrics | null | undefined): BacktestCalibration {
  const state = getActiveTimeframeState(tf);
  state.calibration = buildBacktestCalibration(metrics, new Date().toISOString());
  state.optimizeTime = Date.now();
  return state.calibration;
}

function allTimeframeSummaries() {
  return {
    m1: summarizeTimeframeState(activeTimeframeStates.m1),
    m5: summarizeTimeframeState(activeTimeframeStates.m5),
    m15: summarizeTimeframeState(activeTimeframeStates.m15),
    h1: summarizeTimeframeState(activeTimeframeStates.h1),
  };
}

function toDomainBacktestParams(params: Record<string, unknown>, weights: Record<string, number>): BacktestParams {
  return {
    threshold: (params.entryThreshold ?? params.threshold) as number,
    holdBars: params.holdBars as number,
    stopLossPct: params.stopLossPct as number,
    takeProfitPct: params.takeProfitPct as number,
    leverage: params.leverage as number,
    weights: { ...weights },
    timeframe: normalizeProfileTimeframe((params.tf as string) || 'm5'),
    fxTicks: (params.fxTicks as any[]) || [],
  };
}

function scoreBacktestResult(metrics: BacktestMetrics) {
  return (metrics.sharpe || 0) * Math.sqrt(metrics.totalTrades) *
    (metrics.winRate / 100) - metrics.maxDrawdown / 10;
}

async function autoOptimize(tfInput: string = 'm5') {
  if (optimizeRunning) return;
  optimizeRunning = true;
  try {
    const profileKey = normalizeProfileTimeframe(tfInput);
    const profileState = getActiveTimeframeState(profileKey);
    const tfConfig = getTimeframeConfig(profileKey);
    const now = Math.floor(Date.now() / 1000);
    const rangeSec = tfConfig.rangeSec;
    const ticks = selectRange.all(now - rangeSec, now) as TickData[];
    const candles = ticks.length > 1 ? buildCandlesFromTicks(ticks, tfConfig.intervalSec) : [];
    const binanceWindow = selectBinanceRange.all(now - rangeSec, now) as BinanceTickData[];
    const sentimentData = selectSentimentRange.all(now - rangeSec, now) as BacktestSentimentRow[];
    const fxWindow = selectFxRange.all(now - rangeSec, now) as any[];

    if (candles.length < 50) {
      console.log('[optimize] not enough data, skipping');
      return;
    }

    // Train/test split: 70% train, 30% test
    const splitIdx = Math.floor(candles.length * 0.7);
    const trainCandles = candles.slice(0, splitIdx);
    const testCandles = candles.slice(splitIdx);
    const trainBinance = binanceWindow.filter(t => (t as any).ts <= trainCandles[trainCandles.length - 1].time);
    const testBinance = binanceWindow.filter(t => (t as any).ts > trainCandles[trainCandles.length - 1].time);
    const trainSentiment = sentimentData.filter(t => (t as any).ts <= trainCandles[trainCandles.length - 1].time);
    const testSentiment = sentimentData.filter(t => (t as any).ts > trainCandles[trainCandles.length - 1].time);

    // Grid search on training set
    let bestScore = null;
    let bestWeights = { ...profileState.weights };
    let bestParams = { ...profileState.params };

    const thresholds = profileState.profile.thresholdCandidates;
    const holdOptions = profileState.profile.holdBarsCandidates;
    const weightOptions = [0.3, 0.5, 0.7, 0.9];
    const factorKeys = Object.keys(DEFAULT_WEIGHTS);

    for (const th of thresholds) {
      for (const hold of holdOptions) {
        const result = backtestEngine(trainCandles, trainBinance as any, trainSentiment as any,
          toDomainBacktestParams({ ...profileState.params, entryThreshold: th, holdBars: hold, leverage: profileState.params.leverage, tf: profileKey, fxTicks: fxWindow }, profileState.weights));
        if (result.metrics && result.metrics.totalTrades >= profileState.profile.minSampleTrades) {
          const score = scoreBacktestResult(result.metrics);
          if (bestScore == null || score > bestScore) {
            bestScore = score;
            bestParams = { ...bestParams, entryThreshold: th, holdBars: hold };
          }
        }
      }
    }

    if (bestScore == null) {
      bestScore = 0;
      bestParams = { ...profileState.params };
      console.log('[optimize] no eligible threshold/hold config, keeping active params');
    }

    // Optimize weights on training set
    for (const key of factorKeys) {
      let bestForFactor = DEFAULT_WEIGHTS[key];
      let bestFactorScore = -Infinity;
      for (const w of weightOptions) {
        const testWeights = { ...profileState.weights, [key]: w };
        const result = backtestEngine(trainCandles, trainBinance as any, trainSentiment as any,
          toDomainBacktestParams({ ...bestParams, tf: profileKey, fxTicks: fxWindow }, testWeights));
        if (result.metrics && result.metrics.totalTrades >= profileState.profile.minSampleTrades) {
          const score = scoreBacktestResult(result.metrics);
          if (score > bestFactorScore) {
            bestFactorScore = score;
            bestForFactor = w;
          }
        }
      }
      bestWeights[key] = bestForFactor;
    }

    // Validate on training set
    const optimizedParams = toDomainBacktestParams({ ...bestParams, tf: profileKey, fxTicks: fxWindow }, bestWeights);
    const trainResult = backtestEngine(trainCandles, trainBinance as any, trainSentiment as any, optimizedParams);
    // Validate on test set (out-of-sample)
    const testResult = backtestEngine(testCandles, testBinance as any, testSentiment as BacktestSentimentRow[], optimizedParams);
    // Full dataset validation
    const fullResult = backtestEngine(candles, binanceWindow as BacktestBinanceTick[], sentimentData as BacktestSentimentRow[], optimizedParams);

    profileState.weights = bestWeights;
    profileState.params = { ...profileState.params, ...bestParams };
    profileState.optimizeTime = Date.now();
    updateBacktestCalibration(profileKey, testResult.metrics);

    console.log(`[optimize:${profileKey}] done | score=${bestScore.toFixed(2)} | th=${(bestParams as any).entryThreshold} hold=${(bestParams as any).holdBars}`);
    console.log(`[optimize] weights: ${Object.entries(bestWeights).map(([k,v]) => `${k}=${v}`).join(' ')}`);
    if (trainResult.metrics) {
      console.log(`[optimize] train: return=${trainResult.metrics.totalReturn}% win=${trainResult.metrics.winRate}% sharpe=${trainResult.metrics?.sharpe || 0}`);
    }
    if (testResult.metrics) {
      console.log(`[optimize] test:  return=${testResult.metrics.totalReturn}% win=${testResult.metrics.winRate}% sharpe=${testResult.metrics?.sharpe || 0}`);
    }
  } catch (err) {
    console.error('[optimize] error:', err.message);
  } finally {
    optimizeRunning = false;
  }
}

async function autoOptimizeAllTimeframes() {
  for (const tf of ['m1', 'm5', 'm15', 'h1'] as TimeframeKey[]) {
    await autoOptimize(tf);
  }
}

function calcCandlesForWindow(ticks: TickData[], from: number, to: number, intervalSec: number) {
  const windowTicks = ticks.filter(t => (t as any).ts >= from && (t as any).ts < to);
  return windowTicks.length > 1 ? buildCandlesFromTicks(windowTicks, intervalSec) : [];
}

// Use imported backtest functions from domain module
const legacyBacktestEngine = backtestEngine;
const legacyOptimizeWeights = optimizeWeights;

app.get('/api/backtest', async (req, res) => {
  try {
    const tfConfig = getTimeframeConfig((req.query as any).tf || 'm5');
    const tf = tfConfig.tf;
    const profileKey = normalizeProfileTimeframe(tf);
    const profileState = getActiveTimeframeState(profileKey);
    const rangeSec = tfConfig.rangeSec;
    const intervalSec = tfConfig.intervalSec;
    const optimize = (req.query as any).optimize === 'true';
    let parsedParams;
    try {
      parsedParams = parseBacktestParams(req.query as any, profileState.params);
    } catch (err) {
      return res.status(400).json({
        error: {
          code: 'INVALID_BACKTEST_PARAMS',
          message: 'Invalid backtest parameters',
        },
      });
    }
    const { entryThreshold, holdBars, stopLossPct, takeProfitPct, leverage } = parsedParams;

    const now = Math.floor(Date.now() / 1000);
    
    // Get Binance data as primary for backtest (USD prices)
    const binanceTicks = selectBinanceRange.all(now - rangeSec, now) as BinanceTickData[];
    const binanceCandles = binanceTicks.length >= 50 
      ? buildBinanceCandlesFromTicks(binanceTicks, intervalSec) 
      : [];
    
    // Fallback to Naver if Binance data insufficient
    const naverTicks = selectRange.all(now - rangeSec, now) as TickData[];
    const naverCandles = naverTicks.length > 1 ? buildCandlesFromTicks(naverTicks, intervalSec) : [];
    
    // Use Binance candles if available, otherwise Naver
    const candles = binanceCandles.length >= 50 ? binanceCandles : naverCandles;
    const dataSource = binanceCandles.length >= 50 ? 'binance' : 'naver';

    if (candles.length < 50) {
      return res.json({
        error: '数据不足，无法进行回测（至少需要 50 根 K 线）',
        metrics: null, trades: [], equityCurve: [], factorHistory: []
      });
    }

    const sentimentData = selectSentimentRange.all(now - rangeSec, now) as BacktestSentimentRow[];
    const fxWindow = selectFxRange.all(now - rangeSec, now) as any[];

    // Train/test split (70/30)
    const splitIdx = Math.floor(candles.length * 0.7);
    const trainCandles = candles.slice(0, splitIdx);
    const testCandles = candles.slice(splitIdx);
    const trainBinance = binanceTicks.filter(t => t.ts <= trainCandles[trainCandles.length - 1].time);
    const testBinance = binanceTicks.filter(t => t.ts > trainCandles[trainCandles.length - 1].time);
    const trainSentiment = sentimentData.filter(t => (t as any).ts <= trainCandles[trainCandles.length - 1].time);
    const testSentiment = sentimentData.filter(t => (t as any).ts > trainCandles[trainCandles.length - 1].time);

    if (optimize) {
      await autoOptimize(profileKey);
      const optimizedState = getActiveTimeframeState(profileKey);
      // Run with optimization (closed-loop)
      const optimizedParams = toDomainBacktestParams({ ...optimizedState.params, leverage, tf: profileKey, fxTicks: fxWindow }, optimizedState.weights);
      const fullResult = backtestWithOptimization(candles, binanceTicks as BacktestBinanceTick[], sentimentData as BacktestSentimentRow[], optimizedParams);
      const trainResult = backtestEngine(trainCandles, trainBinance as any, trainSentiment as any, optimizedParams);
      const testResult = backtestEngine(testCandles, testBinance as any, testSentiment as BacktestSentimentRow[], optimizedParams);
      const calibration = updateBacktestCalibration(profileKey, testResult.metrics);
      
      // Apply optimized weights if they improve performance
      if (fullResult.optimization?.optimizedMetrics?.sharpe > fullResult.metrics.sharpe + 0.1) {
        Object.assign(optimizedState.weights, fullResult.optimization.optimizedWeights);
        optimizedState.optimizeTime = Date.now();
        console.log(`[backtest] weights optimized: sharpe ${fullResult.metrics.sharpe} → ${fullResult.optimization.optimizedMetrics.sharpe}`);
      }
      
      res.json({
        params: { tf, optimize: true, ...optimizedState.params },
        ...fullResult,
        train: { metrics: trainResult.metrics, trades: trainResult.trades?.length },
        test: { metrics: testResult.metrics, trades: testResult.trades?.length },
        timeframeProfile: summarizeTimeframeState(optimizedState),
        activeWeights: { ...optimizedState.weights },
        activeParams: { ...optimizedState.params },
        activeProfiles: allTimeframeSummaries(),
        backtestCalibration: calibration,
        optimizeTime: optimizedState.optimizeTime ? new Date(optimizedState.optimizeTime).toISOString() : null,
      });
    } else {
      const requestedParams = toDomainBacktestParams(
        { entryThreshold, holdBars, stopLossPct, takeProfitPct, leverage, tf: profileKey, fxTicks: fxWindow }, profileState.weights);
      const fullResult = backtestEngine(candles, binanceTicks as BacktestBinanceTick[], sentimentData as BacktestSentimentRow[], requestedParams);
      const trainResult = backtestEngine(trainCandles, trainBinance as any, trainSentiment as any, requestedParams);
      const testResult = backtestEngine(testCandles, testBinance as any, testSentiment as BacktestSentimentRow[], requestedParams);
      const calibration = updateBacktestCalibration(profileKey, testResult.metrics);
      res.json({
        params: { tf, entryThreshold, holdBars, stopLossPct, takeProfitPct, leverage, dataSource },
        ...fullResult,
        train: { metrics: trainResult.metrics, trades: trainResult.trades?.length },
        test: { metrics: testResult.metrics, trades: testResult.trades?.length },
        timeframeProfile: summarizeTimeframeState(profileState),
        activeWeights: { ...profileState.weights },
        activeParams: { ...profileState.params },
        activeProfiles: allTimeframeSummaries(),
        backtestCalibration: calibration,
      });
    }
  } catch (err) {
    console.error('[backtest] error:', err.message);
    res.status(500).json({ error: 'BACKTEST_FAILED' });
  }
});

// ══════════════════════════════════════════
//  Contract Calculator API
// ══════════════════════════════════════════
app.post('/api/calculate', express.json(), (req, res) => {
  try {
    const result = calculateContract(req.body);
    res.json(result);
  } catch (err) {
    if (err instanceof ContractValidationError) {
      return res.status(400).json({
        error: { code: 'INVALID_CONTRACT_PARAMS', message: err.message },
      });
    }
    console.error('[calculate] error:', err);
    res.status(500).json({ error: 'CALCULATION_FAILED' });
  }
});

// Get current Binance price for calculator
app.get('/api/binance/price', async (req, res) => {
  try {
    const meta = await binanceMeta();
    res.json({
      price: (meta as any).price,
      markPrice: meta.markPrice,
      indexPrice: meta.indexPrice,
      fundingRate: meta.fundingRate,
      nextFundingTime: meta.nextFundingTime,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: paper trading ──
app.get('/api/paper/account', async (req, res) => {
  try {
    res.json(await buildPaperSummary());
  } catch (err) {
    paperError(res, err);
  }
});

app.patch('/api/paper/account', express.json(), async (req, res) => {
  try {
    const current = getPaperAccount();
    const initialBalance = req.body.initialBalance != null ? Number(req.body.initialBalance) : current.initialBalance;
    const availableBalance = req.body.availableBalance != null ? Number(req.body.availableBalance) : initialBalance;
    const realizedPnl = req.body.realizedPnl != null ? Number(req.body.realizedPnl) : 0;
    if (!Number.isFinite(initialBalance) || initialBalance <= 0) throw new PaperTradeValidationError('初始资产必须大于0');
    if (!Number.isFinite(availableBalance) || availableBalance < 0) throw new PaperTradeValidationError('可用余额不能小于0');
    if (!Number.isFinite(realizedPnl)) throw new PaperTradeValidationError('已实现盈亏必须为有限数字');
    savePaperAccount({ initialBalance, availableBalance, realizedPnl });
    res.json(await buildPaperSummary());
  } catch (err) {
    paperError(res, err);
  }
});

app.get('/api/paper/positions', async (req, res) => {
  try {
    const markPrice = await getPaperMarkPrice();
    res.json({ positions: summarizePaperAccount(getPaperAccount(), readOpenPaperPositions(), markPrice).positions, markPrice });
  } catch (err) {
    paperError(res, err);
  }
});

app.post('/api/paper/orders', express.json(), async (req, res) => {
  try {
    const markPrice = await getPaperMarkPrice();
    const direction = req.body.direction as PaperDirection;
    const entryPrice = req.body.entryPrice != null && Number(req.body.entryPrice) > 0
      ? Number(req.body.entryPrice)
      : markPrice;
    const opened = openPaperPosition(getPaperAccount(), {
      direction,
      entryPrice,
      notional: Number(req.body.notional),
      leverage: Number(req.body.leverage),
      takeProfitPrice: parseOptionalPositive(req.body.takeProfitPrice),
      stopLossPrice: parseOptionalPositive(req.body.stopLossPrice),
      now: Math.floor(Date.now() / 1000),
    });
    const result = insertPaperPosition.run(
      opened.position.direction,
      opened.position.entryPrice,
      opened.position.quantity,
      opened.position.leverage,
      opened.position.margin,
      opened.position.notional,
      opened.position.takeProfitPrice,
      opened.position.stopLossPrice,
      opened.position.openedAt,
    );
    const positionId = Number(result.lastInsertRowid);
    savePaperAccount(opened.account);
    savePaperFill(opened.fill, positionId);
    res.json(await buildPaperSummary(markPrice));
  } catch (err) {
    paperError(res, err);
  }
});

function settlePaperPosition(position: PaperPosition, exitPrice: number, type: 'CLOSE' | 'CLOSE_ALL' | 'TAKE_PROFIT' | 'STOP_LOSS') {
  const closed = closePaperPosition(getPaperAccount(), position, {
    exitPrice,
    type,
    now: Math.floor(Date.now() / 1000),
  });
  savePaperAccount(closed.account);
  closePaperPositionStmt.run('CLOSED', closed.fill.createdAt, position.id);
  savePaperFill(closed.fill, position.id || null);
  return closed.fill;
}

app.post('/api/paper/positions/:id/close', express.json(), async (req, res) => {
  try {
    const row = selectPaperPositionById.get(Number(req.params.id), 'OPEN') as any;
    if (!row) return res.status(404).json({ error: { code: 'PAPER_POSITION_NOT_FOUND', message: '持仓不存在或已平仓' } });
    const markPrice = await getPaperMarkPrice();
    const exitPrice = req.body.exitPrice != null && Number(req.body.exitPrice) > 0 ? Number(req.body.exitPrice) : markPrice;
    settlePaperPosition(mapPaperPosition(row), exitPrice, 'CLOSE');
    res.json(await buildPaperSummary(markPrice));
  } catch (err) {
    paperError(res, err);
  }
});

app.post('/api/paper/positions/close-all', express.json(), async (req, res) => {
  try {
    const markPrice = await getPaperMarkPrice();
    for (const position of readOpenPaperPositions()) {
      settlePaperPosition(position, markPrice, 'CLOSE_ALL');
    }
    res.json(await buildPaperSummary(markPrice));
  } catch (err) {
    paperError(res, err);
  }
});

app.get('/api/paper/fills', (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    res.json({ fills: (selectPaperFills.all(limit) as any[]).map(mapPaperFill) });
  } catch (err) {
    paperError(res, err);
  }
});

async function settleTriggeredPaperPositions() {
  try {
    const markPrice = await getPaperMarkPrice();
    if (!Number.isFinite(markPrice) || markPrice <= 0) return;
    for (const position of readOpenPaperPositions()) {
      const trigger = findTriggeredExit(position, markPrice);
      if (!trigger) continue;
      settlePaperPosition(position, trigger.price, trigger.type);
      console.log(`[paper] ${trigger.type} position=${position.id} price=${trigger.price}`);
    }
  } catch (err) {
    console.error('[paper] trigger check error:', err.message);
  }
}

// ── Timers ──
// Auto-optimize factor weights for every timeframe profile on startup (delayed) and every hour
scheduler.setTimeout(() => { void autoOptimizeAllTimeframes(); }, 5000);
scheduler.setInterval(() => { void autoOptimizeAllTimeframes(); }, 3600000);

// Broadcast full data every 10s during market hours
// Broadcast during market hours, pre-market, and after-hours (all active trading sessions)
scheduler.setInterval(() => { if (isMarketOpen() || isPreMarket() || isAfterHours()) broadcast(); }, 10000);

// When market is closed, still push Binance data every 30s (Binance trades 24/7)
scheduler.setInterval(async () => {
  if (isMarketOpen() || isPreMarket() || isAfterHours()) return;
  try {
    const binance = {};
    const sharedMeta = await binanceMetaWithFallback();
    const [b1, b5, b15, bh] = await Promise.all([
      binanceLine('1m', sharedMeta), binanceLine('5m', sharedMeta),
      binanceLine('15m', sharedMeta), binanceLine('1h', sharedMeta),
    ]);
    (binance as any).m1 = b1; (binance as any).m5 = b5; (binance as any).m15 = b15; (binance as any).h1 = bh;
    // Always update snapshot with latest Binance data
    for (const source of ['naver', 'yahoo']) {
      let previous = source === 'naver'
        ? { ...(await getNaverTimeframesOnly()), source: 'naver', krwUsd: krwUsdRate, serverTime: Date.now(), binance: null }
        : lastSnapshotsBySource.get(source);
      if (!previous && source !== 'naver') {
        const fresh = await getAllTimeframes(source);
        cacheDashboardSnapshot(fresh);
        previous = lastSnapshotsBySource.get((fresh as any).source);
      }
      if (previous) {
        const merged = mergeBinanceIntoSnapshot(previous, binance, Date.now());
        lastSnapshotsBySource.set(merged.source, merged);
      }
    }

    // Push to connected clients
    if (clients.length > 0) {
      const clientsBySource = new Map<string, SSEClient[]>();
      for (const client of clients) {
        const group = clientsBySource.get(client.source) || [];
        group.push(client);
        clientsBySource.set(client.source, group);
      }
      for (const [source, group] of clientsBySource) {
        const snapshot = lastSnapshotsBySource.get(source);
        if (snapshot) {
          const payload = `data: ${JSON.stringify(snapshot)}\n\n`;
          group.forEach(client => client.res.write(payload));
        }
      }
    }
    console.log(`[${new Date().toLocaleTimeString()}] binance-update → ${clients.length} clients`);
  } catch (err) {
    console.error('[binance-broadcast] error:', err.message);
  }
}, 30000);

// Record Naver tick every 60s (always, even outside market hours — captures state)
scheduler.setInterval(() => { recordTick(); }, 60000);

// Record Binance tick every 30s for local fallback
scheduler.setInterval(() => { recordBinanceTick(); }, 30000);

// Check simulated TP/SL against Binance futures price
scheduler.setInterval(() => { void settleTriggeredPaperPositions(); }, 5000);

// Backfill missing Binance ticks every 5 minutes
scheduler.setInterval(() => { backfillBinanceTicks(); }, 300000);

// Fetch Binance sentiment data every 5 minutes
fetchBinanceSentiment();
scheduler.setInterval(() => { fetchBinanceSentiment(); }, 300000);

// ══════════════════════════════════════════
//  New Domain-based API Endpoints
// ══════════════════════════════════════════

const server = app.listen(PORT, () => {
  console.log(`\n  SK Hynix Chart Server (multi-source + SQLite)`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  Sources: ${Object.keys(SOURCES).join(', ')}`);
  const cnt = (countTicks.get() as { cnt: number }).cnt;
  const bnCnt = (countBinanceTicks.get() as { cnt: number }).cnt;
  console.log(`  SQLite ticks: ${cnt} (Naver: ${cnt}, Binance: ${bnCnt})\n`);
  // Record first tick immediately
  recordTick();
  recordBinanceTick();
  backfillBinanceTicks();
  broadcast();
});

const shutdownCoordinator = createShutdownCoordinator({
  stopTimers: () => scheduler.stopAll(),
  stopCollectors: () => {
    binanceRuntime.stop();
    binanceBreaker.stop();
  },
  closeClients: closeSseClients,
  checkpoint: walCheckpoint,
  closeDatabase: () => db.close(),
  closeServer: (done) => server.close(done),
  exit: (code) => process.exit(code),
  log: (message) => console.log(message),
  error: (message, error) => console.error(message, error),
});

process.on('SIGINT', () => { void shutdownCoordinator.shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdownCoordinator.shutdown('SIGTERM'); });
