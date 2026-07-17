// @ts-nocheck
import express, { Request, Response } from 'express';
import https from 'https';
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
const NAVER_CODE: string = '000660';
const KRW_USD_DEFAULT: number = 1544;
let krwUsdRate: number = KRW_USD_DEFAULT;
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
      console.log(`[FX] USD/KRW = ${krwUsdRate} (open.er-api fallback)`);
    }
  } catch (e) {
    console.error(`[FX] open.er-api failed: ${e.message}, using cached ${krwUsdRate}`);
  }
}
// Initial fetch + hourly refresh
fetchExchangeRate();
setInterval(fetchExchangeRate, 3600000);

let clients = [];
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
setInterval(walCheckpoint, 300000);

// Prepared statements
const insertTick = db.prepare('INSERT OR REPLACE INTO ticks (ts, price, prev_close, market_open, after_hours_price, after_hours_session) VALUES (?, ?, ?, ?, ?, ?)');
const selectRange = db.prepare('SELECT ts, price, prev_close, market_open, after_hours_price, after_hours_session FROM ticks WHERE ts >= ? AND ts <= ? ORDER BY ts');
const selectLatest = db.prepare('SELECT ts, price, prev_close, market_open, after_hours_price, after_hours_session FROM ticks ORDER BY ts DESC LIMIT 1');
const countTicks = db.prepare('SELECT COUNT(*) as cnt FROM ticks');
const countAfterHours = db.prepare('SELECT COUNT(*) as cnt FROM ticks WHERE after_hours_price IS NOT NULL');

function fetchJSON<T = any>(url: string): Promise<T> {
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
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
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
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Market hours ──
function isMarketOpen() {
  const kst = new Date(Date.now() + 9 * 3600000);
  const day = kst.getUTCDay();
  if (day === 0 || day === 6) return false;
  const t = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return t >= 540 && t <= 930; // 09:00 - 15:30 KST
}

function isPreMarket() {
  const kst = new Date(Date.now() + 9 * 3600000);
  const day = kst.getUTCDay();
  if (day === 0 || day === 6) return false;
  const t = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return t >= 480 && t < 540; // 08:00 - 09:00 KST
}

function isAfterHours() {
  const kst = new Date(Date.now() + 9 * 3600000);
  const day = kst.getUTCDay();
  if (day === 0 || day === 6) return false;
  const t = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return t > 930 && t <= 1080; // 15:30 - 18:00 KST
}

function getNextOpenTime() {
  const kst = new Date(Date.now() + 9 * 3600000);
  let daysToAdd = 0;
  const day = kst.getUTCDay();
  const t = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  if (day === 0) daysToAdd = 1;
  else if (day === 6) daysToAdd = 2;
  else if (t >= 930) daysToAdd = day === 5 ? 3 : 1;
  const next = new Date(kst);
  next.setUTCDate(next.getUTCDate() + daysToAdd);
  next.setUTCHours(9, 0, 0, 0);
  return next.toISOString().replace('T', ' ').slice(0, 16) + ' KST';
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
    let status = 'missing';
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

// Record a tick to SQLite (only when market is open or after-hours session active)
async function recordTick() {
  try {
    const basic = await naverBasic();

    // Clear cached after-hours when market opens (new trading day)
    if (basic.marketOpen) {
      lastAfterHours = null;
    }

    // Preserve last known after-hours price when API stops returning it
    if (!basic.afterHours && lastAfterHours && !basic.marketOpen) {
      basic.afterHours = lastAfterHours;
    }

    // Update cache when fresh after-hours data arrives
    if (basic.afterHours) {
      lastAfterHours = basic.afterHours;
    }

    // Skip recording if market is fully closed (no regular session, no after-hours)
    if (!basic.marketOpen && !basic.afterHours) {
      return null;
    }
    const ts = Math.floor(Date.now() / 1000);
    const ahPrice = basic.afterHours?.price || null;
    const ahSession = basic.afterHours?.session || null;
    insertTick.run(ts, (basic as any).price, basic.prevClose, basic.marketOpen ? 1 : 0, ahPrice, ahSession);
    markSourceHealthy('naver', {
      updatedAt: ts * 1000,
      detail: `₩${(ahPrice || (basic as any).price).toLocaleString()}`,
    });
    const cnt = countTicks.get().cnt;
    const label = basic.marketOpen ? 'regular' : (ahPrice ? 'after-hours' : 'closed');
    const displayPrice = ahPrice || (basic as any).price;
    console.log(`[tick] ${new Date().toLocaleTimeString()} ${label} price=${displayPrice} (total: ${cnt})`);
    return basic;
  } catch (err) {
    console.error('[tick] error:', err.message);
    return null;
  }
}

// Build candles from SQLite ticks (uses after_hours_price when available)
function buildCandlesFromTicks(ticks, intervalSec) {
  if (!ticks.length) return [];
  const candles = [];
  const effectivePrice = t => t.after_hours_price || (t as any).price;
  let bucket = Math.floor(ticks[0].ts / intervalSec) * intervalSec;
  let o = effectivePrice(ticks[0]), h = o, l = o, c = o, tickCount = 1;

  for (let i = 1; i < ticks.length; i++) {
    const t = ticks[i];
    const b = Math.floor((t as any).ts / intervalSec) * intervalSec;
    const p = effectivePrice(t);
    if (b !== bucket) {
      // Finalize candle with minimum visible body
      if (h === l) { h = o + 1; l = o - 1; } // single-tick candle: give it a tiny body
      candles.push({ time: bucket, open: o, high: h, low: l, close: c, volume: tickCount });
      bucket = b;
      o = p; h = p; l = p; c = p; tickCount = 1;
    } else {
      c = p;
      if (p > h) h = p;
      if (p < l) l = p;
      tickCount++;
    }
  }
  // Last candle
  if (h === l) { h = o + 1; l = o - 1; }
  candles.push({ time: bucket, open: o, high: h, low: l, close: c, volume: tickCount });
  return candles;
}

async function naverChart(interval, range) {
  const basic = await naverBasic();

  // Use cached after-hours when API stops returning it (after trading window closes)
  if (!basic.afterHours && lastAfterHours && !basic.marketOpen) {
    basic.afterHours = lastAfterHours;
  }

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

  const from = now - rangeSec;
  const ticks = selectRange.all(from, now);
  const candles = buildCandlesFromTicks(ticks, intervalSec);

  // Use after-hours price when market is closed but OTC is open
  const displayPrice = (!basic.marketOpen && basic.afterHours) ? basic.afterHours.price : (basic as any).price;

  return {
    source: 'naver',
    candles: candles.length ? candles : [{ time: now, open: displayPrice, high: displayPrice, low: displayPrice, close: displayPrice, volume: 0 }],
    meta: {
      currency: 'KRW', price: displayPrice, previousClose: basic.prevClose,
      exchangeName: 'KOSPI', ...metaCommon(), marketOpen: basic.marketOpen,
      tickCount: ticks.length,
      afterHours: basic.afterHours,
    }
  };
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
let latestBinanceFundingTimeMs = 0;

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
  try {
    const meta = await binanceMeta();
    const ts = Math.floor(Date.now() / 1000);
    insertBinanceTick.run(ts, (meta as any).price, meta.markPrice, meta.indexPrice, meta.fundingRate, meta.high24h, meta.low24h, meta.volume24h);
    latestBinanceFundingTimeMs = meta.nextFundingTime || 0;
    markSourceHealthy('binance', {
      updatedAt: ts * 1000,
      detail: `$${Math.round((meta as any).price * 100) / 100}`,
    });
    const cnt = countBinanceTicks.get().cnt;
    console.log(`[binance-tick] ${new Date().toLocaleTimeString()} price=$${(meta as any).price} (total: ${cnt})`);
    return meta;
  } catch (err) {
    console.error('[binance-tick] error:', err.message);
    return null;
  }
}

function buildBinanceCandlesFromTicks(ticks, intervalSec) {
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

function getBinanceLocal(interval) {
  const now = Math.floor(Date.now() / 1000);
  let rangeSec, intervalSec;
  switch (interval) {
    case '1m':  rangeSec = 3*86400;    intervalSec = 60; break;    // 3天
    case '5m':  rangeSec = 7*86400;    intervalSec = 300; break;   // 7天
    case '15m': rangeSec = 30*86400;   intervalSec = 900; break;   // 30天
    case '1h':  rangeSec = 90*86400;   intervalSec = 3600; break;  // 90天
    default:    rangeSec = 7*86400;    intervalSec = 300;
  }
  const ticks = selectBinanceRange.all(now - rangeSec, now);
  const candles = buildBinanceCandlesFromTicks(ticks, intervalSec);
  const latest = selectBinanceLatest.get();
  const line = candles.map(k => ({ time: k.time, value: k.close }));
  return {
    line,
    candles,
    meta: latest ? {
      price: (latest as any).price,
      markPrice: (latest as any).mark_price,
      indexPrice: (latest as any).index_price,
      fundingRate: (latest as any).funding_rate,
      high24h: (latest as any).high_24h,
      low24h: (latest as any).low_24h,
      volume24h: (latest as any).volume_24h,
    } : null,
    local: true,
    tickCount: ticks.length,
  };
}

async function binanceFetch(path) {
  let lastErr;
  for (const base of BINANCE_ENDPOINTS) {
    try {
      const data = await fetchJSON(`${base}${path}`);
      // Check for error response
      if (data && typeof data === 'object' && data.code !== undefined && data.code !== 0) {
        throw new Error(`Binance API error: ${data.msg || JSON.stringify(data)}`);
      }
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All Binance endpoints failed');
}

async function binanceKlines(interval, limit) {
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
    const cnt = countSentimentRows.get().cnt;
    console.log(`[sentiment] rows=${merged.length} latest LS=${latest.ls_ratio} Taker=${latest.taker_ratio} OI=${latest.open_interest} Top=${(latest as any).top_ls_ratio} (total: ${cnt})`);
  } catch (err) {
    console.error('[sentiment] fetch error:', err.message);
  }
}

// Map our timeframe to Binance interval + limit
function binanceParams(interval) {
  switch (interval) {
    case '1m':  return { interval: '1m',  limit: 1440 };   // ~3d
    case '5m':  return { interval: '5m',  limit: 2016 };   // ~7d
    case '15m': return { interval: '15m', limit: 2880 };   // ~30d
    case '1h':  return { interval: '1h',  limit: 2160 };   // ~90d
    default:    return { interval: '5m',  limit: 2016 };
  }
}

async function binanceLine(interval, sharedMeta) {
  try {
    const { interval: bnInterval, limit } = binanceParams(interval);
    const klines = await binanceKlines(bnInterval, limit);
    // Return as line points (close prices)
    const line = klines.map(k => ({ time: k.time, value: k.close }));
    return { line, meta: sharedMeta, candles: klines };
  } catch (err) {
    console.error(`[binance] API failed for ${interval}: ${err.message}, using local fallback`);
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

async function getAllTimeframes(source = 'yahoo') {
  let m1, m5, m15, h1;

  if (source === 'naver') {
    // Call naverBasic() once, build all timeframes from SQLite ticks
    const basic = await naverBasic();
    // Use cached after-hours when API stops returning it
    if (!basic.afterHours && lastAfterHours && !basic.marketOpen) {
      basic.afterHours = lastAfterHours;
    }
    const now = Math.floor(Date.now() / 1000);
  const displayPrice = (!basic.marketOpen && basic.afterHours) ? (basic.afterHours as any).price : (basic as any).price;
    const makeResult = (rangeSec, intervalSec) => {
      const ticks = selectRange.all(now - rangeSec, now);
      const candles = buildCandlesFromTicks(ticks, intervalSec);
      return {
        source: 'naver',
        candles: candles.length ? candles : [{ time: now, open: displayPrice, high: displayPrice, low: displayPrice, close: displayPrice, volume: 0 }],
        meta: { currency: 'KRW', price: displayPrice, previousClose: basic.prevClose, exchangeName: 'KOSPI', ...metaCommon(), marketOpen: basic.marketOpen, tickCount: ticks.length, afterHours: basic.afterHours }
      };
    };
    m1 = makeResult(3*86400, 60);      // 3天
    m5 = makeResult(7*86400, 300);      // 7天
    m15 = makeResult(30*86400, 900);    // 30天
    h1 = makeResult(90*86400, 3600);    // 90天
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
    const sharedMeta = await binanceMeta();
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
    res.json(data);
  } catch (err) {
    console.error(`[${source}] Fetch error:`, err.message);
    if (source !== 'naver') {
      try {
        console.log('Trying naver fallback...');
        const data = await getAllTimeframes('naver');
        (data as any).fallbackFrom = source;
        res.json(data);
        return;
      } catch (e2) { console.error('[naver] Fallback also failed:', e2.message); }
    }
    res.status(500).json({ error: err.message });
  }
});

// ── API: sources ──
app.get('/api/sources', (req, res) => {
  const cnt = countTicks.get().cnt;
  res.json([
    { id: 'yahoo', name: 'Yahoo Finance', desc: 'K线完整，延迟~20min', status: 'ok' },
    { id: 'naver', name: 'Naver Finance', desc: `实时报价，本地${cnt}条tick`, status: 'ok' },
  ]);
});

// ── API: tick stats ──
app.get('/api/ticks', (req, res) => {
  const cnt = countTicks.get().cnt;
  const latest = selectLatest.get();
  const bnCnt = countBinanceTicks.get().cnt;
  const bnLatest = selectBinanceLatest.get();
  res.json({
    naver: { count: cnt, latest: latest || null },
    binance: { count: bnCnt, latest: bnLatest || null },
  });
});

// ── SSE ──
let currentSource = 'naver';
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*'
  });
  res.write(':\n\n');
  clients.push(res);
  req.on('close', () => { clients = clients.filter(c => c !== res); });
});

async function broadcast() {
  if (clients.length === 0) return;
  try {
    const data = await getAllTimeframes(currentSource);
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    clients.forEach(c => c.write(payload));
    console.log(`[${new Date().toLocaleTimeString()}] ${currentSource} → ${clients.length} clients`);
  } catch (err) {
    console.error('Broadcast error:', err.message);
    if (currentSource !== 'naver') {
      try {
        currentSource = 'naver';
        const data = await getAllTimeframes('naver');
        (data as any).fallbackFrom = 'yahoo';
        const payload = `data: ${JSON.stringify(data)}\n\n`;
        clients.forEach(c => c.write(payload));
      } catch (e2) { /* ignore */ }
    }
  }
}

app.post('/api/source', express.json(), (req, res) => {
  if (req.body.source && SOURCES[req.body.source]) {
    currentSource = req.body.source;
    res.json({ source: currentSource });
    broadcast();
  } else {
    res.status(400).json({ error: 'invalid source' });
  }
});

// ══════════════════════════════════════════
//  Quantitative Indicators Engine
// ══════════════════════════════════════════
function calcSMA(closes, period) {
  const result = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    result.push(Math.round((sum / period) * 100) / 100);
  }
  return result;
}

function calcEMA(closes, period) {
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

function detectSignals(closes, times, indicators) {
  const signals = [];
  const { ma5, ma20, rsi, dif, dea, hist, bollUpper, bollLower } = indicators;
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
    if (dif[i] == null || dea[i] == null || dif[i-1] == null || dea[i-1] == null) continue;
    if (dif[i-1] <= dea[i-1] && dif[i] > dea[i]) {
      signals.push({ type: 'macd_golden', label: 'MACD 金叉', direction: 'long', time: times[i] });
    }
    if (dif[i-1] >= dea[i-1] && dif[i] < dea[i]) {
      signals.push({ type: 'macd_death', label: 'MACD 死叉', direction: 'short', time: times[i] });
    }
  }

  // Bollinger Breakout
  for (let i = Math.max(20, len - 50); i < len; i++) {
    if (bollUpper[i] == null || bollLower[i] == null) continue;
    if (closes[i] > bollUpper[i] && closes[i-1] <= bollUpper[i-1]) {
      signals.push({ type: 'boll_breakup', label: '突破布林上轨', direction: 'short', time: times[i] });
    }
    if (closes[i] < bollLower[i] && closes[i-1] >= bollLower[i-1]) {
      signals.push({ type: 'boll_breakdown', label: '跌破布林下轨', direction: 'long', time: times[i] });
    }
  }

  // Volume spike (volume > 2x average of last 20)
  // volume is tick count per candle, passed separately
  return signals;
}

function findSupportResistance(candles) {
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

app.get('/api/indicators', (req, res) => {
  try {
    const { rangeSec, intervalSec } = getTimeframeConfig((req.query as any).tf || 'm5');
    const now = Math.floor(Date.now() / 1000);

    const ticks = selectRange.all(now - rangeSec, now);
    if (ticks.length < 2) {
      return res.json({ indicators: null, signals: [], support: [], resistance: [] });
    }

    const candles = buildCandlesFromTicks(ticks, intervalSec);
    const closes = candles.map(c => c.close);
    const times = candles.map(c => c.time);
    const volumes = candles.map(c => c.volume);

    // Calculate indicators
    const ma5 = calcSMA(closes, 5);
    const ma10 = calcSMA(closes, 10);
    const ma20 = calcSMA(closes, 20);
    const ma60 = calcSMA(closes, 60);
    const ema12 = calcEMA(closes, 12);
    const ema26 = calcEMA(closes, 26);
    const rsi = calcRSI(closes, 14);
    const macd = calcMACD(closes, 12, 26, 9);
    const boll = calcBollinger(closes, 20, 2);

    // Volume ratio (current vol / avg of last 20)
    const recentVols = volumes.slice(-20);
    const avgVol = recentVols.reduce((s, v) => s + v, 0) / recentVols.length;
    const volRatio = avgVol > 0 ? Math.round(volumes[volumes.length - 1] / avgVol * 100) / 100 : 1;

    // Detect signals
    const signals = detectSignals(closes, times, {
      ma5, ma20, rsi, dif: macd.dif, dea: macd.dea, hist: macd.hist,
      bollUpper: boll.upper, bollLower: boll.lower,
    });

    // Support / Resistance
    const sr = findSupportResistance(candles);

    // Latest values for header
    const latest = {
      rsi: rsi[rsi.length - 1],
      macdDif: macd.dif[macd.dif.length - 1],
      macdDea: macd.dea[macd.dea.length - 1],
      macdHist: macd.hist[macd.hist.length - 1],
      volRatio,
      ma5: ma5[ma5.length - 1],
      ma20: ma20[ma20.length - 1],
      bollUpper: boll.upper[boll.upper.length - 1],
      bollLower: boll.lower[boll.lower.length - 1],
    };

    // MACD state
    let macdState = 'neutral';
    if (latest.macdDif > latest.macdDea && latest.macdHist > 0) macdState = 'bullish';
    else if (latest.macdDif < latest.macdDea && latest.macdHist < 0) macdState = 'bearish';

    res.json({
      indicators: {
        ma: { ma5, ma10, ma20, ma60 },
        ema: { ema12, ema26 },
        rsi,
        macd,
        boll,
        volRatio,
      },
      signals,
      support: sr.support,
      resistance: sr.resistance,
      latest: { ...latest, macdState },
      times,
    });
  } catch (err) {
    console.error('[indicators] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
//  Impact Factor Analysis Engine
// ══════════════════════════════════════════
function clampScore(v) { return Math.max(-10, Math.min(10, v)); }

function factorMomentum(candles) {
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

function factorFundingRate(binanceTicks) {
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

function factorVolume(candles) {
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

function factorVolatility(candles) {
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

function factorPremium(naverLatest, binanceLatest) {
  if (!naverLatest || !binanceLatest) return { score: 0, weight: 0, detail: '数据不足' };
  const naverKRW = naverLatest.after_hours_price || (naverLatest as any).price;
  const naverUSD = naverKRW / krwUsdRate;
  const bnPrice = (binanceLatest as any).price;
  const premium = (bnPrice - naverUSD) / naverUSD * 100;
  // Positive premium = market expects upside = bullish
  let score = clampScore(premium * 2);
  return {
    category: 'premium', label: '合约溢价',
    score: Math.round(score * 10) / 10, weight: 0.7,
    detail: `Binance vs 现货 ${premium >= 0 ? '+' : ''}${premium.toFixed(2)}% ${premium > 3 ? '(高溢价)' : premium > 1 ? '(正溢价)' : premium < -2 ? '(折价)' : '(正常)'}`
  };
}

function factorIndicatorMomentum(indicators) {
  if (!indicators) return { score: 0, weight: 0, detail: '数据不足' };
  const rsi = indicators.rsi;
  const macdHist = indicators.macdHist;
  const macdDif = indicators.macdDif;
  const macdDea = indicators.macdDea;
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

function factorSupportResistance(candles, sr) {
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
function factorLongShortRatio(sentiment) {
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

function factorTakerVolume(sentiment) {
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

function factorOpenInterest(sentimentRows, candles) {
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

let newsSentiment = { score: 0, headlines: [], updatedAt: 0 };

async function fetchNewsSentiment() {
  // Try Bing News RSS first (reliable, English headlines)
  try {
    const url = 'https://www.bing.com/news/search?q=SK+hynix+HBM&format=rss';
    const xml = await fetchText(url);
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
    const xml = await fetchText(url);
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
setInterval(() => { fetchNewsSentiment(); }, 1800000);

function generateFactorSummary(factors, composite) {
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

function calcAtrPctFromCandles(candles, period = 14) {
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

function calcFactorConsensus(factors) {
  if (!factors || !factors.length) return 0;
  const bullish = factors.filter(f => f.score > 2).length;
  const bearish = factors.filter(f => f.score < -2).length;
  return Math.abs(bullish - bearish) / factors.length;
}

function calcScoreConsensus(scores) {
  const values = Object.values(scores || {}).filter(value => Number.isFinite(value));
  if (!values.length) return 0;
  const bullish = values.filter(value => value > 2).length;
  const bearish = values.filter(value => value < -2).length;
  return Math.abs(bullish - bearish) / values.length;
}

function applyRiskToStrategy(strategy, risk, context = {}) {
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
  };

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

  if (next.direction !== '观望') (next as any).leverage = risk.leverageCap;
  return next;
}

function generateStrategy(factors, composite, indicators, candles, sr, naverLatest, binanceLatest, context = {}) {
  const strategy = { direction: '', entry: '', stopLoss: '', takeProfit: '', riskLevel: '', reasoning: [], warnings: [], confidence: 0, evidence: { for: [], against: [], neutral: [] }, riskReward: '' };

  if (!candles || candles.length < 5) {
    strategy.direction = '观望';
    strategy.reasoning.push('数据不足，无法形成有效策略');
    return strategy;
  }

  // Use Binance contract price as the reference (not Naver stock price)
  const price = binanceLatest && (binanceLatest as any).price ? (binanceLatest as any).price : candles[candles.length - 1].close;
  const th = (activeParams as any).entryThreshold * ((context as any).regime?.entryThresholdMultiplier || 1);
  (strategy as any).regimeLabel = (context as any).regime?.label || '未识别';
  (strategy as any).regimeReason = (context as any).regime?.reason || '';
  (strategy as any).entryThresholdUsed = th;

  // ── Factor Evidence Chain ──
  for (const f of factors) {
    const w = activeWeights[f.category] || f.weight;
    const weightedScore = f.score * w;
    if (weightedScore > 1) {
      strategy.evidence.for.push({ label: f.label, score: f.score, detail: f.detail });
    } else if (weightedScore < -1) {
      strategy.evidence.against.push({ label: f.label, score: f.score, detail: f.detail });
    } else {
      strategy.evidence.neutral.push({ label: f.label, score: f.score });
    }
  }

  // ── Confidence Score (0-100) ──
  const forCount = strategy.evidence.for.length;
  const againstCount = strategy.evidence.against.length;
  const totalFactors = factors.length || 1;
  const consensus = Math.abs(forCount - againstCount) / totalFactors;
  const magnitude = Math.abs(composite) / 10;
  strategy.confidence = Math.round(Math.min(95, (consensus * 60 + magnitude * 40)));

  // ── Direction ──
  if (composite > th * 2) {
    strategy.direction = '做多';
    strategy.riskLevel = composite > th * 3 ? '低' : '中';
  } else if (composite < -th * 2) {
    strategy.direction = '做空';
    strategy.riskLevel = composite < -th * 3 ? '低' : '中';
  } else if (composite > th) {
    strategy.direction = '轻仓做多';
    strategy.riskLevel = '中高';
  } else if (composite < -th) {
    strategy.direction = '轻仓做空';
    strategy.riskLevel = '中高';
  } else {
    strategy.direction = '观望';
    strategy.riskLevel = '低';
    strategy.confidence = Math.max(10, 50 - Math.abs(composite) * 10);
  }

  // ── Entry / Stop / TakeProfit (only when direction is actionable) ──
  if (strategy.direction !== '观望') {
    // Entry price
    strategy.entry = price;
    if (strategy.direction.includes('做多') && indicators && indicators.rsi > 65) {
      strategy.entry = Math.round(price * 0.99);
      (strategy as any).entryNote = '回踩入场';
    } else if (strategy.direction.includes('做空') && indicators && indicators.rsi < 35) {
      strategy.entry = Math.round(price * 1.01);
      (strategy as any).entryNote = '反弹入场';
    }

    // Calculate ATR for fallback (minimum 0.5% of price to ensure reasonable levels)
    const atrKRW = candles.slice(-14).reduce((s, c, i, a) => {
      if (i === 0) return 0;
      const tr = Math.max(c.high - c.low, Math.abs(c.high - a[i-1].close), Math.abs(c.low - a[i-1].close));
      return s + tr;
    }, 0) / 13;
    const minAtrUsd = price * 0.005; // 0.5% of price as minimum
    const atrUsd = Math.max(atrKRW / krwUsdRate, minAtrUsd);

    // Stop Loss — prefer S/R, fallback to ATR
    let slCandidate = null;
    if (strategy.direction.includes('做多') && sr?.support?.length > 0) {
      slCandidate = Math.round(sr.support[0].price / krwUsdRate * 0.995);
    } else if (strategy.direction.includes('做空') && sr?.resistance?.length > 0) {
      slCandidate = Math.round(sr.resistance[0].price / krwUsdRate * 1.005);
    }
    const slAtr = strategy.direction.includes('做多')
      ? Math.round(price - atrUsd * 1.5)
      : Math.round(price + atrUsd * 1.5);
    // Use S/R only if risk is reasonable (<= 5% from entry)
    const slRisk = Math.abs((slCandidate || slAtr) - price) / price * 100;
    strategy.stopLoss = (slCandidate && slRisk <= 5) ? slCandidate : slAtr;

    // Take Profit — prefer S/R, fallback to ATR
    let tpCandidate = null;
    if (strategy.direction.includes('做多') && sr?.resistance?.length > 0) {
      tpCandidate = Math.round(sr.resistance[0].price / krwUsdRate * 0.995);
    } else if (strategy.direction.includes('做空') && sr?.support?.length > 0) {
      tpCandidate = Math.round(sr.support[0].price / krwUsdRate * 1.005);
    }
    const tpAtr = strategy.direction.includes('做多')
      ? Math.round(price + atrUsd * 2.5)
      : Math.round(price - atrUsd * 2.5);
    // Use S/R only if reward is reasonable (>= 1% from entry)
    const tpReward = Math.abs((tpCandidate || tpAtr) - price) / price * 100;
    strategy.takeProfit = (tpCandidate && tpReward >= 1) ? tpCandidate : tpAtr;

    // Risk/Reward Ratio
    if (strategy.stopLoss && strategy.takeProfit) {
      const risk = Math.abs(strategy.entry - strategy.stopLoss);
      const reward = Math.abs(strategy.takeProfit - strategy.entry);
      if (risk > 0) {
        const rr = Math.round(reward / risk * 10) / 10;
        strategy.riskReward = `1:${rr}`;
      }
    }
  }

  if ((context as any).marketContext?.event?.status === 'watch' || (context as any).marketContext?.event?.status === 'cooldown') {
    strategy.warnings.push((context as any).marketContext.event.message);
  }
  if ((context as any).basis?.ready && Math.abs((context as any).basis.zScore) >= 2) {
    strategy.warnings.push(`${(context as any).basis.label}，避免把映射误差当趋势`);
  }

  // ── Reasoning (top contributing factors) ──
  const sorted = [...factors].sort((a, b) => Math.abs(b.score * (activeWeights[b.category] || b.weight)) - Math.abs(a.score * (activeWeights[a.category] || a.weight)));
  for (const f of sorted.slice(0, 5)) {
    const w = activeWeights[f.category] || f.weight;
    if (Math.abs(f.score * w) > 1) {
      const dir = f.score > 0 ? '利多' : '利空';
      strategy.reasoning.push(`${f.label} ${dir} (${f.score > 0 ? '+' : ''}${f.score.toFixed(1)}) — ${f.detail}`);
    }
  }

  // ── Warnings ──
  if (indicators) {
    if (indicators.rsi > 75) strategy.warnings.push('RSI 严重超买，短期回调风险高');
    else if (indicators.rsi > 70) strategy.warnings.push('RSI 超买区间，注意回调');
    if (indicators.rsi < 25) strategy.warnings.push('RSI 严重超卖，短期反弹概率大');
    else if (indicators.rsi < 30) strategy.warnings.push('RSI 超卖区间，关注反弹');
  }

  const premium = factors.find(f => f.category === 'premium');
  if (premium && premium.score > 5) strategy.warnings.push('合约溢价过高，注意收敛风险');

  const vol = factors.find(f => f.category === 'volatility');
  if (vol && vol.score < -4) strategy.warnings.push('波动率偏高，建议缩小仓位');

  if (composite > 3 && indicators && indicators.rsi > 70) {
    strategy.warnings.push('虽然整体偏多但 RSI 已超买，不宜追高');
  }
  if (composite < -3 && indicators && indicators.rsi < 30) {
    strategy.warnings.push('虽然整体偏空但 RSI 已超卖，不宜追空');
  }

  // ── Leverage suggestion ──
  if (strategy.riskLevel === '低') (strategy as any).leverage = '5-10x';
  else if (strategy.riskLevel === '中') (strategy as any).leverage = '3-5x';
  else (strategy as any).leverage = '1-3x';

  return strategy;
}

// News sentiment endpoint
app.get('/api/news', (req, res) => {
  res.json(newsSentiment);
});

app.post('/api/news/refresh', async (req, res) => {
  await fetchNewsSentiment();
  res.json(newsSentiment);
});

app.get('/api/factors', (req, res) => {
  try {
    const { rangeSec, intervalSec } = getTimeframeConfig((req.query as any).tf || 'm5');
    const now = Math.floor(Date.now() / 1000);

    const ticks = selectRange.all(now - rangeSec, now);
    const candles = ticks.length > 1 ? buildCandlesFromTicks(ticks, intervalSec) : [];

    // Get latest Naver and Binance data
    const naverLatest = selectLatest.get();
    const binanceTicks = selectBinanceRange.all(now - 86400, now); // last 24h
    const binanceLatest = selectBinanceLatest.get();
    const basisSpotTicks = selectRange.all(now - 7 * 86400, now);
    const basisBinanceTicks = selectBinanceRange.all(now - 7 * 86400, now);

    // Get indicators
    let indicators = null;
    if (candles.length > 26) {
      const closes = candles.map(c => c.close);
      const rsiArr = calcRSI(closes, 14);
      const macdObj = calcMACD(closes, 12, 26, 9);
      indicators = {
        rsi: rsiArr[rsiArr.length - 1],
        macdHist: macdObj.hist[macdObj.hist.length - 1],
        macdDif: macdObj.dif[macdObj.dif.length - 1],
        macdDea: macdObj.dea[macdObj.dea.length - 1],
      };
    }

    // Get S/R
    const sr = candles.length > 5 ? findSupportResistance(candles) : { support: [], resistance: [] };

    // Get Binance sentiment data
    const sentimentRows = selectSentimentRange.all(now - 6 * 3600, now);
    const sentimentLatest = sentimentRows[sentimentRows.length - 1] || selectSentimentLatest.get();
    const marketContext = {
      korea: { ...getKoreaSessionState(Date.now()), nextOpen: getNextOpenTime() },
      funding: getFundingCountdown({ nowMs: Date.now(), nextFundingTimeMs: latestBinanceFundingTimeMs, intervalHours: 4 }),
      event: getEventWindow(Date.now()),
    };
    const basisSeries = alignBasisSeries({
      spotTicks: basisSpotTicks,
      binanceTicks: basisBinanceTicks,
      fxRate: krwUsdRate,
      bucketSec: 15 * 60,
    });
    const basis = computeBasisSnapshot(basisSeries, { lookback: 96, bandWidth: 2 });

    // Calculate all factors
    const factors = [
      factorMomentum(candles),
      factorFundingRate(binanceTicks),
      factorVolume(candles),
      factorVolatility(candles),
      factorExchangeRate(),
      factorPremium(naverLatest, binanceLatest),
      factorIndicatorMomentum(indicators),
      factorSupportResistance(candles, sr),
      factorLongShortRatio(sentimentLatest),
      factorTakerVolume(sentimentLatest),
      factorOpenInterest(sentimentRows.length ? sentimentRows : sentimentLatest ? [sentimentLatest] : [], candles),
      factorLongShortTrend(),
      factorWhaleActivity(),
      factorNewsSentiment(),
    ].filter(f => f.weight > 0); // remove factors with no data

    // Composite score using optimized weights
    const totalWeight = factors.reduce((s, f) => s + (activeWeights[f.category] || f.weight), 0);
    const composite = totalWeight > 0
      ? Math.round(factors.reduce((s, f) => s + f.score * (activeWeights[f.category] || f.weight), 0) / totalWeight * 10) / 10
      : 0;

    let label, color;
    if (composite > 5) { label = '强烈看多'; color = 'strong_bullish'; }
    else if (composite > 2) { label = '看多'; color = 'bullish'; }
    else if (composite > -2) { label = '中性'; color = 'neutral'; }
    else if (composite > -5) { label = '看空'; color = 'bearish'; }
    else { label = '强烈看空'; color = 'strong_bearish'; }

    const summary = generateFactorSummary(factors, composite);
    const atrPct = calcAtrPctFromCandles(candles, 14);
    const regime = deriveRegime({
      composite,
      consensus: calcFactorConsensus(factors),
      eventStatus: marketContext.event.status,
      basisZScore: basis.ready ? basis.zScore : 0,
      atrPct,
    });

    // Generate strategy recommendation using optimized params
    const baseStrategy = generateStrategy(factors, composite, indicators, candles, sr, naverLatest, binanceLatest, {
      regime,
      marketContext,
      basis,
    });
    const risk = buildRiskOverlay({
      direction: baseStrategy.direction,
      atrPct,
      volatilityScore: factors.find(f => f.category === 'volatility')?.score || 0,
      fundingRate: binanceLatest?.funding_rate || 0,
      eventStatus: marketContext.event.status,
      basisZScore: basis.ready ? basis.zScore : 0,
      regimeMode: regime.mode,
    });
    const strategy = applyRiskToStrategy(baseStrategy, risk, { regime, marketContext, basis });
    const sourceHealth = getSourceHealthSnapshot();
    const coverage = buildFactorCoverage({ expectedFactors: FACTOR_DEFS, factors, sourceHealth });

    res.json({
      factors, composite: { score: composite, label, color }, summary, strategy,
      coverage, sourceHealth, marketContext, basis, risk, regime,
      activeWeights, activeParams,
      optimizeTime: lastOptimizeTime ? new Date(lastOptimizeTime).toISOString() : null,
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
let activeWeights = { ...DEFAULT_WEIGHTS };
let activeParams = { entryThreshold: 2.0, holdBars: 12, stopLossPct: 3.0, takeProfitPct: 5.0, leverage: 5 };
let lastOptimizeTime = 0;
let optimizeRunning = false;

async function autoOptimize() {
  if (optimizeRunning) return;
  optimizeRunning = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const rangeSec = 7 * 86400;
    const ticks = selectRange.all(now - rangeSec, now);
    const candles = ticks.length > 1 ? buildCandlesFromTicks(ticks, 300) : [];
    const binanceWindow = selectBinanceRange.all(now - rangeSec, now);
    const sentimentData = selectSentimentRange.all(now - rangeSec, now);

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
    let bestWeights = { ...activeWeights };
    let bestParams = { ...activeParams };

    const thresholds = [1.5, 2.0, 2.5, 3.0];
    const holdOptions = [8, 12, 18, 24];
    const weightOptions = [0.3, 0.5, 0.7, 0.9];
    const factorKeys = Object.keys(DEFAULT_WEIGHTS);

    for (const th of thresholds) {
      for (const hold of holdOptions) {
        const result = backtestEngine(trainCandles, trainBinance, trainSentiment, {
          entryThreshold: th, holdBars: hold, leverage: 5,
          weights: { ...DEFAULT_WEIGHTS }, useSR: true
        });
        if (result.metrics && result.metrics.totalTrades >= 3) {
          const score = result.metrics.sharpeRatio * Math.sqrt(result.metrics.totalTrades) *
            (result.metrics.winRate / 100) - result.metrics.maxDrawdown / 10;
          if (bestScore == null || score > bestScore) {
            bestScore = score;
            bestParams = { ...bestParams, entryThreshold: th, holdBars: hold };
          }
        }
      }
    }

    if (bestScore == null) {
      bestScore = 0;
      bestParams = { ...activeParams };
      console.log('[optimize] no eligible threshold/hold config, keeping active params');
    }

    // Optimize weights on training set
    for (const key of factorKeys) {
      let bestForFactor = DEFAULT_WEIGHTS[key];
      let bestFactorScore = -Infinity;
      for (const w of weightOptions) {
        const testWeights = { ...DEFAULT_WEIGHTS, [key]: w };
        const result = backtestEngine(trainCandles, trainBinance, trainSentiment, {
          ...bestParams, leverage: 5, weights: testWeights, useSR: true
        });
        if (result.metrics && result.metrics.totalTrades >= 3) {
          const score = result.metrics.sharpeRatio * Math.sqrt(result.metrics.totalTrades) *
            (result.metrics.winRate / 100) - result.metrics.maxDrawdown / 10;
          if (score > bestFactorScore) {
            bestFactorScore = score;
            bestForFactor = w;
          }
        }
      }
      bestWeights[key] = bestForFactor;
    }

    // Validate on training set
    const trainResult = backtestEngine(trainCandles, trainBinance, trainSentiment, {
      ...bestParams, leverage: 5, weights: bestWeights, useSR: true
    });
    // Validate on test set (out-of-sample)
    const testResult = backtestEngine(testCandles, testBinance, testSentiment, {
      ...bestParams, leverage: 5, weights: bestWeights, useSR: true
    });
    // Full dataset validation
    const fullResult = backtestEngine(candles, binanceWindow, sentimentData, {
      ...bestParams, leverage: 5, weights: bestWeights, useSR: true
    });

    activeWeights = bestWeights;
    activeParams = { ...activeParams, ...bestParams };
    lastOptimizeTime = Date.now();

    console.log(`[optimize] done | score=${bestScore.toFixed(2)} | th=${(bestParams as any).entryThreshold} hold=${(bestParams as any).holdBars}`);
    console.log(`[optimize] weights: ${Object.entries(bestWeights).map(([k,v]) => `${k}=${v}`).join(' ')}`);
    if (trainResult.metrics) {
      console.log(`[optimize] train: return=${trainResult.metrics.totalReturn}% win=${trainResult.metrics.winRate}% sharpe=${trainResult.metrics.sharpeRatio}`);
    }
    if (testResult.metrics) {
      console.log(`[optimize] test:  return=${testResult.metrics.totalReturn}% win=${testResult.metrics.winRate}% sharpe=${testResult.metrics.sharpeRatio}`);
    }
  } catch (err) {
    console.error('[optimize] error:', err.message);
  } finally {
    optimizeRunning = false;
  }
}

function calcCandlesForWindow(ticks, from, to, intervalSec) {
  const windowTicks = ticks.filter(t => (t as any).ts >= from && (t as any).ts < to);
  return windowTicks.length > 1 ? buildCandlesFromTicks(windowTicks, intervalSec) : [];
}

function computeFactorScoreAtIndex(candles, binanceWindow, sentimentWindow, idx) {
  if (idx < 5) return { composite: 0, scores: {} };
  const slice = candles.slice(0, idx + 1);
  const closes = slice.map(c => c.close);

  // Momentum
  const last = closes[closes.length - 1];
  const shortLen = Math.min(12, closes.length);
  const shortChg = (last - closes[closes.length - shortLen]) / closes[closes.length - shortLen] * 100;
  const medLen = Math.min(Math.floor(closes.length * 0.15), closes.length - 1);
  const medChg = (last - closes[closes.length - Math.max(medLen, 2)]) / closes[closes.length - Math.max(medLen, 2)] * 100;
  const longChg = (last - closes[0]) / closes[0] * 100;
  const momentum = clampScore(shortChg * 2 + medChg * 1.2 + longChg * 0.5);

  // RSI + MACD
  const rsiArr = calcRSI(closes, 14);
  const rsi = rsiArr[rsiArr.length - 1];
  const rsiScore = rsi != null ? (rsi - 50) / 5 : 0;
  let macdScore = 0;
  if (closes.length > 26) {
    const macd = calcMACD(closes, 12, 26, 9);
    const hist = macd.hist[macd.hist.length - 1];
    macdScore = Math.sign(hist) * Math.min(Math.abs(hist) / 500, 5);
  }
  const indicator = clampScore(rsiScore * 0.6 + macdScore * 0.4);

  // Volatility (ATR %)
  let atrPct = 1;
  if (slice.length > 15) {
    let atrSum = 0;
    const p = Math.min(14, slice.length - 1);
    for (let i = slice.length - p; i < slice.length; i++) {
      const h = slice[i].high, l = slice[i].low, prevC = slice[i - 1].close;
      atrSum += Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
    }
    atrPct = (atrSum / p / last) * 100;
  }
  const volatility = atrPct < 0.5 ? 3 : atrPct < 1 ? 2 : atrPct < 2 ? 0 : atrPct < 3 ? -3 : -6;

  // Volume
  const vols = slice.map(c => c.volume);
  const lastVol = vols[vols.length - 1];
  const avgVol = vols.slice(-20).reduce((s, v) => s + v, 0) / Math.min(20, vols.length);
  const ratio = avgVol > 0 ? lastVol / avgVol : 1;
  const lastChg = closes.length >= 2 ? closes[closes.length - 1] - closes[closes.length - 2] : 0;
  const volDir = lastChg > 0 ? 1 : lastChg < 0 ? -1 : 0;
  const volume = ratio > 2 ? clampScore(volDir * Math.min(ratio, 5)) : ratio > 1.5 ? clampScore(volDir * 2) : ratio < 0.5 ? -1 : 0;

  // Funding
  let funding = 0;
  if (binanceWindow.length > 0) {
    const latestFR = binanceWindow[binanceWindow.length - 1].funding_rate || 0;
    funding = clampScore(latestFR * 300);
  }

  // FX
  const fx = clampScore((krwUsdRate - KRW_USD_DEFAULT) / KRW_USD_DEFAULT * 300);

  // Premium (Naver vs Binance price spread)
  let premium = 0;
  if (binanceWindow.length > 0 && binanceWindow[binanceWindow.length - 1].price) {
    const bnPrice = binanceWindow[binanceWindow.length - 1].price;
    const spread = (bnPrice - last / krwUsdRate) / (last / krwUsdRate) * 100;
    premium = clampScore(spread * 3);
  }

  // Structure (distance to recent high/low)
  const recentHigh = Math.max(...slice.slice(-20).map(c => c.high));
  const recentLow = Math.min(...slice.slice(-20).map(c => c.low));
  const distHigh = (recentHigh - last) / last * 100;
  const distLow = (last - recentLow) / last * 100;
  const structure = clampScore(distLow * 2 - distHigh * 2);

  // ── Sentiment Factors (from binance_sentiment history) ──
  let lsRatio = 0, takerVol = 0, openInterest = 0, lsTrend = 0, whale = 0;

  if (sentimentWindow && sentimentWindow.length > 0) {
    const latest = sentimentWindow[sentimentWindow.length - 1];

    // Long/Short Ratio (contrarian)
    const ls = latest.ls_ratio || 1;
    if (ls > 3) lsRatio = -4; else if (ls > 2) lsRatio = -2;
    else if (ls > 1.3) lsRatio = 2; else if (ls > 0.8) lsRatio = 0;
    else if (ls > 0.5) lsRatio = 2; else lsRatio = 4;
    const topR = (latest as any).top_ls_ratio || 1;
    lsRatio = clampScore(lsRatio + (topR > 2 ? -1 : topR > 1.3 ? 1 : topR < 0.7 ? 1 : 0));

    // Taker Volume
    const tr = latest.taker_ratio || 1;
    if (tr > 1.3) takerVol = 4; else if (tr > 1.05) takerVol = 2;
    else if (tr > 0.95) takerVol = 0; else if (tr > 0.8) takerVol = -2;
    else takerVol = -4;

    // Open Interest + Price
    const oiSignal = scoreOpenInterestSignal({
      sentimentRows: sentimentWindow,
      priceNow: last,
      pricePrev: idx >= 5 ? closes[idx - 5] : null,
    });
    openInterest = oiSignal.score;

    // LS Trend (compare with earliest in window)
    if (sentimentWindow.length >= 3) {
      const earliest = sentimentWindow[0].ls_ratio;
      const lTrend = ls - earliest;
      const prevH = sentimentWindow.length >= 2 ? sentimentWindow[sentimentWindow.length - 2].ls_ratio : ls;
      const sTrend = ls - prevH;
      if (ls > 2.5 && sTrend > 0.1) lsTrend = -3;
      else if (ls < 0.7 && sTrend < -0.1) lsTrend = 3;
      else if (ls > 1.8 && sTrend > 0.05) lsTrend = -2;
      else if (ls < 0.9 && sTrend < -0.05) lsTrend = 2;
      else if (lTrend > 0.3) lsTrend = 1; else if (lTrend < -0.3) lsTrend = -1;
      else if (ls > 1.8) lsTrend = 1; else if (ls < 0.9) lsTrend = -1;
    }

    // Whale Activity
    if (sentimentWindow.length >= 3) {
      const tl = (latest as any).top_ls_ratio || 1;
      const te = sentimentWindow[0].top_ls_ratio || 1;
      const tTrend = tl - te;
      const tp = sentimentWindow.length >= 2 ? sentimentWindow[sentimentWindow.length - 2].top_ls_ratio : tl;
      const tsT = tl - tp;
      if (tl > 2 && tsT > 0.1) whale = 4;
      else if (tl > 1.5 && tsT > 0.05) whale = 2;
      else if (tl < 0.7 && tsT < -0.1) whale = -4;
      else if (tl < 0.8 && tsT < -0.05) whale = -2;
      else if (tl > 1.8 && tTrend > 0.2) whale = 2;
      else if (tl < 0.9 && tTrend < -0.2) whale = -2;
      else if (tl > 1.8) whale = 1; else if (tl < 0.9) whale = -1;
    }
  }

  return {
    scores: { momentum, funding, volume, volatility, fx, premium, indicator, structure, lsRatio, takerVol, openInterest, lsTrend, whale },
    rsi, atrPct, lastPrice: last
  };
}

function inferCandleIntervalSec(candles, idx) {
  if (!candles || idx <= 0 || !candles[idx] || !candles[idx - 1]) return 900;
  return Math.max(60, candles[idx].time - candles[idx - 1].time);
}

function buildBacktestBasisSnapshot(candles, idx, binanceWindow) {
  const intervalSec = inferCandleIntervalSec(candles, idx);
  const start = Math.max(0, idx - 95);
  const spotRows = candles.slice(start, idx + 1).map(candle => ({
    ts: candle.time,
    price: candle.close,
  }));
  const series = alignBasisSeries({
    spotTicks: spotRows,
    binanceTicks: binanceWindow,
    fxRate: krwUsdRate,
    bucketSec: intervalSec,
  });
  return computeBasisSnapshot(series, { lookback: Math.min(96, series.length || 96), bandWidth: 2 });
}

function buildBacktestTradeContext({ candles, idx, binanceWindow, scores, composite, atrPct, entryThreshold }) {
  const basis = buildBacktestBasisSnapshot(candles, idx, binanceWindow);
  const event = getEventWindow(candles[idx].time * 1000);
  const regime = deriveRegime({
    composite,
    consensus: calcScoreConsensus(scores),
    eventStatus: event.status,
    basisZScore: basis.ready ? basis.zScore : 0,
    atrPct,
  });
  const adjustedThreshold = entryThreshold * (regime.entryThresholdMultiplier || 1);
  let direction = '观望';
  if (composite > adjustedThreshold) direction = '做多';
  else if (composite < -adjustedThreshold) direction = '做空';
  const risk = buildRiskOverlay({
    direction,
    atrPct,
    volatilityScore: scores.volatility || 0,
    fundingRate: binanceWindow[binanceWindow.length - 1]?.funding_rate || 0,
    eventStatus: event.status,
    basisZScore: basis.ready ? basis.zScore : 0,
    regimeMode: regime.mode,
  });

  return {
    basis,
    event,
    regime,
    risk,
    adjustedThreshold,
    direction,
  };
}

function backtestEngine(candles, binanceTicks, sentimentData, params = {}) {
  const {
    entryThreshold = 2.0,
    holdBars = 12,
    leverage = 5,
    weights = { ...DEFAULT_WEIGHTS },
    useSR = true, // use S/R-based SL/TP
    stopLossPct = 3.0, // fallback if useSR=false
    takeProfitPct = 5.0,
  } = params;

  if (candles.length < 30) {
    return { metrics: null, trades: [], equityCurve: [], factorHistory: [] };
  }

  const initialEquity = 10000;
  let equity = initialEquity;
  let peak = initialEquity;
  const trades = [];
  const equityCurve = [{ time: candles[0].time, equity }];
  const factorHistory = [];
  let inPosition = false;
  let entryBar = 0;
  let entryPrice = 0;
  let direction = 0;
  let slPrice = 0, tpPrice = 0;
  let positionSizeFrac = 0;

  let binanceIdx = 0;
  let sentimentIdx = 0;

  for (let i = 30; i < candles.length; i++) {
    const candle = candles[i];
    
    while (binanceIdx < binanceTicks.length && binanceTicks[binanceIdx].ts <= candle.time) {
      binanceIdx++;
    }
    const binanceWindow = binanceTicks.slice(0, binanceIdx);
    
    if (sentimentData) {
      while (sentimentIdx < sentimentData.length && sentimentData[sentimentIdx].ts <= candle.time) {
        sentimentIdx++;
      }
    }
    const sentimentWindow = sentimentData ? sentimentData.slice(Math.max(0, sentimentIdx - 24), sentimentIdx) : [];

    // Compute factor scores (now with sentiment)
    const { scores, atrPct, lastPrice } = computeFactorScoreAtIndex(candles, binanceWindow, sentimentWindow, i);
    // News factor: 0 in backtest (no historical news)
    (scores as any).news = 0;

    // Weighted composite
    const totalWeight = Object.values(weights).reduce((s, w) => s + w, 0);
    const composite = totalWeight > 0
      ? Object.entries(scores).reduce((s, [k, v]) => s + (v || 0) * (weights[k] || 0), 0) / totalWeight
      : 0;
    const context = buildBacktestTradeContext({
      candles,
      idx: i,
      binanceWindow,
      scores,
      composite,
      atrPct,
      entryThreshold,
    });

    // Find S/R levels for SL/TP
    const recentSlice = candles.slice(Math.max(0, i - 30), i + 1);
    let nearestSupport = 0, nearestResistance = Infinity;
    if (useSR && recentSlice.length > 5) {
      const sr = findSupportResistance(recentSlice);
      const price = lastPrice;
      for (const l of (sr.support || [])) {
        if ((l as any).price < price && (l as any).price > nearestSupport) nearestSupport = (l as any).price;
      }
      for (const l of (sr.resistance || [])) {
        if ((l as any).price > price && (l as any).price < nearestResistance) nearestResistance = (l as any).price;
      }
    }

    // ATR for dynamic SL
    const atr = lastPrice * atrPct / 100;

    factorHistory.push({
      time: candle.time,
      scores,
      composite,
      action: 'hold',
      regime: (context as any).regime.mode,
      eventStatus: context.event.status,
      basisZScore: (context as any).basis.ready ? (context as any).basis.zScore : null,
      riskAction: context.risk.action,
      positionPct: context.risk.positionPct,
    });

    if (inPosition) {
      const barsInTrade = i - entryBar;
      const grossPnlPct = direction === 1
        ? (candle.close - entryPrice) / entryPrice * 100 * leverage
        : (entryPrice - candle.close) / entryPrice * 100 * leverage;
      const pnlPct = grossPnlPct * positionSizeFrac;

      let exit = false, exitReason = '';

      // Check SL/TP
      if (direction === 1) {
        if (candle.low <= slPrice) { exit = true; exitReason = 'stop_loss'; }
        else if (candle.high >= tpPrice) { exit = true; exitReason = 'take_profit'; }
      } else {
        if (candle.high >= slPrice) { exit = true; exitReason = 'stop_loss'; }
        else if (candle.low <= tpPrice) { exit = true; exitReason = 'take_profit'; }
      }

      if (!exit && barsInTrade >= holdBars) { exit = true; exitReason = 'time_exit'; }
      if (!exit && context.event.status === 'freeze') { exit = true; exitReason = 'event_freeze'; }
      if (!exit && ((direction === 1 && composite < -context.adjustedThreshold) ||
                     (direction === -1 && composite > context.adjustedThreshold))) {
        exit = true; exitReason = 'reverse';
      }

      if (exit) {
        const pnl = equity * (pnlPct / 100);
        equity += pnl;
        trades.push({
          entryTime: candles[entryBar].time, exitTime: candle.time,
          entryPrice, exitPrice: candle.close,
          direction: direction === 1 ? 'long' : 'short',
          pnlPct: Math.round(pnlPct * 100) / 100,
          pnl: Math.round(pnl * 100) / 100,
          exitReason, bars: barsInTrade,
          positionSizePct: Math.round(positionSizeFrac * 100),
          sl: Math.round(slPrice), tp: Math.round(tpPrice)
        });
        inPosition = false;
        positionSizeFrac = 0;
        if (factorHistory.length > 0) factorHistory[factorHistory.length - 1].action = exitReason;
      }
    } else {
      if (context.direction === '做多' && !context.risk.blocked && context.risk.positionPct > 0) {
        inPosition = true; entryBar = i; entryPrice = candle.close; direction = 1;
        positionSizeFrac = context.risk.positionPct / 100;
        // S/R-based or ATR-based SL/TP
        if (useSR && nearestSupport > 0 && nearestResistance < Infinity) {
          slPrice = nearestSupport * 0.995; // 0.5% below support
          tpPrice = nearestResistance * 0.995; // 0.5% below resistance
        } else {
          slPrice = entryPrice * (1 - stopLossPct / 100 / leverage);
          tpPrice = entryPrice * (1 + takeProfitPct / 100 / leverage);
        }
        if (factorHistory.length > 0) factorHistory[factorHistory.length - 1].action = 'long';
      } else if (context.direction === '做空' && !context.risk.blocked && context.risk.positionPct > 0) {
        inPosition = true; entryBar = i; entryPrice = candle.close; direction = -1;
        positionSizeFrac = context.risk.positionPct / 100;
        if (useSR && nearestSupport > 0 && nearestResistance < Infinity) {
          slPrice = nearestResistance * 1.005;
          tpPrice = nearestSupport * 1.005;
        } else {
          slPrice = entryPrice * (1 + stopLossPct / 100 / leverage);
          tpPrice = entryPrice * (1 - takeProfitPct / 100 / leverage);
        }
        if (factorHistory.length > 0) factorHistory[factorHistory.length - 1].action = 'short';
      } else if (context.direction !== '观望' && factorHistory.length > 0) {
        factorHistory[factorHistory.length - 1].action = context.risk.blocked ? 'blocked' : 'skip';
      }
    }

    peak = Math.max(peak, equity);
    equityCurve.push({ time: candle.time, equity: Math.round(equity * 100) / 100 });
  }

  // Close open position
  if (inPosition) {
    const lastPrice = candles[candles.length - 1].close;
    const grossPnlPct = direction === 1
      ? (lastPrice - entryPrice) / entryPrice * 100 * leverage
      : (entryPrice - lastPrice) / entryPrice * 100 * leverage;
    const pnlPct = grossPnlPct * positionSizeFrac;
    const pnl = equity * (pnlPct / 100);
    equity += pnl;
    trades.push({
      entryTime: candles[entryBar].time, exitTime: candles[candles.length - 1].time,
      entryPrice, exitPrice: lastPrice,
      direction: direction === 1 ? 'long' : 'short',
      pnlPct: Math.round(pnlPct * 100) / 100,
      pnl: Math.round(pnl * 100) / 100,
      exitReason: 'end_of_data', bars: candles.length - 1 - entryBar,
      positionSizePct: Math.round(positionSizeFrac * 100),
      sl: Math.round(slPrice), tp: Math.round(tpPrice)
    });
  }

  const metrics = computeMetrics(trades, equityCurve, initialEquity);
  return { metrics, trades: trades.slice(-50), equityCurve, factorHistory: factorHistory.slice(-200) };
}

function computeMetrics(trades, equityCurve, initialEquity) {
  if (trades.length === 0) {
    return {
      totalReturn: 0, winRate: 0, profitFactor: 0, sharpeRatio: 0,
      maxDrawdown: 0, totalTrades: 0, avgHoldBars: 0,
      avgWin: 0, avgLoss: 0, expectancy: 0
    };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winRate = (wins.length / trades.length * 100);

  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? 99 : 0;

  // Sharpe Ratio (simplified)
  const returns = trades.map(t => t.pnlPct);
  const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
  const stdReturn = Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / returns.length);
  const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252 / Math.max(1, trades.length)) : 0;

  // Max Drawdown
  let maxDD = 0;
  let peak = initialEquity;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    const dd = (peak - point.equity) / peak * 100;
    maxDD = Math.max(maxDD, dd);
  }

  const totalReturn = ((equityCurve[equityCurve.length - 1].equity - initialEquity) / initialEquity * 100);
  const avgHoldBars = trades.reduce((s, t) => s + t.bars, 0) / trades.length;
  const expectancy = (winRate / 100 * avgWin) - ((100 - winRate) / 100 * avgLoss);

  return {
    totalReturn: Math.round(totalReturn * 100) / 100,
    winRate: Math.round(winRate * 10) / 10,
    profitFactor: Math.round(profitFactor * 100) / 100,
    sharpeRatio: Math.round(sharpeRatio * 100) / 100,
    maxDrawdown: Math.round(maxDD * 100) / 100,
    totalTrades: trades.length,
    avgHoldBars: Math.round(avgHoldBars * 10) / 10,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    expectancy: Math.round(expectancy * 100) / 100,
  };
}

function optimizeWeights(candles, binanceTicks) {
  const best = { score: -Infinity, weights: { ...DEFAULT_WEIGHTS } };
  const factorKeys = Object.keys(DEFAULT_WEIGHTS);
  const weightOptions = [0.3, 0.5, 0.7, 0.9, 1.0];

  // Simplified optimization: optimize each factor independently
  for (const key of factorKeys) {
    let bestForFactor = DEFAULT_WEIGHTS[key];
    let bestScore = -Infinity;

    for (const w of weightOptions) {
      const testWeights = { ...DEFAULT_WEIGHTS, [key]: w };
      const result = backtestEngine(candles, binanceTicks, {
        entryThreshold: 2.0, holdBars: 12, stopLossPct: 3.0,
        takeProfitPct: 5.0, leverage: 5, weights: testWeights
      });
      if (result.metrics && result.metrics.totalTrades >= 3) {
        // Score = Sharpe * sqrt(trades) * winRate/100 - maxDrawdown/10
        const score = result.metrics.sharpeRatio * Math.sqrt(result.metrics.totalTrades) *
          (result.metrics.winRate / 100) - result.metrics.maxDrawdown / 10;
        if (score > bestScore) {
          bestScore = score;
          bestForFactor = w;
        }
      }
    }
    (best as any).weights[key] = bestForFactor;
  }

  // Run final backtest with optimized weights
  const finalResult = backtestEngine(candles, binanceTicks, {
    entryThreshold: 2.0, holdBars: 12, stopLossPct: 3.0,
    takeProfitPct: 5.0, leverage: 5, weights: (best as any).weights
  });

  return {
    optimizedWeights: (best as any).weights,
    metrics: finalResult.metrics,
    trades: finalResult.trades,
    equityCurve: finalResult.equityCurve,
    factorHistory: finalResult.factorHistory,
  };
}

app.get('/api/backtest', async (req, res) => {
  try {
    const tfConfig = getTimeframeConfig((req.query as any).tf || 'm5');
    const tf = tfConfig.tf;
    const rangeSec = tfConfig.rangeSec;
    const intervalSec = tfConfig.intervalSec;
    const optimize = (req.query as any).optimize === 'true';
    const entryThreshold = parseFloat((req.query as any).entryThreshold) || (activeParams as any).entryThreshold;
    const holdBars = parseInt((req.query as any).holdBars) || (activeParams as any).holdBars;
    const stopLossPct = parseFloat((req.query as any).stopLossPct) || (activeParams as any).stopLossPct;
    const takeProfitPct = parseFloat((req.query as any).takeProfitPct) || (activeParams as any).takeProfitPct;
    const leverage = parseInt((req.query as any).leverage) || (activeParams as any).leverage;

    const now = Math.floor(Date.now() / 1000);
    const ticks = selectRange.all(now - rangeSec, now);
    const candles = ticks.length > 1 ? buildCandlesFromTicks(ticks, intervalSec) : [];

    if (candles.length < 50) {
      return res.json({
        error: '数据不足，无法进行回测（至少需要 50 根 K 线）',
        metrics: null, trades: [], equityCurve: [], factorHistory: []
      });
    }

    const binanceWindow = selectBinanceRange.all(now - rangeSec, now);
    const sentimentData = selectSentimentRange.all(now - rangeSec, now);

    // Train/test split (70/30)
    const splitIdx = Math.floor(candles.length * 0.7);
    const trainCandles = candles.slice(0, splitIdx);
    const testCandles = candles.slice(splitIdx);
    const trainBinance = binanceWindow.filter(t => (t as any).ts <= trainCandles[trainCandles.length - 1].time);
    const testBinance = binanceWindow.filter(t => (t as any).ts > trainCandles[trainCandles.length - 1].time);
    const trainSentiment = sentimentData.filter(t => (t as any).ts <= trainCandles[trainCandles.length - 1].time);
    const testSentiment = sentimentData.filter(t => (t as any).ts > trainCandles[trainCandles.length - 1].time);

    if (optimize) {
      await autoOptimize();
      // Run on full, train, and test sets
      const fullResult = backtestEngine(candles, binanceWindow, sentimentData, {
        ...activeParams, leverage, weights: { ...activeWeights }, useSR: true
      });
      const trainResult = backtestEngine(trainCandles, trainBinance, trainSentiment, {
        ...activeParams, leverage, weights: { ...activeWeights }, useSR: true
      });
      const testResult = backtestEngine(testCandles, testBinance, testSentiment, {
        ...activeParams, leverage, weights: { ...activeWeights }, useSR: true
      });
      res.json({
        params: { tf, optimize: true, ...activeParams },
        ...fullResult,
        train: { metrics: trainResult.metrics, trades: trainResult.trades?.length },
        test: { metrics: testResult.metrics, trades: testResult.trades?.length },
        activeWeights: { ...activeWeights },
        activeParams: { ...activeParams },
        optimizeTime: lastOptimizeTime ? new Date(lastOptimizeTime).toISOString() : null,
      });
    } else {
      const fullResult = backtestEngine(candles, binanceWindow, sentimentData, {
        entryThreshold, holdBars, stopLossPct, takeProfitPct, leverage,
        weights: { ...activeWeights }, useSR: true
      });
      const trainResult = backtestEngine(trainCandles, trainBinance, trainSentiment, {
        entryThreshold, holdBars, stopLossPct, takeProfitPct, leverage,
        weights: { ...activeWeights }, useSR: true
      });
      const testResult = backtestEngine(testCandles, testBinance, testSentiment, {
        entryThreshold, holdBars, stopLossPct, takeProfitPct, leverage,
        weights: { ...activeWeights }, useSR: true
      });
      res.json({
        params: { tf, entryThreshold, holdBars, stopLossPct, takeProfitPct, leverage },
        ...fullResult,
        train: { metrics: trainResult.metrics, trades: trainResult.trades?.length },
        test: { metrics: testResult.metrics, trades: testResult.trades?.length },
        activeWeights: { ...activeWeights },
        activeParams: { ...activeParams },
      });
    }
  } catch (err) {
    console.error('[backtest] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
//  Contract Calculator API
// ══════════════════════════════════════════
const BINANCE_FEES = {
  maker: 0.0002,   // 0.02%
  taker: 0.0005,   // 0.05%
};

function calculateContract(params) {
  const {
    entryPrice,      // 开仓价格
    exitPrice,       // 平仓价格
    leverage,        // 杠杆倍数
    positionSize,    // 仓位大小 (USDT)
    direction,       // 'long' or 'short'
    feeType = 'taker', // 'maker' or 'taker'
    fundingRate = 0, // 资金费率
    fundingCount = 0, // 资金费用结算次数
  } = params;

  // Input validation
  if (!entryPrice || entryPrice <= 0) throw new Error('开仓价格必须大于0');
  if (!exitPrice || exitPrice <= 0) throw new Error('平仓价格必须大于0');
  if (!leverage || leverage < 1 || leverage > 125) throw new Error('杠杆倍数须在1-125之间');
  if (!positionSize || positionSize <= 0) throw new Error('仓位大小必须大于0');
  if (!['long', 'short'].includes(direction)) throw new Error('方向须为 long 或 short');
  if (!['maker', 'taker'].includes(feeType)) throw new Error('手续费类型须为 maker 或 taker');

  const fee = BINANCE_FEES[feeType] || BINANCE_FEES.taker;
  const margin = positionSize / leverage;
  const quantity = positionSize / entryPrice;

  // 盈亏计算
  let pnl;
  if (direction === 'long') {
    pnl = (exitPrice - entryPrice) * quantity;
  } else {
    pnl = (entryPrice - exitPrice) * quantity;
  }

  // 手续费计算 (开仓 + 平仓)
  const openFee = positionSize * fee;
  const closeFee = (quantity * exitPrice) * fee;
  const totalFee = openFee + closeFee;

  // 资金费用
  const fundingCost = Math.abs(positionSize) * Math.abs(fundingRate) * fundingCount;

  // 净盈亏
  const netPnl = pnl - totalFee - fundingCost;
  const roi = (netPnl / margin) * 100;

  // 强平价格计算
  let liquidationPrice;
  const maintenanceMarginRate = 0.004; // 0.4% 维持保证金率
  if (direction === 'long') {
    liquidationPrice = entryPrice * (1 - 1/leverage + maintenanceMarginRate);
  } else {
    liquidationPrice = entryPrice * (1 + 1/leverage - maintenanceMarginRate);
  }

  return {
    entryPrice,
    exitPrice,
    leverage,
    positionSize,
    margin: Math.round(margin * 100) / 100,
    quantity: Math.round(quantity * 1000000) / 1000000,
    direction,
    pnl: Math.round(pnl * 100) / 100,
    openFee: Math.round(openFee * 100) / 100,
    closeFee: Math.round(closeFee * 100) / 100,
    totalFee: Math.round(totalFee * 100) / 100,
    fundingCost: Math.round(fundingCost * 100) / 100,
    netPnl: Math.round(netPnl * 100) / 100,
    roi: Math.round(roi * 100) / 100,
    liquidationPrice: Math.round(liquidationPrice * 100) / 100,
    feeType,
    feeRate: fee,
  };
}

app.post('/api/calculate', express.json(), (req, res) => {
  try {
    const result = calculateContract(req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
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

// ── Timers ──
// Auto-optimize factor weights on startup (delayed) and every hour
setTimeout(() => { autoOptimize(); }, 5000);
setInterval(() => { autoOptimize(); }, 3600000);

// Broadcast full data every 10s during market hours
// Broadcast during market hours, pre-market, and after-hours (all active trading sessions)
setInterval(() => { if (isMarketOpen() || isPreMarket() || isAfterHours()) broadcast(); }, 10000);

// When market is closed, still push Binance data every 30s (Binance trades 24/7)
setInterval(async () => {
  if (isMarketOpen() || clients.length === 0) return;
  try {
    const binance = {};
    const sharedMeta = await binanceMeta();
    const [b1, b5, b15, bh] = await Promise.all([
      binanceLine('1m', sharedMeta), binanceLine('5m', sharedMeta),
      binanceLine('15m', sharedMeta), binanceLine('1h', sharedMeta),
    ]);
    (binance as any).m1 = b1; (binance as any).m5 = b5; (binance as any).m15 = b15; (binance as any).h1 = bh;
    // Merge with existing Naver data (from last full broadcast)
    const payload = `data: ${JSON.stringify({ binance, serverTime: Date.now(), krwUsd: krwUsdRate })}\n\n`;
    clients.forEach(c => c.write(payload));
    console.log(`[${new Date().toLocaleTimeString()}] binance-only → ${clients.length} clients`);
  } catch (err) {
    console.error('[binance-broadcast] error:', err.message);
  }
}, 30000);

// Record Naver tick every 60s (always, even outside market hours — captures state)
setInterval(() => { recordTick(); }, 60000);

// Record Binance tick every 30s for local fallback
setInterval(() => { recordBinanceTick(); }, 30000);

// Fetch Binance sentiment data every 5 minutes
fetchBinanceSentiment();
setInterval(() => { fetchBinanceSentiment(); }, 300000);

app.listen(PORT, () => {
  console.log(`\n  SK Hynix Chart Server (multi-source + SQLite)`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  Sources: ${Object.keys(SOURCES).join(', ')}`);
  const cnt = countTicks.get().cnt;
  const bnCnt = countBinanceTicks.get().cnt;
  console.log(`  SQLite ticks: ${cnt} (Naver: ${cnt}, Binance: ${bnCnt})\n`);
  // Record first tick immediately
  recordTick();
  recordBinanceTick();
  broadcast();
});
